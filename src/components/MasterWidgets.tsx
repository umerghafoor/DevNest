import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-react";
import {
  api,
  errorMessage,
  type ContainerSummary,
  type HostStats,
} from "../lib/api";
import { WIDGETS } from "../lib/master";
import { useAppStore } from "../store/app-store";

/**
 * Live widgets the Master agent shows in its transcript, for the host or any
 * DevNest device. Each one polls the device itself while it's on screen —
 * nothing is a snapshot from the agent. "Open as panel" opens the matching
 * full DevNest panel on the same device.
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
  const meta = WIDGETS[widget];
  const name = device?.name ?? deviceName;

  const dock = () => {
    if (!meta) return;
    const id = Math.random().toString(36).slice(2, 10);
    openPane({ id, instanceId: id, deviceId, panel: meta.panel });
  };

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface)"
    >
      <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${visible ? "bg-(--color-online) animate-pulse" : "bg-(--color-fg-muted)"}`}
          title={visible ? "Live" : "Paused while off screen"}
        />
        <span className="min-w-0 flex-1 truncate font-semibold">
          {title || meta?.label || widget}
        </span>
        {name && (
          <span
            className="max-w-[40%] shrink-0 truncate rounded bg-(--color-surface-2) px-1.5 py-0.5 text-[10px] text-(--color-fg-muted)"
            title={device?.isLocalhost ? "This computer" : device?.host}
          >
            {name}
          </span>
        )}
        {meta && (
          <button
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            onClick={dock}
            title={`Open ${meta.label} for ${name ?? "this device"} as a panel`}
          >
            <ExternalLink size={11} /> Open as panel
          </button>
        )}
      </div>
      <div className="px-3 py-2">
        {widget === "system_monitor" ? (
          <SystemMonitor live={visible} deviceId={deviceId} />
        ) : widget === "processes" ? (
          <Processes live={visible} deviceId={deviceId} />
        ) : widget === "tailscale" ? (
          <Tailscale live={visible} deviceId={deviceId} />
        ) : widget === "docker" ? (
          <Docker live={visible} deviceId={deviceId} />
        ) : (
          <Muted>Unknown widget “{widget}”.</Muted>
        )}
      </div>
    </div>
  );
}

// ─── Shared stats poller (one per device) ─────────────────────────────────────

const HISTORY = 40;

interface StatsFeed {
  latest: HostStats | null;
  prev: HostStats | null;
  cpu: number[];
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
  if (!s) return f.error ? <Err>{f.error}</Err> : <Muted>Reading…</Muted>;

  const dt = f.prev ? (s.timestampMs - f.prev.timestampMs) / 1000 : 0;
  const rate = (now: number, before?: number) =>
    dt > 0 && before != null ? Math.max(0, (now - before) / dt) : null;
  const rx = rate(s.netRx, f.prev?.netRx);
  const tx = rate(s.netTx, f.prev?.netTx);

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-3">
        <div className="w-20 shrink-0">
          <div className="text-[11px] text-(--color-fg-muted)">
            CPU · {s.cores} cores
          </div>
          <div className="text-xl font-semibold tabular-nums">
            {s.cpuPercent.toFixed(0)}%
          </div>
        </div>
        <Sparkline values={f.cpu} />
      </div>
      <Bar label="Memory" used={s.memUsed} total={s.memTotal} />
      <Bar label="Disk" used={s.diskUsed} total={s.diskTotal} />
      <div className="grid grid-cols-3 gap-2 text-[11px] text-(--color-fg-muted)">
        <span title="Load average 1 / 5 / 15 min">
          Load{" "}
          <b className="text-(--color-fg) tabular-nums">
            {s.load.map((l) => l.toFixed(2)).join(" ")}
          </b>
        </span>
        <span>
          Net{" "}
          <b className="text-(--color-fg) tabular-nums">
            ↓{rx == null ? "–" : fmtBytes(rx)}/s ↑
            {tx == null ? "–" : fmtBytes(tx)}/s
          </b>
        </span>
        <span className="text-right">
          Up <b className="text-(--color-fg)">{fmtUptime(s.uptimeSecs)}</b>
        </span>
      </div>
    </div>
  );
}

function Processes({ live, deviceId }: { live: boolean; deviceId: string }) {
  const f = useDeviceStats(deviceId, live);
  const s = f.latest;
  if (!s) return f.error ? <Err>{f.error}</Err> : <Muted>Reading…</Muted>;
  return (
    <table className="w-full table-fixed text-[11px]">
      <thead className="text-(--color-fg-muted)">
        <tr>
          <th className="text-left font-normal">Process</th>
          <th className="w-14 text-right font-normal">PID</th>
          <th className="w-12 text-right font-normal">CPU</th>
          <th className="w-12 text-right font-normal">Mem</th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {s.top.map((p) => (
          <tr key={p.pid}>
            <td className="truncate" title={p.name}>
              {p.name}
            </td>
            <td className="text-right text-(--color-fg-muted)">{p.pid}</td>
            <td className="text-right">{p.cpu.toFixed(1)}%</td>
            <td className="text-right">{p.mem.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TailnetPeer {
  tailscaleIps: string[];
  hostName: string;
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
  if (!data) return error ? <Err>{error}</Err> : <Muted>Reading…</Muted>;
  if (!data.available)
    return <Muted>Tailscale isn’t running on this device.</Muted>;

  const peers = [...data.peers].sort(
    (a, b) => Number(b.online) - Number(a.online),
  );
  const online = peers.filter((p) => p.online).length;
  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="flex flex-wrap gap-x-3 text-(--color-fg-muted)">
        <span>
          This device{" "}
          <b className="text-(--color-fg)">{data.selfNode?.hostName ?? "?"}</b>{" "}
          {data.selfNode?.tailscaleIps[0]}
        </span>
        <span>
          {online}/{peers.length} peers online
        </span>
        <span>
          Exit node{" "}
          <b className="text-(--color-fg)">{data.currentExitNode ?? "none"}</b>
        </span>
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto">
        {peers.map((p) => (
          <li
            key={p.hostName + p.tailscaleIps[0]}
            className="flex items-center gap-2"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.online ? "bg-(--color-online)" : "bg-(--color-offline)"}`}
            />
            <span className="min-w-0 flex-1 truncate">{p.hostName}</span>
            {p.isExitNode && (
              <span className="rounded bg-(--color-accent)/15 px-1 text-[10px]">
                exit
              </span>
            )}
            <span className="font-mono text-(--color-fg-muted)">
              {p.tailscaleIps[0]}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Docker({ live, deviceId }: { live: boolean; deviceId: string }) {
  const { data, error } = usePoll<ContainerSummary[]>(live, 5000, () =>
    api.dockerListContainers(deviceId),
  );
  if (!data) return error ? <Err>{error}</Err> : <Muted>Reading…</Muted>;
  if (data.length === 0) return <Muted>No containers.</Muted>;
  return (
    <ul className="max-h-48 space-y-0.5 overflow-y-auto text-[11px]">
      {data.map((c) => (
        <li key={c.id} className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.state === "running" ? "bg-(--color-online)" : "bg-(--color-offline)"}`}
          />
          <span className="min-w-0 flex-1 truncate" title={c.image}>
            {c.name}
          </span>
          <span className="truncate text-(--color-fg-muted)">{c.status}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Bits ─────────────────────────────────────────────────────────────────────

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

function Bar({
  label,
  used,
  total,
}: {
  label: string;
  used: number;
  total: number;
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color =
    pct > 90
      ? "bg-(--color-error)"
      : pct > 75
        ? "bg-(--color-warn)"
        : "bg-(--color-accent)";
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[11px]">
        <span className="text-(--color-fg-muted)">{label}</span>
        <span className="tabular-nums">
          {fmtBytes(used)} / {fmtBytes(total)} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-(--color-surface-2)">
        <div
          className={`h-full rounded-full ${color} transition-[width] duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 200;
  const h = 36;
  if (values.length < 2) return <div className="h-9 flex-1" />;
  const step = w / (HISTORY - 1);
  const x0 = w - (values.length - 1) * step;
  const pts = values.map(
    (v, i) => `${x0 + i * step},${h - (Math.min(100, v) / 100) * h}`,
  );
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-9 min-w-0 flex-1"
    >
      <polygon
        points={`${x0},${h} ${pts.join(" ")} ${w},${h}`}
        className="fill-(--color-accent) opacity-15"
      />
      <polyline
        points={pts.join(" ")}
        fill="none"
        className="stroke-(--color-accent)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-(--color-fg-muted)">{children}</div>;
}

function Err({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-(--color-error)">{children}</div>;
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
