import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Calendar,
  Check,
  ChevronDown,
  Code2,
  Columns3,
  Copy,
  Filter,
  Hash,
  ListOrdered,
  Play,
  Plus,
  Search,
  Table2,
  ToggleLeft,
  Type,
  X,
} from "lucide-react";
import {
  FILTER_OPS,
  opTakesValue,
  type BuilderFilter,
  type BuilderState,
  type FilterOp,
  type TableColumn,
} from "./sql-utils";

type Kind = "number" | "text" | "date" | "bool" | "other";

function kindOf(dataType: string | undefined): Kind {
  const t = (dataType ?? "").toLowerCase();
  if (/bool/.test(t)) return "bool";
  if (/date|time/.test(t)) return "date";
  if (/int|numeric|decimal|real|double|float|serial|money|number/.test(t))
    return "number";
  if (/char|text|string|uuid|json|enum/.test(t)) return "text";
  return "other";
}

const KIND_ICON: Record<Kind, typeof Hash> = {
  number: Hash,
  text: Type,
  date: Calendar,
  bool: ToggleLeft,
  other: Type,
};

/** Operators that make sense for a column type, so the menu stays short. */
function opsFor(kind: Kind): FilterOp[] {
  const nulls: FilterOp[] = ["null", "notnull"];
  switch (kind) {
    case "number":
    case "date":
      return ["=", "!=", ">", ">=", "<", "<=", "in", ...nulls];
    case "bool":
      return ["=", "!=", ...nulls];
    case "text":
      return ["contains", "=", "!=", "starts", "ends", "in", ...nulls];
    default:
      return FILTER_OPS.map((o) => o.value);
  }
}

const OP_LABEL = new Map(FILTER_OPS.map((o) => [o.value, o.label]));
const LIMIT_PRESETS = [10, 100, 1000];

/**
 * Form-driven SELECT builder for people who don't write SQL. The parent turns
 * `value` into SQL (see `buildSelectSql`) so Run behaves the same in both modes.
 */
export function QueryBuilder({
  tables,
  columns,
  value,
  onChange,
  onNeedColumns,
  sql,
  canRun,
  running,
  onRun,
  onEditSql,
}: {
  tables: string[];
  /** Columns of `value.table`, or undefined while loading. */
  columns: TableColumn[] | undefined;
  value: BuilderState;
  onChange: (next: BuilderState) => void;
  onNeedColumns: (table: string) => void;
  sql: string;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  onEditSql: () => void;
}) {
  const set = (patch: Partial<BuilderState>) =>
    onChange({ ...value, ...patch });

  useEffect(() => {
    if (value.table && !columns) onNeedColumns(value.table);
  }, [value.table, columns, onNeedColumns]);

  const cols = useMemo(() => columns ?? [], [columns]);
  const types = useMemo(
    () => new Map(cols.map((c) => [c.name, c.dataType])),
    [cols],
  );

  if (tables.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-(--color-fg-muted)">
        <Table2 size={20} className="opacity-50" />
        Connect to a database to start building a query.
      </div>
    );
  }

  const addFilter = () => {
    const first = cols[0];
    set({
      filters: [
        ...value.filters,
        {
          id: Math.random().toString(36).slice(2, 8),
          column: first?.name ?? "",
          op: opsFor(kindOf(first?.dataType))[0],
          value: "",
        },
      ],
    });
  };

  const orderKind = kindOf(types.get(value.orderBy));

  return (
    <div className="@container h-full overflow-auto">
      <div className="flex flex-col gap-3 p-3 @3xl:flex-row @3xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Card icon={Table2} title="From table">
            <TablePicker
              tables={tables}
              value={value.table}
              onChange={(table) =>
                onChange({
                  ...value,
                  table,
                  columns: [],
                  filters: [],
                  orderBy: "",
                })
              }
            />
          </Card>

          {value.table && (
            <>
              <ColumnsCard
                cols={cols}
                loading={!columns}
                value={value}
                set={set}
              />

              <Card
                icon={Filter}
                title="Filter rows"
                hint="optional"
                aside={
                  value.filters.length > 0 && (
                    <button
                      onClick={() => set({ filters: [] })}
                      className="text-[11px] text-(--color-fg-muted) hover:text-(--color-fg)"
                    >
                      Clear all
                    </button>
                  )
                }
              >
                <div className="flex flex-col gap-1.5">
                  {value.filters.length === 0 && (
                    <div className="text-[11px] text-(--color-fg-muted)">
                      No filters — every row is included.
                    </div>
                  )}
                  {value.filters.map((f, i) => (
                    <FilterRow
                      key={f.id}
                      index={i}
                      filter={f}
                      cols={cols}
                      kind={kindOf(types.get(f.column))}
                      match={value.match}
                      onToggleMatch={() =>
                        set({ match: value.match === "all" ? "any" : "all" })
                      }
                      onChange={(patch) =>
                        set({
                          filters: value.filters.map((x) =>
                            x.id === f.id ? { ...x, ...patch } : x,
                          ),
                        })
                      }
                      onRemove={() =>
                        set({
                          filters: value.filters.filter((x) => x.id !== f.id),
                        })
                      }
                    />
                  ))}
                  <button
                    onClick={addFilter}
                    disabled={cols.length === 0}
                    className="mt-0.5 flex w-fit items-center gap-1 rounded-md border border-dashed border-(--color-border) px-2.5 py-1 text-[11px] text-(--color-fg-muted) transition-colors hover:border-(--color-accent) hover:text-(--color-accent) disabled:opacity-40"
                  >
                    <Plus size={12} /> Add filter
                  </button>
                </div>
              </Card>

              {!value.countOnly && (
                <Card icon={ListOrdered} title="Sort & limit">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Label>Sort by</Label>
                      <select
                        value={value.orderBy}
                        onChange={(e) => set({ orderBy: e.target.value })}
                        className="input w-44! py-1! font-mono text-xs"
                      >
                        <option value="">— none —</option>
                        {cols.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      {value.orderBy && (
                        <Segmented
                          value={value.orderDir}
                          onChange={(d) => set({ orderDir: d })}
                          options={[
                            {
                              value: "ASC",
                              label: sortLabel(orderKind, "ASC"),
                              icon: ArrowUpNarrowWide,
                            },
                            {
                              value: "DESC",
                              label: sortLabel(orderKind, "DESC"),
                              icon: ArrowDownWideNarrow,
                            },
                          ]}
                        />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Label>Max rows</Label>
                      <Segmented
                        value={
                          value.limit === null
                            ? "all"
                            : LIMIT_PRESETS.includes(value.limit)
                              ? String(value.limit)
                              : "custom"
                        }
                        onChange={(v) =>
                          v !== "custom" &&
                          set({ limit: v === "all" ? null : Number(v) })
                        }
                        options={[
                          ...LIMIT_PRESETS.map((n) => ({
                            value: String(n),
                            label: n.toLocaleString(),
                          })),
                          { value: "all", label: "All" },
                        ]}
                      />
                      <input
                        type="number"
                        min={1}
                        value={
                          value.limit !== null &&
                          !LIMIT_PRESETS.includes(value.limit)
                            ? value.limit
                            : ""
                        }
                        onChange={(e) =>
                          set({
                            limit:
                              e.target.value === ""
                                ? 100
                                : Number(e.target.value),
                          })
                        }
                        placeholder="custom"
                        className="input w-20! py-1! text-xs"
                      />
                    </div>
                  </div>
                </Card>
              )}
            </>
          )}
        </div>

        {value.table && (
          <PreviewCard
            summary={describe(value, types)}
            sql={sql}
            canRun={canRun}
            running={running}
            onRun={onRun}
            onEditSql={onEditSql}
          />
        )}
      </div>
    </div>
  );
}

// ── Sections ───────────────────────────────────────────────────────────────

function ColumnsCard({
  cols,
  loading,
  value,
  set,
}: {
  cols: TableColumn[];
  loading: boolean;
  value: BuilderState;
  set: (patch: Partial<BuilderState>) => void;
}) {
  const [q, setQ] = useState("");
  const f = q.trim().toLowerCase();
  const shown = f ? cols.filter((c) => c.name.toLowerCase().includes(f)) : cols;
  const all = value.columns.length === 0;

  const toggle = (name: string) => {
    const has = value.columns.includes(name);
    set({
      columns: has
        ? value.columns.filter((c) => c !== name)
        : // Keep table order so the result columns match the schema.
          cols
            .map((c) => c.name)
            .filter((n) => n === name || value.columns.includes(n)),
    });
  };

  return (
    <Card
      icon={Columns3}
      title="Show"
      hint={
        value.countOnly || loading
          ? undefined
          : all
            ? `all ${cols.length} columns`
            : `${value.columns.length} of ${cols.length} columns`
      }
      aside={
        <Segmented
          value={value.countOnly ? "count" : "rows"}
          onChange={(v) => set({ countOnly: v === "count" })}
          options={[
            { value: "rows", label: "Rows" },
            { value: "count", label: "Count only" },
          ]}
        />
      }
    >
      {loading ? (
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <span
              key={i}
              className="h-6 w-20 animate-pulse rounded-md bg-(--color-surface-2)"
            />
          ))}
        </div>
      ) : value.countOnly ? (
        <div className="text-[11px] text-(--color-fg-muted)">
          Returns a single number: how many rows match your filters.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {cols.length > 10 && (
              <div className="relative">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-(--color-fg-muted)"
                />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find column…"
                  className="input w-44! py-1! pl-7! text-xs"
                />
              </div>
            )}
            <span className="text-[11px] text-(--color-fg-muted)">
              {all
                ? "Showing every column — click to pick specific ones."
                : "Only the highlighted columns will be shown."}
            </span>
            {!all && (
              <button
                onClick={() => set({ columns: [] })}
                className="text-[11px] font-medium text-(--color-accent) hover:underline"
              >
                Show all
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {shown.map((c) => {
              const on = !all && value.columns.includes(c.name);
              const Icon = KIND_ICON[kindOf(c.dataType)];
              return (
                <button
                  key={c.name}
                  onClick={() => toggle(c.name)}
                  title={`${c.name} · ${c.dataType}`}
                  className={`flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                    on
                      ? "border-(--color-accent) bg-(--color-accent) text-(--color-accent-fg)"
                      : all
                        ? "border-(--color-border) bg-(--color-surface-2) text-(--color-fg) hover:border-(--color-accent)"
                        : "border-(--color-border) text-(--color-fg-muted) hover:border-(--color-accent) hover:text-(--color-fg)"
                  }`}
                >
                  {on ? (
                    <Check size={11} />
                  ) : (
                    <Icon size={11} className="opacity-60" />
                  )}
                  {c.name}
                </button>
              );
            })}
            {shown.length === 0 && (
              <span className="text-[11px] text-(--color-fg-muted)">
                No columns match “{q}”.
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function FilterRow({
  index,
  filter: f,
  cols,
  kind,
  match,
  onToggleMatch,
  onChange,
  onRemove,
}: {
  index: number;
  filter: BuilderFilter;
  cols: TableColumn[];
  kind: Kind;
  match: "all" | "any";
  onToggleMatch: () => void;
  onChange: (patch: Partial<BuilderFilter>) => void;
  onRemove: () => void;
}) {
  const ops = opsFor(kind);
  return (
    <div className="group flex flex-wrap items-center gap-1.5 rounded-md bg-(--color-surface-2) p-1.5">
      {index === 0 ? (
        <span className="w-12 text-center text-[11px] font-medium text-(--color-fg-muted)">
          where
        </span>
      ) : (
        <button
          onClick={onToggleMatch}
          title="Click to switch between AND / OR"
          className="w-12 rounded border border-(--color-border) bg-(--color-surface) py-0.5 text-[10px] font-semibold uppercase text-(--color-accent) hover:border-(--color-accent)"
        >
          {match === "all" ? "and" : "or"}
        </button>
      )}
      <select
        value={f.column}
        onChange={(e) => {
          const col = cols.find((c) => c.name === e.target.value);
          const nextOps = opsFor(kindOf(col?.dataType));
          onChange({
            column: e.target.value,
            op: nextOps.includes(f.op) ? f.op : nextOps[0],
          });
        }}
        className="input w-40! bg-(--color-surface)! py-1! font-mono text-xs"
      >
        {cols.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <select
        value={f.op}
        onChange={(e) => onChange({ op: e.target.value as FilterOp })}
        className="input w-36! bg-(--color-surface)! py-1! text-xs"
      >
        {ops.map((o) => (
          <option key={o} value={o}>
            {OP_LABEL.get(o)}
          </option>
        ))}
      </select>
      {opTakesValue(f.op) &&
        (kind === "bool" ? (
          <Segmented
            value={f.value.toLowerCase() === "false" ? "false" : "true"}
            onChange={(v) => onChange({ value: v })}
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
          />
        ) : (
          <input
            value={f.value}
            onChange={(e) => onChange({ value: e.target.value })}
            placeholder={
              f.op === "in"
                ? "a, b, c"
                : kind === "number"
                  ? "number"
                  : kind === "date"
                    ? "YYYY-MM-DD"
                    : "text"
            }
            inputMode={kind === "number" ? "decimal" : undefined}
            className="input w-auto! min-w-28 flex-1 bg-(--color-surface)! py-1! font-mono text-xs"
          />
        ))}
      <button
        onClick={onRemove}
        title="Remove filter"
        className="ml-auto rounded p-1 text-(--color-fg-muted) opacity-60 hover:bg-(--color-surface) hover:text-(--color-error) group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function PreviewCard({
  summary,
  sql,
  canRun,
  running,
  onRun,
  onEditSql,
}: {
  summary: string;
  sql: string;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  onEditSql: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) p-3 @3xl:sticky @3xl:top-0 @3xl:w-80 @3xl:shrink-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-(--color-fg-muted)">
        This query will
      </div>
      <p className="text-xs leading-relaxed text-(--color-fg)">{summary}</p>
      <div className="relative">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-(--color-surface-2) p-2 pr-7 font-mono text-[11px] text-(--color-fg)">
          {sql}
        </pre>
        <button
          onClick={() => {
            void navigator.clipboard
              ?.writeText(sql)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
              .catch(() => {});
          }}
          title="Copy SQL"
          className="absolute right-1 top-1 rounded p-1 text-(--color-fg-muted) hover:bg-(--color-surface) hover:text-(--color-fg)"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={onRun}
          disabled={!canRun || running}
          className="flex flex-1 items-center justify-center gap-1 rounded-md bg-(--color-accent) px-2 py-1 text-xs text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
        >
          <Play size={12} /> {running ? "Running…" : "Run query"}
        </button>
        <button
          onClick={onEditSql}
          title="Keep editing this query as SQL"
          className="flex items-center gap-1 rounded-md border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
        >
          <Code2 size={12} /> Edit as SQL
        </button>
      </div>
    </div>
  );
}

// ── Primitives ─────────────────────────────────────────────────────────────

function Card({
  icon: Icon,
  title,
  hint,
  aside,
  children,
}: {
  icon: typeof Hash;
  title: string;
  hint?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-(--color-border) bg-(--color-surface) text-xs">
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <Icon size={13} className="text-(--color-accent)" />
        <span className="font-semibold text-(--color-fg)">{title}</span>
        {hint && (
          <span className="text-[11px] text-(--color-fg-muted)">· {hint}</span>
        )}
        {aside && <span className="ml-auto">{aside}</span>}
      </header>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] text-(--color-fg-muted)">{children}</span>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: typeof Hash }[];
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-(--color-border) bg-(--color-surface) text-[11px]">
      {options.map((o, i) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1 px-2 py-0.5 transition-colors ${
              i > 0 ? "border-l border-(--color-border)" : ""
            } ${
              value === o.value
                ? "bg-(--color-accent) text-(--color-accent-fg)"
                : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            }`}
          >
            {Icon && <Icon size={11} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function TablePicker({
  tables,
  value,
  onChange,
}: {
  tables: string[];
  value: string;
  onChange: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<React.ComponentRef<"ul">>(null);

  const f = q.trim().toLowerCase();
  const shown = f ? tables.filter((t) => t.toLowerCase().includes(f)) : tables;

  const openMenu = () => {
    setQ("");
    setHi(Math.max(0, tables.indexOf(value)));
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${hi}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const pick = (t: string) => {
    onChange(t);
    setOpen(false);
  };

  return (
    <div className="relative max-w-md">
      <button
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`flex w-full items-center gap-2 rounded-md border border-(--color-border) bg-(--color-surface-2) px-2.5 py-1.5 text-left text-xs transition-colors hover:border-(--color-accent) ${
          value ? "font-mono text-(--color-fg)" : "text-(--color-fg-muted)"
        }`}
      >
        <Table2 size={12} className="shrink-0 text-(--color-fg-muted)" />
        <span className="min-w-0 flex-1 truncate">
          {value || "Choose a table…"}
        </span>
        <ChevronDown size={12} className="shrink-0 text-(--color-fg-muted)" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-(--color-border) bg-(--color-surface) shadow-lg">
            <div className="relative border-b border-(--color-border) p-1.5">
              <Search
                size={12}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-(--color-fg-muted)"
              />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setHi(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHi((h) => Math.min(h + 1, shown.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHi((h) => Math.max(h - 1, 0));
                  } else if (e.key === "Enter" && shown[hi]) {
                    pick(shown[hi]);
                  } else if (e.key === "Escape") {
                    setOpen(false);
                  }
                }}
                placeholder={`Search ${tables.length} tables…`}
                className="input py-1! pl-7! text-xs"
              />
            </div>
            <ul ref={listRef} className="max-h-60 overflow-auto py-1">
              {shown.length === 0 && (
                <li className="px-3 py-1.5 text-(--color-fg-muted)">
                  No tables match.
                </li>
              )}
              {shown.map((t, i) => (
                <li
                  key={t}
                  data-i={i}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(t)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-1 font-mono text-[11px] ${
                    i === hi ? "bg-(--color-surface-2)" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{t}</span>
                  {t === value && (
                    <Check size={12} className="text-(--color-accent)" />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// ── Plain-English summary ──────────────────────────────────────────────────

function sortLabel(kind: Kind, dir: "ASC" | "DESC"): string {
  if (kind === "date") return dir === "ASC" ? "Oldest first" : "Newest first";
  if (kind === "number")
    return dir === "ASC" ? "Smallest first" : "Largest first";
  if (kind === "text") return dir === "ASC" ? "A → Z" : "Z → A";
  return dir === "ASC" ? "Ascending" : "Descending";
}

function describe(b: BuilderState, types: Map<string, string>): string {
  const what = b.countOnly
    ? "Count the rows"
    : b.columns.length === 0
      ? "Show all columns"
      : b.columns.length <= 4
        ? `Show ${b.columns.join(", ")}`
        : `Show ${b.columns.length} columns`;
  let s = `${what} from ${b.table}`;
  const conds = b.filters
    .filter((f) => f.column && (!opTakesValue(f.op) || f.value.trim()))
    .map((f) => {
      const label = OP_LABEL.get(f.op) ?? f.op;
      if (!opTakesValue(f.op)) return `${f.column} ${label}`;
      const op = f.op === "in" ? "is one of" : label;
      return `${f.column} ${op} “${f.value.trim()}”`;
    });
  if (conds.length > 0) {
    s += ` where ${conds.join(b.match === "all" ? " and " : " or ")}`;
  }
  if (!b.countOnly && b.orderBy) {
    s += `, sorted ${sortLabel(kindOf(types.get(b.orderBy)), b.orderDir).toLowerCase()} by ${b.orderBy}`;
  }
  if (!b.countOnly) {
    s += b.limit ? `, up to ${b.limit.toLocaleString()} rows` : ", all rows";
  }
  return s + ".";
}
