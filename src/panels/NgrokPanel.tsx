import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type NgrokTunnel } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";

export function NgrokPanel() {
  const [tunnels, setTunnels] = useState<NgrokTunnel[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [port, setPort] = useState("");
  const [proto, setProto] = useState<"http" | "tcp">("http");
  const [starting, setStarting] = useState(false);

  // Initial probe + state.
  useEffect(() => {
    void api
      .ngrokAvailable()
      .then(setAvailable)
      .catch(() => setAvailable(false));
    void api
      .ngrokList()
      .then(setTunnels)
      .catch((e) => toast.error(`ngrok list: ${errorMessage(e)}`));
  }, []);

  // Live updates from the Rust side when a tunnel acquires a URL or errors.
  useEffect(() => {
    const unlisten = listen<NgrokTunnel>("ngrok:update", (e) => {
      const updated = e.payload;
      setTunnels((prev) => {
        const idx = prev.findIndex((t) => t.id === updated.id);
        if (idx === -1) return [...prev, updated];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const start = async () => {
    const portNum = parseInt(port.trim(), 10);
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      toast.error("Enter a valid port (1–65535).");
      return;
    }
    setStarting(true);
    try {
      const t = await api.ngrokStart(portNum, proto);
      setTunnels((prev) => [...prev, t]);
      setPort("");
      toast.info(`Starting ${proto}://:${portNum}…`);
    } catch (e) {
      toast.error(`Start failed: ${errorMessage(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const stop = async (t: NgrokTunnel) => {
    const ok = await confirm(
      `Stop tunnel ${t.proto}://:${t.port}?`,
      { title: "Stop tunnel" },
    );
    if (!ok) return;
    try {
      await api.ngrokStop(t.id);
      setTunnels((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      toast.error(`Stop failed: ${errorMessage(e)}`);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  return (
    <div className="fade-up flex h-full flex-col">
      <div className="shrink-0 border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <h2 className="text-sm font-semibold">Ngrok tunnels</h2>
        <p className="text-xs text-(--color-fg-muted)">
          Expose a local port over a public URL. Tunnels run as child processes
          and stop when DevNest closes.
        </p>
      </div>

      {available === false && (
        <div className="shrink-0 border-b border-(--color-border) bg-(--color-warn)/10 px-4 py-2 text-xs text-(--color-warn)">
          <strong>ngrok not found.</strong> Install it from{" "}
          <button
            onClick={() => void openUrl("https://ngrok.com/download")}
            className="underline hover:text-(--color-fg)"
          >
            ngrok.com/download
          </button>{" "}
          and run{" "}
          <code className="font-mono">ngrok config add-authtoken &lt;token&gt;</code>{" "}
          once.
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-4 py-2">
        <input
          type="number"
          className="input max-w-[160px]"
          placeholder="port (e.g. 3000)"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void start()}
          disabled={available === false}
        />
        <select
          value={proto}
          onChange={(e) => setProto(e.target.value as "http" | "tcp")}
          disabled={available === false}
          className="rounded-md border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs disabled:opacity-50"
        >
          <option value="http">http</option>
          <option value="tcp">tcp</option>
        </select>
        <button
          onClick={() => void start()}
          disabled={available === false || starting}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
        >
          {starting ? "Starting…" : "Start tunnel"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tunnels.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
            No tunnels running.
          </div>
        ) : (
          <ul className="space-y-2">
            {tunnels.map((t) => (
              <TunnelRow
                key={t.id}
                tunnel={t}
                onStop={() => void stop(t)}
                onCopy={() => t.url && void copyUrl(t.url)}
                onOpen={() => t.url && void openUrl(t.url)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TunnelRow({
  tunnel,
  onStop,
  onCopy,
  onOpen,
}: {
  tunnel: NgrokTunnel;
  onStop: () => void;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const dot =
    tunnel.status === "active"
      ? "bg-(--color-online)"
      : tunnel.status === "error"
        ? "bg-(--color-error)"
        : tunnel.status === "starting"
          ? "bg-(--color-warn) animate-pulse"
          : "bg-(--color-offline)";

  return (
    <li className="row-animate rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2">
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-mono text-sm">
            <span>
              {tunnel.proto}://:{tunnel.port}
            </span>
            <span className="text-(--color-fg-muted)">→</span>
            {tunnel.url ? (
              <button
                onClick={onOpen}
                className="truncate text-(--color-accent) hover:underline"
                title="Open in browser"
              >
                {tunnel.url}
              </button>
            ) : (
              <span className="text-(--color-fg-muted)">
                {tunnel.status === "starting" ? "starting…" : "—"}
              </span>
            )}
          </div>
          {tunnel.error && (
            <div className="mt-1 truncate font-mono text-[11px] text-(--color-error)" title={tunnel.error}>
              {tunnel.error}
            </div>
          )}
        </div>
        {tunnel.url && (
          <button
            onClick={onCopy}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
            title="Copy URL"
          >
            Copy
          </button>
        )}
        <button
          onClick={onStop}
          className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
        >
          Stop
        </button>
      </div>
    </li>
  );
}
