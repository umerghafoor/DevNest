import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkCheck,
  LayoutDashboard,
  Maximize2,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { api, errorMessage } from "../lib/api";
import {
  formatValue,
  isSaved,
  num,
  parseOutput,
  pick,
  rowsOf,
  sortRows,
  useWidgetsStore,
  type WidgetBlock,
  type WidgetSpec,
} from "../lib/custom-widgets";
import { useAppStore } from "../store/app-store";
import { toast } from "./Toast";

/** Series colours for bars / donut slices, from the theme where possible. */
const PALETTE = [
  "var(--color-accent)",
  "var(--color-online)",
  "var(--color-warn)",
  "oklch(0.66 0.15 300)",
  "oklch(0.7 0.12 200)",
  "oklch(0.66 0.17 25)",
  "oklch(0.72 0.13 140)",
  "var(--color-fg-muted)",
];
const HISTORY = 60;

/**
 * A widget the Master agent designed: runs its command on the device on a
 * timer while on screen, parses the output and draws the blocks. Shown in
 * the Master chat (with Save / open as panel) and in the Widgets panel.
 */
export function CustomWidget({
  spec,
  deviceId,
  deviceName,
  variant = "chat",
}: {
  spec: WidgetSpec;
  deviceId: string;
  deviceName?: string;
  variant?: "chat" | "panel";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref);
  const device = useAppStore((s) => s.devices.find((d) => d.id === deviceId));
  const status = useAppStore((s) => s.statuses[deviceId]);
  const openPane = useAppStore((s) => s.openPane);
  const saved = useWidgetsStore((s) => s.saved);
  const save = useWidgetsStore((s) => s.save);
  const remove = useWidgetsStore((s) => s.remove);
  const name = device?.name ?? deviceName ?? "device";
  const online = device?.isLocalhost || status === "connected";
  const isStored = isSaved(saved, spec);
  const [showCmd, setShowCmd] = useState(false);

  const feed = useWidgetFeed(spec, deviceId, visible);

  const onSave = () => {
    save({ spec, deviceId, deviceName: name });
    toast.success(`Saved “${spec.name}” — find it in the Widgets panel`);
  };
  const dock = () => {
    const id = Math.random().toString(36).slice(2, 10);
    if (!isStored) save({ spec, deviceId, deviceName: name });
    openPane({
      id,
      instanceId: id,
      deviceId,
      panel: "widgets",
      extra: { widgetId: spec.id },
    });
  };

  const iconBtn =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors";

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-lg border border-(--color-border) bg-(--color-bg) text-xs"
    >
      <div className="relative flex h-9 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) pr-1 pl-2.5 select-none">
        <div
          className={`absolute top-0 right-0 left-0 h-0.5 transition-colors ${visible ? "bg-(--color-accent)" : "bg-transparent"}`}
        />
        <LayoutDashboard
          size={13}
          className="shrink-0 text-(--color-accent)"
          strokeWidth={1.75}
        />
        <span className="truncate font-semibold" title={spec.description ?? ""}>
          {spec.name}
        </span>
        <span className="opacity-40">·</span>
        <span className="flex min-w-0 shrink items-center gap-1 text-(--color-fg-muted)">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? "bg-(--color-online)" : "bg-(--color-fg-muted)"}`}
          />
          <span className="truncate">{name}</span>
        </span>
        <span className="ml-auto shrink-0 pl-1 text-[10px] text-(--color-fg-muted) tabular-nums">
          {feed.updatedAt ? <Ago at={feed.updatedAt} /> : null}
        </span>
        <button
          className={iconBtn}
          onClick={() => setShowCmd((v) => !v)}
          title="Show command"
        >
          <Terminal size={12} />
        </button>
        <button className={iconBtn} onClick={feed.refresh} title="Refresh now">
          <RefreshCw
            size={12}
            className={feed.loading ? "animate-spin" : undefined}
          />
        </button>
        {variant === "chat" ? (
          <>
            <button
              className={`${iconBtn} ${isStored ? "text-(--color-accent)" : ""}`}
              onClick={isStored ? undefined : onSave}
              title={isStored ? "Saved" : "Save widget"}
            >
              {isStored ? <BookmarkCheck size={13} /> : <Bookmark size={13} />}
            </button>
            <button className={iconBtn} onClick={dock} title="Open as a panel">
              <Maximize2 size={12} />
            </button>
          </>
        ) : (
          <button
            className={`${iconBtn} hover:text-(--color-error)`}
            onClick={() => remove(spec.id)}
            title="Delete saved widget"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {showCmd && (
        <pre className="border-b border-(--color-border) bg-(--color-surface) px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap text-(--color-fg-muted)">
          {spec.cwd ? `cd ${spec.cwd}\n` : ""}
          {spec.command}
          {"\n"}
          <span className="opacity-70">
            {spec.interval
              ? `every ${spec.interval}s while visible`
              : "on refresh only"}
            {" · parse "}
            {spec.parse ?? "json"}
          </span>
        </pre>
      )}

      <div className="space-y-3 p-3">
        {feed.error && (
          <div className="rounded-md bg-(--color-error)/10 px-2.5 py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-(--color-error)">
            {feed.error}
          </div>
        )}
        {feed.data === undefined && !feed.error ? (
          <div className="py-4 text-center text-(--color-fg-muted)">
            Running…
          </div>
        ) : feed.data !== undefined ? (
          spec.blocks.map((b, i) => (
            <Block
              key={i}
              block={b}
              data={feed.data}
              history={feed.history.current[i] ?? []}
            />
          ))
        ) : null}
      </div>
    </div>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function useWidgetFeed(spec: WidgetSpec, deviceId: string, live: boolean) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  /** Per-block numeric history for trend / line blocks. */
  const history = useRef<Record<number, number[]>>({});
  const specKey = JSON.stringify(spec);
  const specRef = useRef(spec);
  specRef.current = spec;

  // A revised spec starts fresh.
  useEffect(() => {
    history.current = {};
  }, [specKey]);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = specRef.current;
      setLoading(true);
      try {
        const out = await api.widgetRun(deviceId, s.command, s.cwd ?? null);
        if (stop) return;
        if (out.exitCode !== 0 && !out.stdout.trim()) {
          throw new Error(
            out.stderr.trim() || `Command exited with code ${out.exitCode}`,
          );
        }
        const parsed = parseOutput(out.stdout, s.parse);
        s.blocks.forEach((b, i) => {
          const v = trackedValue(b, parsed);
          if (v === null) return;
          const h = [...(history.current[i] ?? []), v];
          history.current[i] = h.slice(-HISTORY);
        });
        setData(parsed);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (!stop) setError(errorMessage(e));
      } finally {
        if (!stop) setLoading(false);
      }
      const every = specRef.current.interval ?? 30;
      if (!stop && every > 0)
        timer = setTimeout(() => void tick(), Math.max(2, every) * 1000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [live, deviceId, specKey, nonce]);

  return {
    data,
    error,
    loading,
    updatedAt,
    history,
    refresh: () => setNonce((n) => n + 1),
  };
}

function trackedValue(b: WidgetBlock, data: unknown): number | null {
  if (b.type === "line" || (b.type === "stat" && b.trend))
    return num(pick(data, b.value));
  return null;
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

function Block({
  block: b,
  data,
  history,
}: {
  block: WidgetBlock;
  data: unknown;
  history: number[];
}) {
  const body = (() => {
    switch (b.type) {
      case "stat":
        return <StatBlock b={b} data={data} history={history} />;
      case "stats":
        return (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-2">
            {(b.items ?? []).map((it, i) => (
              <Tile
                key={i}
                label={it.label}
                value={formatValue(pick(data, it.value), it.format, it.unit)}
              />
            ))}
          </div>
        );
      case "gauge":
        return <GaugeBlock b={b} data={data} />;
      case "bars":
        return <BarsBlock b={b} data={data} />;
      case "donut":
        return <DonutBlock b={b} data={data} />;
      case "line":
        return <LineBlock b={b} data={data} history={history} />;
      case "table":
        return <TableBlock b={b} data={data} />;
      case "list":
        return <ListBlock b={b} data={data} />;
      case "kv":
        return (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {(b.items ?? []).map((it, i) => (
              <div key={i} className="contents">
                <dt className="text-(--color-fg-muted)">{it.label}</dt>
                <dd className="truncate text-right font-mono tabular-nums">
                  {formatValue(pick(data, it.value), it.format)}
                </dd>
              </div>
            ))}
          </dl>
        );
      case "status":
        return <StatusBlock b={b} data={data} />;
      case "text": {
        const v = pick(data, b.value);
        const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
        const lines = (text ?? "").split("\n");
        const shown = b.maxLines ? lines.slice(-b.maxLines) : lines;
        return (
          <pre
            className={`max-h-60 overflow-auto rounded-md bg-(--color-surface) p-2 text-[11px] whitespace-pre-wrap ${b.mono === false ? "" : "font-mono"}`}
          >
            {shown.join("\n")}
          </pre>
        );
      }
      default:
        return (
          <div className="text-(--color-fg-muted)">
            Unknown block “{(b as { type: string }).type}”.
          </div>
        );
    }
  })();
  const label =
    b.type !== "stat" && b.type !== "gauge" && b.type !== "status"
      ? b.label
      : undefined;
  return (
    <section>
      {label && (
        <h4 className="mb-1.5 text-[10px] font-semibold tracking-wider text-(--color-fg-muted) uppercase">
          {label}
        </h4>
      )}
      {body}
    </section>
  );
}

function Tile({
  label,
  value,
  sub,
}: {
  label?: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-(--color-surface) px-2.5 py-2">
      <div className="truncate text-[10px] tracking-wide text-(--color-fg-muted) uppercase">
        {label}
      </div>
      <div className="truncate text-lg leading-tight font-semibold tabular-nums">
        {value}
      </div>
      {sub && (
        <div className="truncate text-[11px] text-(--color-fg-muted)">
          {sub}
        </div>
      )}
    </div>
  );
}

function StatBlock({
  b,
  data,
  history,
}: {
  b: Extract<WidgetBlock, { type: "stat" }>;
  data: unknown;
  history: number[];
}) {
  return (
    <div className="flex items-end gap-3 rounded-md bg-(--color-surface) px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-[10px] tracking-wide text-(--color-fg-muted) uppercase">
          {b.label}
        </div>
        <div className="truncate text-2xl leading-tight font-semibold tabular-nums">
          {formatValue(pick(data, b.value), b.format, b.unit)}
        </div>
        {b.sub && (
          <div className="truncate text-[11px] text-(--color-fg-muted)">
            {formatValue(pick(data, b.sub))}
          </div>
        )}
      </div>
      {b.trend && history.length > 1 && (
        <div className="ml-auto h-9 w-28 shrink-0">
          <Spark data={history} />
        </div>
      )}
    </div>
  );
}

function GaugeBlock({
  b,
  data,
}: {
  b: Extract<WidgetBlock, { type: "gauge" }>;
  data: unknown;
}) {
  const v = num(pick(data, b.value)) ?? 0;
  const max =
    (typeof b.max === "number" ? b.max : num(pick(data, b.max))) ||
    (b.format === "percent" ? 100 : Math.max(v, 1));
  const p = Math.max(0, Math.min(100, (v / max) * 100));
  const color =
    b.danger !== undefined && v >= b.danger
      ? "var(--color-error)"
      : b.warn !== undefined && v >= b.warn
        ? "var(--color-warn)"
        : "var(--color-accent)";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-(--color-fg-muted)">{b.label}</span>
        <span className="font-mono font-semibold tabular-nums">
          {formatValue(v, b.format, b.unit)}
          {b.format !== "percent" && (
            <span className="font-normal text-(--color-fg-muted)">
              {" / "}
              {formatValue(max, b.format, b.unit)}
            </span>
          )}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-(--color-surface-2)">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${p}%`, background: color }}
        />
      </div>
    </div>
  );
}

function useSeries(
  b: Extract<WidgetBlock, { type: "bars" | "donut" }>,
  data: unknown,
) {
  const labelKey = b.labelKey ?? "key";
  const valueKey = b.valueKey ?? "value";
  const rows = sortRows(rowsOf(data, b), valueKey, b.sort ?? "desc");
  const all = rows.map((r) => ({
    label: String(r[labelKey] ?? "—"),
    value: num(r[valueKey]) ?? 0,
  }));
  const limit = b.limit ?? (b.type === "donut" ? 6 : 10);
  if (all.length <= limit) return all;
  const head = all.slice(0, limit - 1);
  const rest = all.slice(limit - 1).reduce((s, x) => s + x.value, 0);
  return [...head, { label: `Other (${all.length - limit + 1})`, value: rest }];
}

function BarsBlock({
  b,
  data,
}: {
  b: Extract<WidgetBlock, { type: "bars" }>;
  data: unknown;
}) {
  const series = useSeries(b, data);
  const max = Math.max(1, ...series.map((s) => s.value));
  if (series.length === 0) return <Empty />;
  return (
    <ul className="space-y-1.5">
      {series.map((s, i) => (
        <li
          key={s.label}
          className="grid grid-cols-[minmax(60px,30%)_1fr_auto] items-center gap-2"
        >
          <span className="truncate" title={s.label}>
            {s.label}
          </span>
          <div className="h-3.5 overflow-hidden rounded-sm bg-(--color-surface)">
            <div
              className="h-full rounded-sm transition-[width] duration-500"
              style={{
                width: `${(s.value / max) * 100}%`,
                background: PALETTE[i % PALETTE.length],
                opacity: 0.85,
              }}
            />
          </div>
          <span className="text-right font-mono tabular-nums">
            {formatValue(s.value, b.format)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DonutBlock({
  b,
  data,
}: {
  b: Extract<WidgetBlock, { type: "donut" }>;
  data: unknown;
}) {
  const series = useSeries(b, data);
  const total = series.reduce((s, x) => s + x.value, 0);
  if (series.length === 0 || total <= 0) return <Empty />;
  const r = 15.9155; // circumference 100
  let offset = 25; // start at 12 o'clock
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 42 42" className="h-24 w-24 shrink-0 -rotate-0">
        <circle
          cx="21"
          cy="21"
          r={r}
          fill="none"
          stroke="var(--color-surface-2)"
          strokeWidth="6"
        />
        {series.map((s, i) => {
          const len = (s.value / total) * 100;
          const el = (
            <circle
              key={s.label}
              cx="21"
              cy="21"
              r={r}
              fill="none"
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth="6"
              strokeDasharray={`${len} ${100 - len}`}
              strokeDashoffset={offset}
            />
          );
          offset -= len;
          return el;
        })}
        <text
          x="21"
          y="22.5"
          textAnchor="middle"
          className="fill-(--color-fg) text-[6px] font-semibold"
        >
          {formatValue(total, b.format === "bytes" ? "bytes" : "compact")}
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1">
        {series.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: PALETTE[i % PALETTE.length] }}
            />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="font-mono text-(--color-fg-muted) tabular-nums">
              {((s.value / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LineBlock({
  b,
  data,
  history,
}: {
  b: Extract<WidgetBlock, { type: "line" }>;
  data: unknown;
  history: number[];
}) {
  return (
    <div className="rounded-md bg-(--color-surface) px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-(--color-fg-muted)">{b.label}</span>
        <span className="font-mono font-semibold tabular-nums">
          {formatValue(pick(data, b.value), b.format)}
        </span>
      </div>
      <div className="mt-1 h-16">
        {history.length > 1 ? (
          <Spark data={history} max={b.max} fill />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-(--color-fg-muted)">
            Collecting points…
          </div>
        )}
      </div>
    </div>
  );
}

function TableBlock({
  b,
  data,
}: {
  b: Extract<WidgetBlock, { type: "table" }>;
  data: unknown;
}) {
  let rows = rowsOf(data, b);
  if (b.sortBy) rows = sortRows(rows, b.sortBy, b.sort ?? "desc");
  rows = rows.slice(0, b.limit ?? 50);
  const cols =
    b.columns ??
    Object.keys(rows[0] ?? {}).map((key) => ({
      key,
      label: key,
      format: undefined,
    }));
  if (rows.length === 0) return <Empty />;
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-(--color-border)">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-(--color-surface)">
          <tr>
            {cols.map((c, i) => (
              <th
                key={c.key}
                className={`px-2.5 py-1.5 text-[10px] font-semibold tracking-wide whitespace-nowrap text-(--color-fg-muted) uppercase ${i === 0 ? "text-left" : "text-right"}`}
              >
                {c.label ?? c.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              key={ri}
              className="border-t border-(--color-border) hover:bg-(--color-surface)"
            >
              {cols.map((c, i) => (
                <td
                  key={c.key}
                  className={`max-w-48 truncate px-2.5 py-1 ${i === 0 ? "text-left" : "text-right font-mono tabular-nums"}`}
                >
                  {formatValue(pick(r, c.key), c.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListBlock({
  b,
  data,
}: {
  b: Extract<WidgetBlock, { type: "list" }>;
  data: unknown;
}) {
  const rows = rowsOf(data, b).slice(0, b.limit ?? 50);
  if (rows.length === 0) return <Empty />;
  return (
    <ul className="divide-y divide-(--color-border) rounded-md border border-(--color-border)">
      {rows.map((r, i) => (
        <li key={i} className="flex items-center gap-2 px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="truncate">
              {formatValue(pick(r, b.primary ?? "key"))}
            </div>
            {b.secondary && (
              <div className="truncate text-[11px] text-(--color-fg-muted)">
                {formatValue(pick(r, b.secondary))}
              </div>
            )}
          </div>
          {b.badge && (
            <span className="shrink-0 rounded bg-(--color-surface-2) px-1.5 py-0.5 text-[10px] font-medium">
              {formatValue(pick(r, b.badge))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function StatusBlock({
  b,
  data,
}: {
  b: Extract<WidgetBlock, { type: "status" }>;
  data: unknown;
}) {
  const v = pick(data, b.value);
  const ok = b.ok
    ? b.ok.some((x) => String(x).toLowerCase() === String(v).toLowerCase())
    : !!v && v !== "false" && v !== "0";
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-(--color-surface) px-3 py-2">
      <span className="truncate">{b.label}</span>
      <span
        className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? "bg-(--color-online)/15 text-(--color-online)" : "bg-(--color-error)/15 text-(--color-error)"}`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-(--color-online)" : "bg-(--color-error)"}`}
        />
        {formatValue(v)}
      </span>
    </div>
  );
}

function Empty() {
  return <div className="text-(--color-fg-muted)">No rows.</div>;
}

function Spark({
  data,
  max,
  fill,
}: {
  data: number[];
  max?: number;
  fill?: boolean;
}) {
  const w = 200;
  const h = 40;
  const hi = max ?? Math.max(...data);
  const lo = max !== undefined ? 0 : Math.min(...data);
  const span = hi - lo || 1;
  const step = w / Math.max(1, data.length - 1);
  const pts = data.map(
    (v, i) =>
      `${(i * step).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`,
  );
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-full w-full"
    >
      {fill && (
        <polygon
          points={`0,${h} ${pts.join(" ")} ${((data.length - 1) * step).toFixed(1)},${h}`}
          fill="var(--color-accent)"
          opacity="0.12"
        />
      )}
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Ago({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - at) / 1000));
  return (
    <>
      {s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`}
    </>
  );
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

/** Saved widgets: one if the pane names it, else all of them as a board. */
export function WidgetsPanel({ widgetId }: { widgetId?: string }) {
  const saved = useWidgetsStore((s) => s.saved);
  const shown = widgetId ? saved.filter((w) => w.spec.id === widgetId) : saved;
  if (shown.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-xs text-(--color-fg-muted)">
        <LayoutDashboard size={22} strokeWidth={1.5} />
        <span className="font-medium text-(--color-fg)">
          {widgetId ? "This widget was deleted" : "No saved widgets yet"}
        </span>
        <span>
          Ask the Master agent to make one — e.g. “create a widget that shows
          lines of code in ~/project” — then press Save.
        </span>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {shown.map((w) => (
          <CustomWidget
            key={w.spec.id}
            spec={w.spec}
            deviceId={w.deviceId}
            deviceName={w.deviceName}
            variant="panel"
          />
        ))}
      </div>
    </div>
  );
}
