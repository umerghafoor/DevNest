import { useState } from "react";
import { toast } from "../components/Toast";

interface Tunnel {
  id: string;
  port: string;
  proto: "http" | "tcp";
  status: "inactive" | "active";
  url: string | null;
}

const STORAGE_KEY = "devnest.ngrok";

function readStored(): Tunnel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Tunnel[]) : [];
  } catch {
    return [];
  }
}

function persist(t: Tunnel[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
}

export function NgrokPanel() {
  const [tunnels, setTunnels] = useState<Tunnel[]>(readStored);
  const [port, setPort] = useState("");
  const [proto, setProto] = useState<"http" | "tcp">("http");

  const add = () => {
    if (!port.trim()) return;
    const next: Tunnel[] = [
      ...tunnels,
      {
        id: Math.random().toString(36).slice(2, 10),
        port: port.trim(),
        proto,
        status: "inactive",
        url: null,
      },
    ];
    setTunnels(next);
    persist(next);
    setPort("");
    toast.info(`Tunnel for :${port} added (offline — wire up backend to start)`);
  };

  const toggle = (id: string) => {
    const next = tunnels.map((t) =>
      t.id === id
        ? {
            ...t,
            status: t.status === "active" ? "inactive" : "active",
            url:
              t.status === "active"
                ? null
                : `https://example-${Math.random().toString(36).slice(2, 7)}.ngrok.app`,
          }
        : t,
    ) as Tunnel[];
    setTunnels(next);
    persist(next);
  };

  const remove = (id: string) => {
    const next = tunnels.filter((t) => t.id !== id);
    setTunnels(next);
    persist(next);
  };

  return (
    <div className="fade-up flex h-full flex-col">
      <div className="shrink-0 border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <h2 className="text-sm font-semibold">Ngrok tunnels</h2>
        <p className="text-xs text-(--color-fg-muted)">
          Scaffold only. URLs shown are placeholders until the ngrok backend
          command is wired up.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-4 py-2">
        <input
          className="input max-w-[140px]"
          placeholder="port (e.g. 3000)"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <select
          value={proto}
          onChange={(e) => setProto(e.target.value as "http" | "tcp")}
          className="rounded-md border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs"
        >
          <option value="http">http</option>
          <option value="tcp">tcp</option>
        </select>
        <button
          onClick={add}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
        >
          Add tunnel
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tunnels.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
            No tunnels defined.
          </div>
        ) : (
          <ul className="space-y-2">
            {tunnels.map((t) => (
              <li
                key={t.id}
                className="row-animate flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2"
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    t.status === "active"
                      ? "bg-(--color-online)"
                      : "bg-(--color-offline)"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">
                    {t.proto}://:{t.port}
                  </div>
                  <div className="truncate font-mono text-[11px] text-(--color-fg-muted)">
                    {t.url ?? "—"}
                  </div>
                </div>
                <button
                  onClick={() => toggle(t.id)}
                  className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
                >
                  {t.status === "active" ? "Stop" : "Start"}
                </button>
                <button
                  onClick={() => remove(t.id)}
                  className="rounded px-1.5 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
                  aria-label="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
