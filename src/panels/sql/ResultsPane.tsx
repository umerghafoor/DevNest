import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Maximize2,
  Search,
} from "lucide-react";
import type { SqlQueryResult } from "../../lib/api";
import { toast } from "../../components/Toast";
import { Modal } from "../../components/Modal";
import {
  useResizableColumns,
  type ColumnSpec,
} from "../../components/ResizableColumns";

const ROW_NUM_W = 48;
const CHAR_PX = 7.2;
const MIN_COL = 72;
const MAX_COL = 380;

type Cell = { r: number; c: number };
type Range = { anchor: Cell; focus: Cell };
type Sort = { col: number; dir: "asc" | "desc" } | null;
type CopyFormat = "tsv" | "csv" | "json" | "markdown";

export function isConnectionLost(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("error communicating with database") ||
    m.includes("connection reset") ||
    m.includes("broken pipe") ||
    m.includes("connection closed") ||
    m.includes("not connected")
  );
}

export function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Cell text for export: NULL becomes empty so spreadsheets don't see "NULL". */
function exportCell(v: unknown): string {
  return v === null || v === undefined ? "" : renderCell(v);
}

function csvEscape(s: string, sep: string): string {
  return s.includes(sep) || /["\n\r]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function formatRows(
  format: CopyFormat,
  headers: string[],
  rows: unknown[][],
  withHeader: boolean,
): string {
  if (format === "json") {
    return JSON.stringify(
      rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))),
      null,
      2,
    );
  }
  if (format === "markdown") {
    const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    return [
      `| ${headers.map(esc).join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((r) => `| ${r.map((v) => esc(exportCell(v))).join(" | ")} |`),
    ].join("\n");
  }
  const sep = format === "csv" ? "," : "\t";
  const line = (cells: string[]) =>
    cells.map((s) => csvEscape(s, sep)).join(sep);
  const out = rows.map((r) => line(r.map(exportCell)));
  if (withHeader) out.unshift(line(headers));
  return out.join("\n");
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch {
    toast.error("Couldn't access the clipboard");
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return renderCell(a).localeCompare(renderCell(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function ResultsPane({
  result,
  error,
  running,
  paneId,
  onReconnect,
  emptyHint,
}: {
  result: SqlQueryResult | null;
  error: string | null;
  running: boolean;
  paneId?: string;
  onReconnect: () => void;
  emptyHint: React.ReactNode;
}) {
  // Size each column to its content (header + a sample of rows) until the
  // user drags it.
  const columnSpecs: ColumnSpec[] = useMemo(() => {
    if (!result) return [];
    const sample = result.rows.slice(0, 200);
    return result.columns.map((c, i) => {
      const headerLen = c.name.length + c.dataType.length + 2;
      const cellLen = sample.reduce(
        (m, row) => Math.max(m, renderCell(row[i]).length),
        0,
      );
      const px = Math.max(headerLen, cellLen) * CHAR_PX + 28;
      return {
        id: `col:${c.name}`,
        defaultWidth: Math.round(Math.min(MAX_COL, Math.max(MIN_COL, px))),
        minWidth: 48,
      };
    });
  }, [result]);
  const { widthFor, ResizeHandle } = useResizableColumns(columnSpecs, paneId);

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [sel, setSel] = useState<Range | null>(null);
  const [expanded, setExpanded] = useState<{
    column: string;
    value: unknown;
  } | null>(null);
  const [copyMenu, setCopyMenu] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    setSel(null);
    setSort(null);
    setFilter("");
  }, [result]);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const view = useMemo(() => {
    if (!result) return [];
    const f = filter.trim().toLowerCase();
    let rows = result.rows.map((row, i) => ({ row, i }));
    if (f) {
      rows = rows.filter(({ row }) =>
        row.some((v) => renderCell(v).toLowerCase().includes(f)),
      );
    }
    if (sort) {
      const k = sort.dir === "asc" ? 1 : -1;
      rows = [...rows].sort(
        (a, b) => k * compare(a.row[sort.col], b.row[sort.col]),
      );
    }
    return rows;
  }, [result, filter, sort]);

  if (running) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-(--color-fg-muted)">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-(--color-border) border-t-(--color-accent)" />
        Running query…
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full overflow-auto p-3 text-xs">
        {isConnectionLost(error) && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2">
            <span className="flex-1 text-(--color-fg)">
              The connection to the database was lost (the SSH tunnel or server
              may have dropped it).
            </span>
            <button
              onClick={onReconnect}
              className="rounded bg-(--color-accent) px-2 py-0.5 text-(--color-accent-fg) hover:opacity-90"
            >
              Reconnect
            </button>
          </div>
        )}
        <div className="whitespace-pre-wrap font-mono text-(--color-error)">
          {error}
        </div>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-(--color-fg-muted)">
        <span>Run a query to see results.</span>
        <span className="text-[11px]">{emptyHint}</span>
      </div>
    );
  }
  if (result.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-(--color-fg-muted)">
        {result.rowsAffected !== null ? (
          <span>
            Query completed in {result.elapsedMs} ms · {result.rowsAffected}{" "}
            row(s) affected
          </span>
        ) : (
          <>
            <span className="font-medium text-(--color-fg)">
              No rows returned
            </span>
            <span className="text-[11px]">
              The query ran in {result.elapsedMs} ms but nothing matched. Try
              loosening your filters.
            </span>
          </>
        )}
      </div>
    );
  }

  const headers = result.columns.map((c) => c.name);
  const tableWidth =
    ROW_NUM_W +
    result.columns.reduce((s, c) => s + widthFor(`col:${c.name}`), 0);

  const bounds = sel
    ? {
        r0: Math.min(sel.anchor.r, sel.focus.r),
        r1: Math.max(sel.anchor.r, sel.focus.r),
        c0: Math.min(sel.anchor.c, sel.focus.c),
        c1: Math.max(sel.anchor.c, sel.focus.c),
      }
    : null;
  const inSel = (r: number, c: number) =>
    !!bounds &&
    r >= bounds.r0 &&
    r <= bounds.r1 &&
    c >= bounds.c0 &&
    c <= bounds.c1;
  const selCount = bounds
    ? (bounds.r1 - bounds.r0 + 1) * (bounds.c1 - bounds.c0 + 1)
    : 0;

  const copySelection = () => {
    if (!bounds) return;
    if (selCount === 1) {
      const v = view[bounds.r0]?.row[bounds.c0];
      void copyText(exportCell(v), "cell");
      return;
    }
    const cols = headers.slice(bounds.c0, bounds.c1 + 1);
    const rows = view
      .slice(bounds.r0, bounds.r1 + 1)
      .map(({ row }) => row.slice(bounds.c0, bounds.c1 + 1));
    // A full-width row selection is most useful with headers.
    const withHeader = bounds.c0 === 0 && bounds.c1 === headers.length - 1;
    void copyText(
      formatRows("tsv", cols, rows, withHeader),
      `${rows.length} row${rows.length === 1 ? "" : "s"}`,
    );
  };

  const copyAll = (format: CopyFormat) => {
    setCopyMenu(false);
    void copyText(
      formatRows(
        format,
        headers,
        view.map((v) => v.row),
        true,
      ),
      `${view.length} rows as ${format.toUpperCase()}`,
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c" && sel) {
      e.preventDefault();
      copySelection();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      if (view.length > 0) {
        setSel({
          anchor: { r: 0, c: 0 },
          focus: { r: view.length - 1, c: headers.length - 1 },
        });
      }
    } else if (e.key === "Escape") {
      setSel(null);
    } else if (sel && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      }[e.key];
      if (!d) return;
      const next = {
        r: clamp(sel.focus.r + d[0], 0, view.length - 1),
        c: clamp(sel.focus.c + d[1], 0, headers.length - 1),
      };
      setSel(
        e.shiftKey
          ? { anchor: sel.anchor, focus: next }
          : { anchor: next, focus: next },
      );
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-cell="${next.r}:${next.c}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else if (sel && e.key === "Enter" && selCount === 1) {
      setExpanded({
        column: headers[sel.focus.c],
        value: view[sel.focus.r]?.row[sel.focus.c],
      });
    }
  };

  const toggleSort = (col: number) =>
    setSort((s) =>
      s?.col !== col
        ? { col, dir: "asc" }
        : s.dir === "asc"
          ? { col, dir: "desc" }
          : null,
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) px-3 py-1.5 text-[11px] text-(--color-fg-muted)">
        <span className="font-medium text-(--color-fg)">
          {filter
            ? `${view.length} of ${result.rows.length}`
            : result.rows.length}{" "}
          row{result.rows.length === 1 ? "" : "s"}
        </span>
        {result.truncated && (
          <span className="rounded bg-(--color-surface-2) px-1.5 py-0.5">
            truncated
          </span>
        )}
        <span>· {result.elapsedMs} ms</span>
        {selCount > 1 && (
          <span className="text-(--color-accent)">
            · {selCount} cells selected
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative">
            <Search
              size={11}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
            />
            <input
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setSel(null);
              }}
              placeholder="Filter results…"
              className="input w-44! py-0.5! pl-6! text-[11px]"
            />
          </div>
          {sel && (
            <button
              onClick={copySelection}
              title="Copy selected cells (⌘C)"
              className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 text-(--color-fg) hover:bg-(--color-surface-2)"
            >
              <Copy size={11} /> Copy selection
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setCopyMenu((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-0.5 text-(--color-fg) hover:bg-(--color-surface-2)"
            >
              <Copy size={11} /> Copy {filter ? "shown" : "all"}
              <ChevronDown size={11} />
            </button>
            {copyMenu && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setCopyMenu(false)}
                />
                <div className="absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-md border border-(--color-border) bg-(--color-surface) py-1 text-xs shadow-lg">
                  <MenuItem
                    label="For Excel / Sheets"
                    hint="tab-separated"
                    onClick={() => copyAll("tsv")}
                  />
                  <MenuItem
                    label="CSV"
                    hint="comma-separated"
                    onClick={() => copyAll("csv")}
                  />
                  <MenuItem
                    label="JSON"
                    hint="array of objects"
                    onClick={() => copyAll("json")}
                  />
                  <MenuItem
                    label="Markdown table"
                    hint="for docs / chat"
                    onClick={() => copyAll("markdown")}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <table
          className="table-fixed border-separate border-spacing-0 font-mono text-xs"
          // Fixed layout honours <col> widths only with an explicit table
          // width; the trailing filler column soaks up spare space.
          style={{ width: `max(${tableWidth}px, 100%)` }}
        >
          <colgroup>
            <col style={{ width: ROW_NUM_W }} />
            {result.columns.map((c) => (
              <col key={c.name} style={{ width: widthFor(`col:${c.name}`) }} />
            ))}
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th
                onClick={() =>
                  view.length > 0 &&
                  setSel({
                    anchor: { r: 0, c: 0 },
                    focus: { r: view.length - 1, c: headers.length - 1 },
                  })
                }
                title="Select all"
                className="sticky left-0 z-20 cursor-pointer border-b border-r border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-right font-normal text-(--color-fg-muted) hover:text-(--color-fg)"
              >
                #
              </th>
              {result.columns.map((c, ci) => (
                <th
                  key={c.name}
                  onClick={() => toggleSort(ci)}
                  title={`${c.name} · ${c.dataType}\nClick to sort`}
                  className="group relative cursor-pointer select-none border-b border-r border-(--color-border) bg-(--color-surface) px-2 py-1.5 text-left font-normal hover:bg-(--color-surface-2)"
                >
                  <div className="flex items-center gap-1 overflow-hidden">
                    <span className="truncate font-semibold text-(--color-fg)">
                      {c.name}
                    </span>
                    <span className="truncate text-[10px] text-(--color-fg-muted)">
                      {c.dataType.toLowerCase()}
                    </span>
                    <span className="ml-auto shrink-0 text-(--color-accent)">
                      {sort?.col === ci &&
                        (sort.dir === "asc" ? (
                          <ArrowUp size={11} />
                        ) : (
                          <ArrowDown size={11} />
                        ))}
                    </span>
                  </div>
                  <ResizeHandle columnId={`col:${c.name}`} />
                </th>
              ))}
              <th className="border-b border-(--color-border) bg-(--color-surface)" />
            </tr>
          </thead>
          <tbody>
            {view.map(({ row, i }, ri) => {
              const rowSelected =
                !!bounds &&
                ri >= bounds.r0 &&
                ri <= bounds.r1 &&
                bounds.c0 === 0 &&
                bounds.c1 === headers.length - 1;
              return (
                <tr key={i} className="group/row">
                  <td
                    onMouseDown={(e) => {
                      e.preventDefault();
                      gridRef.current?.focus();
                      const focus = { r: ri, c: headers.length - 1 };
                      setSel(
                        e.shiftKey && sel
                          ? { anchor: { r: sel.anchor.r, c: 0 }, focus }
                          : { anchor: { r: ri, c: 0 }, focus },
                      );
                    }}
                    title="Select row"
                    className={`sticky left-0 cursor-pointer border-b border-r border-(--color-border) px-2 py-1 text-right text-[10px] ${
                      rowSelected
                        ? "bg-(--color-accent) text-(--color-accent-fg)"
                        : "bg-(--color-surface) text-(--color-fg-muted) group-hover/row:text-(--color-fg)"
                    }`}
                  >
                    {i + 1}
                  </td>
                  {row.map((cell, ci) => {
                    const isNull = cell === null || cell === undefined;
                    const selected = inSel(ri, ci);
                    const text = renderCell(cell);
                    return (
                      <td
                        key={ci}
                        data-cell={`${ri}:${ci}`}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          e.preventDefault();
                          gridRef.current?.focus();
                          dragging.current = true;
                          const at = { r: ri, c: ci };
                          setSel(
                            e.shiftKey && sel
                              ? { anchor: sel.anchor, focus: at }
                              : { anchor: at, focus: at },
                          );
                        }}
                        onMouseEnter={() => {
                          if (dragging.current && sel) {
                            setSel({
                              anchor: sel.anchor,
                              focus: { r: ri, c: ci },
                            });
                          }
                        }}
                        onDoubleClick={() =>
                          setExpanded({ column: headers[ci], value: cell })
                        }
                        title={isNull ? "NULL" : text}
                        className={`group/cell relative cursor-cell truncate border-b border-r border-(--color-border) px-2 py-1 ${
                          typeof cell === "number"
                            ? "text-right tabular-nums"
                            : ""
                        } ${
                          selected
                            ? "bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
                            : ri % 2 === 1
                              ? "bg-(--color-surface) group-hover/row:bg-(--color-surface-2)"
                              : "group-hover/row:bg-(--color-surface-2)"
                        } ${
                          selected && selCount === 1
                            ? "outline-2 -outline-offset-2 outline-(--color-accent)"
                            : ""
                        }`}
                      >
                        {isNull ? (
                          <span className="rounded bg-(--color-surface-2) px-1 text-[10px] italic text-(--color-fg-muted)">
                            NULL
                          </span>
                        ) : (
                          <span className="text-(--color-fg)">{text}</span>
                        )}
                        <span className="absolute right-0.5 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover/cell:flex">
                          <CellButton
                            title="Show full value"
                            onClick={() =>
                              setExpanded({ column: headers[ci], value: cell })
                            }
                          >
                            <Maximize2 size={10} />
                          </CellButton>
                          <CellButton
                            title="Copy value"
                            onClick={() =>
                              void copyText(exportCell(cell), "value")
                            }
                          >
                            <Copy size={10} />
                          </CellButton>
                        </span>
                      </td>
                    );
                  })}
                  <td className="border-b border-(--color-border)" />
                </tr>
              );
            })}
          </tbody>
        </table>
        {view.length === 0 && (
          <div className="p-6 text-center text-xs text-(--color-fg-muted)">
            {result.rows.length === 0
              ? "No rows returned — nothing matched this query."
              : `No rows match “${filter}”.`}
          </div>
        )}
      </div>

      {expanded && (
        <ValueDialog
          column={expanded.column}
          value={expanded.value}
          onClose={() => setExpanded(null)}
        />
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function MenuItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left hover:bg-(--color-surface-2)"
    >
      <span className="text-(--color-fg)">{label}</span>
      <span className="text-[10px] text-(--color-fg-muted)">{hint}</span>
    </button>
  );
}

function CellButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded border border-(--color-border) bg-(--color-surface) p-0.5 text-(--color-fg-muted) shadow-sm hover:text-(--color-fg)"
    >
      {children}
    </button>
  );
}

function ValueDialog({
  column,
  value,
  onClose,
}: {
  column: string;
  value: unknown;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isNull = value === null || value === undefined;
  let text = renderCell(value);
  // Pretty-print JSON-looking values.
  if (typeof value === "object" && value !== null) {
    text = JSON.stringify(value, null, 2);
  } else if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      // not JSON
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={column}
      footer={
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={() => {
              void navigator.clipboard
                ?.writeText(isNull ? "" : text)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                })
                .catch(() => {});
            }}
            className="flex items-center gap-1 rounded bg-(--color-accent) px-3 py-1 text-(--color-accent-fg) hover:opacity-90"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      }
    >
      {isNull ? (
        <div className="text-xs italic text-(--color-fg-muted)">NULL</div>
      ) : (
        <pre className="max-h-[60vh] select-text overflow-auto whitespace-pre-wrap break-all rounded-md bg-(--color-surface-2) p-3 font-mono text-xs text-(--color-fg)">
          {text}
        </pre>
      )}
    </Modal>
  );
}
