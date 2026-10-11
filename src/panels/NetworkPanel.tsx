import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Gauge, Pause, Play, Plus, Square, Trash2, X } from "lucide-react";
import {
  cancelSpeedTest,
  clearPingHistory,
  configurePing,
  getNetSession,
  isRunning,
  pingStats,
  readSpeedHistory,
  runSpeedTest,
  subscribeNetSession,
  type NetSession,
  type PingSeries,
  type SpeedResult,
  type SpeedRun,
} from "../lib/net-sessions";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN, segBtn } from "../lib/ui";
import { useElementSize } from "../lib/use-element-size";
import {
  usePaneSettings,
  usePaneSettingsStore,
} from "../store/pane-settings-store";
import { toast } from "../components/Toast";

interface Props {
  deviceId: string;
  paneId: string;
}

type View = "ping" | "speed";

interface NetSettings {
  hosts: string[];
  intervalMs: number;
  paused: boolean;
  view: View;
}

const DEFAULTS: NetSettings = {
  hosts: ["1.1.1.1", "8.8.8.8", "google.com"],
  intervalMs: 2000,
  paused: false,
  view: "ping",
};

const INTERVALS = [1000, 2000, 5000, 10000];
/** Bars shown per ping chart; older samples still count in the stats. */
const CHART_SAMPLES = 120;
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;

export function NetworkPanel({ deviceId, paneId }: Props) {
  const [settings, update] = usePaneSettings<NetSettings>(paneId, DEFAULTS);
  const { hosts, intervalMs, paused, view } = settings;

  const session = getNetSession(paneId, deviceId);
  useSyncExternalStore(
    (fn) => subscribeNetSession(session, fn),
    () => session.version,
  );

  const hostsKey = hosts.join("\n");
  useEffect(() => {
    configurePing(session, {
      hosts: hostsKey ? hostsKey.split("\n") : [],
      intervalMs,
      paused,
    });
  }, [session, hostsKey, intervalMs, paused]);

  const history = readSpeedHistory(
    usePaneSettingsStore((s) => s.byPaneId[paneId]),
  );

  const [measureRef, size] = useElementSize();
  const measured = size.w > 0;
  const tiny = measured && (size.w < 340 || size.h < 190);
  const split = measured && !tiny && size.w >= 760;

  const addHost = (raw: string): boolean => {
    const h = raw.trim();
    if (!h) return false;
    if (!HOST_RE.test(h) || h.startsWith("-")) {
      toast.error(`Not a valid host: ${h}`);
      return false;
    }
    if (hosts.includes(h)) return true;
    if (hosts.length >= 16) {
      toast.error("At most 16 hosts");
      return false;
    }
    update({ hosts: [...hosts, h] });
    return true;
  };
  const removeHost = (h: string) =>
    update({ hosts: hosts.filter((x) => x !== h) });

  const ping = (
    <PingView
      session={session}
      hosts={hosts}
      intervalMs={intervalMs}
      paused={paused}
      tiny={tiny}
      onInterval={(ms) => update({ intervalMs: ms })}
      onPause={() => update({ paused: !paused })}
      onAdd={addHost}
      onRemove={removeHost}
    />
  );
  const speed = (
    <SpeedView
      session={session}
      history={history}
      tiny={tiny}
      onClearHistory={() =>
        usePaneSettingsStore.getState().patch(paneId, { speedHistory: [] })
      }
    />
  );

  return (
    <div ref={measureRef} className="fade-up flex h-full flex-col overflow-hidden">
      {!measured ? null : split ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">{ping}</div>
          <div className="flex w-[340px] shrink-0 flex-col border-l border-(--color-border)">
            {speed}
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1.5 border-b border-(--color-border) px-2 py-1 text-xs">
            <div className={BTN_GROUP}>
              <button
                onClick={() => update({ view: "ping" })}
                className={segBtn(view === "ping")}
              >
                Ping
              </button>
              <button
                onClick={() => update({ view: "speed" })}
                className={segBtn(view === "speed")}
              >
                Speed test
              </button>
            </div>
            <TabSummary session={session} view={view} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {view === "ping" ? ping : speed}
          </div>
        </>
      )}
    </div>
  );
}

/** What the hidden tab is doing, so it isn't out of sight, out of mind. */
function TabSummary({ session, view }: { session: NetSession; view: View }) {
  if (view === "ping") {
    const run = session.speed;
    if (!run || run.phase === "cancelled") return null;
    return (
      <span className="ml-auto truncate text-[11px] text-(--color-fg-muted)">
        {isRunning(run.phase)
          ? `Speed test: ${PHASE_LABEL[run.phase]}`
          : run.phase === "done"
            ? `↓ ${fmtMbps(run.downMbps)}  ↑ ${fmtMbps(run.upMbps)}`
            : null}
      </span>
    );
  }
  const worst = [...session.series.values()].reduce(
    (acc, s) => Math.max(acc, pingStats(s.rtts.slice(-30)).loss),
    0,
  );
  const lastAll = [...session.series.values()]
    .map((s) => s.rtts[s.rtts.length - 1])
    .filter((v): v is number => typeof v === "number");
  if (lastAll.length === 0) return null;
  return (
    <span className="ml-auto truncate text-[11px] text-(--color-fg-muted)">
      Ping {fmtMs(Math.min(...lastAll))}
      {worst > 0 && (
        <span className="text-(--color-error)"> · {worst.toFixed(0)}% loss</span>
      )}
    </span>
  );
}

// ─── Ping ────────────────────────────────────────────────────────────────────

function PingView({
  session,
  hosts,
  intervalMs,
  paused,
  tiny,
  onInterval,
  onPause,
  onAdd,
  onRemove,
}: {
  session: NetSession;
  hosts: string[];
  intervalMs: number;
  paused: boolean;
  tiny: boolean;
  onInterval: (ms: number) => void;
  onPause: () => void;
  onAdd: (host: string) => boolean;
  onRemove: (host: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [listRef, listSize] = useElementSize();
  // Stats go on their own line when they won't fit beside the host.
  const narrow = listSize.w > 0 && listSize.w < 640;

  const empty: PingSeries = { rtts: [], error: null };
  // Hand each host an equal share of the height for its chart.
  const rowChrome = narrow ? 52 : 34;
  const chartH = hosts.length
    ? Math.max(
        24,
        Math.min(96, Math.floor(listSize.h / hosts.length) - rowChrome),
      )
    : 0;

  const add = () => {
    if (onAdd(draft)) setDraft("");
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-(--color-border) px-2 py-1 text-xs">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add host or IP…"
          className={`${SMALL_INPUT} min-w-0 flex-1 ${tiny ? "" : "max-w-48"}`}
        />
        {!tiny && (
          <div className={BTN_GROUP}>
            <button onClick={add} className={TOOL_BTN} title="Add host">
              <Plus size={12} />
            </button>
          </div>
        )}
        <div className={`${BTN_GROUP} ${tiny ? "" : "ml-auto"}`}>
          {INTERVALS.map((ms) => (
            <button
              key={ms}
              onClick={() => onInterval(ms)}
              className={segBtn(intervalMs === ms)}
              title={`Ping every ${ms / 1000} s`}
            >
              {ms / 1000}s
            </button>
          ))}
        </div>
        <div className={BTN_GROUP}>
          <button
            onClick={onPause}
            className={TOOL_BTN}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>
          {!tiny && (
            <button
              onClick={() => clearPingHistory(session)}
              className={TOOL_BTN}
              title="Clear history"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {session.pingError && (
        <div className="shrink-0 truncate px-3 py-1 text-xs text-(--color-error)">
          {session.pingError}
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
        {hosts.length === 0 ? (
          <Msg>Add a host or IP to start monitoring.</Msg>
        ) : tiny ? (
          <ul>
            {hosts.map((h) => (
              <TinyPingRow
                key={h}
                host={h}
                series={session.series.get(h) ?? empty}
                onRemove={onRemove}
              />
            ))}
          </ul>
        ) : (
          <ul>
            {hosts.map((h) => (
              <PingRow
                key={h}
                host={h}
                series={session.series.get(h) ?? empty}
                narrow={narrow}
                chartH={chartH}
                intervalMs={intervalMs}
                onRemove={onRemove}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function PingRow({
  host,
  series,
  narrow,
  chartH,
  intervalMs,
  onRemove,
}: {
  host: string;
  series: PingSeries;
  narrow: boolean;
  chartH: number;
  intervalMs: number;
  onRemove: (h: string) => void;
}) {
  const st = useMemo(() => pingStats(series.rtts), [series.rtts]);
  const chartSamples = series.rtts.slice(-CHART_SAMPLES);
  const stats = (
    <>
      <Stat label="avg" value={fmtMs(st.avg)} />
      <Stat label="min" value={fmtMs(st.min)} />
      <Stat label="max" value={fmtMs(st.max)} />
      <Stat label="jitter" value={fmtMs(st.jitter)} />
      <Stat
        label="loss"
        value={st.sent ? `${st.loss.toFixed(st.loss % 1 ? 1 : 0)}%` : "—"}
        tone={st.loss > 0 ? "text-(--color-error)" : undefined}
      />
    </>
  );
  return (
    <li className="group border-b border-(--color-border) px-3 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <QualityDot rtt={st.last} sent={st.sent} />
        <span className="min-w-0 flex-1 truncate font-medium" title={host}>
          {host}
        </span>
        {!narrow && (
          <span className="flex shrink-0 items-center gap-3">{stats}</span>
        )}
        <span
          className={`w-16 shrink-0 text-right font-mono text-sm tabular-nums ${rttTone(st.last, st.sent)}`}
        >
          {st.sent === 0 ? "…" : st.last === null ? "lost" : fmtMs(st.last)}
        </span>
        <button
          onClick={() => onRemove(host)}
          className="shrink-0 rounded p-0.5 text-(--color-fg-muted) opacity-0 group-hover:opacity-100 hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          title="Stop monitoring"
        >
          <X size={12} />
        </button>
      </div>
      {narrow && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 pl-4 text-xs">{stats}</div>
      )}
      {series.error ? (
        <div className="mt-1 truncate pl-4 text-xs text-(--color-error)">
          {series.error}
        </div>
      ) : (
        <div className="mt-1">
          <PingChart
            samples={chartSamples}
            height={chartH}
            spanLabel={fmtSpan(CHART_SAMPLES * intervalMs)}
          />
        </div>
      )}
    </li>
  );
}

function TinyPingRow({
  host,
  series,
  onRemove,
}: {
  host: string;
  series: PingSeries;
  onRemove: (h: string) => void;
}) {
  const st = pingStats(series.rtts);
  return (
    <li className="group flex h-7 items-center gap-2 border-b border-(--color-border) px-2 text-xs">
      <QualityDot rtt={st.last} sent={st.sent} />
      <span className="min-w-0 flex-1 truncate" title={series.error ?? host}>
        {host}
      </span>
      {st.loss > 0 && (
        <span className="shrink-0 text-[11px] text-(--color-error)">
          {st.loss.toFixed(0)}%
        </span>
      )}
      <span
        className={`shrink-0 font-mono tabular-nums ${rttTone(st.last, st.sent)}`}
      >
        {series.error
          ? "error"
          : st.sent === 0
            ? "…"
            : st.last === null
              ? "lost"
              : fmtMs(st.last)}
      </span>
      <button
        onClick={() => onRemove(host)}
        className="hidden shrink-0 text-(--color-fg-muted) group-hover:block hover:text-(--color-fg)"
        title="Stop monitoring"
      >
        <X size={11} />
      </button>
    </li>
  );
}

/** RTT bars, newest on the right; lost packets are red full-height bars. */
function PingChart({
  samples,
  height,
  spanLabel,
}: {
  samples: (number | null)[];
  height: number;
  spanLabel: string;
}) {
  const ok = samples.filter((v): v is number => v !== null);
  const top = niceCeil(Math.max(10, ...ok) * 1.1);
  const w = CHART_SAMPLES;
  const offset = w - samples.length;
  return (
    <div
      className="flex gap-1.5"
      style={{ height }}
      title={`${spanLabel} · one bar per ping · red = lost`}
    >
      <div className="flex w-11 shrink-0 flex-col justify-between text-right text-[10px] leading-none text-(--color-fg-muted) tabular-nums">
        <span>{top} ms</span>
        {height >= 40 && <span>{spanLabel}</span>}
      </div>
      <svg
        viewBox={`0 0 ${w} 100`}
        preserveAspectRatio="none"
        className="block h-full min-w-0 flex-1"
      >
        {[0, 50, 100].map((y) => (
          <line
            key={y}
            x1="0"
            x2={w}
            y1={y}
            y2={y}
            stroke="var(--color-fg-muted)"
            strokeOpacity={y === 100 ? 0.35 : 0.18}
            strokeDasharray={y === 100 ? undefined : "3 3"}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {samples.map((v, i) => {
          const x = offset + i + 0.15;
          if (v === null) {
            return (
              <rect
                key={i}
                x={x}
                y={0}
                width={0.7}
                height={100}
                fill="var(--color-error)"
                fillOpacity={0.45}
              />
            );
          }
          const h = Math.max(2, (Math.min(v, top) / top) * 100);
          return (
            <rect
              key={i}
              x={x}
              y={100 - h}
              width={0.7}
              height={h}
              fill={rttColor(v)}
              fillOpacity={0.85}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ─── Speed test ──────────────────────────────────────────────────────────────

const PHASE_LABEL: Record<SpeedRun["phase"], string> = {
  latency: "measuring latency…",
  download: "testing download…",
  upload: "testing upload…",
  done: "done",
  error: "failed",
  cancelled: "stopped",
};

function SpeedView({
  session,
  history,
  tiny,
  onClearHistory,
}: {
  session: NetSession;
  history: SpeedResult[];
  tiny: boolean;
  onClearHistory: () => void;
}) {
  const run = session.speed;
  const running = isRunning(run?.phase);
  // Before the first run in this session, show the last saved result.
  const last = history[0];
  const down = run?.downMbps ?? (run ? null : (last?.downMbps ?? null));
  const up = run?.upMbps ?? (run ? null : (last?.upMbps ?? null));
  const latency = run?.probe?.latencyMs ?? (run ? null : (last?.latencyMs ?? null));
  const jitter = run?.probe?.jitterMs ?? (run ? null : (last?.jitterMs ?? null));
  const colo = run?.probe?.colo ?? (run ? null : (last?.colo ?? null));

  const startStop = (
    <button
      onClick={() =>
        running ? cancelSpeedTest(session) : void runSpeedTest(session)
      }
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${
        running
          ? "bg-(--color-surface) text-(--color-fg) hover:bg-(--color-surface-2)"
          : "bg-(--color-accent) text-(--color-accent-fg) hover:opacity-90"
      }`}
    >
      {running ? <Square size={11} /> : <Gauge size={13} />}
      {running ? "Stop" : run || last ? "Run again" : "Start test"}
    </button>
  );

  if (tiny) {
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 px-3 py-2 text-xs">
        <div className="flex items-baseline gap-3 tabular-nums">
          <span title="Download">
            <span className="text-(--color-accent)">↓</span> {fmtMbps(down)}
          </span>
          <span title="Upload">
            <span className="text-(--color-online)">↑</span> {fmtMbps(up)}
          </span>
          <span className="text-(--color-fg-muted)" title="Latency">
            {fmtMs(latency)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {startStop}
          <span className="min-w-0 truncate text-[11px] text-(--color-fg-muted)">
            {run ? (run.error ?? PHASE_LABEL[run.phase]) : ""}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="grid shrink-0 grid-cols-2 gap-2 p-3">
        <SpeedTile
          label="Download"
          arrow="↓"
          color="var(--color-accent)"
          value={down}
          samples={run?.down ?? []}
          active={run?.phase === "download"}
        />
        <SpeedTile
          label="Upload"
          arrow="↑"
          color="var(--color-online)"
          value={up}
          samples={run?.up ?? []}
          active={run?.phase === "upload"}
        />
        <div className="col-span-2 flex items-center gap-4 rounded-md bg-(--color-surface) px-3 py-2 text-xs">
          <Stat label="Latency" value={fmtMs(latency)} big />
          <Stat label="Jitter" value={fmtMs(jitter)} big />
          <span className="ml-auto truncate text-right text-[11px] text-(--color-fg-muted)">
            {colo ? `Cloudflare ${colo}` : ""}
            {run?.probe?.ip && (
              <span className="block font-mono">{run.probe.ip}</span>
            )}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        {startStop}
        <span
          className={`min-w-0 truncate text-xs ${run?.phase === "error" ? "text-(--color-error)" : "text-(--color-fg-muted)"}`}
          title={run?.error ?? undefined}
        >
          {run
            ? run.error ??
              `${PHASE_LABEL[run.phase]}${run.bytes ? ` · ${fmtBytes(run.bytes)} used` : ""}`
            : "Runs on this device with curl · uses ~100 MB+ on fast links"}
        </span>
      </div>

      <div className="flex shrink-0 items-center border-t border-(--color-border) px-3 py-1 text-[11px] text-(--color-fg-muted)">
        <span>History</span>
        {history.length > 0 && (
          <button
            onClick={onClearHistory}
            className="ml-auto rounded px-1 hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            Clear
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <div className="px-3 pb-3 text-xs text-(--color-fg-muted)">
          No tests yet.
        </div>
      ) : (
        <ul className="pb-1">
          {history.map((r) => (
            <li
              key={r.at}
              className="flex h-6 items-center gap-2 px-3 text-xs tabular-nums hover:bg-(--color-surface)"
            >
              <span className="min-w-0 flex-1 truncate text-(--color-fg-muted)">
                {fmtWhen(r.at)}
              </span>
              <span className="w-20 shrink-0 text-right">
                <span className="text-(--color-accent)">↓</span>{" "}
                {fmtMbps(r.downMbps)}
              </span>
              <span className="w-20 shrink-0 text-right">
                <span className="text-(--color-online)">↑</span>{" "}
                {fmtMbps(r.upMbps)}
              </span>
              <span className="w-12 shrink-0 text-right text-(--color-fg-muted)">
                {fmtMs(r.latencyMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SpeedTile({
  label,
  arrow,
  color,
  value,
  samples,
  active,
}: {
  label: string;
  arrow: string;
  color: string;
  value: number | null;
  samples: number[];
  active: boolean;
}) {
  const [num, unit] = splitMbps(value);
  const top = Math.max(1, ...samples);
  return (
    <div
      className={`relative overflow-hidden rounded-md bg-(--color-surface) px-3 py-2 ${active ? "ring-1 ring-(--color-accent)/60" : ""}`}
    >
      <div className="flex items-center gap-1 text-[11px] text-(--color-fg-muted)">
        <span style={{ color }}>{arrow}</span>
        {label}
        {active && (
          <span
            className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: color }}
          />
        )}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{num}</span>
        <span className="text-xs text-(--color-fg-muted)">{unit}</span>
      </div>
      {samples.length > 0 && (
        <div className="mt-1 flex h-4 items-end gap-0.5">
          {samples.map((v, i) => (
            <span
              key={i}
              className="w-1.5 rounded-sm"
              style={{
                height: `${Math.max(12, (v / top) * 100)}%`,
                background: color,
                opacity: i === 0 && samples.length > 2 ? 0.35 : 0.8,
              }}
              title={`${fmtMbps(v)}${i === 0 && samples.length > 2 ? " (warm-up, ignored)" : ""}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  big,
}: {
  label: string;
  value: string;
  tone?: string;
  big?: boolean;
}) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-(--color-fg-muted)">{label} </span>
      <span
        className={`tabular-nums ${big ? "text-sm font-medium" : ""} ${tone ?? ""}`}
      >
        {value}
      </span>
    </span>
  );
}

function QualityDot({ rtt, sent }: { rtt: number | null; sent: number }) {
  const bg =
    sent === 0
      ? "var(--color-fg-muted)"
      : rtt === null
        ? "var(--color-error)"
        : rttColor(rtt);
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: bg, opacity: sent === 0 ? 0.4 : 1 }}
    />
  );
}

function Msg({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-(--color-fg-muted)">
      {children}
    </div>
  );
}

function rttColor(ms: number): string {
  return ms < 80
    ? "var(--color-online)"
    : ms < 200
      ? "var(--color-warn)"
      : "var(--color-error)";
}

function rttTone(rtt: number | null, sent: number): string {
  if (sent === 0) return "text-(--color-fg-muted)";
  if (rtt === null) return "text-(--color-error)";
  return rtt < 80
    ? "text-(--color-online)"
    : rtt < 200
      ? "text-(--color-warn)"
      : "text-(--color-error)";
}

function niceCeil(v: number): number {
  const steps = [10, 20, 30, 50, 80, 100, 150, 200, 300, 500, 800, 1000, 2000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
}

function fmtMs(v: number | null): string {
  if (v === null) return "—";
  return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
}

function splitMbps(v: number | null): [string, string] {
  if (v === null) return ["—", "Mbps"];
  if (v >= 1000) return [(v / 1000).toFixed(2), "Gbps"];
  return [v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), "Mbps"];
}

function fmtMbps(v: number | null): string {
  const [n, u] = splitMbps(v);
  return v === null ? n : `${n} ${u}`;
}

function fmtBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
}

function fmtSpan(ms: number): string {
  const s = ms / 1000;
  return s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
}

function fmtWhen(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
