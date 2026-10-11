import { useCallback, useEffect, useMemo, useState } from "react";
import { LogOut, RefreshCw, Route } from "lucide-react";
import { errorMessage, invokeWithSudo } from "../lib/api";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN, segBtn } from "../lib/ui";
import { useElementSize } from "../lib/use-element-size";
import { toast } from "../components/Toast";

interface TailnetPeer {
  tailscaleIps: string[];
  hostName: string;
  dnsName: string;
  online: boolean;
  isExitNode: boolean;
  isSelf: boolean;
  os: string;
  tags: string[];
}

interface TailnetStatus {
  selfNode: TailnetPeer | null;
  peers: TailnetPeer[];
  currentExitNode: string | null;
  available: boolean;
}

interface Props {
  deviceId: string;
}

type Filter = "all" | "online" | "offline";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
];

export function TailscalePanel({ deviceId }: Props) {
  const [status, setStatus] = useState<TailnetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [settingExit, setSettingExit] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  // Narrow panes get a two-line list instead of a table.
  const [measureRef, size] = useElementSize();
  const narrow = size.w > 0 && size.w < 560;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const s = await invokeWithSudo<TailnetStatus>("tailscale_status", {
        deviceId,
      });
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const setExitNode = async (hostName: string | null) => {
    setSettingExit(hostName ?? "");
    try {
      await invokeWithSudo("tailscale_set_exit_node", {
        deviceId,
        exitNode: hostName,
      });
      toast.success(
        hostName ? `Using ${hostName} as exit node` : "Exit node cleared",
      );
      await refresh();
    } catch (e) {
      toast.error(`Exit node change failed: ${errorMessage(e)}`);
    } finally {
      setSettingExit(null);
    }
  };

  const peers = useMemo(() => status?.peers ?? [], [status]);
  const counts = useMemo(
    () => ({
      all: peers.length,
      online: peers.filter((p) => p.online).length,
      offline: peers.filter((p) => !p.online).length,
    }),
    [peers],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return peers
      .filter((p) =>
        filter === "online"
          ? p.online
          : filter === "offline"
            ? !p.online
            : true,
      )
      .filter(
        (p) =>
          !q ||
          p.hostName.toLowerCase().includes(q) ||
          p.dnsName.toLowerCase().includes(q) ||
          p.os.toLowerCase().includes(q) ||
          p.tailscaleIps.some((ip) => ip.includes(q)),
      )
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          a.hostName.localeCompare(b.hostName, undefined, {
            sensitivity: "base",
          }),
      );
  }, [peers, filter, query]);

  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`Copied ${text}`));
  };

  if (loading) return <Msg>Loading Tailscale status…</Msg>;
  if (error && !status) return <Msg tone="error">Error: {error}</Msg>;
  if (!status?.available)
    return <Msg>Tailscale is not installed or not running on this device.</Msg>;

  const self = status.selfNode;
  const exit = status.currentExitNode;

  return (
    <div
      ref={measureRef}
      className="fade-up flex h-full flex-col overflow-hidden"
    >
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-(--color-border) px-2 py-1 text-xs">
        {self && (
          <span
            className="min-w-0 truncate text-(--color-fg-muted)"
            title={`This device: ${self.dnsName || self.hostName}`}
          >
            <span className="font-medium text-(--color-fg)">
              {self.hostName}
            </span>{" "}
            <button
              onClick={() => self.tailscaleIps[0] && copy(self.tailscaleIps[0])}
              className="font-mono hover:text-(--color-fg)"
              title="Copy IP"
            >
              {self.tailscaleIps[0] ?? "—"}
            </button>
          </span>
        )}
        {exit && (
          <span className="flex items-center gap-1 rounded-md bg-(--color-online)/12 px-1.5 py-0.5 text-(--color-online)">
            <Route size={12} />
            via {exit}
            <button
              onClick={() => void setExitNode(null)}
              disabled={settingExit !== null}
              className="ml-0.5 rounded px-1 hover:bg-(--color-online)/20 disabled:opacity-50"
              title="Stop using exit node"
            >
              <LogOut size={11} />
            </button>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <div className={BTN_GROUP}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={segBtn(filter === f.key)}
              >
                {narrow ? f.label[0] + f.label.slice(1, 3) : f.label}
                <span className="ml-1 tabular-nums opacity-70">
                  {counts[f.key]}
                </span>
              </button>
            ))}
          </div>
          {!narrow && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter peers…"
              className={`${SMALL_INPUT} w-36`}
            />
          )}
          <div className={BTN_GROUP}>
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className={TOOL_BTN}
              title="Refresh"
            >
              <RefreshCw
                size={12}
                className={refreshing ? "animate-spin" : ""}
              />
            </button>
          </div>
        </div>
      </div>

      {narrow && (
        <div className="shrink-0 border-b border-(--color-border) px-2 py-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter peers…"
            className={`${SMALL_INPUT} w-full`}
          />
        </div>
      )}

      {error && (
        <div className="px-3 py-1 text-xs text-(--color-error)">
          Refresh failed: {error}
        </div>
      )}

      {/* Peers */}
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
            No peers match.
          </div>
        ) : narrow ? (
          <ul>
            {visible.map((p) => (
              <li
                key={p.dnsName || p.hostName}
                className="flex items-center gap-2 border-b border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface)"
              >
                <Dot online={p.online} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate ${p.online ? "" : "text-(--color-fg-muted)"}`}
                    title={p.dnsName || p.hostName}
                  >
                    {p.hostName}
                  </div>
                  <div className="truncate text-[11px] text-(--color-fg-muted)">
                    <button
                      onClick={() =>
                        p.tailscaleIps[0] && copy(p.tailscaleIps[0])
                      }
                      className="font-mono hover:text-(--color-fg)"
                      title="Copy IP"
                    >
                      {p.tailscaleIps[0] ?? "—"}
                    </button>
                    {" · "}
                    {osLabel(p.os)}
                  </div>
                </div>
                <ExitButton
                  peer={p}
                  current={exit}
                  busy={settingExit}
                  compact
                  onSet={setExitNode}
                />
              </li>
            ))}
          </ul>
        ) : (
          <ul>
            <li className="sticky top-0 z-10 flex h-6 items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-3 text-[11px] text-(--color-fg-muted)">
              <span className="w-2 shrink-0" />
              <span className="min-w-0 flex-1">Host</span>
              <span className="w-32 shrink-0">IP</span>
              <span className="w-20 shrink-0">OS</span>
              <span className="w-16 shrink-0">Status</span>
              <span className="w-20 shrink-0 text-right">Exit node</span>
            </li>
            {visible.map((p) => (
              <li
                key={p.dnsName || p.hostName}
                className="flex h-8 items-center gap-2 border-b border-(--color-border) px-3 text-xs hover:bg-(--color-surface)"
              >
                <Dot online={p.online} />
                <span
                  className={`min-w-0 flex-1 truncate ${p.online ? "" : "text-(--color-fg-muted)"}`}
                  title={p.dnsName || p.hostName}
                >
                  {p.hostName}
                  {p.tags.length > 0 && (
                    <span className="ml-2 text-[11px] text-(--color-fg-muted)">
                      {p.tags.map((t) => t.replace(/^tag:/, "#")).join(" ")}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => p.tailscaleIps[0] && copy(p.tailscaleIps[0])}
                  className="w-32 shrink-0 truncate text-left font-mono text-(--color-fg-muted) hover:text-(--color-fg)"
                  title="Copy IP"
                >
                  {p.tailscaleIps[0] ?? "—"}
                </button>
                <span className="w-20 shrink-0 truncate text-(--color-fg-muted)">
                  {osLabel(p.os)}
                </span>
                <span
                  className={`w-16 shrink-0 ${p.online ? "text-(--color-online)" : "text-(--color-fg-muted)"}`}
                >
                  {p.online ? "Online" : "Offline"}
                </span>
                <span className="flex w-20 shrink-0 justify-end">
                  <ExitButton
                    peer={p}
                    current={exit}
                    busy={settingExit}
                    onSet={setExitNode}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function osLabel(os: string): string {
  const map: Record<string, string> = {
    macos: "macOS",
    ios: "iOS",
    linux: "Linux",
    windows: "Windows",
    android: "Android",
    freebsd: "FreeBSD",
  };
  return map[os.toLowerCase()] ?? os;
}

function Dot({ online }: { online: boolean }) {
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-(--color-online)" : "bg-(--color-offline)"}`}
      title={online ? "Online" : "Offline"}
    />
  );
}

/** Exit-node control; only peers that advertise as exit nodes get one. */
function ExitButton({
  peer,
  current,
  busy,
  compact,
  onSet,
}: {
  peer: TailnetPeer;
  current: string | null;
  busy: string | null;
  compact?: boolean;
  onSet: (host: string | null) => Promise<void>;
}) {
  if (!peer.isExitNode) {
    return compact ? null : (
      <span className="text-(--color-fg-muted)/60">—</span>
    );
  }
  const active = current === peer.hostName;
  return (
    <button
      disabled={busy !== null}
      onClick={() => void onSet(active ? null : peer.hostName)}
      className={`${TOOL_BTN} ${
        active
          ? "bg-(--color-online)/15 text-(--color-online)"
          : "text-(--color-fg-muted) hover:text-(--color-fg)"
      }`}
      title={
        active ? "Stop using as exit node" : "Route traffic through this peer"
      }
    >
      {busy === peer.hostName ? (
        "…"
      ) : compact ? (
        <Route size={12} />
      ) : active ? (
        "Active"
      ) : (
        "Use"
      )}
    </button>
  );
}

function Msg({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs">
      <div
        className={
          tone === "error" ? "text-(--color-error)" : "text-(--color-fg-muted)"
        }
      >
        {children}
      </div>
    </div>
  );
}
