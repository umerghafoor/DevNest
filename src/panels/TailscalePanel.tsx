import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

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

export function TailscalePanel({ deviceId }: Props) {
  const [status, setStatus] = useState<TailnetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingExit, setSettingExit] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<TailnetStatus>("tailscale_status", { deviceId });
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
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
      await invoke("tailscale_set_exit_node", {
        deviceId,
        exitNode: hostName,
      });
      await refresh();
    } catch (e) {
      alert(`Failed: ${errorMessage(e)}`);
    } finally {
      setSettingExit(null);
    }
  };

  if (loading) return <Msg>Loading Tailscale status…</Msg>;
  if (error) return <Msg tone="error">Error: {error}</Msg>;
  if (!status?.available)
    return <Msg>Tailscale is not installed or not running on this device.</Msg>;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-(--color-border) px-4 py-2 text-xs text-(--color-fg-muted)">
        {status.selfNode && (
          <span>
            Self:{" "}
            <span className="font-medium text-(--color-fg)">
              {status.selfNode.hostName}
            </span>{" "}
            ({status.selfNode.tailscaleIps[0] ?? "—"})
          </span>
        )}
        {status.currentExitNode && (
          <span className="ml-4">
            Exit node:{" "}
            <span className="font-medium text-(--color-online)">
              {status.currentExitNode}
            </span>
            <button
              onClick={() => setExitNode(null)}
              disabled={settingExit !== null}
              className="ml-2 rounded border border-(--color-border) px-1.5 py-0.5 text-[10px] hover:bg-(--color-surface-2) disabled:opacity-50"
            >
              Clear
            </button>
          </span>
        )}
        <button
          onClick={refresh}
          className="ml-4 rounded border border-(--color-border) px-2 py-0.5 text-[10px] hover:bg-(--color-surface-2)"
        >
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-(--color-surface) text-left text-(--color-fg-muted)">
            <tr>
              <Th>Host</Th>
              <Th>IP</Th>
              <Th>OS</Th>
              <Th>Status</Th>
              <Th>Exit node</Th>
            </tr>
          </thead>
          <tbody>
            {status.peers.map((peer) => (
              <tr
                key={peer.dnsName || peer.hostName}
                className="border-b border-(--color-border) hover:bg-(--color-surface-2)"
              >
                <Td className="font-medium">{peer.hostName}</Td>
                <Td className="font-mono text-(--color-fg-muted)">
                  {peer.tailscaleIps[0] ?? "—"}
                </Td>
                <Td className="capitalize text-(--color-fg-muted)">
                  {peer.os}
                </Td>
                <Td>
                  <span
                    className={`inline-flex items-center gap-1 ${
                      peer.online
                        ? "text-(--color-online)"
                        : "text-(--color-fg-muted)"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${peer.online ? "bg-(--color-online)" : "bg-(--color-offline)"}`}
                    />
                    {peer.online ? "Online" : "Offline"}
                  </span>
                </Td>
                <Td>
                  {peer.isExitNode ? (
                    <button
                      disabled={settingExit !== null}
                      onClick={() =>
                        setExitNode(
                          status.currentExitNode === peer.hostName
                            ? null
                            : peer.hostName,
                        )
                      }
                      className={`rounded border px-2 py-0.5 text-[10px] disabled:opacity-50 ${
                        status.currentExitNode === peer.hostName
                          ? "border-(--color-online) text-(--color-online)"
                          : "border-(--color-border) hover:bg-(--color-surface-2)"
                      }`}
                    >
                      {settingExit === peer.hostName
                        ? "…"
                        : status.currentExitNode === peer.hostName
                          ? "Active"
                          : "Use"}
                    </button>
                  ) : (
                    <span className="text-(--color-fg-muted)">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}
function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-middle ${className}`}>{children}</td>;
}
function Msg({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex h-full items-center justify-center text-sm">
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
