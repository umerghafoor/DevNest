import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2 } from "lucide-react";
import {
  api,
  errorMessage,
  type ContainerSummary,
  type HostStats,
} from "../lib/api";
import { WIDGETS } from "../lib/master";
import { useAppStore } from "../store/app-store";
import { PANEL_ICONS, PANEL_LABELS } from "./PaneTile";

/**
 * Live widgets the Master agent shows in its transcript, for the host or any
 * DevNest device. Each is a small embedded pane — same header and rows as
 * the full panels — that polls the device itself while it's on screen.
 * The maximize button opens the full panel on the same device.
 */
export function MasterWidget({
  widget,
  title,
  deviceId,
  deviceName,
}: {
  widget: string;
  title?: string;
  deviceId: string;
  deviceName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref);
  const openPane = useAppStore((s) => s.openPane);
  const device = useAppStore((s) => s.devices.find((d) => d.id === deviceId));
  const status = useAppStore((s) => s.statuses[deviceId]);
  const meta = WIDGETS[widget];
  const name = device?.name ?? deviceName ?? "device";
  const online = device?.isLocalhost || status === "connected";

  const dock = () => {
    if (!meta) return;
    const id = Math.random().toString(36).slice(2, 10);
    openPane({ id, instanceId: id, deviceId, panel: meta.panel });
  };

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-md border border-(--color-border) bg-(--color-bg) text-xs"
    >
      <div
        className="relative flex h-8 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) px-2 select-none"
        title={title}
      >
        <div
          className={`absolute top-0 right-0 left-0 h-0.5 ${visible ? "bg-(--color-accent)" : "bg-transparent"}`}
        />
        <span className="text-[10px] opacity-40">
          {meta ? PANEL_ICONS[meta.panel] : "◇"}
        </span>
        <span className="font-medium">
          {meta?.label ?? (meta ? PANEL_LABELS[meta.panel] : widget)}
        </span>
        <span className="opacity-40">·</span>
        <span className="flex min-w-0 items-center gap-1 text-(--color-fg-muted)">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? "bg-(--color-online)" : "bg-(--color-fg-muted)"}`}
          />
          <span className="truncate">{name}</span>
        </span>
        <span
          className="ml-auto shrink-0 text-[10px] text-(--color-fg-muted)"
          title={visible ? "Updating live" : "Paused while off screen"}
        >
          {visible ? "live" : "paused"}
        </span>
        {meta && (
          <button
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            onClick={dock}
            title={`Open ${meta.label} for ${name} as a panel`}
          >
            <Maximize2 size={11} />
          </button>
        )}
      </div>
      {widget === "system_monitor" ? (
        <SystemMonitor live={visible} deviceId={deviceId} />
      ) : widget === "processes" ? (
        <Processes live={visible} deviceId={deviceId} />
      ) : widget === "tailscale" ? (
        <Tailscale live={visible} deviceId={deviceId} />
      ) : widget === "docker" ? (
        <Docker live={visible} deviceId={deviceId} />
      ) : (
        <Note>Unknown widget “{widget}”.</Note>
      )}
    </div>
  );
}

// ─── Shared stats poller (one per device) ─────────────────────────────────────

const HISTORY = 40;

interface StatsFeed {
  latest: HostStats | null;
  prev: HostStats | null;
  cpu: number[];
  mem: number[];
  error: string | null;
  version: number;
  subs: Set<() => void>;
  live: number;
  polling: boolean;
}

const feeds = new Map<string, StatsFeed>();

function feedFor(deviceId: string): StatsFeed {
  let f = feeds.get(deviceId);
  if (!f) {
    f = {
      latest: null,
      prev: null,
      cpu: [],
      mem: [],
      error: null,
      version: 0,
      subs: new Set(),
      live: 0,
      polling: false,
    };
    feeds.set(deviceId, f);
  }
  return f;
}

async function pollLoop(deviceId: string, f: StatsFeed) {
  if (f.polling) return;
  f.polling = true;
  while (f.live > 0) {
    try {
      const s = await api.hostStats(deviceId);
      f.prev = f.latest;
      f.latest = s;
      f.cpu = [...f.cpu, s.cpuPercent].slice(-HISTORY);
      f.mem = [...f.mem, pct(s.memUsed, s.memTotal)].slice(-HISTORY);
      f.error = null;
    } catch (e) {
      f.error = errorMessage(e);
    }
    f.version++;
    for (const fn of f.subs) fn();
    await new Promise((r) => setTimeout(r, 1500));
  }
  f.polling = false;
}

/** Live stats for `deviceId` while `live`; widgets share a poller per device. */
function useDeviceStats(deviceId: string, live: boolean) {
  const f = feedFor(deviceId);
  useSyncExternalStore(
    (fn) => {
      f.subs.add(fn);
      return () => f.subs.delete(fn);
    },
    () => f.version,
  );
  useEffect(() => {
    if (!live) return;
    f.live++;
    void pollLoop(deviceId, f);
    return () => {
      f.live--;
    };
  }, [live, deviceId, f]);
  return f;
}

// ─── Widgets ──────────────────────────────────────────────────────────────────

function SystemMonitor({
  live,
  deviceId,
}: {
  live: boolean;
  deviceId: string;
}) {
  const f = useDeviceStats(deviceId, live);
  const s = f.latest;
  if (!s) return f.error ? <Note error>{f.error}</Note> : <Note>Reading…</Note>;

  const dt = f.prev ? (s.timestampMs - f.prev.timestampMs) / 1000 : 0;
  const rate = (now: number, before?: number) =>
    dt > 0 && before != null ? Math.max(0, (now - before) / dt) : null;
  const rx = rate(s.netRx, f.prev?.netRx);
  const tx = rate(s.netTx, f.prev?.netTx);

  return (
    <>
      <div className="space-y-1 px-3 py-2">
        <Meter
          label="CPU"
          percent={s.cpuPercent}
          history={f.cpu}
          color="var(--color-accent)"
          detail={`${s.cores} cores`}
        />
        <Meter
          label="Mem"
          percent={pct(s.memUsed, s.memTotal)}
          history={f.mem}
          color="var(--color-online)"
          detail={`${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`}
        />
        <Meter
          label="Disk"
          percent={pct(s.diskUsed, s.diskTotal)}
          color="var(--color-warn)"
          detail={`${fmtBytes(s.diskUsed)} / ${fmtBytes(s.diskTotal)}`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-(--color-border) px-3 py-1 text-[11px] text-(--color-fg-muted)">
        <span title="Load average 1 / 5 / 15 min">
          load{" "}
          <span className="font-mono text-(--color-fg)">
            {s.load.map((l) => l.toFixed(2)).join(" ")}
          </span>
        </span>
        <span>
          <span className="font-mono text-(--color-fg)">
            ↓{rx == null ? "–" : fmtBytes(rx)}/s ↑
            {tx == null ? "–" : fmtBytes(tx)}/s
          </span>
        </span>
        <span className="ml-auto">
          up{" "}
          <span className="text-(--color-fg)">{fmtUptime(s.uptimeSecs)}</span>
        </span>
      </div>
    </>
  );
}

function Processes({ live, deviceId }: { live: boolean; deviceId: string }) {
  const f = useDeviceStats(deviceId, live);
  const s = f.latest;
  if (!s) return f.error ? <Note error>{f.error}</Note> : <Note>Reading…</Note>;
  return (
    <ul>
      <HeadRow>
        <span className="min-w-0 flex-1">Process</span>
        <span className="w-14 shrink-0 text-right">PID</span>
        <span className="w-12 shrink-0 text-right">CPU</span>
        <span className="w-12 shrink-0 text-right">Mem</span>
      </HeadRow>
      {s.top.map((p) => (
        <Row key={p.pid}>
          <span className="min-w-0 flex-1 truncate" title={p.name}>
            {p.name}
          </span>
          <span className="w-14 shrink-0 text-right font-mono text-(--color-fg-muted)">
            {p.pid}
          </span>
          <span className="w-12 shrink-0 text-right font-mono tabular-nums">
            {p.cpu.toFixed(1)}%
          </span>
          <span className="w-12 shrink-0 text-right font-mono tabular-nums">
            {p.mem.toFixed(1)}%
          </span>
        </Row>
      ))}
    </ul>
  );
}

interface TailnetPeer {
  tailscaleIps: string[];
  hostName: string;
  dnsName: string;
  online: boolean;
  isExitNode: boolean;
  os: string;
}

interface TailnetStatus {
  selfNode: TailnetPeer | null;
  peers: TailnetPeer[];
  currentExitNode: string | null;
  available: boolean;
}

function Tailscale({ live, deviceId }: { live: boolean; deviceId: string }) {
  const { data, error } = usePoll(live, 5000, () =>
    invoke<TailnetStatus>("tailscale_status", { deviceId }),
  );
  if (!data) return error ? <Note error>{error}</Note> : <Note>Reading…</Note>;
  if (!data.available)
    return (
      <Note>Tailscale is not installed or not running on this device.</Note>
    );

  const peers = [...data.peers].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      a.hostName.localeCompare(b.hostName, undefined, { sensitivity: "base" }),
  );
  const online = peers.filter((p) => p.online).length;
  const self = data.selfNode;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-(--color-border) px-2 py-1">
        {self && (
          <span className="min-w-0 truncate text-(--color-fg-muted)">
            <span className="font-medium text-(--color-fg)">
              {self.hostName}
            </span>{" "}
            <span className="font-mono">{self.tailscaleIps[0] ?? "—"}</span>
          </span>
        )}
        {data.currentExitNode && (
          <span className="rounded-md bg-(--color-online)/12 px-1.5 py-0.5 text-(--color-online)">
            via {data.currentExitNode}
          </span>
        )}
        <span className="ml-auto text-(--color-fg-muted) tabular-nums">
          {online}/{peers.length} online
        </span>
      </div>
      <ul className="max-h-56 overflow-y-auto">
        {peers.map((p) => (
          <Row key={p.dnsName || p.hostName}>
            <Dot on={p.online} />
            <span
              className={`min-w-0 flex-1 truncate ${p.online ? "" : "text-(--color-fg-muted)"}`}
              title={p.dnsName || p.hostName}
            >
              {p.hostName}
            </span>
            {p.isExitNode && (
              <span
                className="shrink-0 text-[10px] text-(--color-fg-muted)"
                title="Offers itself as an exit node"
              >
                exit
              </span>
            )}
            <span className="w-28 shrink-0 truncate text-right font-mono text-(--color-fg-muted)">
              {p.tailscaleIps[0] ?? "—"}
            </span>
          </Row>
        ))}
      </ul>
    </>
  );
}

function Docker({ live, deviceId }: { live: boolean; deviceId: string }) {
  const { data, error } = usePoll<ContainerSummary[]>(live, 5000, () =>
    api.dockerListContainers(deviceId),
  );
  if (!data) return error ? <Note error>{error}</Note> : <Note>Reading…</Note>;
  if (data.length === 0) return <Note>No containers.</Note>;
  const running = data.filter((c) => c.state === "running").length;
  return (
    <ul className="max-h-56 overflow-y-auto">
      <HeadRow>
        <span className="min-w-0 flex-1">
          Container{" "}
          <span className="tabular-nums">
            ({running}/{data.length} running)
          </span>
        </span>
        <span className="w-28 shrink-0 text-right">Status</span>
      </HeadRow>
      {data.map((c) => (
        <Row key={c.id}>
          <Dot on={c.state === "running"} />
          <span className="min-w-0 flex-1 truncate" title={c.image}>
            {c.name}
          </span>
          <span className="w-28 shrink-0 truncate text-right text-(--color-fg-muted)">
            {c.status}
          </span>
        </Row>
      ))}
    </ul>
  );
}

// ─── Bits (same look as the full panels) ──────────────────────────────────────

/** Metrics' compact meter: label, sparkline over the usage fill, value. */
function Meter({
  label,
  percent,
  history,
  color,
  detail,
}: {
  label: string;
  percent: number;
  history?: number[];
  color: string;
  detail: string;
}) {
  return (
    <div className="flex h-6 items-center gap-2">
      <span className="w-9 shrink-0 text-[11px] tracking-wide text-(--color-fg-muted) uppercase">
        {label}
      </span>
      <div className="relative min-w-12 flex-1 self-stretch overflow-hidden rounded-sm bg-(--color-surface)">
        <div
          className="absolute inset-y-0 left-0 opacity-25 transition-[width] duration-500"
          style={{ width: `${Math.min(percent, 100)}%`, background: color }}
        />
        {history && history.length > 1 && (
          <div className="absolute inset-0">
            <Sparkline data={history} stroke={color} />
          </div>
        )}
      </div>
      <span className="w-11 shrink-0 text-right font-mono font-semibold tabular-nums">
        {percent.toFixed(percent < 10 ? 1 : 0)}%
      </span>
      <span
        className="w-28 shrink-0 truncate text-(--color-fg-muted)"
        title={detail}
      >
        {detail}
      </span>
    </div>
  );
}

function Sparkline({ data, stroke }: { data: number[]; stroke: string }) {
  const w = 200;
  const h = 40;
  const step = w / Math.max(1, data.length - 1);
  const points = data
    .map(
      (v, i) =>
        `${(i * step).toFixed(1)},${(h - (Math.min(v, 100) / 100) * h).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-full w-full"
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function HeadRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="sticky top-0 z-10 flex h-6 items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-3 text-[11px] text-(--color-fg-muted)">
      {children}
    </li>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex h-7 items-center gap-2 border-b border-(--color-border) px-3 last:border-b-0 hover:bg-(--color-surface)">
      {children}
    </li>
  );
}

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-(--color-online)" : "bg-(--color-offline)"}`}
    />
  );
}

function Note({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`px-3 py-3 text-center ${error ? "text-(--color-error)" : "text-(--color-fg-muted)"}`}
    >
      {children}
    </div>
  );
}

/** Poll `fetch` every `ms` while `live`. Keeps the last good value. */
function usePoll<T>(live: boolean, ms: number, fetch: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  useEffect(() => {
    if (!live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const v = await fetchRef.current();
        if (stop) return;
        setData(v);
        setError(null);
      } catch (e) {
        if (!stop) setError(errorMessage(e));
      }
      if (!stop) timer = setTimeout(() => void tick(), ms);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [live, ms]);
  return { data, error };
}

function useVisible(ref: React.RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}

function pct(used: number, total: number) {
  return total > 0 ? Math.min(100, (used / total) * 100) : 0;
}

function fmtBytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
