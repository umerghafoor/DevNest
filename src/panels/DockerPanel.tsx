import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { ContainerSummary } from "../lib/api";
import { withSudo } from "../lib/with-sudo";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { SkeletonTable } from "../components/Skeleton";

interface Props {
  deviceId: string;
}

const ACTIONS = ["start", "stop", "restart", "remove"] as const;
type Action = (typeof ACTIONS)[number];

export function DockerPanel({ deviceId }: Props) {
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await withSudo(deviceId, () =>
        api.dockerListContainers(deviceId),
      );
      setContainers(list);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const doAction = async (id: string, action: Action) => {
    if (action === "remove") {
      const ok = await confirm(
        `Remove container ${id.slice(0, 12)}? This cannot be undone.`,
        { title: "Remove container", destructive: true },
      );
      if (!ok) return;
    }
    setBusyId(id);
    try {
      await withSudo(deviceId, () => api.dockerAction(deviceId, id, action));
      toast.success(`Container ${action}ed`);
      await refresh();
    } catch (e) {
      toast.error(`${action} failed: ${errorMessage(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2 text-xs text-(--color-fg-muted)">
          <span>Loading containers…</span>
        </div>
        <SkeletonTable rows={6} cols={6} />
      </div>
    );
  }

  if (error) {
    return (
      <PanelMessage tone="error">
        Could not list containers: {error}
        <br />
        <button
          onClick={refresh}
          className="mt-2 rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2) transition-colors"
        >
          Retry
        </button>
      </PanelMessage>
    );
  }

  if (containers.length === 0) {
    return <PanelMessage>No containers on this device.</PanelMessage>;
  }

  return (
    <div className="flex h-full flex-col fade-up">
      <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2 text-xs text-(--color-fg-muted)">
        <span>{containers.length} containers</span>
        <button
          onClick={refresh}
          className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) transition-colors"
        >
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-(--color-surface) text-left text-(--color-fg-muted)">
            <tr>
              <Th>State</Th>
              <Th>Name</Th>
              <Th>Image</Th>
              <Th>Status</Th>
              <Th>Ports</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {containers.map((c, i) => (
              <tr
                key={c.id}
                className="border-b border-(--color-border) hover:bg-(--color-surface-2) row-animate"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <Td>
                  <StateBadge state={c.state} />
                </Td>
                <Td className="font-medium">{c.name}</Td>
                <Td className="font-mono text-(--color-fg-muted)">{c.image}</Td>
                <Td className="text-(--color-fg-muted)">{c.status}</Td>
                <Td className="font-mono text-(--color-fg-muted)">
                  {c.ports || "—"}
                </Td>
                <Td>
                  <div className="flex gap-1">
                    {ACTIONS.map((a) => (
                      <button
                        key={a}
                        disabled={busyId === c.id}
                        onClick={() => void doAction(c.id, a)}
                        className="rounded border border-(--color-border) px-1.5 py-0.5 text-[10px]
                          hover:bg-(--color-surface) disabled:opacity-50 transition-colors"
                      >
                        {busyId === c.id ? "…" : a}
                      </button>
                    ))}
                  </div>
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

function StateBadge({ state }: { state: string }) {
  const s = state.toLowerCase();
  const color =
    s === "running"
      ? "bg-(--color-online)"
      : s === "exited" || s === "dead"
        ? "bg-(--color-offline)"
        : "bg-(--color-warn)";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${color} transition-colors`} />
      <span className="capitalize text-(--color-fg-muted)">{state}</span>
    </span>
  );
}

function PanelMessage({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center fade-up">
      <div
        className={`max-w-md text-sm ${tone === "error" ? "text-(--color-error)" : "text-(--color-fg-muted)"}`}
      >
        {children}
      </div>
    </div>
  );
}
