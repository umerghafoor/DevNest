import { useState } from "react";
import { useAppStore } from "../store/app-store";
import type { ConnectionStatus } from "../lib/api";
import { api } from "../lib/api";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { ThemeToggle } from "./ThemeToggle";

type Status = ConnectionStatus | "connecting" | "error";

const statusDot: Record<Status, string> = {
  connected: "bg-(--color-online)",
  connecting: "bg-(--color-warn) animate-pulse",
  offline: "bg-(--color-offline)",
  error: "bg-(--color-error)",
};

export function Sidebar() {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const setActiveDevice = useAppStore((s) => s.setActiveDevice);
  const setStatus = useAppStore((s) => s.setStatus);
  const removeDevice = useAppStore((s) => s.removeDevice);
  const [dialogOpen, setDialogOpen] = useState(false);

  const onSelect = async (id: string) => {
    setActiveDevice(id);
    const dev = devices.find((d) => d.id === id);
    if (!dev || dev.isLocalhost) return;
    if (statuses[id] === "connected" || statuses[id] === "connecting") return;
    setStatus(id, "connecting");
    try {
      await api.connectDevice(id);
      setStatus(id, "connected");
    } catch {
      setStatus(id, "error");
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this device?")) return;
    try {
      await api.deleteDevice(id);
      removeDevice(id);
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  };

  return (
    <>
      <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)">
        <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-3">
          <h1 className="text-sm font-semibold tracking-wide">DevNest</h1>
          <button
            onClick={() => setDialogOpen(true)}
            className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            aria-label="Add device"
          >
            + Add
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {devices.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
              No devices yet.
              <br />
              Add one to get started.
            </div>
          ) : (
            <ul className="space-y-0.5 px-2">
              {devices.map((d) => {
                const status: Status = d.isLocalhost
                  ? "connected"
                  : (statuses[d.id] ?? "offline");
                const active = activeDeviceId === d.id;
                return (
                  <li key={d.id}>
                    <div
                      className={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-(--color-surface-2) ${
                        active
                          ? "bg-(--color-surface-2) text-(--color-fg)"
                          : "text-(--color-fg-muted)"
                      }`}
                    >
                      <button
                        onClick={() => onSelect(d.id)}
                        className="flex flex-1 items-center gap-2 text-left"
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${statusDot[status]}`}
                          aria-label={status}
                        />
                        <span className="truncate">{d.name}</span>
                      </button>
                      {!d.isLocalhost && (
                        <button
                          onClick={() => onDelete(d.id)}
                          aria-label="Delete device"
                          title="Delete"
                          className="opacity-0 transition group-hover:opacity-100"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
        <div className="flex items-center justify-end border-t border-(--color-border) px-2 py-2">
          <ThemeToggle />
        </div>
      </aside>
      <AddDeviceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
