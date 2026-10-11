import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, errorMessage } from "../lib/api";
import type {
  CpuCoreTicks,
  CpuInfo,
  DimmModule,
  GpuInfo,
  MetricsSnapshot,
} from "../lib/api";
import { withSudo } from "../lib/with-sudo";
import { SkeletonCard } from "../components/Skeleton";
import { usePaneSettings } from "../store/pane-settings-store";

interface Props {
  deviceId: string;
  paneId?: string;
}

const HISTORY = 60;
const INTERVALS = [1000, 2000, 5000, 10000, 30000];

interface MetricsSettings {
  intervalMs: number;
  paused: boolean;
}

const DEFAULT_METRICS_SETTINGS: MetricsSettings = {
  intervalMs: 2000,
  paused: false,
};

interface CoreUsage {
  core: number;
  percent: number;
}

interface NetRate {
  name: string;
  rxBps: number;
  txBps: number;
}

function pushCapped(buf: number[], v: number) {
  buf.push(v);
  if (buf.length > HISTORY) buf.shift();
}

const gpuKey = (g: GpuInfo) => `${g.vendor}-${g.id}`;
const vramKey = (g: GpuInfo) => `${gpuKey(g)}-vram`;

/** VRAM use as a percentage; null for unified memory or unknown totals. */
function vramPercent(g: GpuInfo): number | null {
  return g.memoryUsedMb != null && g.memoryTotalMb
    ? (g.memoryUsedMb / g.memoryTotalMb) * 100
    : null;
}

/**
 * Everything a Metrics pane has collected so far. Kept outside React so the
 * charts survive the panel unmounting — switching workspace tabs or adding a
 * pane remounts panels, which would otherwise restart every chart from zero.
 */
interface MetricsHistory {
  deviceId: string;
  overallCpu: number[];
  mem: number[];
  gpu: Map<string, number[]>;
  perCore: Map<number, number[]>;
  net: Map<string, { rx: number[]; tx: number[] }>;
  prevCores: Map<number, CpuCoreTicks>;
  prevNet: Map<string, { rx: number; tx: number; ts: number }>;
  snap: MetricsSnapshot | null;
  cpuInfo: CpuInfo | null;
  coreUsage: CoreUsage[];
  netRates: NetRate[];
}

const historyCache = new Map<string, MetricsHistory>();

/** Cached history for this pane, or a fresh one if it's new or the device changed. */
function getHistory(key: string, deviceId: string): MetricsHistory {
  const cached = historyCache.get(key);
  if (cached && cached.deviceId === deviceId) return cached;
  const fresh: MetricsHistory = {
    deviceId,
    overallCpu: [],
    mem: [],
    gpu: new Map(),
    perCore: new Map(),
    net: new Map(),
    prevCores: new Map(),
    prevNet: new Map(),
    snap: null,
    cpuInfo: null,
    coreUsage: [],
    netRates: [],
  };
  historyCache.set(key, fresh);
  return fresh;
}

export function MetricsPanel({ deviceId, paneId }: Props) {
  const [settings, updateSettings] = usePaneSettings<MetricsSettings>(
    paneId,
    DEFAULT_METRICS_SETTINGS,
  );
  const { intervalMs, paused } = settings;

  // Restore whatever this pane collected before it was last unmounted.
  const history = getHistory(paneId ?? deviceId, deviceId);
  const historyRef = useRef(history);
  historyRef.current = history;

  const [snap, setSnap] = useState<MetricsSnapshot | null>(history.snap);
  const [error, setError] = useState<string | null>(null);
  const [cpuInfo, setCpuInfo] = useState<CpuInfo | null>(history.cpuInfo);
  const [dimms, setDimms] = useState<DimmModule[] | null>(null);
  const [dimmError, setDimmError] = useState<string | null>(null);
  const [loadingDimms, setLoadingDimms] = useState(false);

  // History buffers (rolling sparkline data). These point into the cached
  // history, so pushing to them updates the cache too.
  const overallCpuHistory = useRef(history.overallCpu);
  const memHistory = useRef(history.mem);
  const gpuHistory = useRef(history.gpu);
  const perCoreHistory = useRef(history.perCore);
  const netRateHistory = useRef(history.net);
  const [tick, setTick] = useState(0);

  // Previous raw values for delta computation
  const prevCores = useRef(history.prevCores);
  const prevNet = useRef(history.prevNet);
  // Skip a tick if the previous SSH round-trip hasn't come back yet, so a
  // short interval on a slow link can't pile up requests.
  const inFlight = useRef(false);

  const [coreUsage, setCoreUsage] = useState<CoreUsage[]>(history.coreUsage);
  const [netRates, setNetRates] = useState<NetRate[]>(history.netRates);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // Metrics read /proc + df — no sudo. Wrapping with withSudo would trigger
      // the password dialog every poll if the user enabled sudo on the device.
      const s = await api.metricsSnapshot(deviceId);

      // ─ per-core CPU% from deltas ─
      const usage: CoreUsage[] = [];
      for (const c of s.cpuCores) {
        const prev = prevCores.current.get(c.core);
        if (prev) {
          const totalPrev =
            prev.user +
            prev.nice +
            prev.system +
            prev.idle +
            prev.iowait +
            prev.irq +
            prev.softirq +
            prev.steal;
          const totalNow =
            c.user +
            c.nice +
            c.system +
            c.idle +
            c.iowait +
            c.irq +
            c.softirq +
            c.steal;
          const totalDelta = totalNow - totalPrev;
          const idleDelta = c.idle + c.iowait - prev.idle - prev.iowait;
          const pct =
            totalDelta > 0
              ? Math.max(
                  0,
                  Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100),
                )
              : 0;
          usage.push({ core: c.core, percent: pct });
          const buf = perCoreHistory.current.get(c.core) ?? [];
          pushCapped(buf, pct);
          perCoreHistory.current.set(c.core, buf);
        }
        prevCores.current.set(c.core, c);
      }
      setCoreUsage(usage);
      historyRef.current.coreUsage = usage;

      // ─ overall CPU (avg of cores) ─
      const overall =
        usage.length > 0
          ? usage.reduce((acc, u) => acc + u.percent, 0) / usage.length
          : 0;
      pushCapped(overallCpuHistory.current, overall);

      // ─ memory % history ─
      const memPct =
        s.mem.totalMb > 0 ? (s.mem.usedMb / s.mem.totalMb) * 100 : 0;
      pushCapped(memHistory.current, memPct);

      // ─ GPU utilization history ─
      for (const g of s.gpus) {
        if (g.utilizationPercent != null) {
          const buf = gpuHistory.current.get(gpuKey(g)) ?? [];
          pushCapped(buf, g.utilizationPercent);
          gpuHistory.current.set(gpuKey(g), buf);
        }
        const vram = vramPercent(g);
        if (vram != null) {
          const buf = gpuHistory.current.get(vramKey(g)) ?? [];
          pushCapped(buf, vram);
          gpuHistory.current.set(vramKey(g), buf);
        }
      }

      // ─ network rates ─
      const rates: NetRate[] = [];
      const nowTs = s.timestampMs;
      for (const n of s.net) {
        const prev = prevNet.current.get(n.name);
        if (prev) {
          const dtSec = Math.max(0.001, (nowTs - prev.ts) / 1000);
          const rxBps = Math.max(0, (n.rxBytes - prev.rx) / dtSec);
          const txBps = Math.max(0, (n.txBytes - prev.tx) / dtSec);
          rates.push({ name: n.name, rxBps, txBps });
          const buf = netRateHistory.current.get(n.name) ?? {
            rx: [],
            tx: [],
          };
          pushCapped(buf.rx, rxBps);
          pushCapped(buf.tx, txBps);
          netRateHistory.current.set(n.name, buf);
        }
        prevNet.current.set(n.name, {
          rx: n.rxBytes,
          tx: n.txBytes,
          ts: nowTs,
        });
      }
      setNetRates(rates);
      historyRef.current.netRates = rates;

      setSnap(s);
      historyRef.current.snap = s;
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      inFlight.current = false;
    }
  }, [deviceId]);

  // Point the buffers at this device's history (cached or fresh) and load
  // one-shot info. On a plain remount this restores the same objects, so the
  // charts carry on where they left off.
  useEffect(() => {
    const h = historyRef.current;
    overallCpuHistory.current = h.overallCpu;
    perCoreHistory.current = h.perCore;
    memHistory.current = h.mem;
    gpuHistory.current = h.gpu;
    netRateHistory.current = h.net;
    prevCores.current = h.prevCores;
    prevNet.current = h.prevNet;
    setSnap(h.snap);
    setCoreUsage(h.coreUsage);
    setNetRates(h.netRates);
    setCpuInfo(h.cpuInfo);
    setDimms(null);
    setDimmError(null);
    if (h.cpuInfo) return;
    void api
      .cpuInfo(deviceId)
      .then((info) => {
        h.cpuInfo = info;
        setCpuInfo(info);
      })
      .catch(() => {
        // best-effort
      });
  }, [deviceId]);

  useEffect(() => {
    void poll();
    if (paused) return;
    const t = setInterval(poll, intervalMs);
    return () => clearInterval(t);
  }, [poll, intervalMs, paused]);

  const loadDimms = async () => {
    setLoadingDimms(true);
    setDimmError(null);
    try {
      const d = await withSudo(deviceId, () => api.dimmInfo(deviceId));
      setDimms(d);
    } catch (e) {
      setDimmError(errorMessage(e));
    } finally {
      setLoadingDimms(false);
    }
  };

  // Pick a layout from the pane's own size (not the window), so split panes
  // each get the view that fits them.
  const [paneSize, setPaneSize] = useState({ w: 0, h: 0 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setPaneSize((p) =>
        p.w === Math.round(width) && p.h === Math.round(height)
          ? p
          : { w: Math.round(width), h: Math.round(height) },
      );
    });
    ro.observe(el);
    observerRef.current = ro;
  }, []);
  const layout: "tiny" | "compact" | "regular" | "large" =
    paneSize.w === 0
      ? "regular"
      : paneSize.h < 260
        ? "tiny"
        : paneSize.w < 560 || paneSize.h < 420
          ? "compact"
          : paneSize.h >= 640
            ? "large"
            : "regular";

  // Card layouts: measure how tall everything except the Cores section is,
  // so leftover pane height can go to per-core charts. Measuring "everything
  // else" keeps this stable — switching Cores to charts doesn't change it.
  const contentRef = useRef<HTMLDivElement>(null);
  const coresRef = useRef<HTMLElement>(null);
  const [otherHeight, setOtherHeight] = useState(0);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const coresEl = coresRef.current;
    if (!content || !coresEl) return;
    const h = content.offsetHeight - coresEl.offsetHeight;
    if (Math.abs(h - otherHeight) > 2) setOtherHeight(h);
    // Re-measure whenever content or pane size can change.
  }, [tick, paneSize.w, paneSize.h, otherHeight, dimms, dimmError, error]);

  // Narrow panes get short meter details ("6.7/30G" instead of "6.7 / 30.4 GiB").
  const narrow = paneSize.w > 0 && paneSize.w < 380;

  // Compact control group; lives inside the info card so it doesn't cost a
  // full row of height.
  const iconBtn =
    "flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) disabled:opacity-50";
  const controls = (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-(--color-border) p-0.5 text-xs">
      <select
        value={intervalMs}
        onChange={(e) => updateSettings({ intervalMs: Number(e.target.value) })}
        className="h-6 rounded bg-transparent px-1 text-(--color-fg) hover:bg-(--color-surface-2)"
        title="Refresh interval"
      >
        {INTERVALS.map((ms) => (
          <option key={ms} value={ms}>
            {ms / 1000}s
          </option>
        ))}
      </select>
      <button
        onClick={() => updateSettings({ paused: !paused })}
        className={`${iconBtn} ${paused ? "text-(--color-accent)" : ""}`}
        title={paused ? "Resume polling" : "Pause polling"}
      >
        {paused ? "▶" : "❚❚"}
      </button>
      {paused && (
        <button
          onClick={() => void poll()}
          className={iconBtn}
          title="Refresh now"
        >
          ↻
        </button>
      )}
      {layout !== "tiny" && (
        <button
          onClick={() => void loadDimms()}
          disabled={loadingDimms}
          className={iconBtn}
          title="Memory chip details via dmidecode (needs sudo)"
        >
          {loadingDimms ? "…" : "DIMMs"}
        </button>
      )}
    </div>
  );
  const toolbar = <div className="flex justify-end p-2">{controls}</div>;

  if (error && !snap) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-(--color-error)">
          Could not read metrics: {error}
        </div>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="grid grid-cols-2 gap-2 p-3">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  const overall =
    coreUsage.length > 0
      ? coreUsage.reduce((a, c) => a + c.percent, 0) / coreUsage.length
      : 0;
  const memPct =
    snap.mem.totalMb > 0 ? (snap.mem.usedMb / snap.mem.totalMb) * 100 : 0;
  // Skip loopback and per-container virtual links; they flood the list.
  const visibleNet = netRates.filter(
    (r) => r.name !== "lo" && !/^(veth|br-)/.test(r.name),
  );
  // Pseudo filesystems (efivars, /run, …) are noise next to real disks.
  const disks = snap.disks.filter(
    (d) => !/^\/(sys|proc|dev|run|snap)(\/|$)/.test(d.mount),
  );

  const stats: StatItem[] = [
    {
      key: "cpu",
      title: "CPU",
      short: "CPU",
      percent: overall,
      history: overallCpuHistory.current,
      color: "var(--color-accent)",
      detail: cpuInfo
        ? `${cpuInfo.logicalCores} threads · ${cpuInfo.mhz.toFixed(0)} MHz`
        : undefined,
      brief: cpuInfo ? `${(cpuInfo.mhz / 1000).toFixed(1)} GHz` : undefined,
    },
    {
      key: "mem",
      title: "Memory",
      short: "Mem",
      percent: memPct,
      history: memHistory.current,
      color: "var(--color-online)",
      detail: `${(snap.mem.usedMb / 1024).toFixed(1)} / ${(snap.mem.totalMb / 1024).toFixed(1)} GiB`,
      brief: `${(snap.mem.usedMb / 1024).toFixed(1)}/${(snap.mem.totalMb / 1024).toFixed(0)}G`,
    },
    ...snap.gpus.flatMap((g, i): StatItem[] => {
      const n = snap.gpus.length > 1 ? String(i) : "";
      const gpu: StatItem = {
        key: gpuKey(g),
        title: n ? `GPU ${n}` : "GPU",
        short: `GPU${n}`,
        subtitle: g.name,
        percent: g.utilizationPercent,
        history: gpuHistory.current.get(gpuKey(g)) ?? [],
        color: "var(--color-online)",
        detail: gpuDetail(g),
        brief:
          g.temperatureC != null ? `${g.temperatureC.toFixed(0)}°C` : undefined,
        error: g.error,
      };
      const vram = vramPercent(g);
      if (vram == null || g.memoryUsedMb == null || !g.memoryTotalMb) {
        return [gpu];
      }
      const used = (g.memoryUsedMb / 1024).toFixed(1);
      return [
        gpu,
        {
          key: vramKey(g),
          secondaryOf: gpuKey(g),
          title: n ? `VRAM ${n}` : "VRAM",
          short: `VRAM${n}`,
          subtitle: g.name,
          percent: vram,
          history: gpuHistory.current.get(vramKey(g)) ?? [],
          color: "var(--color-accent)",
          detail: `${used} / ${(g.memoryTotalMb / 1024).toFixed(1)} GiB`,
          brief: `${used}/${(g.memoryTotalMb / 1024).toFixed(0)}G`,
        },
      ];
    }),
    {
      key: "swap",
      secondaryOf: "mem",
      title: "Swap",
      short: "Swap",
      percent:
        snap.swap.totalMb > 0
          ? (snap.swap.usedMb / snap.swap.totalMb) * 100
          : null,
      color: "var(--color-warn)",
      detail:
        snap.swap.totalMb > 0
          ? `${formatMb(snap.swap.usedMb)} / ${formatMb(snap.swap.totalMb)}`
          : "Not configured",
      brief:
        snap.swap.totalMb > 0
          ? `${(snap.swap.usedMb / 1024).toFixed(1)}/${(snap.swap.totalMb / 1024).toFixed(0)}G`
          : "off",
    },
  ];

  const info = (
    <>
      {error && (
        <span
          className="w-full truncate text-xs text-(--color-error)"
          title={error}
        >
          Update failed: {error}
        </span>
      )}
      <span>
        Load{" "}
        <span className="font-mono text-(--color-fg) tabular-nums">
          {snap.load.one.toFixed(2)} {snap.load.five.toFixed(2)}{" "}
          {snap.load.fifteen.toFixed(2)}
        </span>
      </span>
      <span>
        Up{" "}
        <span className="font-mono text-(--color-fg)">
          {formatUptime(snap.uptimeSeconds)}
        </span>
      </span>
      <span>
        Procs{" "}
        <span className="font-mono text-(--color-fg) tabular-nums">
          {snap.processes.total}
        </span>{" "}
        ({snap.processes.running} running)
      </span>
      {cpuInfo && (
        <span className="min-w-0 truncate" title={cpuInfo.model}>
          {cpuInfo.model || cpuInfo.vendor} · {cpuInfo.physicalCores}C/
          {cpuInfo.logicalCores}T
          {cpuInfo.governor ? ` · ${cpuInfo.governor}` : ""}
        </span>
      )}
      {snap.temperatures.map((t) => (
        <span key={t.name}>
          {t.name}{" "}
          <span
            className={`font-mono tabular-nums ${tempColor(t.celsius) || "text-(--color-fg)"}`}
          >
            {t.celsius.toFixed(0)}°C
          </span>
        </span>
      ))}
    </>
  );

  const compact = layout === "compact";

  // Per-core charts when the card layout has spare height: work out the grid
  // and give each cell an equal share of the leftover space (capped).
  const CORE_CELL_MIN_W = 130;
  const CORE_GAP = 8;
  const coreCols = Math.max(
    1,
    Math.floor(
      (paneSize.w - 24 - 34 + CORE_GAP) / (CORE_CELL_MIN_W + CORE_GAP),
    ),
  );
  const coreRows = Math.ceil(coreUsage.length / coreCols);
  // Section chrome: border + vertical padding + heading.
  const coreSpace = paneSize.h - otherHeight - 54 - 4;
  const coreCellH = Math.min(
    140,
    Math.floor((coreSpace - (coreRows - 1) * CORE_GAP) / Math.max(1, coreRows)),
  );
  const coreCharts =
    layout !== "compact" &&
    layout !== "tiny" &&
    otherHeight > 0 &&
    coreUsage.length > 0 &&
    coreCellH >= 52;

  const cores =
    coreUsage.length === 0 ? (
      <Empty>Collecting first delta…</Empty>
    ) : coreCharts ? (
      <div
        className="grid"
        style={{
          gap: CORE_GAP,
          gridTemplateColumns: `repeat(${coreCols}, minmax(0, 1fr))`,
        }}
        title="Per-core usage, 0–100%"
      >
        {coreUsage.map((c) => (
          <div
            key={c.core}
            className="flex flex-col rounded-md bg-(--color-bg) px-2 pt-1 pb-1.5"
            style={{ height: coreCellH }}
          >
            <div className="flex items-baseline justify-between font-mono text-xs">
              <span className="text-(--color-fg-muted)">core {c.core}</span>
              <span className="font-semibold tabular-nums">
                {c.percent.toFixed(0)}%
              </span>
            </div>
            <div className="mt-1 min-h-0 flex-1">
              <AreaChart
                data={perCoreHistory.current.get(c.core) ?? []}
                max={100}
                color={
                  c.percent > 85
                    ? "var(--color-error)"
                    : c.percent > 60
                      ? "var(--color-warn)"
                      : "var(--color-accent)"
                }
              />
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div
        className={`grid gap-y-1 ${
          compact
            ? "grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-3"
            : "grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-4"
        }`}
      >
        {coreUsage.map((c) => (
          <div
            key={c.core}
            className={`flex items-center gap-2 font-mono ${compact ? "text-xs" : "text-sm"}`}
          >
            <span className="w-5 shrink-0 text-right text-(--color-fg-muted)">
              {c.core}
            </span>
            <div className="flex-1">
              <UsageBar percent={c.percent} />
            </div>
            <span className="w-9 shrink-0 text-right tabular-nums">
              {c.percent.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    );

  const netRows = visibleNet.map((r) => (
    <NetRow
      key={r.name}
      rate={r}
      history={netRateHistory.current.get(r.name)}
      tick={tick}
      compact={compact}
    />
  ));

  const diskRows = disks.map((d) => (
    <Line key={d.mount} compact={compact}>
      <span className="w-24 shrink-0 truncate font-mono" title={d.mount}>
        {d.mount}
      </span>
      <div className="flex-1">
        <UsageBar percent={d.usePercent} />
      </div>
      <span className="shrink-0 font-mono tabular-nums text-(--color-fg-muted)">
        {d.used}/{d.total}
      </span>
      <span className="w-9 shrink-0 text-right font-mono tabular-nums">
        {d.usePercent.toFixed(0)}%
      </span>
    </Line>
  ));

  const dimmBlock = (dimms || dimmError) && (
    <Section title="Memory chips" flat={compact}>
      {dimmError && (
        <div className="rounded bg-(--color-error)/10 px-2 py-1 text-xs text-(--color-error)">
          {dimmError}
        </div>
      )}
      {dimms && dimms.length === 0 && !dimmError && (
        <Empty>No populated DIMM slots reported.</Empty>
      )}
      {dimms && dimms.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] uppercase text-(--color-fg-muted)">
              <th className="pr-2 font-normal">Slot</th>
              <th className="pr-2 font-normal">Size</th>
              <th className="pr-2 font-normal">Type</th>
              <th className="pr-2 font-normal">Speed</th>
              <th className="pr-2 font-normal">Manufacturer</th>
              <th className="font-normal">Part</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {dimms.map((d, i) => (
              <tr key={`${d.locator}-${i}`}>
                <td className="pr-2">{d.locator}</td>
                <td className="pr-2 font-semibold">{d.size}</td>
                <td className="pr-2">{d.kind}</td>
                <td className="pr-2">{d.speed}</td>
                <td className="truncate pr-2 font-sans">{d.manufacturer}</td>
                <td className="truncate">{d.partNumber}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );

  // ── Tiny pane: just the four meters and one status line ──
  if (layout === "tiny") {
    return (
      <div ref={measureRef} className="fade-up h-full overflow-y-auto">
        <div className="flex min-h-full flex-col gap-1.5 p-2">
          <div className="flex flex-1 flex-col gap-1">
            {stats.map((s) => (
              <Meter key={s.key} item={s} tick={tick} brief />
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-(--color-fg-muted)">
            <span className="min-w-0 truncate">
              Load{" "}
              <span className="font-mono text-(--color-fg) tabular-nums">
                {snap.load.one.toFixed(2)}
              </span>
              {" · "}Up{" "}
              <span className="font-mono text-(--color-fg)">
                {formatUptime(snap.uptimeSeconds)}
              </span>
            </span>
            {error && (
              <span className="text-(--color-error)" title={error}>
                ⚠
              </span>
            )}
            <div className="ml-auto">{controls}</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Small pane: dense htop-style list, no cards ──
  if (layout === "compact") {
    return (
      <div ref={measureRef} className="fade-up h-full overflow-y-auto">
        <div className="flex min-h-full flex-col gap-2 p-2">
          {/* Meters absorb any leftover height so the pane is never half empty. */}
          <div className="flex flex-1 flex-col gap-1">
            {stats.map((s) => (
              <Meter key={s.key} item={s} tick={tick} brief={narrow} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-(--color-fg-muted)">
            {info}
            <div className="ml-auto">{controls}</div>
          </div>
          <Section title="Cores" flat>
            {cores}
          </Section>
          {netRows.length > 0 && (
            <Section title="Network" flat>
              {netRows}
            </Section>
          )}
          {diskRows.length > 0 && (
            <Section title="Disks" flat>
              {diskRows}
            </Section>
          )}
          {dimmBlock}
        </div>
      </div>
    );
  }

  // ── Medium / large pane: cards. Tall panes get slightly taller charts and
  // bigger numbers. ──
  const large = layout === "large";
  const cards = stats
    .filter((s) => !s.secondaryOf)
    .map((s) => ({
      ...s,
      secondary: stats.find((x) => x.secondaryOf === s.key),
    }));
  // Balance the grid: as many columns as fit, then even out the rows so a
  // lone card never sits next to empty slots; any remainder widens the last.
  const maxCols = Math.max(1, Math.floor((paneSize.w - 12) / 202));
  const rows = Math.ceil(cards.length / Math.min(cards.length, maxCols));
  const cols = Math.ceil(cards.length / rows);
  const lastSpan = rows * cols - cards.length + 1;
  return (
    <div ref={measureRef} className="fade-up h-full overflow-y-auto">
      <div ref={contentRef} className="space-y-3 p-3">
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {cards.map((s, i) => (
            <div
              key={s.key}
              className="flex min-w-0"
              style={
                i === cards.length - 1 && lastSpan > 1
                  ? { gridColumn: `span ${lastSpan}` }
                  : undefined
              }
            >
              <StatCard item={s} large={large} intervalMs={intervalMs} />
            </div>
          ))}
        </div>

        <div
          className={`${CARD} flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 text-sm text-(--color-fg-muted)`}
        >
          {info}
          <div className="ml-auto">{controls}</div>
        </div>

        <Section title="Cores" sectionRef={coresRef}>
          {cores}
        </Section>

        {(netRows.length > 0 || diskRows.length > 0) && (
          <div className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(340px,1fr))] gap-3">
            {netRows.length > 0 && <Section title="Network">{netRows}</Section>}
            {diskRows.length > 0 && <Section title="Disks">{diskRows}</Section>}
          </div>
        )}

        {dimmBlock}
      </div>
    </div>
  );
}

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Card surface — same flat look as the app's other panels. */
const CARD = "rounded-lg border border-(--color-border) bg-(--color-surface)";

interface StatItem {
  key: string;
  title: string;
  /** Label for the compact meter row. */
  short: string;
  subtitle?: string;
  percent: number | null;
  history?: number[];
  color: string;
  detail?: string;
  /** Very short detail for narrow / tiny layouts. */
  brief?: string;
  error?: string | null;
  /** Card layouts fold this item into the card with this key. */
  secondaryOf?: string;
  /** Folded-in item shown as a second bar inside the card. */
  secondary?: StatItem;
}

function formatPercent(p: number | null): string {
  return p != null ? `${p.toFixed(p < 10 ? 1 : 0)}%` : "—";
}

/** Headline card: title, big value, trend vs recent average, area chart. */
function StatCard({
  item,
  large,
  intervalMs,
}: {
  item: StatItem;
  large: boolean;
  intervalMs: number;
}) {
  const { title, subtitle, percent, history, color, detail, error, secondary } =
    item;
  // Trend: current value vs the average of the visible history window.
  const avg =
    history && history.length > 2
      ? history.slice(0, -1).reduce((a, b) => a + b, 0) / (history.length - 1)
      : null;
  const delta = percent != null && avg != null ? percent - avg : null;
  const rising = delta != null && delta > 0.5;
  const falling = delta != null && delta < -0.5;

  return (
    <div className={`${CARD} flex min-w-0 flex-1 flex-col overflow-hidden`}>
      <div className="px-4 pt-3">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="shrink-0 whitespace-nowrap text-sm font-semibold">
            {title}
          </span>
          {subtitle && (
            <span
              className="min-w-0 truncate text-xs text-(--color-fg-muted)"
              title={subtitle}
            >
              {subtitle}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-end justify-between gap-2">
          <span
            className={`font-bold tabular-nums leading-none ${large ? "text-3xl" : "text-2xl"}`}
          >
            {formatPercent(percent)}
          </span>
          {delta != null && (
            <span
              className={`shrink-0 text-xs font-medium tabular-nums ${
                rising
                  ? "text-(--color-warn)"
                  : falling
                    ? "text-(--color-online)"
                    : "text-(--color-fg-muted)"
              }`}
              title="Change vs average of the chart window"
            >
              {rising ? "↗" : falling ? "↘" : "→"} {Math.abs(delta).toFixed(1)}
              <span className="font-normal text-(--color-fg-muted)">
                {" "}
                vs avg
              </span>
            </span>
          )}
        </div>
        {error ? (
          <div
            className="mt-1 line-clamp-2 text-xs text-(--color-error)"
            title={error}
          >
            {error}
          </div>
        ) : (
          detail && (
            <div
              className="mt-1 truncate text-xs text-(--color-fg-muted)"
              title={detail}
            >
              {detail}
            </div>
          )
        )}
        {secondary && (
          <div
            className="mt-2 flex items-center gap-2 text-xs"
            title={secondary.detail}
          >
            <span className="w-10 shrink-0 text-(--color-fg-muted)">
              {secondary.title.split(" ")[0]}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-(--color-surface-2)">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(secondary.percent ?? 0, 100)}%`,
                  background: secondary.color,
                }}
              />
            </div>
            <span className="shrink-0 font-mono font-semibold tabular-nums">
              {formatPercent(secondary.percent)}
            </span>
            <span className="shrink-0 text-(--color-fg-muted)">
              {secondary.brief}
            </span>
          </div>
        )}
      </div>
      {/* Fixed chart height: tall enough to read, never stretched. */}
      <div className={`mt-1 flex flex-col ${large ? "h-24" : "h-20"}`}>
        {history && history.length > 1 ? (
          <div className="flex flex-1 flex-col px-4 pb-2">
            {/* Y axis (0–100%) on the left, plot area with gridlines. */}
            <div className="relative my-1.5 flex-1">
              {[100, 50, 0].map((v) => (
                <span
                  key={v}
                  className="absolute left-0 w-8 -translate-y-1/2 text-right text-[10px] leading-none tabular-nums text-(--color-fg-muted)"
                  style={{ top: `${100 - v}%` }}
                >
                  {v}%
                </span>
              ))}
              <div className="absolute inset-y-0 right-0 left-10">
                <AreaChart data={history} max={100} color={color} />
              </div>
            </div>
            {/* X axis: how far back the window reaches. */}
            <div className="flex justify-between pl-10 text-[10px] leading-none text-(--color-fg-muted)">
              <span>−{formatDuration((history.length - 1) * intervalMs)}</span>
              <span>now</span>
            </div>
          </div>
        ) : (
          percent != null && (
            <div className="flex h-full items-end px-4 pb-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-(--color-surface-2)">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(percent, 100)}%`,
                    background: color,
                  }}
                />
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** Compact-mode row: label, live sparkline over a usage fill, value, detail. */
function Meter({
  item,
  tick,
  brief: useBrief,
}: {
  item: StatItem;
  tick: number;
  /** Show the short detail (narrow / tiny panes). */
  brief?: boolean;
}) {
  const { short, subtitle, percent, history, color, detail, brief, error } =
    item;
  return (
    <div
      className="flex max-h-8 min-h-5 flex-1 items-center gap-2 text-xs"
      title={subtitle}
    >
      <span className="w-10 shrink-0 text-[11px] uppercase tracking-wide text-(--color-fg-muted)">
        {short}
      </span>
      <div className="relative min-h-4 min-w-12 flex-1 self-stretch overflow-hidden rounded-sm bg-(--color-surface)">
        <div
          className="absolute inset-y-0 left-0 opacity-25"
          style={{
            width: `${Math.min(percent ?? 0, 100)}%`,
            background: color,
          }}
        />
        {history && (
          <div className="absolute inset-0">
            <Sparkline
              data={history}
              max={100}
              stroke={color}
              key={`${short}-${tick}`}
            />
          </div>
        )}
      </div>
      <span className="w-11 shrink-0 text-right font-mono font-semibold tabular-nums">
        {formatPercent(percent)}
      </span>
      <span
        className={`shrink-0 truncate ${useBrief ? "w-16" : "w-28"} ${error ? "text-(--color-error)" : "text-(--color-fg-muted)"}`}
        title={error ?? detail}
      >
        {error ? (useBrief ? "error" : error) : useBrief ? brief : detail}
      </span>
    </div>
  );
}

/** Smooth area chart with a fading gradient fill, edge to edge. */
function AreaChart({
  data,
  max,
  color,
}: {
  data: number[];
  max: number;
  color: string;
}) {
  const gradientId = useId();
  if (data.length < 2) return null;
  const w = 200;
  const h = 48;
  const safeMax = max > 0 ? max : 1;
  // Stretch whatever history we have across the full width.
  const stepX = w / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [
    i * stepX,
    h - (Math.min(Math.max(v, 0), safeMax) / safeMax) * h,
  ]);
  // Catmull-Rom → cubic Bézier for a smooth line.
  let line = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    line += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block h-full w-full overflow-visible"
    >
      {[0, h / 2, h].map((y) => (
        <line
          key={y}
          x1="0"
          x2={w}
          y1={y}
          y2={y}
          stroke="var(--color-fg-muted)"
          strokeOpacity="0.2"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Section({
  title,
  flat,
  sectionRef,
  children,
}: {
  title: string;
  /** Compact mode: no card chrome, small uppercase heading. */
  flat?: boolean;
  sectionRef?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}) {
  if (flat) {
    return (
      <section className="min-w-0">
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-(--color-fg-muted)">
          {title}
        </h3>
        <div className="space-y-0.5">{children}</div>
      </section>
    );
  }
  return (
    <section ref={sectionRef} className={`${CARD} min-w-0 shrink-0 px-4 py-3`}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Line({
  compact,
  children,
}: {
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-2 ${compact ? "h-5 text-xs" : "h-6 text-sm"}`}
    >
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-(--color-fg-muted)">{children}</div>;
}

function UsageBar({ percent }: { percent: number }) {
  const color =
    percent > 90
      ? "bg-(--color-error)"
      : percent > 75
        ? "bg-(--color-warn)"
        : "bg-(--color-accent)";
  return (
    <div className="h-2 overflow-hidden rounded bg-(--color-surface-2)">
      <div
        className={`h-full disk-bar ${color}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}

function NetRow({
  rate,
  history,
  tick,
  compact,
}: {
  rate: NetRate;
  history?: { rx: number[]; tx: number[] };
  tick: number;
  compact?: boolean;
}) {
  const max = history ? Math.max(1, ...history.rx, ...history.tx) : 1;
  return (
    <Line compact={compact}>
      <span className="w-24 shrink-0 truncate font-mono" title={rate.name}>
        {rate.name}
      </span>
      <div
        className="relative h-4 flex-1"
        title={`Scale: 0 – ${formatBytesPerSec(max)} (peak in window)`}
      >
        {history && (
          <>
            {!compact && (
              <span className="absolute -top-2 left-0 z-10 rounded-sm bg-(--color-surface) px-0.5 text-[10px] leading-none whitespace-nowrap text-(--color-fg-muted)">
                peak {formatBytesPerSec(max)}
              </span>
            )}
            <div className="absolute inset-0">
              <Sparkline
                data={history.rx}
                max={max}
                stroke="var(--color-online)"
                key={`rx-${rate.name}-${tick}`}
              />
            </div>
            <div className="absolute inset-0">
              <Sparkline
                data={history.tx}
                max={max}
                stroke="var(--color-accent)"
                key={`tx-${rate.name}-${tick}`}
              />
            </div>
          </>
        )}
      </div>
      <span
        className="w-24 shrink-0 whitespace-nowrap text-right font-mono tabular-nums"
        title="Download"
      >
        <span className="text-(--color-online)">↓</span>
        {formatBytesPerSec(rate.rxBps)}
      </span>
      <span
        className="w-24 shrink-0 whitespace-nowrap text-right font-mono tabular-nums"
        title="Upload"
      >
        <span className="text-(--color-accent)">↑</span>
        {formatBytesPerSec(rate.txBps)}
      </span>
    </Line>
  );
}

function Sparkline({
  data,
  max,
  stroke = "var(--color-accent)",
}: {
  data: number[];
  max: number;
  stroke?: string;
}) {
  if (data.length < 2) return null;
  const w = 200;
  const h = 40;
  // Stretch whatever history we have across the full width.
  const stepX = w / Math.max(1, data.length - 1);
  const safeMax = max > 0 ? max : 1;
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - (Math.min(v, safeMax) / safeMax) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
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

// ─── Formatters ──────────────────────────────────────────────────────────────

function tempColor(c: number): string {
  return c >= 85
    ? "text-(--color-error)"
    : c >= 70
      ? "text-(--color-warn)"
      : "";
}

function gpuDetail(g: GpuInfo): string {
  const parts: string[] = [];
  // Dedicated VRAM gets its own meter; unified memory (Apple) has no total,
  // so show what's in use here instead.
  if (g.memoryUsedMb != null && !g.memoryTotalMb) {
    parts.push(`${formatMb(g.memoryUsedMb)} shared`);
  }
  if (g.temperatureC != null) parts.push(`${g.temperatureC.toFixed(0)}°C`);
  if (g.powerW != null) parts.push(`${g.powerW.toFixed(0)} W`);
  return parts.join(" · ") || g.name;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${mb} MiB`;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytesPerSec(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps < 1024 * 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  return `${(bps / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}
