import { create } from "zustand";

/**
 * Custom widgets the Master agent designs (`create_widget` in
 * src-tauri/src/master.rs): a read-only command run on a device, how to parse
 * its stdout, and a stack of blocks drawn from the result. Specs are plain
 * data — no agent-written code runs in the webview. Saved ones live here and
 * open again from the Widgets panel.
 */

export type ParseMode = "json" | "lines" | "table" | "kv" | "number" | "text";

export type ValueFormat =
  | "number"
  | "compact"
  | "bytes"
  | "percent"
  | "duration"
  | "text";

interface ListSource {
  items?: string;
  exclude?: string[];
  limit?: number;
}

export type WidgetBlock =
  | {
      type: "stat";
      label?: string;
      value?: string;
      format?: ValueFormat;
      unit?: string;
      sub?: string;
      trend?: boolean;
    }
  | {
      type: "stats";
      label?: string;
      items?: {
        label?: string;
        value?: string;
        format?: ValueFormat;
        unit?: string;
      }[];
    }
  | {
      type: "gauge";
      label?: string;
      value?: string;
      max?: number | string;
      format?: ValueFormat;
      unit?: string;
      warn?: number;
      danger?: number;
    }
  | ({
      type: "bars";
      label?: string;
      labelKey?: string;
      valueKey?: string;
      format?: ValueFormat;
      sort?: "desc" | "asc" | "none";
    } & ListSource)
  | ({
      type: "donut";
      label?: string;
      labelKey?: string;
      valueKey?: string;
      format?: ValueFormat;
      sort?: "desc" | "asc" | "none";
    } & ListSource)
  | {
      type: "line";
      label?: string;
      value?: string;
      format?: ValueFormat;
      max?: number;
    }
  | ({
      type: "table";
      label?: string;
      columns?: { key: string; label?: string; format?: ValueFormat }[];
      sortBy?: string;
      sort?: "desc" | "asc" | "none";
    } & ListSource)
  | ({
      type: "list";
      label?: string;
      primary?: string;
      secondary?: string;
      badge?: string;
    } & ListSource)
  | {
      type: "kv";
      label?: string;
      items?: { label?: string; value?: string; format?: ValueFormat }[];
    }
  | {
      type: "status";
      label?: string;
      value?: string;
      ok?: (string | number | boolean)[];
    }
  | {
      type: "text";
      label?: string;
      value?: string;
      mono?: boolean;
      maxLines?: number;
    };

export interface WidgetSpec {
  id: string;
  name: string;
  description?: string | null;
  command: string;
  cwd?: string | null;
  parse?: ParseMode;
  /** Seconds between refreshes; 0 = only on demand. */
  interval?: number;
  blocks: WidgetBlock[];
}

export interface SavedWidget {
  spec: WidgetSpec;
  deviceId: string;
  deviceName: string;
  savedAt: number;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/** Turn a command's stdout into data for the blocks. */
export function parseOutput(stdout: string, mode: ParseMode = "json"): unknown {
  const text = stdout.replace(/\r/g, "");
  switch (mode) {
    case "json": {
      const trimmed = text.trim();
      try {
        return JSON.parse(trimmed);
      } catch {
        // Tolerate a banner before the JSON (warnings, progress lines).
        const start = trimmed.search(/[[{]/);
        if (start < 0) throw new Error("Command output isn't JSON.");
        return JSON.parse(trimmed.slice(start));
      }
    }
    case "lines":
      return text.split("\n").filter((l) => l.trim() !== "");
    case "table": {
      const rows = text.split("\n").filter((l) => l.trim() !== "");
      if (rows.length === 0) return [];
      const head = rows[0].trim().split(/\s+/);
      return rows.slice(1).map((r) => {
        const cells = r.trim().split(/\s+/);
        // Extra cells belong to the last column (e.g. commands with spaces).
        const last = head.length - 1;
        const row: Record<string, string> = {};
        head.forEach((h, i) => {
          row[h] = i === last ? cells.slice(i).join(" ") : (cells[i] ?? "");
        });
        return row;
      });
    }
    case "kv": {
      const out: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const m = /^\s*([^:=]+?)\s*[:=]\s*(.*)$/.exec(line);
        if (m) out[m[1]] = m[2].trim();
      }
      return out;
    }
    case "number": {
      const m = /-?\d+(?:\.\d+)?/.exec(text);
      if (!m) throw new Error("Command output has no number.");
      return Number(m[0]);
    }
    case "text":
      return text.trimEnd();
  }
}

/** Value at `path` ("a.b[0].c", "" for the root, "length" of arrays). */
export function pick(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
  let cur: unknown = data;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && part === "length") cur = cur.length;
    else if (typeof cur === "object")
      cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/**
 * Rows for list-like blocks. An object becomes one row per key: its fields
 * plus `key` (or `{key, value}` for plain values) — so `{"Python": {...}}`
 * reads as a list of languages.
 */
export function rowsOf(
  data: unknown,
  src: ListSource,
): Record<string, unknown>[] {
  const v = pick(data, src.items);
  let rows: Record<string, unknown>[];
  if (Array.isArray(v)) {
    rows = v.map((x) =>
      x !== null && typeof x === "object"
        ? (x as Record<string, unknown>)
        : { key: String(x), value: x },
    );
  } else if (v !== null && typeof v === "object") {
    rows = Object.entries(v).map(([key, x]) =>
      x !== null && typeof x === "object" && !Array.isArray(x)
        ? { key, ...(x as Record<string, unknown>) }
        : { key, value: x },
    );
  } else {
    return [];
  }
  if (src.exclude?.length) {
    const skip = new Set(src.exclude);
    rows = rows.filter((r) => !skip.has(String(r.key ?? "")));
  }
  return rows;
}

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[,%\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Sort rows by a numeric key (strings compare as text). */
export function sortRows(
  rows: Record<string, unknown>[],
  key: string | undefined,
  dir: "desc" | "asc" | "none" = "desc",
) {
  if (!key || dir === "none") return rows;
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = num(a[key]);
    const y = num(b[key]);
    if (x !== null && y !== null) return (x - y) * sign;
    return String(a[key] ?? "").localeCompare(String(b[key] ?? "")) * sign;
  });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatValue(v: unknown, format?: ValueFormat, unit?: string) {
  const suffix = unit ? ` ${unit}` : "";
  if (v === undefined || v === null || v === "") return "—";
  const n = num(v);
  if (format === "text" || n === null || (typeof v === "string" && !format)) {
    return typeof v === "object" ? JSON.stringify(v) : `${String(v)}${suffix}`;
  }
  switch (format) {
    case "bytes":
      return fmtBytes(n) + suffix;
    case "percent":
      return `${n.toFixed(Math.abs(n) < 10 ? 1 : 0)}%`;
    case "duration":
      return fmtDuration(n);
    case "compact":
      return fmtCompact(n) + suffix;
    default:
      return (
        n.toLocaleString(undefined, {
          maximumFractionDigits:
            Math.abs(n) < 10 ? 2 : Math.abs(n) < 100 ? 1 : 0,
        }) + suffix
      );
  }
}

function fmtBytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Math.abs(n) >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

function fmtCompact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtDuration(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.round(s)}s`;
}

// ─── Saved widgets ────────────────────────────────────────────────────────────

const KEY = "devnest.widgets";

function load(): SavedWidget[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedWidget[]) : [];
  } catch {
    return [];
  }
}

function persist(list: SavedWidget[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Saved widgets just won't persist.
  }
}

interface WidgetsState {
  saved: SavedWidget[];
  save: (w: Omit<SavedWidget, "savedAt">) => void;
  remove: (id: string) => void;
}

export const useWidgetsStore = create<WidgetsState>((set, get) => ({
  saved: load(),
  save: (w) => {
    const rest = get().saved.filter((x) => x.spec.id !== w.spec.id);
    const saved = [{ ...w, savedAt: Date.now() }, ...rest];
    set({ saved });
    persist(saved);
  },
  remove: (id) => {
    const saved = get().saved.filter((x) => x.spec.id !== id);
    set({ saved });
    persist(saved);
  },
}));

/** Saved and identical to `spec` (a revised preview counts as unsaved). */
export function isSaved(saved: SavedWidget[], spec: WidgetSpec) {
  const s = saved.find((x) => x.spec.id === spec.id);
  return !!s && JSON.stringify(s.spec) === JSON.stringify(spec);
}
