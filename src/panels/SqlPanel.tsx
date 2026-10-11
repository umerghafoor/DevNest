import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Play,
  Save,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  Wand2,
} from "lucide-react";
import "../lib/monaco-setup";
import { api, errorMessage } from "../lib/api";
import type { SqlEngine, SqlQueryResult } from "../lib/api";
import {
  useSqlQueriesStore,
  useSqlStore,
  type SavedSqlConnection,
  type SavedSqlQuery,
} from "../store/sql-store";
import { useAppStore } from "../store/app-store";
import { useThemeStore } from "../store/theme-store";
import { usePaneSettings } from "../store/pane-settings-store";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { Splitter } from "../components/Splitter";
import { notifyCompleted } from "../lib/notify";
import { QueryBuilder } from "./sql/QueryBuilder";
import { ResultsPane } from "./sql/ResultsPane";
import {
  registerSqlCompletion,
  setCompletionSchema,
} from "./sql/sql-completion";
import {
  EMPTY_BUILDER,
  buildSelectSql,
  columnsSql,
  selectAllSql,
  templates,
  type BuilderState,
  type TableColumn,
} from "./sql/sql-utils";

const ENGINE_LABELS: Record<SqlEngine, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  sqlite: "SQLite",
};

const ENGINE_DEFAULT_PORTS: Record<SqlEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
};

const TUNNEL_PREFIX = "sql:";

const DEFAULT_LAYOUT = { sqlSidebarW: 260, sqlEditorFrac: 0.4 };

type ConnState = "disconnected" | "connecting" | "connected" | "error";
type EditorMode = "sql" | "builder";
type RailTab = "tables" | "saved";

function isRetryableSshError(message: string | null): boolean {
  return !!message && message.toLowerCase().includes("device not connected");
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function SqlPanel({ paneId }: { paneId?: string } = {}) {
  const saved = useSqlStore((s) => s.saved);
  const activeId = useSqlStore((s) => s.activeId);
  const setActive = useSqlStore((s) => s.setActive);
  const addConn = useSqlStore((s) => s.add);
  const updateConn = useSqlStore((s) => s.update);
  const removeConn = useSqlStore((s) => s.remove);

  const queries = useSqlQueriesStore((s) => s.queries);
  const saveQuery = useSqlQueriesStore((s) => s.save);
  const updateQuery = useSqlQueriesStore((s) => s.update);
  const removeQuery = useSqlQueriesStore((s) => s.remove);

  const [layoutSettings, updateLayoutSettings] = usePaneSettings(
    paneId,
    DEFAULT_LAYOUT,
  );
  // Local copy so splitters still work for panes without an id.
  const [sidebarW, setSidebarW] = useState(layoutSettings.sqlSidebarW);
  const [editorFrac, setEditorFrac] = useState(layoutSettings.sqlEditorFrac);
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const [editing, setEditing] = useState<SavedSqlConnection | "new" | null>(
    null,
  );
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connError, setConnError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [columnsByTable, setColumnsByTable] = useState<
    Record<string, TableColumn[]>
  >({});
  const [sql, setSql] = useState("SELECT 1;");
  const [mode, setMode] = useState<EditorMode>("sql");
  const [builder, setBuilder] = useState<BuilderState>(EMPTY_BUILDER);
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [queryErr, setQueryErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [currentQueryId, setCurrentQueryId] = useState<string | null>(null);
  const [saveDialog, setSaveDialog] = useState<"new" | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const columnsLoading = useRef(new Set<string>());

  const active = saved.find((c) => c.id === activeId) ?? null;
  const engine: SqlEngine = active?.engine ?? "postgres";
  const currentQuery = queries.find((q) => q.id === currentQueryId) ?? null;
  const dirty = !!currentQuery && currentQuery.sql !== sql;

  // Close any open tunnel when the active connection changes or panel unmounts.
  useEffect(() => {
    return () => {
      const tid = tunnelIdRef.current;
      if (tid) {
        void api.sqlCloseTunnel(tid);
        tunnelIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setCompletionSchema({ tables, columns: columnsByTable });
  }, [tables, columnsByTable]);

  const loadColumns = useCallback(
    async (table: string) => {
      if (!active || columnsLoading.current.has(table)) return;
      columnsLoading.current.add(table);
      try {
        const r = await api.sqlQuery(
          active.id,
          columnsSql(active.engine, table),
        );
        const cols = r.rows.map((row) => ({
          name: String(row[0] ?? ""),
          dataType: String(row[1] ?? ""),
        }));
        setColumnsByTable((prev) => ({ ...prev, [table]: cols }));
      } catch {
        setColumnsByTable((prev) => ({ ...prev, [table]: [] }));
      } finally {
        columnsLoading.current.delete(table);
      }
    },
    [active],
  );

  const resetSchema = () => {
    setTables([]);
    setColumnsByTable({});
    columnsLoading.current.clear();
  };

  const connect = async (conn: SavedSqlConnection) => {
    setConnError(null);
    setConnState("connecting");
    try {
      let host = conn.host;
      let port = conn.port;
      if (conn.viaDeviceId) {
        const tunnelId = TUNNEL_PREFIX + conn.id;
        if (tunnelIdRef.current) {
          await api.sqlCloseTunnel(tunnelIdRef.current);
          tunnelIdRef.current = null;
        }
        const localPort = await api.sqlOpenTunnel(
          tunnelId,
          conn.viaDeviceId,
          conn.host,
          conn.port,
        );
        tunnelIdRef.current = tunnelId;
        host = "127.0.0.1";
        port = localPort;
      }

      await api.sqlConnect({
        id: conn.id,
        engine: conn.engine,
        host,
        port,
        username: conn.username,
        database: conn.database || null,
      });
      setConnState("connected");
      resetSchema();
      const t = await api.sqlListTables(conn.id).catch(() => [] as string[]);
      setTables(t);
    } catch (e) {
      setConnState("error");
      setConnError(errorMessage(e));
      if (tunnelIdRef.current) {
        await api.sqlCloseTunnel(tunnelIdRef.current).catch(() => {});
        tunnelIdRef.current = null;
      }
    }
  };

  const disconnect = async (id: string) => {
    await api.sqlDisconnect(id).catch(() => {});
    if (tunnelIdRef.current) {
      await api.sqlCloseTunnel(tunnelIdRef.current).catch(() => {});
      tunnelIdRef.current = null;
    }
    setConnState("disconnected");
    resetSchema();
    setResult(null);
    setQueryErr(null);
  };

  const onSelect = async (conn: SavedSqlConnection) => {
    if (active && active.id !== conn.id && connState === "connected") {
      await disconnect(active.id);
    }
    setActive(conn.id);
    setResult(null);
    setQueryErr(null);
    resetSchema();
    setBuilder(EMPTY_BUILDER);
    setConnState("disconnected");
  };

  const onRun = async (text?: string) => {
    const toRun = (text ?? sql).trim();
    if (!active || connState !== "connected" || !toRun) return;
    setRunning(true);
    setQueryErr(null);
    const startedAt = performance.now();
    try {
      const r = await api.sqlQuery(active.id, toRun);
      setResult(r);
      const elapsed = performance.now() - startedAt;
      if (elapsed > 10000) {
        const rowCount = r.rows.length;
        notifyCompleted(
          `SQL query finished on ${active.name}`,
          `${rowCount} row${rowCount === 1 ? "" : "s"} · ${Math.round(elapsed)} ms`,
        );
      }
    } catch (e) {
      setResult(null);
      setQueryErr(errorMessage(e));
      const elapsed = performance.now() - startedAt;
      if (elapsed > 10000) {
        notifyCompleted(
          `SQL query failed on ${active.name}`,
          `${Math.round(elapsed)} ms`,
        );
      }
    } finally {
      setRunning(false);
    }
  };

  // Monaco keybindings are registered once at mount; route them through a ref
  // so they always see the latest sql / connection state.
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const saveRef = useRef<() => void>(() => {});

  const updateBuilder = (next: BuilderState) => {
    setBuilder(next);
    setSql(
      buildSelectSql(engine, next, columnsByTable[next.table] ?? []) ||
        "SELECT 1;",
    );
    setCurrentQueryId(null);
  };

  // Columns arrive asynchronously; regenerate so typed literals pick them up.
  const builderCols = columnsByTable[builder.table];
  useEffect(() => {
    if (mode !== "builder" || !builder.table) return;
    setSql(buildSelectSql(engine, builder, builderCols ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderCols]);

  // Only fills the editor; running is always the user's call.
  const openTable = (table: string, run = false) => {
    const q = selectAllSql(engine, table);
    setMode("sql");
    setSql(q);
    setCurrentQueryId(null);
    if (run) void onRun(q);
    void loadColumns(table);
  };

  const buildFromTable = (table: string) => {
    setMode("builder");
    updateBuilder({ ...EMPTY_BUILDER, table });
  };

  const insertAtCursor = (text: string) => {
    const ed = editorRef.current;
    if (mode !== "sql" || !ed) {
      void navigator.clipboard?.writeText(text).catch(() => {});
      toast.success(`Copied "${text}"`);
      return;
    }
    const sel = ed.getSelection();
    if (!sel) return;
    ed.executeEdits("insert-identifier", [{ range: sel, text }]);
    ed.focus();
  };

  const loadSavedQuery = (q: SavedSqlQuery, run: boolean) => {
    setMode("sql");
    setSql(q.sql);
    setCurrentQueryId(q.id);
    if (run) void onRun(q.sql);
  };

  const onSave = () => {
    if (!sql.trim()) return;
    if (currentQuery) {
      updateQuery(currentQuery.id, { sql });
      toast.success(`Saved "${currentQuery.name}"`);
    } else {
      setSaveDialog("new");
    }
  };
  saveRef.current = onSave;

  const visibleQueries = useMemo(
    () =>
      queries.filter(
        (q) => !q.connectionId || !active || q.connectionId === active.id,
      ),
    [queries, active],
  );

  const tpl = useMemo(() => {
    const t = builder.table || tables[0] || null;
    return templates(engine, t, t ? (columnsByTable[t] ?? []) : []);
  }, [engine, builder.table, tables, columnsByTable]);

  const connected = connState === "connected";

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="flex shrink-0" style={{ width: sidebarW }}>
          <ConnectionRail
            saved={saved}
            activeId={active?.id ?? null}
            connState={connState}
            tables={tables}
            columnsByTable={columnsByTable}
            queries={visibleQueries}
            currentQueryId={currentQueryId}
            onSelect={onSelect}
            onNew={() => setEditing("new")}
            onEdit={(c) => setEditing(c)}
            onDelete={async (c) => {
              const ok = await confirm(`Remove connection "${c.name}"?`, {
                title: "Delete connection",
                destructive: true,
              });
              if (!ok) return;
              if (active?.id === c.id) await disconnect(c.id);
              await api.sqlClearPassword(c.id).catch(() => {});
              removeConn(c.id);
            }}
            onConnect={connect}
            onDisconnect={(c) => disconnect(c.id)}
            onOpenTable={openTable}
            onBuildTable={buildFromTable}
            onExpandTable={(t) => void loadColumns(t)}
            onInsert={insertAtCursor}
            onLoadQuery={loadSavedQuery}
            onDeleteQuery={async (q) => {
              const ok = await confirm(`Delete saved query "${q.name}"?`, {
                title: "Delete query",
                destructive: true,
              });
              if (!ok) return;
              removeQuery(q.id);
              if (currentQueryId === q.id) setCurrentQueryId(null);
            }}
          />
        </div>
        <Splitter
          axis="x"
          containerRef={rootRef}
          onChange={(x) => {
            const w = clamp(x, 180, 520);
            setSidebarW(w);
            updateLayoutSettings({ sqlSidebarW: w });
          }}
          onReset={() => {
            setSidebarW(DEFAULT_LAYOUT.sqlSidebarW);
            updateLayoutSettings({ sqlSidebarW: DEFAULT_LAYOUT.sqlSidebarW });
          }}
        />
        <div ref={mainRef} className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            active={active}
            connState={connState}
            connError={connError}
            running={running}
            canRun={connected && sql.trim().length > 0}
            mode={mode}
            onMode={(m) => {
              setMode(m);
              if (m === "builder" && !builder.table && tables[0]) {
                // Nothing picked yet — leave the form empty but ready.
                setBuilder(EMPTY_BUILDER);
              }
            }}
            templates={tpl}
            onTemplate={(t) => {
              setMode("sql");
              setSql(t);
              setCurrentQueryId(null);
            }}
            queryName={currentQuery?.name ?? null}
            dirty={dirty}
            onSave={onSave}
            onSaveAs={() => setSaveDialog("new")}
            onRun={() => void onRun()}
            onConnect={() => active && void connect(active)}
            onDisconnect={() => active && void disconnect(active.id)}
          />
          <div
            className="flex min-h-0 shrink-0 flex-col"
            style={{ height: `${editorFrac * 100}%` }}
          >
            {mode === "sql" ? (
              <SqlEditor
                sql={sql}
                onChange={setSql}
                onRun={(text) => void runRef.current(text)}
                onSave={() => saveRef.current()}
                onReady={(ed) => {
                  editorRef.current = ed;
                  setCompletionSchema({ tables, columns: columnsByTable });
                }}
              />
            ) : (
              <QueryBuilder
                tables={tables}
                columns={columnsByTable[builder.table]}
                value={builder}
                onChange={updateBuilder}
                onNeedColumns={(t) => void loadColumns(t)}
                sql={sql}
                canRun={connected && sql.trim().length > 0}
                running={running}
                onRun={() => void onRun()}
                onEditSql={() => setMode("sql")}
              />
            )}
          </div>
          <Splitter
            axis="y"
            containerRef={mainRef}
            onChange={(y, total) => {
              const f = clamp(y / total, 0.15, 0.85);
              setEditorFrac(f);
              updateLayoutSettings({ sqlEditorFrac: f });
            }}
            onReset={() => {
              setEditorFrac(DEFAULT_LAYOUT.sqlEditorFrac);
              updateLayoutSettings({
                sqlEditorFrac: DEFAULT_LAYOUT.sqlEditorFrac,
              });
            }}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <ResultsPane
              result={result}
              error={queryErr}
              running={running}
              paneId={paneId}
              emptyHint={
                <>
                  Tip: click a table on the left to start a query, or use the{" "}
                  <b>Builder</b> to create a query without writing SQL. Press{" "}
                  <Kbd>⇧↵</Kbd> to run.
                </>
              }
              onReconnect={() => {
                setQueryErr(null);
                if (active) void connect(active);
              }}
            />
          </div>
        </div>
      </div>

      {saveDialog && (
        <SaveQueryDialog
          connectionName={active?.name ?? null}
          onClose={() => setSaveDialog(null)}
          onSave={(name, scoped) => {
            const q = saveQuery({
              name,
              sql,
              connectionId: scoped && active ? active.id : undefined,
            });
            setCurrentQueryId(q.id);
            setSaveDialog(null);
            toast.success(`Saved "${name}"`);
          }}
        />
      )}

      {editing && (
        <ConnectionEditor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (draft, password) => {
            let id: string;
            if (editing === "new") {
              const created = addConn(draft);
              id = created.id;
            } else {
              id = editing.id;
              updateConn(id, draft);
            }
            if (password !== null) {
              if (password.length > 0) {
                await api.sqlSetPassword(id, password);
              } else {
                await api.sqlClearPassword(id).catch(() => {});
              }
            }
            setEditing(null);
            toast.success("Connection saved");
          }}
        />
      )}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function ConnectionRail({
  saved,
  activeId,
  connState,
  tables,
  columnsByTable,
  queries,
  currentQueryId,
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
  onOpenTable,
  onBuildTable,
  onExpandTable,
  onInsert,
  onLoadQuery,
  onDeleteQuery,
}: {
  saved: SavedSqlConnection[];
  activeId: string | null;
  connState: ConnState;
  tables: string[];
  columnsByTable: Record<string, TableColumn[]>;
  queries: SavedSqlQuery[];
  currentQueryId: string | null;
  onSelect: (c: SavedSqlConnection) => void;
  onNew: () => void;
  onEdit: (c: SavedSqlConnection) => void;
  onDelete: (c: SavedSqlConnection) => void;
  onConnect: (c: SavedSqlConnection) => void;
  onDisconnect: (c: SavedSqlConnection) => void;
  onOpenTable: (t: string, run?: boolean) => void;
  onBuildTable: (t: string) => void;
  onExpandTable: (t: string) => void;
  onInsert: (text: string) => void;
  onLoadQuery: (q: SavedSqlQuery, run: boolean) => void;
  onDeleteQuery: (q: SavedSqlQuery) => void;
}) {
  const [tab, setTab] = useState<RailTab>("tables");

  return (
    <aside className="flex min-w-0 flex-1 flex-col bg-(--color-surface)">
      <div className="flex items-center justify-between border-b border-(--color-border) px-3 py-2 text-xs">
        <span className="font-semibold uppercase tracking-wide text-(--color-fg-muted)">
          Connections
        </span>
        <button
          onClick={onNew}
          className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
        >
          + New
        </button>
      </div>
      <div className="max-h-[40%] shrink-0 overflow-auto text-xs">
        {saved.length === 0 && (
          <div className="px-3 py-4 text-center text-(--color-fg-muted)">
            No saved connections.
          </div>
        )}
        {saved.map((c) => {
          const isActive = c.id === activeId;
          const dot =
            isActive && connState === "connected"
              ? "bg-(--color-online)"
              : isActive && connState === "connecting"
                ? "bg-(--color-warn) animate-pulse"
                : isActive && connState === "error"
                  ? "bg-(--color-error)"
                  : "bg-(--color-offline)";
          return (
            <div key={c.id} className="border-b border-(--color-border)">
              <button
                onClick={() => onSelect(c)}
                className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  isActive
                    ? "bg-(--color-surface-2)"
                    : "hover:bg-(--color-surface-2)"
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
                <span className="min-w-0 flex-1">
                  <div className="truncate font-medium text-(--color-fg)">
                    {c.name}
                  </div>
                  <div className="truncate text-[10px] text-(--color-fg-muted)">
                    {ENGINE_LABELS[c.engine]} · {c.host}:{c.port}
                    {c.viaDeviceId ? " · via SSH" : ""}
                  </div>
                </span>
              </button>
              {isActive && (
                <div className="flex items-center gap-1 bg-(--color-surface-2) px-3 pb-2 text-[10px]">
                  {connState === "connected" ? (
                    <button
                      onClick={() => onDisconnect(c)}
                      className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface)"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => onConnect(c)}
                      disabled={connState === "connecting"}
                      className="rounded bg-(--color-accent) px-2 py-0.5 text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
                    >
                      {connState === "error" ? "Retry" : "Connect"}
                    </button>
                  )}
                  <button
                    onClick={() => onEdit(c)}
                    className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface)"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(c)}
                    className="ml-auto rounded border border-(--color-border) px-2 py-0.5 text-(--color-error) hover:bg-(--color-surface)"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 border-y border-(--color-border) text-[11px]">
        <RailTabButton
          active={tab === "tables"}
          onClick={() => setTab("tables")}
        >
          Tables{tables.length > 0 ? ` (${tables.length})` : ""}
        </RailTabButton>
        <RailTabButton active={tab === "saved"} onClick={() => setTab("saved")}>
          Saved queries{queries.length > 0 ? ` (${queries.length})` : ""}
        </RailTabButton>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "tables" ? (
          <TableList
            connected={connState === "connected"}
            tables={tables}
            columnsByTable={columnsByTable}
            onOpen={onOpenTable}
            onBuild={onBuildTable}
            onExpand={onExpandTable}
            onInsert={onInsert}
          />
        ) : (
          <SavedQueryList
            queries={queries}
            currentQueryId={currentQueryId}
            canRun={connState === "connected"}
            onLoad={onLoadQuery}
            onDelete={onDeleteQuery}
          />
        )}
      </div>
    </aside>
  );
}

function RailTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 border-b-2 px-2 py-1.5 font-medium transition-colors ${
        active
          ? "border-(--color-accent) text-(--color-fg)"
          : "border-transparent text-(--color-fg-muted) hover:text-(--color-fg)"
      }`}
    >
      {children}
    </button>
  );
}

function TableList({
  connected,
  tables,
  columnsByTable,
  onOpen,
  onBuild,
  onExpand,
  onInsert,
}: {
  connected: boolean;
  tables: string[];
  columnsByTable: Record<string, TableColumn[]>;
  onOpen: (t: string, run?: boolean) => void;
  onBuild: (t: string) => void;
  onExpand: (t: string) => void;
  onInsert: (text: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!connected) {
    return (
      <div className="px-3 py-4 text-center text-xs text-(--color-fg-muted)">
        Connect to browse tables.
      </div>
    );
  }

  const f = filter.trim().toLowerCase();
  const shown = f ? tables.filter((t) => t.toLowerCase().includes(f)) : tables;

  const toggle = (t: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else {
        next.add(t);
        onExpand(t);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="relative shrink-0 p-2">
        <Search
          size={12}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-(--color-fg-muted)"
        />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
          className="input w-full py-1 pl-7! text-xs"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-auto pb-2">
        {shown.length === 0 && (
          <li className="px-3 py-2 text-(--color-fg-muted)">No tables.</li>
        )}
        {shown.map((t) => {
          const open = expanded.has(t);
          const cols = columnsByTable[t];
          return (
            <li key={t}>
              <div
                className="group flex cursor-pointer items-center gap-1 px-1.5 py-0.5 hover:bg-(--color-surface-2)"
                onClick={() => onOpen(t)}
                title={`Click to put SELECT * FROM ${t} in the editor`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(t);
                  }}
                  title={open ? "Hide columns" : "Show columns"}
                  className="rounded p-0.5 text-(--color-fg-muted) hover:text-(--color-fg)"
                >
                  {open ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </button>
                <Table2
                  size={12}
                  className="shrink-0 text-(--color-fg-muted)"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--color-fg)">
                  {t}
                </span>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <IconButton
                    title="Run SELECT * … LIMIT 100 now"
                    onClick={() => onOpen(t, true)}
                  >
                    <Play size={11} />
                  </IconButton>
                  <IconButton
                    title="Build a query on this table"
                    onClick={() => onBuild(t)}
                  >
                    <SlidersHorizontal size={11} />
                  </IconButton>
                </span>
              </div>
              {open && (
                <ul className="ml-6 border-l border-(--color-border) pl-2">
                  {!cols ? (
                    <li className="py-0.5 text-[11px] text-(--color-fg-muted)">
                      Loading…
                    </li>
                  ) : cols.length === 0 ? (
                    <li className="py-0.5 text-[11px] text-(--color-fg-muted)">
                      No columns.
                    </li>
                  ) : (
                    cols.map((c) => (
                      <li
                        key={c.name}
                        onClick={() => onInsert(c.name)}
                        title="Click to insert into the editor"
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-(--color-surface-2)"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--color-fg)">
                          {c.name}
                        </span>
                        <span className="shrink-0 truncate text-[10px] text-(--color-fg-muted)">
                          {c.dataType.toLowerCase()}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SavedQueryList({
  queries,
  currentQueryId,
  canRun,
  onLoad,
  onDelete,
}: {
  queries: SavedSqlQuery[];
  currentQueryId: string | null;
  canRun: boolean;
  onLoad: (q: SavedSqlQuery, run: boolean) => void;
  onDelete: (q: SavedSqlQuery) => void;
}) {
  if (queries.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-xs text-(--color-fg-muted)">
        No saved queries yet.
        <div className="mt-1 text-[11px]">
          Write a query and press <Kbd>⌘S</Kbd> or click Save.
        </div>
      </div>
    );
  }
  return (
    <ul className="h-full overflow-auto py-1 text-xs">
      {queries.map((q) => (
        <li
          key={q.id}
          onClick={() => onLoad(q, false)}
          title={q.sql}
          className={`group flex cursor-pointer items-center gap-1 px-2 py-1 ${
            q.id === currentQueryId
              ? "bg-(--color-surface-2)"
              : "hover:bg-(--color-surface-2)"
          }`}
        >
          <span className="min-w-0 flex-1">
            <div className="truncate font-medium text-(--color-fg)">
              {q.name}
            </div>
            <div className="truncate font-mono text-[10px] text-(--color-fg-muted)">
              {q.sql.replace(/\s+/g, " ")}
            </div>
          </span>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            {canRun && (
              <IconButton title="Load and run" onClick={() => onLoad(q, true)}>
                <Play size={11} />
              </IconButton>
            )}
            <IconButton title="Delete" danger onClick={() => onDelete(q)}>
              <Trash2 size={11} />
            </IconButton>
          </span>
        </li>
      ))}
    </ul>
  );
}

function IconButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded p-1 text-(--color-fg-muted) hover:bg-(--color-surface) ${
        danger ? "hover:text-(--color-error)" : "hover:text-(--color-fg)"
      }`}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-(--color-border) bg-(--color-surface-2) px-1 font-mono text-[10px]">
      {children}
    </kbd>
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({
  active,
  connState,
  connError,
  running,
  canRun,
  mode,
  onMode,
  templates,
  onTemplate,
  queryName,
  dirty,
  onSave,
  onSaveAs,
  onRun,
  onConnect,
  onDisconnect,
}: {
  active: SavedSqlConnection | null;
  connState: ConnState;
  connError: string | null;
  running: boolean;
  canRun: boolean;
  mode: EditorMode;
  onMode: (m: EditorMode) => void;
  templates: { label: string; hint: string; sql: string }[];
  onTemplate: (sql: string) => void;
  queryName: string | null;
  dirty: boolean;
  onSave: () => void;
  onSaveAs: () => void;
  onRun: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const [tplOpen, setTplOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) px-3 py-2 text-xs">
      <div className="min-w-0 flex-1 truncate">
        {active ? (
          <>
            <span className="font-semibold text-(--color-fg)">
              {active.name}
            </span>
            <span className="ml-2 text-(--color-fg-muted)">
              {ENGINE_LABELS[active.engine]}
            </span>
            {queryName && (
              <span className="ml-2 text-(--color-fg-muted)">
                · {queryName}
                {dirty ? " •" : ""}
              </span>
            )}
            {connError && isRetryableSshError(connError) ? (
              <button
                onClick={onConnect}
                disabled={connState === "connecting"}
                className="ml-2 rounded border border-(--color-accent) px-2 py-0.5 text-[10px] text-(--color-accent) hover:bg-(--color-accent) hover:text-white disabled:opacity-40"
              >
                Retry
              </button>
            ) : connError ? (
              <span className="ml-2 text-(--color-error)">· {connError}</span>
            ) : null}
          </>
        ) : (
          <span className="text-(--color-fg-muted)">
            No connection selected
          </span>
        )}
      </div>

      <div className="flex overflow-hidden rounded border border-(--color-border)">
        <ModeButton
          active={mode === "sql"}
          onClick={() => onMode("sql")}
          title="Write SQL by hand"
        >
          <Code2 size={12} /> SQL
        </ModeButton>
        <ModeButton
          active={mode === "builder"}
          onClick={() => onMode("builder")}
          title="Build a query by picking options — no SQL needed"
        >
          <SlidersHorizontal size={12} /> Builder
        </ModeButton>
      </div>

      <div className="relative">
        <button
          onClick={() => setTplOpen((v) => !v)}
          title="Insert a starter query"
          className="flex items-center gap-1 rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
        >
          <Wand2 size={12} /> Templates
        </button>
        {tplOpen && (
          <>
            <div
              className="fixed inset-0 z-20"
              onClick={() => setTplOpen(false)}
            />
            <div className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded border border-(--color-border) bg-(--color-surface) py-1 shadow-lg">
              {templates.map((t) => (
                <button
                  key={t.label}
                  onClick={() => {
                    onTemplate(t.sql);
                    setTplOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-(--color-surface-2)"
                >
                  <div className="font-medium text-(--color-fg)">{t.label}</div>
                  <div className="text-[10px] text-(--color-fg-muted)">
                    {t.hint}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex overflow-hidden rounded border border-(--color-border)">
        <button
          onClick={onSave}
          title={queryName ? `Save "${queryName}" (⌘S)` : "Save query (⌘S)"}
          className="flex items-center gap-1 px-2 py-0.5 hover:bg-(--color-surface-2)"
        >
          <Save size={12} /> Save
        </button>
        {queryName && (
          <button
            onClick={onSaveAs}
            title="Save as a new query"
            className="border-l border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
          >
            Save as…
          </button>
        )}
      </div>

      {active && connState === "connected" && (
        <button
          onClick={onDisconnect}
          className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
        >
          Disconnect
        </button>
      )}
      {active && connState !== "connected" && (
        <button
          onClick={onConnect}
          disabled={connState === "connecting"}
          className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
        >
          {connState === "connecting" ? "Connecting…" : "Connect"}
        </button>
      )}
      <button
        onClick={onRun}
        disabled={!canRun || running}
        title="Shift+Enter or ⌘Enter · runs the selection if text is selected"
        className="flex items-center gap-1 rounded bg-(--color-accent) px-2 py-0.5 text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
      >
        <Play size={12} />
        {running ? "Running…" : "Run"}
        <span className="text-[10px] opacity-70">⇧↵</span>
      </button>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 px-2 py-0.5 transition-colors ${
        active
          ? "bg-(--color-surface-2) font-medium text-(--color-fg)"
          : "text-(--color-fg-muted) hover:text-(--color-fg)"
      }`}
    >
      {children}
    </button>
  );
}

// ── Save query dialog ──────────────────────────────────────────────────────

function SaveQueryDialog({
  connectionName,
  onClose,
  onSave,
}: {
  connectionName: string | null;
  onClose: () => void;
  onSave: (name: string, scopedToConnection: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [scoped, setScoped] = useState(!!connectionName);
  const submit = () => {
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    onSave(name.trim(), scoped);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Save query"
      footer={
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            className="rounded border border-(--color-border) px-3 py-1 hover:bg-(--color-surface-2)"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="rounded bg-(--color-accent) px-3 py-1 text-(--color-accent-fg) hover:opacity-90"
          >
            Save
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-xs">
        <Field label="Name" full>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Active users this week"
            className="input w-full py-1 text-xs"
          />
        </Field>
        {connectionName && (
          <label className="flex items-center gap-2 text-(--color-fg-muted)">
            <input
              type="checkbox"
              checked={scoped}
              onChange={(e) => setScoped(e.target.checked)}
            />
            Only show for “{connectionName}”
          </label>
        )}
      </div>
    </Modal>
  );
}

// ── SQL editor (Monaco) ────────────────────────────────────────────────────

function SqlEditor({
  sql,
  onChange,
  onRun,
  onSave,
  onReady,
}: {
  sql: string;
  onChange: (v: string) => void;
  /** Called with the selected text when there is a selection. */
  onRun: (selection?: string) => void;
  onSave: () => void;
  onReady: (editor: Monaco.editor.IStandaloneCodeEditor) => void;
}) {
  const theme = useThemeStore((s) => s.theme);
  const monacoTheme =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches)
      ? "vs-dark"
      : "vs";

  return (
    <Editor
      height="100%"
      language="sql"
      value={sql}
      onChange={(v) => onChange(v ?? "")}
      theme={monacoTheme}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: '"Cascadia Code", "Fira Code", "Jetbrains Mono", monospace',
        scrollBeyondLastLine: false,
        wordWrap: "on",
        renderLineHighlight: "line",
        automaticLayout: true,
        quickSuggestions: { other: true, strings: false, comments: false },
        suggestOnTriggerCharacters: true,
      }}
      onMount={(editor, monaco) => {
        registerSqlCompletion(monaco);
        const run = () => {
          const model = editor.getModel();
          const sel = editor.getSelection();
          const text = model && sel ? model.getValueInRange(sel) : "";
          onRun(text.trim() ? text : undefined);
        };
        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, run);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
        onReady(editor);
      }}
    />
  );
}

// ── Connection editor ──────────────────────────────────────────────────────

function ConnectionEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: SavedSqlConnection | null;
  onClose: () => void;
  onSave: (
    draft: Omit<SavedSqlConnection, "id" | "updatedAt">,
    password: string | null,
  ) => void | Promise<void>;
}) {
  const devices = useAppStore((s) => s.devices);
  const sshDevices = useMemo(
    () => devices.filter((d) => !d.isLocalhost),
    [devices],
  );

  const [name, setName] = useState(initial?.name ?? "");
  const [engine, setEngine] = useState<SqlEngine>(
    initial?.engine ?? "postgres",
  );
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState<number>(
    initial?.port ?? ENGINE_DEFAULT_PORTS["postgres"],
  );
  const [username, setUsername] = useState(initial?.username ?? "");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [viaDeviceId, setViaDeviceId] = useState<string>(
    initial?.viaDeviceId ?? "",
  );
  const [password, setPassword] = useState("");
  const [touchedPort, setTouchedPort] = useState(false);

  useEffect(() => {
    if (!touchedPort && engine !== "sqlite") {
      setPort(ENGINE_DEFAULT_PORTS[engine]);
    }
  }, [engine, touchedPort]);

  const isSqlite = engine === "sqlite";

  const save = () => {
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    const draft = {
      name: name.trim(),
      engine,
      host: isSqlite ? "" : host.trim(),
      port: isSqlite ? 0 : port,
      username: isSqlite ? "" : username.trim(),
      database: database.trim(),
      viaDeviceId: viaDeviceId || undefined,
    };
    void onSave(draft, password.length > 0 ? password : null);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[28rem] rounded-lg border border-(--color-border) bg-(--color-surface) p-4 text-xs shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold">
          {initial ? "Edit connection" : "New connection"}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Name" full>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="prod-postgres"
              className="input w-full py-1 text-xs"
            />
          </Field>
          <Field label="Engine">
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as SqlEngine)}
              className="input w-full py-1 text-xs"
            >
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
              <option value="sqlite">SQLite</option>
            </select>
          </Field>
          {!isSqlite && (
            <Field label="Port">
              <input
                type="number"
                value={port}
                onChange={(e) => {
                  setTouchedPort(true);
                  setPort(Number(e.target.value));
                }}
                className="input w-full py-1 text-xs"
              />
            </Field>
          )}
          {!isSqlite && (
            <Field label="Host" full>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="db.internal"
                className="input w-full py-1 text-xs"
              />
            </Field>
          )}
          {!isSqlite && (
            <Field label="Username" full>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input w-full py-1 text-xs"
              />
            </Field>
          )}
          <Field label={isSqlite ? "Database file path" : "Database"} full>
            <input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder={isSqlite ? "/path/to/file.db" : "appdb"}
              className="input w-full py-1 text-xs"
            />
          </Field>
          {!isSqlite && (
            <Field label="Password (leave empty to keep stored)" full>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={initial ? "•••••• stored in keyring" : ""}
                className="input w-full py-1 text-xs"
              />
            </Field>
          )}
          {!isSqlite && (
            <Field label="Via SSH device (optional)" full>
              <select
                value={viaDeviceId}
                onChange={(e) => setViaDeviceId(e.target.value)}
                className="input w-full py-1 text-xs"
              >
                <option value="">— direct connection —</option>
                {sshDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.host})
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded border border-(--color-border) px-3 py-1 hover:bg-(--color-surface-2)"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded bg-(--color-accent) px-3 py-1 text-(--color-accent-fg) hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${full ? "col-span-2" : ""}`}>
      <span className="text-[10px] uppercase tracking-wide text-(--color-fg-muted)">
        {label}
      </span>
      {children}
    </label>
  );
}
