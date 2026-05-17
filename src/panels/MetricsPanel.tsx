import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type {
  CpuCoreTicks,
  CpuInfo,
  DimmModule,
  MetricsSnapshot,
} from "../lib/api";
import { withSudo } from "../lib/with-sudo";
import { SkeletonCard } from "../components/Skeleton";

interface Props {
  deviceId: string;
}

const HISTORY = 60;
const POLL_MS = 2000;

interface CoreUsage {
  core: number;
  percent: number;
}

interface NetRate {
  name: string;
  rxBps: number;
  txBps: number;
}

export function MetricsPanel({ deviceId }: Props) {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cpuInfo, setCpuInfo] = useState<CpuInfo | null>(null);
  const [dimms, setDimms] = useState<DimmModule[] | null>(null);
  const [dimmError, setDimmError] = useState<string | null>(null);
  const [loadingDimms, setLoadingDimms] = useState(false);

  // History buffers (rolling sparkline data)
  const overallCpuHistory = useRef<number[]>([]);
  const memHistory = useRef<number[]>([]);
  const perCoreHistory = useRef<Map<number, number[]>>(new Map());
  const netRateHistory = useRef<Map<string, { rx: number[]; tx: number[] }>>(
    new Map(),
  );
  const [tick, setTick] = useState(0);

  // Previous raw values for delta computation
  const prevCores = useRef<Map<number, CpuCoreTicks>>(new Map());
  const prevNet = useRef<Map<string, { rx: number; tx: number; ts: number }>>(
    new Map(),
  );

  const [coreUsage, setCoreUsage] = useState<CoreUsage[]>([]);
  const [netRates, setNetRates] = useState<NetRate[]>([]);

  const poll = useCallback(async () => {
    try {
      const s = await withSudo(deviceId, () => api.metricsSnapshot(deviceId));

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
          buf.push(pct);
          if (buf.length > HISTORY) buf.shift();
          perCoreHistory.current.set(c.core, buf);
        }
        prevCores.current.set(c.core, c);
      }
      setCoreUsage(usage);

      // ─ overall CPU (avg of cores) ─
      const overall =
        usage.length > 0
          ? usage.reduce((acc, u) => acc + u.percent, 0) / usage.length
          : 0;
      overallCpuHistory.current.push(overall);
      if (overallCpuHistory.current.length > HISTORY)
        overallCpuHistory.current.shift();

      // ─ memory % history ─
      const memPct =
        s.mem.totalMb > 0 ? (s.mem.usedMb / s.mem.totalMb) * 100 : 0;
      memHistory.current.push(memPct);
      if (memHistory.current.length > HISTORY) memHistory.current.shift();

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
          buf.rx.push(rxBps);
          buf.tx.push(txBps);
          if (buf.rx.length > HISTORY) buf.rx.shift();
          if (buf.tx.length > HISTORY) buf.tx.shift();
          netRateHistory.current.set(n.name, buf);
        }
        prevNet.current.set(n.name, {
          rx: n.rxBytes,
          tx: n.txBytes,
          ts: nowTs,
        });
      }
      setNetRates(rates);

      setSnap(s);
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [deviceId]);

  useEffect(() => {
    overallCpuHistory.current = [];
    memHistory.current = [];
    perCoreHistory.current = new Map();
    netRateHistory.current = new Map();
    prevCores.current = new Map();
    prevNet.current = new Map();
    setCpuInfo(null);
    setDimms(null);
    setDimmError(null);
    void poll();
    const t = setInterval(poll, POLL_MS);
    void api
      .cpuInfo(deviceId)
      .then(setCpuInfo)
      .catch(() => {
        // best-effort
      });
    return () => clearInterval(t);
  }, [poll, deviceId]);

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

  if (error && !snap) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-(--color-error)">
        Could not read metrics: {error}
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="space-y-4 p-6">
        <div className="grid grid-cols-2 gap-4">
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

  return (
    <div className="fade-up h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        {/* ─── Top row: CPU summary + Memory + Swap ─── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card
            title="CPU"
            value={`${overall.toFixed(1)}%`}
            sub={
              cpuInfo
                ? `${cpuInfo.logicalCores} threads · ${cpuInfo.mhz.toFixed(0)} MHz`
                : undefined
            }
          >
            <Sparkline
              data={overallCpuHistory.current}
              max={100}
              key={`cpu-${tick}`}
            />
          </Card>
          <Card
            title="Memory"
            value={`${(snap.mem.usedMb / 1024).toFixed(1)} / ${(snap.mem.totalMb / 1024).toFixed(1)} GiB`}
            sub={
              snap.mem.totalMb
                ? `${((snap.mem.usedMb / snap.mem.totalMb) * 100).toFixed(1)}%`
                : undefined
            }
          >
            <Sparkline data={memHistory.current} max={100} key={`mem-${tick}`} />
          </Card>
          <Card
            title="Swap"
            value={
              snap.swap.totalMb > 0
                ? `${snap.swap.usedMb} / ${snap.swap.totalMb} MiB`
                : "—"
            }
            sub={
              snap.swap.totalMb > 0
                ? `${((snap.swap.usedMb / snap.swap.totalMb) * 100).toFixed(1)}%`
                : "No swap configured"
            }
          >
            {snap.swap.totalMb > 0 && (
              <UsageBar
                percent={(snap.swap.usedMb / snap.swap.totalMb) * 100}
              />
            )}
          </Card>
        </div>

        {/* ─── Per-core CPU grid ─── */}
        <Section
          title="Per-core CPU"
          right={
            cpuInfo && (
              <span className="text-xs text-(--color-fg-muted)">
                {cpuInfo.physicalCores} cores / {cpuInfo.logicalCores} threads
              </span>
            )
          }
        >
          {coreUsage.length === 0 ? (
            <div className="rounded border border-(--color-border) bg-(--color-surface) p-4 text-center text-xs text-(--color-fg-muted)">
              Collecting first delta…
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {coreUsage.map((c) => (
                <CoreCard
                  key={c.core}
                  core={c.core}
                  percent={c.percent}
                  history={perCoreHistory.current.get(c.core) ?? []}
                  tick={tick}
                />
              ))}
            </div>
          )}
        </Section>

        {/* ─── System overview row ─── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <InfoCard
            title="Load average"
            rows={[
              ["1 min", snap.load.one.toFixed(2)],
              ["5 min", snap.load.five.toFixed(2)],
              ["15 min", snap.load.fifteen.toFixed(2)],
            ]}
          />
          <InfoCard
            title="System"
            rows={[
              ["Uptime", formatUptime(snap.uptimeSeconds)],
              ["Processes", String(snap.processes.total)],
              ["Running", String(snap.processes.running)],
            ]}
          />
          {cpuInfo && (
            <InfoCard
              title="CPU info"
              rows={[
                ["Model", cpuInfo.model || "—"],
                ["Vendor", cpuInfo.vendor || "—"],
                ["Cache", cpuInfo.cacheKb ? `${cpuInfo.cacheKb} KB` : "—"],
                ["Governor", cpuInfo.governor ?? "—"],
                ["Arch", cpuInfo.architecture || "—"],
              ]}
            />
          )}
        </div>

        {/* ─── Temperatures (if available) ─── */}
        {snap.temperatures.length > 0 && (
          <Section title="Temperatures">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {snap.temperatures.map((t) => (
                <div
                  key={t.name}
                  className="rounded border border-(--color-border) bg-(--color-surface) p-3 text-xs"
                >
                  <div className="truncate font-mono text-[10px] text-(--color-fg-muted)">
                    {t.name}
                  </div>
                  <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
                    {t.celsius.toFixed(1)}°C
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ─── Network ─── */}
        {netRates.length > 0 && (
          <Section title="Network">
            <div className="space-y-2">
              {netRates
                .filter((r) => r.name !== "lo")
                .map((r) => {
                  const history = netRateHistory.current.get(r.name);
                  return (
                    <NetRow
                      key={r.name}
                      rate={r}
                      history={history}
                      tick={tick}
                    />
                  );
                })}
            </div>
          </Section>
        )}

        {/* ─── Disks ─── */}
        <Section title="Disks">
          <div className="space-y-2">
            {snap.disks.map((d) => (
              <div
                key={d.mount}
                className="rounded border border-(--color-border) bg-(--color-surface) p-3 text-xs"
              >
                <div className="flex justify-between">
                  <span className="font-mono">{d.mount}</span>
                  <span className="text-(--color-fg-muted)">
                    {d.used} / {d.total}
                  </span>
                </div>
                <UsageBar percent={d.usePercent} />
              </div>
            ))}
          </div>
        </Section>

        {/* ─── Memory chips (DIMMs) ─── */}
        <Section
          title="Memory chips"
          right={
            <button
              onClick={() => void loadDimms()}
              disabled={loadingDimms}
              className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2) disabled:opacity-50"
            >
              {loadingDimms
                ? "Loading…"
                : dimms
                  ? "Reload (sudo)"
                  : "Show DIMMs (sudo)"}
            </button>
          }
        >
          {dimmError && (
            <div className="rounded border border-(--color-border) bg-(--color-error)/10 p-3 text-xs text-(--color-error)">
              {dimmError}
            </div>
          )}
          {dimms === null && !dimmError && (
            <div className="rounded border border-dashed border-(--color-border) bg-(--color-surface) p-3 text-center text-xs text-(--color-fg-muted)">
              DIMM details require root (calls{" "}
              <span className="font-mono">dmidecode -t memory</span>). Click
              &quot;Show DIMMs&quot; — you&apos;ll be prompted for sudo.
            </div>
          )}
          {dimms && dimms.length === 0 && !dimmError && (
            <div className="rounded border border-(--color-border) bg-(--color-surface) p-3 text-center text-xs text-(--color-fg-muted)">
              No populated DIMM slots reported.
            </div>
          )}
          {dimms && dimms.length > 0 && (
            <div className="overflow-hidden rounded border border-(--color-border)">
              <table className="w-full text-xs">
                <thead className="bg-(--color-surface)">
                  <tr className="text-left text-[10px] uppercase text-(--color-fg-muted)">
                    <th className="px-3 py-2">Slot</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Speed</th>
                    <th className="px-3 py-2">Manufacturer</th>
                    <th className="px-3 py-2">Part</th>
                  </tr>
                </thead>
                <tbody>
                  {dimms.map((d, i) => (
                    <tr
                      key={`${d.locator}-${i}`}
                      className="border-t border-(--color-border) bg-(--color-bg)"
                    >
                      <td className="px-3 py-1.5 font-mono">{d.locator}</td>
                      <td className="px-3 py-1.5 font-mono font-semibold">
                        {d.size}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{d.kind}</td>
                      <td className="px-3 py-1.5 font-mono">{d.speed}</td>
                      <td className="px-3 py-1.5 truncate">{d.manufacturer}</td>
                      <td className="px-3 py-1.5 truncate font-mono">
                        {d.partNumber}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}

// ─── Cards & primitives ──────────────────────────────────────────────────────

function Card({
  title,
  value,
  sub,
  children,
}: {
  title: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <div className="text-xs uppercase tracking-wide text-(--color-fg-muted)">
        {title}
      </div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">
        {value}
      </div>
      {sub && <div className="text-xs text-(--color-fg-muted)">{sub}</div>}
      <div className="mt-3 h-12">{children}</div>
    </div>
  );
}

function InfoCard({
  title,
  rows,
}: {
  title: string;
  rows: [string, string][];
}) {
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-(--color-fg-muted)">
        {title}
      </div>
      <dl className="space-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0 text-(--color-fg-muted)">{k}</dt>
            <dd className="truncate text-right font-mono" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
          {title}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function UsageBar({ percent }: { percent: number }) {
  const color =
    percent > 90
      ? "bg-(--color-error)"
      : percent > 75
        ? "bg-(--color-warn)"
        : "bg-(--color-accent)";
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded bg-(--color-surface-2)">
      <div
        className={`h-full disk-bar ${color}`}
        style={{ width: `${Math.min(percent, 100)}%` }}
      />
    </div>
  );
}

function CoreCard({
  core,
  percent,
  history,
  tick,
}: {
  core: number;
  percent: number;
  history: number[];
  tick: number;
}) {
  const color =
    percent > 85
      ? "var(--color-error)"
      : percent > 60
        ? "var(--color-warn)"
        : "var(--color-accent)";
  return (
    <div className="rounded border border-(--color-border) bg-(--color-surface) p-2.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] text-(--color-fg-muted)">
          core {core}
        </span>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {percent.toFixed(0)}%
        </span>
      </div>
      <div className="mt-1 h-8">
        <Sparkline data={history} max={100} stroke={color} key={`c${core}-${tick}`} />
      </div>
    </div>
  );
}

function NetRow({
  rate,
  history,
  tick,
}: {
  rate: NetRate;
  history?: { rx: number[]; tx: number[] };
  tick: number;
}) {
  return (
    <div className="rounded border border-(--color-border) bg-(--color-surface) p-3 text-xs">
      <div className="flex items-baseline justify-between">
        <span className="font-mono font-medium">{rate.name}</span>
        <span className="flex gap-3 font-mono tabular-nums">
          <span title="Download">
            <span className="text-(--color-fg-muted)">↓</span>{" "}
            {formatBytesPerSec(rate.rxBps)}
          </span>
          <span title="Upload">
            <span className="text-(--color-fg-muted)">↑</span>{" "}
            {formatBytesPerSec(rate.txBps)}
          </span>
        </span>
      </div>
      {history && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="h-8">
            <Sparkline
              data={history.rx}
              max={Math.max(1, ...history.rx, ...history.tx)}
              stroke="var(--color-online)"
              key={`rx-${rate.name}-${tick}`}
            />
          </div>
          <div className="h-8">
            <Sparkline
              data={history.tx}
              max={Math.max(1, ...history.rx, ...history.tx)}
              stroke="var(--color-accent)"
              key={`tx-${rate.name}-${tick}`}
            />
          </div>
        </div>
      )}
    </div>
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
  if (data.length < 2) {
    return (
      <div className="flex h-full items-center text-[10px] text-(--color-fg-muted)">
        …
      </div>
    );
  }
  const w = 200;
  const h = 40;
  const stepX = w / (HISTORY - 1);
  const safeMax = max > 0 ? max : 1;
  const points = data
    .map((v, i) => {
      const x = (i + (HISTORY - data.length)) * stepX;
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
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytesPerSec(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps < 1024 * 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  return `${(bps / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}

