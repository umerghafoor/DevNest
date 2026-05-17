import { useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { HttpRequestSpec, HttpResponse } from "../lib/api";
import { useHttpStore, type SavedRequest } from "../store/http-store";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { notifyCompleted } from "../lib/notify";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
type Method = (typeof METHODS)[number];

interface HeaderRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

function emptyHeader(): HeaderRow {
  return {
    id: Math.random().toString(36).slice(2, 10),
    name: "",
    value: "",
    enabled: true,
  };
}

function headerRowsFromPairs(pairs: [string, string][]): HeaderRow[] {
  return pairs.map(([name, value]) => ({
    id: Math.random().toString(36).slice(2, 10),
    name,
    value,
    enabled: true,
  }));
}

function specFromRows(
  method: Method,
  url: string,
  rows: HeaderRow[],
  body: string,
): HttpRequestSpec {
  return {
    method,
    url: url.trim(),
    headers: rows
      .filter((r) => r.enabled && r.name.trim())
      .map((r) => [r.name.trim(), r.value]),
    body,
  };
}

export function HttpPanel() {
  const saved = useHttpStore((s) => s.saved);
  const saveRequest = useHttpStore((s) => s.save);
  const updateRequest = useHttpStore((s) => s.update);
  const removeRequest = useHttpStore((s) => s.remove);

  const [method, setMethod] = useState<Method>("GET");
  const [url, setUrl] = useState("https://httpbin.org/get");
  const [headers, setHeaders] = useState<HeaderRow[]>([emptyHeader()]);
  const [body, setBody] = useState("");
  const [tab, setTab] = useState<"headers" | "body">("headers");
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);

  const supportsBody = method !== "GET" && method !== "HEAD";

  const send = async () => {
    if (!url.trim()) {
      toast.error("Enter a URL.");
      return;
    }
    setSending(true);
    setError(null);
    setResponse(null);
    const startedAt = performance.now();
    try {
      const spec = specFromRows(method, url, headers, supportsBody ? body : "");
      const res = await api.httpRequest(spec);
      setResponse(res);
      const elapsed = performance.now() - startedAt;
      if (elapsed > 5000) {
        notifyCompleted(
          `HTTP ${method} finished`,
          `${res.status} · ${Math.round(elapsed)} ms · ${url}`,
        );
      }
    } catch (e) {
      setError(errorMessage(e));
      const elapsed = performance.now() - startedAt;
      if (elapsed > 5000) {
        notifyCompleted(
          `HTTP ${method} failed`,
          `${Math.round(elapsed)} ms · ${url}`,
        );
      }
    } finally {
      setSending(false);
    }
  };

  const loadSaved = (r: SavedRequest) => {
    setMethod(METHODS.includes(r.spec.method as Method) ? (r.spec.method as Method) : "GET");
    setUrl(r.spec.url);
    const rows = headerRowsFromPairs(r.spec.headers);
    setHeaders(rows.length === 0 ? [emptyHeader()] : rows);
    setBody(r.spec.body);
    setActiveSavedId(r.id);
    setResponse(null);
    setError(null);
  };

  const onSave = async () => {
    const name = window.prompt(
      activeSavedId ? "Rename saved request:" : "Name this request:",
      activeSavedId
        ? saved.find((r) => r.id === activeSavedId)?.name
        : `${method} ${url}`,
    );
    if (name === null) return;
    const spec = specFromRows(method, url, headers, supportsBody ? body : "");
    if (activeSavedId) {
      updateRequest(activeSavedId, { name: name.trim() || "Untitled", spec });
      toast.success("Saved");
    } else {
      const req = saveRequest(name, spec);
      setActiveSavedId(req.id);
      toast.success("Saved");
    }
  };

  const onDelete = async (r: SavedRequest) => {
    const ok = await confirm(`Delete saved request "${r.name}"?`, {
      title: "Delete request",
      destructive: true,
    });
    if (!ok) return;
    removeRequest(r.id);
    if (activeSavedId === r.id) setActiveSavedId(null);
  };

  return (
    <div className="fade-up flex h-full overflow-hidden">
      {/* Saved requests sidebar */}
      <SavedSidebar
        saved={saved}
        activeId={activeSavedId}
        onLoad={loadSaved}
        onDelete={onDelete}
        onNew={() => {
          setMethod("GET");
          setUrl("https://");
          setHeaders([emptyHeader()]);
          setBody("");
          setActiveSavedId(null);
          setResponse(null);
          setError(null);
        }}
      />

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* URL bar */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as Method)}
            className="rounded-md border border-(--color-border) bg-(--color-bg) px-2 py-1 font-mono text-xs"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !sending && void send()}
            placeholder="https://api.example.com/resource"
            className="input flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <button
            onClick={() => void send()}
            disabled={sending}
            className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            {sending ? "Sending…" : "Send"}
          </button>
          <button
            onClick={() => void onSave()}
            className="rounded border border-(--color-border) px-2 py-1.5 text-xs hover:bg-(--color-surface-2)"
          >
            Save
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-0 border-b border-(--color-border) bg-(--color-surface) px-2">
          <TabButton active={tab === "headers"} onClick={() => setTab("headers")}>
            Headers
            {headers.filter((h) => h.enabled && h.name.trim()).length > 0 && (
              <span className="ml-1 text-(--color-fg-muted)">
                ({headers.filter((h) => h.enabled && h.name.trim()).length})
              </span>
            )}
          </TabButton>
          <TabButton
            active={tab === "body"}
            onClick={() => setTab("body")}
            disabled={!supportsBody}
          >
            Body
            {supportsBody && body.length > 0 && (
              <span className="ml-1 text-(--color-fg-muted)">
                ({body.length})
              </span>
            )}
          </TabButton>
        </div>

        {/* Editor area */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "headers" ? (
            <HeadersEditor headers={headers} onChange={setHeaders} />
          ) : (
            <BodyEditor
              body={body}
              onChange={setBody}
              disabled={!supportsBody}
            />
          )}
        </div>

        {/* Response */}
        <ResponseView response={response} error={error} sending={sending} />
      </div>
    </div>
  );
}

function SavedSidebar({
  saved,
  activeId,
  onLoad,
  onDelete,
  onNew,
}: {
  saved: SavedRequest[];
  activeId: string | null;
  onLoad: (r: SavedRequest) => void;
  onDelete: (r: SavedRequest) => void;
  onNew: () => void;
}) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface) md:flex">
      <div className="flex items-center justify-between gap-2 border-b border-(--color-border) px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-(--color-fg-muted)">
          Saved
        </span>
        <button
          onClick={onNew}
          title="New request"
          className="rounded px-1.5 py-0.5 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          +
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {saved.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-(--color-fg-muted)">
            No saved requests yet.
          </div>
        ) : (
          saved.map((r) => (
            <div
              key={r.id}
              className={`group flex items-center gap-1.5 px-2 py-1 text-xs transition-colors ${
                activeId === r.id
                  ? "bg-(--color-accent)/15"
                  : "hover:bg-(--color-surface-2)"
              }`}
            >
              <button
                onClick={() => onLoad(r)}
                className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
              >
                <span
                  className={`shrink-0 rounded px-1 py-px font-mono text-[9px] font-semibold ${methodBadge(r.spec.method)}`}
                >
                  {r.spec.method}
                </span>
                <span className="truncate" title={r.name}>
                  {r.name}
                </span>
              </button>
              <button
                onClick={() => onDelete(r)}
                aria-label="Delete"
                className="rounded px-1 text-(--color-fg-muted) opacity-0 hover:bg-(--color-error)/15 hover:text-(--color-error) group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function methodBadge(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-(--color-online)/15 text-(--color-online)";
    case "POST":
      return "bg-(--color-accent)/15 text-(--color-accent)";
    case "PUT":
    case "PATCH":
      return "bg-(--color-warn)/15 text-(--color-warn)";
    case "DELETE":
      return "bg-(--color-error)/15 text-(--color-error)";
    default:
      return "bg-(--color-surface-2) text-(--color-fg-muted)";
  }
}

function TabButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative px-3 py-1.5 text-xs transition-colors ${
        active
          ? "text-(--color-fg)"
          : "text-(--color-fg-muted) hover:text-(--color-fg)"
      } disabled:opacity-40`}
    >
      {children}
      {active && (
        <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-t bg-(--color-accent)" />
      )}
    </button>
  );
}

function HeadersEditor({
  headers,
  onChange,
}: {
  headers: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  const updateRow = (id: string, patch: Partial<HeaderRow>) => {
    onChange(headers.map((h) => (h.id === id ? { ...h, ...patch } : h)));
  };
  const removeRow = (id: string) => {
    const next = headers.filter((h) => h.id !== id);
    onChange(next.length === 0 ? [emptyHeader()] : next);
  };
  const addRow = () => onChange([...headers, emptyHeader()]);

  // Auto-append blank row when user edits the last one.
  useEffect(() => {
    const last = headers[headers.length - 1];
    if (last && (last.name || last.value)) {
      onChange([...headers, emptyHeader()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers[headers.length - 1]?.name, headers[headers.length - 1]?.value]);

  return (
    <div className="p-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase text-(--color-fg-muted)">
            <th className="w-8"></th>
            <th className="px-1 py-1">Name</th>
            <th className="px-1 py-1">Value</th>
            <th className="w-6"></th>
          </tr>
        </thead>
        <tbody>
          {headers.map((h) => (
            <tr key={h.id}>
              <td className="py-1 pl-1">
                <input
                  type="checkbox"
                  checked={h.enabled}
                  onChange={(e) =>
                    updateRow(h.id, { enabled: e.target.checked })
                  }
                  aria-label="Enabled"
                />
              </td>
              <td className="px-1 py-1">
                <input
                  value={h.name}
                  onChange={(e) => updateRow(h.id, { name: e.target.value })}
                  placeholder="Content-Type"
                  className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 font-mono text-xs"
                />
              </td>
              <td className="px-1 py-1">
                <input
                  value={h.value}
                  onChange={(e) => updateRow(h.id, { value: e.target.value })}
                  placeholder="application/json"
                  className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 font-mono text-xs"
                />
              </td>
              <td className="px-1 py-1 text-right">
                <button
                  onClick={() => removeRow(h.id)}
                  aria-label="Remove"
                  className="rounded px-1 text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={addRow}
        className="mt-2 rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
      >
        + Add header
      </button>
    </div>
  );
}

function BodyEditor({
  body,
  onChange,
  disabled,
}: {
  body: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-(--color-fg-muted)">
        This method doesn&apos;t support a request body.
      </div>
    );
  }
  return (
    <textarea
      value={body}
      onChange={(e) => onChange(e.target.value)}
      placeholder={'{ "name": "value" }'}
      spellCheck={false}
      className="h-full w-full resize-none bg-(--color-bg) p-3 font-mono text-xs text-(--color-fg) outline-none"
    />
  );
}

function ResponseView({
  response,
  error,
  sending,
}: {
  response: HttpResponse | null;
  error: string | null;
  sending: boolean;
}) {
  const [respTab, setRespTab] = useState<"body" | "headers">("body");
  const pretty = useMemo(() => {
    if (!response) return null;
    const ct = response.headers.find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    if (ct?.includes("json") && !response.binary) {
      try {
        return JSON.stringify(JSON.parse(response.body), null, 2);
      } catch {
        return null;
      }
    }
    return null;
  }, [response]);
  const [showPretty, setShowPretty] = useState(true);

  return (
    <div className="flex shrink-0 flex-col border-t border-(--color-border)">
      <div className="flex items-center gap-2 bg-(--color-surface) px-3 py-1.5 text-xs">
        {sending ? (
          <span className="text-(--color-fg-muted)">Sending…</span>
        ) : error ? (
          <span className="text-(--color-error)" title={error}>
            Error: <span className="font-mono">{error}</span>
          </span>
        ) : response ? (
          <>
            <span
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${statusBadge(response.status)}`}
            >
              {response.status} {response.statusText}
            </span>
            <span className="text-(--color-fg-muted)">
              {response.elapsedMs} ms
            </span>
            <span className="text-(--color-fg-muted)">
              {(response.body.length / 1024).toFixed(1)} KB
            </span>
            <div className="ml-auto flex items-center gap-1">
              <TabButton
                active={respTab === "body"}
                onClick={() => setRespTab("body")}
              >
                Body
              </TabButton>
              <TabButton
                active={respTab === "headers"}
                onClick={() => setRespTab("headers")}
              >
                Headers ({response.headers.length})
              </TabButton>
            </div>
          </>
        ) : (
          <span className="text-(--color-fg-muted)">
            Response will appear here.
          </span>
        )}
      </div>

      <div className="max-h-[40vh] min-h-[100px] overflow-auto bg-(--color-bg)">
        {error ? (
          <pre className="m-0 p-3 font-mono text-xs text-(--color-error)">
            {error}
          </pre>
        ) : response && respTab === "headers" ? (
          <table className="w-full text-xs">
            <tbody>
              {response.headers.map(([k, v], i) => (
                <tr key={i} className="border-b border-(--color-border)/40">
                  <td className="px-3 py-1 font-mono text-(--color-fg-muted)">
                    {k}
                  </td>
                  <td className="px-3 py-1 font-mono break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : response ? (
          <>
            {pretty && (
              <div className="sticky top-0 flex justify-end bg-(--color-bg) p-1">
                <button
                  onClick={() => setShowPretty((p) => !p)}
                  className="rounded border border-(--color-border) px-2 py-0.5 text-[10px] text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
                >
                  {showPretty ? "Raw" : "Pretty"}
                </button>
              </div>
            )}
            <pre className="m-0 p-3 font-mono text-xs leading-relaxed text-(--color-fg)">
              {pretty && showPretty ? pretty : response.body}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

function statusBadge(status: number): string {
  if (status >= 200 && status < 300)
    return "bg-(--color-online)/20 text-(--color-online)";
  if (status >= 300 && status < 400)
    return "bg-(--color-accent)/20 text-(--color-accent)";
  if (status >= 400 && status < 500)
    return "bg-(--color-warn)/20 text-(--color-warn)";
  if (status >= 500) return "bg-(--color-error)/20 text-(--color-error)";
  return "bg-(--color-surface-2) text-(--color-fg-muted)";
}
