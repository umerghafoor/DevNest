import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  Bookmark,
  BookmarkCheck,
  Download,
  LayoutDashboard,
  Maximize2,
  Pin,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
  Upload,
} from "lucide-react";
import { api, errorMessage } from "../lib/api";
import {
  exportWidgets,
  formatValue,
  isSaved,
  newWidgetId,
  num,
  parseOutput,
  parseWidgetFile,
  pick,
  resolveSpec,
  rowsOf,
  sortRows,
  useWidgetsStore,
  type SavedWidget,
  type WidgetBlock,
  type WidgetSpec,
} from "../lib/custom-widgets";
import { SMALL_INPUT } from "../lib/ui";
import { paneSlotId } from "../lib/pane-slot";
import { useAppStore } from "../store/app-store";
import { confirm } from "./ConfirmDialog";
import { Modal } from "./Modal";
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
  params,
  variant = "chat",
  frameless,
  slotId,
}: {
  spec: WidgetSpec;
  deviceId: string;
  deviceName?: string;
  /** Values for the spec's template params (saved widgets). */
  params?: Record<string, string>;
  variant?: "chat" | "panel";
  /** Fill the pane edge to edge: no card border or radius. */
  frameless?: boolean;
  /** Pane-header slot (see pane-slot.ts) to put the controls in. */
  slotId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useVisible(ref);
  const device = useAppStore((s) => s.devices.find((d) => d.id === deviceId));
  const status = useAppStore((s) => s.statuses[deviceId]);
  const openPane = useAppStore((s) => s.openPane);
  const saved = useWidgetsStore((s) => s.saved);
  const save = useWidgetsStore((s) => s.save);
  const togglePin = useWidgetsStore((s) => s.togglePin);
  const entry = saved.find((w) => w.spec.id === spec.id);
  const name = device?.name ?? deviceName ?? "device";
  const online = device?.isLocalhost || status === "connected";
  const isStored = isSaved(saved, spec);
  const [showCmd, setShowCmd] = useState(false);
  const [editing, setEditing] = useState(false);
  const run = resolveSpec(spec, params);

  const feed = useWidgetFeed(spec, run, deviceId, visible);
  const wide = blockSpans(spec.blocks);

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

  // A pane showing just this widget already has a header: put the controls
  // in it rather than drawing a second one.
  const inPane = !!(frameless && slotId);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(slotId ? document.getElementById(slotId) : null);
  }, [slotId]);

  const controls = (
    <>
      <span className="flex min-w-0 shrink items-center gap-1 text-(--color-fg-muted) @max-xs:hidden">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${online ? "bg-(--color-online)" : "bg-(--color-fg-muted)"}`}
        />
        <span className="truncate">{name}</span>
      </span>
      <span className="ml-auto shrink-0 pl-1 text-[10px] whitespace-nowrap text-(--color-fg-muted) tabular-nums @max-sm:hidden">
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
        <>
          <button
            className={`${iconBtn} ${entry?.pinned ? "text-(--color-accent)" : ""}`}
            onClick={() => togglePin(spec.id)}
            title={entry?.pinned ? "Unpin from Dashboard" : "Pin to Dashboard"}
          >
            <Pin
              size={12}
              className={entry?.pinned ? "fill-current" : undefined}
            />
          </button>
          {entry && (
            <button
              className={iconBtn}
              onClick={() => setEditing(true)}
              title="Settings, duplicate, export, delete"
            >
              <SlidersHorizontal size={12} />
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <div
      ref={ref}
      className={`@container bg-(--color-bg) text-xs ${
        frameless
          ? "flex h-full flex-col overflow-hidden"
          : "overflow-hidden rounded-lg border border-(--color-border)"
      }`}
    >
      {inPane ? (
        slot &&
        createPortal(
          <div className="ml-auto flex min-w-0 items-center gap-0.5 pl-2">
            {controls}
          </div>,
          slot,
        )
      ) : (
        <div className="relative flex h-9 shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) pr-1 pl-2.5 select-none">
          <div
            className={`absolute top-0 right-0 left-0 h-0.5 transition-colors ${visible ? "bg-(--color-accent)" : "bg-transparent"}`}
          />
          <LayoutDashboard
            size={13}
            className="shrink-0 text-(--color-accent)"
            strokeWidth={1.75}
          />
          <span
            className="truncate font-semibold"
            title={spec.description ?? ""}
          >
            {spec.name}
          </span>
          <span className="opacity-40 @max-xs:hidden">·</span>
          {controls}
        </div>
      )}
      {editing && entry && (
        <WidgetSettings widget={entry} onClose={() => setEditing(false)} />
      )}

      {showCmd && (
        <pre className="border-b border-(--color-border) bg-(--color-surface) px-3 py-2 font-mono text-[11px] break-all whitespace-pre-wrap text-(--color-fg-muted)">
          {run.cwd ? `cd ${run.cwd}\n` : ""}
          {run.command}
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

      <div
        className={`grid content-start gap-3 p-3 @3xl:grid-cols-2 ${frameless ? "min-h-0 flex-1 overflow-y-auto" : ""}`}
      >
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
              wide={wide[i]}
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

/**
 * Last result per widget (device + spec + resolved command), kept across
 * unmounts so switching workspaces or scrolling a widget back into view
 * shows it straight away and only re-runs when its interval is due.
 */
interface FeedCache {
  data: unknown;
  updatedAt: number;
  history: Record<number, number[]>;
}
const feedCache = new Map<string, FeedCache>();

function useWidgetFeed(
  spec: WidgetSpec,
  run: { command: string; cwd: string | null },
  deviceId: string,
  live: boolean,
) {
  const key = JSON.stringify([deviceId, spec, run]);
  const [data, setData] = useState<unknown>(() => feedCache.get(key)?.data);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(
    () => feedCache.get(key)?.updatedAt ?? null,
  );
  const [nonce, setNonce] = useState(0);
  /** Manual refreshes already run; a newer nonce means "run now". */
  const ranNonce = useRef(0);
  /** Per-block numeric history for trend / line blocks. */
  const history = useRef<Record<number, number[]>>(
    feedCache.get(key)?.history ?? {},
  );
  const specRef = useRef(spec);
  specRef.current = spec;
  const runRef = useRef(run);
  runRef.current = run;

  // A revised spec, new params or another device: show what we have for it.
  const shownKey = useRef(key);
  if (shownKey.current !== key) {
    shownKey.current = key;
    const c = feedCache.get(key);
    history.current = c?.history ?? {};
    setData(c?.data);
    setUpdatedAt(c?.updatedAt ?? null);
    setError(null);
  }

  useEffect(() => {
    if (!live) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const every = (specRef.current.interval ?? 30) * 1000;
    const schedule = (ms: number) => {
      if (!stop) timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      const s = specRef.current;
      setLoading(true);
      try {
        const { command, cwd } = runRef.current;
        const out = await api.widgetRun(deviceId, command, cwd);
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
        const at = Date.now();
        feedCache.set(key, {
          data: parsed,
          updatedAt: at,
          history: history.current,
        });
        setData(parsed);
        setError(null);
        setUpdatedAt(at);
      } catch (e) {
        if (!stop) setError(errorMessage(e));
      } finally {
        if (!stop) setLoading(false);
      }
      if (every > 0) schedule(Math.max(2000, every));
    };

    const cached = feedCache.get(key);
    const forced = nonce !== ranNonce.current;
    ranNonce.current = nonce;
    if (forced || !cached) schedule(0);
    else if (every > 0)
      schedule(Math.max(0, cached.updatedAt + every - Date.now()));
    // On-demand widgets with a cached result wait for Refresh.
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [live, deviceId, key, nonce]);

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

/** Blocks that read best at full width; the rest pair up side by side on
 *  wide widgets. */
const FULL_WIDTH = new Set(["stat", "stats", "table", "text", "line"]);

/** Which blocks span both columns of a wide widget: full-width kinds, and a
 *  half-width block with no half-width neighbour to share the row. */
function blockSpans(blocks: WidgetBlock[]) {
  const wide: boolean[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (FULL_WIDTH.has(blocks[i].type)) {
      wide.push(true);
      continue;
    }
    const next = blocks[i + 1];
    if (next && !FULL_WIDTH.has(next.type)) {
      wide.push(false, false);
      i++;
    } else {
      wide.push(true);
    }
  }
  return wide;
}

function Block({
  block: b,
  wide,
  data,
  history,
}: {
  wide: boolean;
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
    <section className={`min-w-0 ${wide ? "@3xl:col-span-2" : ""}`}>
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
    // One grid for all rows so every bar starts and ends at the same x.
    <ul className="grid grid-cols-[fit-content(40%)_1fr_auto] items-center gap-x-3 gap-y-1.5">
      {series.map((s, i) => (
        <li key={s.label} className="contents">
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
export function WidgetsPanel({
  widgetId,
  paneId,
}: {
  widgetId?: string;
  paneId?: string;
}) {
  const saved = useWidgetsStore((s) => s.saved);
  const shown = widgetId ? saved.filter((w) => w.spec.id === widgetId) : saved;

  // A pane for one widget: the widget is the pane.
  if (widgetId && shown[0]) {
    return (
      <SavedWidgetView
        w={shown[0]}
        frameless
        slotId={paneId ? paneSlotId(paneId) : undefined}
      />
    );
  }

  return (
    <div className="flex h-full flex-col text-xs">
      {!widgetId && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-(--color-border) px-2">
          <span className="text-(--color-fg-muted)">
            {saved.length} saved widget{saved.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <ToolbarButton onClick={() => void importWidgets()}>
              <Upload size={12} /> Import
            </ToolbarButton>
            {saved.length > 0 && (
              <ToolbarButton
                onClick={() => void exportToFile(saved, "devnest-widgets")}
              >
                <Download size={12} /> Export all
              </ToolbarButton>
            )}
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center text-(--color-fg-muted)">
          <LayoutDashboard size={22} strokeWidth={1.5} />
          <span className="font-medium text-(--color-fg)">
            {widgetId ? "This widget was deleted" : "No saved widgets yet"}
          </span>
          <span>
            Ask the Master agent to make one — e.g. “create a widget that shows
            lines of code in ~/project” — then press Save. Or import a widget
            file.
          </span>
        </div>
      ) : shown.length === 1 ? (
        <div className="min-h-0 flex-1">
          <SavedWidgetView w={shown[0]} frameless />
        </div>
      ) : (
        <WidgetGrid
          widgets={shown}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        />
      )}
    </div>
  );
}

function WidgetGrid({
  widgets,
  className = "",
}: {
  widgets: SavedWidget[];
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))] items-start gap-2">
        {widgets.map((w) => (
          <SavedWidgetView key={w.spec.id} w={w} />
        ))}
      </div>
    </div>
  );
}

function SavedWidgetView({
  w,
  frameless,
  slotId,
}: {
  w: SavedWidget;
  frameless?: boolean;
  slotId?: string;
}) {
  return (
    <CustomWidget
      spec={w.spec}
      deviceId={w.deviceId}
      deviceName={w.deviceName}
      params={w.params}
      variant="panel"
      frameless={frameless}
      slotId={slotId}
    />
  );
}

function ToolbarButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex h-6 items-center gap-1 rounded px-2 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
    >
      {children}
    </button>
  );
}

// ─── Settings: template params, device, duplicate, export, delete ─────────────

function WidgetSettings({
  widget,
  onClose,
}: {
  widget: SavedWidget;
  onClose: () => void;
}) {
  const devices = useAppStore((s) => s.devices);
  const save = useWidgetsStore((s) => s.save);
  const remove = useWidgetsStore((s) => s.remove);
  const params = widget.spec.params ?? {};
  const [name, setName] = useState(widget.spec.name);
  const [deviceId, setDeviceId] = useState(widget.deviceId);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(params).map(([k, p]) => [
        k,
        widget.params?.[k] ?? p.default ?? "",
      ]),
    ),
  );
  const preview = resolveSpec(widget.spec, values);

  const result = (id: string): Omit<SavedWidget, "savedAt"> => ({
    spec: { ...widget.spec, id, name: name.trim() || widget.spec.name },
    deviceId,
    deviceName:
      devices.find((d) => d.id === deviceId)?.name ?? widget.deviceName,
    params: values,
    pinned: widget.pinned,
  });

  const apply = () => {
    save(result(widget.spec.id));
    onClose();
  };
  const duplicate = () => {
    save({ ...result(newWidgetId()), pinned: false });
    toast.success("Copy saved — it's in the Widgets panel");
    onClose();
  };
  const del = async () => {
    const ok = await confirm(`Delete the widget “${widget.spec.name}”?`, {
      title: "Delete widget",
      destructive: true,
    });
    if (!ok) return;
    remove(widget.spec.id);
    onClose();
  };

  const btn = "h-7 rounded-md px-3 text-xs font-medium transition-colors";
  return (
    <Modal
      open
      onClose={onClose}
      title="Widget settings"
      footer={
        <>
          <button
            className={`${btn} mr-auto text-(--color-error) hover:bg-(--color-error)/10`}
            onClick={() => void del()}
          >
            Delete
          </button>
          <button
            className={`${btn} hover:bg-(--color-surface-2)`}
            onClick={() =>
              void exportToFile(
                [{ ...result(widget.spec.id), savedAt: widget.savedAt }],
                name,
              )
            }
          >
            Export
          </button>
          <button
            className={`${btn} border border-(--color-border) hover:bg-(--color-surface-2)`}
            onClick={duplicate}
            title="Save these settings as a new widget"
          >
            Save as copy
          </button>
          <button
            className={`${btn} bg-(--color-accent) text-(--color-accent-fg) hover:opacity-90`}
            onClick={apply}
          >
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <Field label="Name">
          <input
            className={`${SMALL_INPUT} h-7 w-full`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Device">
          <select
            className={`${SMALL_INPUT} h-7 w-full`}
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
          >
            {!devices.some((d) => d.id === deviceId) && (
              <option value={deviceId}>{widget.deviceName || "Unknown"}</option>
            )}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        {Object.entries(params).map(([k, p]) => (
          <Field key={k} label={p.label ?? k}>
            <input
              className={`${SMALL_INPUT} h-7 w-full font-mono`}
              value={values[k] ?? ""}
              placeholder={p.default}
              onChange={(e) =>
                setValues((v) => ({ ...v, [k]: e.target.value }))
              }
            />
          </Field>
        ))}
        {Object.keys(params).length === 0 && (
          <p className="text-(--color-fg-muted)">
            This widget has no adjustable settings. Ask the Master agent to make
            its folder or target a setting to reuse it elsewhere.
          </p>
        )}
        <Field label="Runs">
          <pre className="max-h-28 overflow-auto rounded-md bg-(--color-bg) px-2 py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-(--color-fg-muted)">
            {preview.cwd ? `cd ${preview.cwd}\n` : ""}
            {preview.command}
          </pre>
        </Field>
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-fg-muted)">
        {label}
      </span>
      {children}
    </label>
  );
}

// ─── Files ────────────────────────────────────────────────────────────────────

async function exportToFile(list: SavedWidget[], name: string) {
  try {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "widget";
    const path = await saveDialog({
      defaultPath: `${slug}.devnest-widget.json`,
      filters: [{ name: "DevNest widgets", extensions: ["json"] }],
    });
    if (!path) return;
    await api.fsWriteText(path, exportWidgets(list));
    toast.success(
      `Exported ${list.length === 1 ? "widget" : `${list.length} widgets`}`,
    );
  } catch (e) {
    toast.error(`Export failed: ${errorMessage(e)}`);
  }
}

/** Pick a widget file, show what it would run, then add the widgets. */
async function importWidgets() {
  try {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "DevNest widgets", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    const items = parseWidgetFile(await api.fsReadText(path));
    const { devices } = useAppStore.getState();
    const host = devices.find((d) => d.isLocalhost);
    const { saved, save } = useWidgetsStore.getState();
    // Same device by id or name here; otherwise this computer.
    const placed = items.map((w) => {
      const d =
        devices.find((x) => x.id === w.deviceId) ??
        devices.find((x) => x.name === w.deviceName) ??
        host;
      const clash = saved.some((x) => x.spec.id === w.spec.id);
      return {
        ...w,
        spec: clash ? { ...w.spec, id: newWidgetId() } : w.spec,
        deviceId: d?.id ?? w.deviceId,
        deviceName: d?.name ?? w.deviceName,
      };
    });
    const list = placed
      .map((w) => {
        const r = resolveSpec(w.spec, w.params);
        return `• ${w.spec.name} on ${w.deviceName}:\n   ${r.command}`;
      })
      .join("\n");
    const ok = await confirm(
      `These widgets run commands on your devices while visible:\n\n${list}\n\nOnly import widgets you trust.`,
      {
        title: `Import ${placed.length === 1 ? "widget" : `${placed.length} widgets`}?`,
      },
    );
    if (!ok) return;
    for (const w of [...placed].reverse()) save(w);
    toast.success(
      `Imported ${placed.length === 1 ? "widget" : `${placed.length} widgets`}`,
    );
  } catch (e) {
    toast.error(`Import failed: ${errorMessage(e)}`);
  }
}
