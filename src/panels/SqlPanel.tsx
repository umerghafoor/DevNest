import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "../lib/monaco-setup";
import { api, errorMessage } from "../lib/api";
import type { SqlEngine, SqlQueryResult } from "../lib/api";
import { useSqlStore, type SavedSqlConnection } from "../store/sql-store";
import { useAppStore } from "../store/app-store";
import { useThemeStore } from "../store/theme-store";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import {
  useResizableColumns,
  type ColumnSpec,
} from "../components/ResizableColumns";
import { notifyCompleted } from "../lib/notify";

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

type ConnState = "disconnected" | "connecting" | "connected" | "error";

export function SqlPanel({ paneId }: { paneId?: string } = {}) {
  const saved = useSqlStore((s) => s.saved);
  const activeId = useSqlStore((s) => s.activeId);
  const setActive = useSqlStore((s) => s.setActive);
  const addConn = useSqlStore((s) => s.add);
  const updateConn = useSqlStore((s) => s.update);
  const removeConn = useSqlStore((s) => s.remove);

  const [editing, setEditing] = useState<SavedSqlConnection | "new" | null>(
    null,
  );
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connError, setConnError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [queryErr, setQueryErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const tunnelIdRef = useRef<string | null>(null);

  const active = saved.find((c) => c.id === activeId) ?? null;

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
    setTables([]);
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
    setTables([]);
    setConnState("disconnected");
  };

  const onRun = async () => {
    if (!active || connState !== "connected") return;
    setRunning(true);
    setQueryErr(null);
    const startedAt = performance.now();
    try {
      const r = await api.sqlQuery(active.id, sql);
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <ConnectionRail
          saved={saved}
          activeId={active?.id ?? null}
          connState={connState}
          tables={tables}
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
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Toolbar
            active={active}
            connState={connState}
            connError={connError}
            running={running}
            canRun={connState === "connected" && sql.trim().length > 0}
            onRun={() => void onRun()}
            onConnect={() => active && void connect(active)}
            onDisconnect={() => active && void disconnect(active.id)}
          />
          <div className="min-h-[40%] border-b border-(--color-border)">
            <SqlEditor sql={sql} onChange={setSql} onRun={() => void onRun()} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ResultsPane
              result={result}
              error={queryErr}
              running={running}
              paneId={paneId}
            />
          </div>
        </div>
      </div>

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
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
}: {
  saved: SavedSqlConnection[];
  activeId: string | null;
  connState: ConnState;
  tables: string[];
  onSelect: (c: SavedSqlConnection) => void;
  onNew: () => void;
  onEdit: (c: SavedSqlConnection) => void;
  onDelete: (c: SavedSqlConnection) => void;
  onConnect: (c: SavedSqlConnection) => void;
  onDisconnect: (c: SavedSqlConnection) => void;
}) {
  return (
    <aside className="flex w-60 flex-col border-r border-(--color-border) bg-(--color-surface)">
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
      <div className="flex-1 overflow-auto text-xs">
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
                <div className="flex items-center gap-1 px-3 pb-2 text-[10px]">
                  {connState === "connected" ? (
                    <button
                      onClick={() => onDisconnect(c)}
                      className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => onConnect(c)}
                      disabled={connState === "connecting"}
                      className="rounded bg-(--color-accent) px-2 py-0.5 text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
                    >
                      Connect
                    </button>
                  )}
                  <button
                    onClick={() => onEdit(c)}
                    className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => onDelete(c)}
                    className="ml-auto rounded border border-(--color-border) px-2 py-0.5 text-(--color-error) hover:bg-(--color-surface-2)"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {connState === "connected" && tables.length > 0 && (
        <div className="max-h-64 overflow-auto border-t border-(--color-border) p-2 text-xs">
          <div className="mb-1 font-semibold uppercase tracking-wide text-(--color-fg-muted)">
            Tables
          </div>
          <ul>
            {tables.map((t) => (
              <li
                key={t}
                className="truncate px-1 py-0.5 font-mono text-[11px] text-(--color-fg)"
              >
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({
  active,
  connState,
  connError,
  running,
  canRun,
  onRun,
  onConnect,
  onDisconnect,
}: {
  active: SavedSqlConnection | null;
  connState: ConnState;
  connError: string | null;
  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2 text-xs">
      <div className="min-w-0 flex-1 truncate">
        {active ? (
          <>
            <span className="font-semibold text-(--color-fg)">
              {active.name}
            </span>
            <span className="ml-2 text-(--color-fg-muted)">
              {ENGINE_LABELS[active.engine]}
            </span>
            {connError && (
              <span className="ml-2 text-(--color-error)">· {connError}</span>
            )}
          </>
        ) : (
          <span className="text-(--color-fg-muted)">
            No connection selected
          </span>
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
        title="Cmd/Ctrl-Enter"
        className="rounded bg-(--color-accent) px-2 py-0.5 text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
      >
        {running ? "Running…" : "Run"}
      </button>
    </div>
  );
}

// ── SQL editor (Monaco) ────────────────────────────────────────────────────

function SqlEditor({
  sql,
  onChange,
  onRun,
}: {
  sql: string;
  onChange: (v: string) => void;
  onRun: () => void;
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
      }}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
          onRun(),
        );
      }}
    />
  );
}

// ── Results ────────────────────────────────────────────────────────────────

function ResultsPane({
  result,
  error,
  running,
  paneId,
}: {
  result: SqlQueryResult | null;
  error: string | null;
  running: boolean;
  paneId?: string;
}) {
  const columnSpecs: ColumnSpec[] = useMemo(
    () =>
      (result?.columns ?? []).map((c) => ({
        id: `col:${c.name}`,
        defaultWidth: 160,
        minWidth: 60,
      })),
    [result],
  );
  const { widthFor, ResizeHandle } = useResizableColumns(columnSpecs, paneId);
  if (running) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
        Running query…
      </div>
    );
  }
  if (error) {
    return (
      <div className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-(--color-error)">
        {error}
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
        Run a query to see results.
      </div>
    );
  }

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-(--color-fg-muted)">
        <span>
          Query completed in {result.elapsedMs} ms
          {result.rowsAffected !== null
            ? ` · ${result.rowsAffected} row(s) affected`
            : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-(--color-border) px-3 py-1 text-[11px] text-(--color-fg-muted)">
        <span>
          {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
          {result.truncated
            ? ` (truncated to first ${result.rows.length})`
            : ""}
        </span>
        <span>{result.elapsedMs} ms</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="table-fixed border-collapse font-mono text-xs"
          style={{ minWidth: "100%" }}
        >
          <colgroup>
            {result.columns.map((c) => (
              <col key={c.name} style={{ width: widthFor(`col:${c.name}`) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 bg-(--color-surface)">
            <tr>
              {result.columns.map((c) => (
                <th
                  key={c.name}
                  className="relative border-b border-(--color-border) px-2 py-1 text-left font-semibold text-(--color-fg)"
                  title={c.dataType}
                >
                  {c.name}
                  <span className="ml-1 text-[10px] text-(--color-fg-muted)">
                    {c.dataType.toLowerCase()}
                  </span>
                  <ResizeHandle columnId={`col:${c.name}`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr
                key={ri}
                className="odd:bg-transparent even:bg-(--color-surface)"
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="max-w-xs truncate border-b border-(--color-border) px-2 py-1 text-(--color-fg)"
                    title={renderCell(cell)}
                  >
                    {renderCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
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
