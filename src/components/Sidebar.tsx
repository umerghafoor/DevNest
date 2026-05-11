import { useState } from "react";
import { useAppStore } from "../store/app-store";
import type { ConnectionStatus, Device } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { ThemeToggle } from "./ThemeToggle";

type Status = ConnectionStatus | "connecting" | "error";

const statusDot: Record<Status, string> = {
  connected: "bg-(--color-online)",
  connecting: "bg-(--color-warn) animate-pulse",
  offline: "bg-(--color-offline)",
  error: "bg-(--color-error)",
};

// DevNest Cradle mark — matches the brand guidelines SVG
function CradleMark({
  size = 28,
  stroke = "currentColor",
  accent = "oklch(0.74 0.17 58)",
}: {
  size?: number;
  stroke?: string;
  accent?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-label="DevNest"
    >
      <path
        d="M 8 60 Q 50 92 92 60"
        stroke={accent}
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M 22 50 Q 50 76 78 50"
        stroke={stroke}
        strokeWidth="9"
        strokeLinecap="round"
      />
      <ellipse cx="50" cy="34" rx="11" ry="13" fill={accent} />
    </svg>
  );
}

export function Sidebar() {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const setActiveDevice = useAppStore((s) => s.setActiveDevice);
  const setStatus = useAppStore((s) => s.setStatus);
  const upsertDevice = useAppStore((s) => s.upsertDevice);
  const removeDevice = useAppStore((s) => s.removeDevice);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

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
      alert(`Delete failed: ${errorMessage(e)}`);
    }
  };

  const onToggleSudo = async (device: Device) => {
    try {
      const updated = await api.setUseSudo(device.id, !device.useSudo);
      upsertDevice(updated);
    } catch (e) {
      alert(`Could not toggle sudo: ${errorMessage(e)}`);
    }
  };

  if (collapsed) {
    return (
      <aside className="flex h-full w-12 shrink-0 flex-col items-center border-r border-(--color-border) bg-(--color-surface) py-3 gap-3">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand sidebar"
          className="flex h-8 w-8 items-center justify-center rounded hover:bg-(--color-surface-2)"
        >
          <CradleMark size={22} stroke="var(--color-fg)" />
        </button>
        <div className="flex-1 flex flex-col items-center gap-2 py-2 overflow-y-auto w-full">
          {devices.map((d) => {
            const status: Status = d.isLocalhost
              ? "connected"
              : (statuses[d.id] ?? "offline");
            const active = activeDeviceId === d.id;
            return (
              <button
                key={d.id}
                onClick={() => void onSelect(d.id)}
                title={d.name}
                className={`flex h-8 w-8 items-center justify-center rounded text-xs font-semibold transition ${
                  active
                    ? "bg-(--color-accent) text-(--color-accent-fg)"
                    : "hover:bg-(--color-surface-2) text-(--color-fg-muted)"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${statusDot[status]}`} />
              </button>
            );
          })}
        </div>
        <ThemeToggle />
      </aside>
    );
  }

  return (
    <>
      <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2.5">
          <div className="flex-1" />
          <button
            onClick={() => setDialogOpen(true)}
            title="Add device"
            className="rounded px-1.5 py-0.5 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            +
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            className="rounded px-1 py-0.5 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            aria-label="Collapse sidebar"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M10 3L5 8l5 5" />
            </svg>
          </button>
        </div>

        {/* Device list */}
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
                      className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition hover:bg-(--color-surface-2) ${
                        active
                          ? "bg-(--color-surface-2) text-(--color-fg)"
                          : "text-(--color-fg-muted)"
                      }`}
                    >
                      <button
                        onClick={() => void onSelect(d.id)}
                        className="flex flex-1 items-center gap-2 text-left min-w-0"
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${statusDot[status]}`}
                          aria-label={status}
                        />
                        <span className="truncate font-medium">{d.name}</span>
                        {d.useSudo && (
                          <span
                            title="sudo enabled"
                            className="shrink-0 rounded bg-(--color-warn)/20 px-1 text-[9px] font-semibold uppercase text-(--color-warn)"
                          >
                            sudo
                          </span>
                        )}
                      </button>
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={() => void onToggleSudo(d)}
                          aria-label={
                            d.useSudo ? "Disable sudo" : "Enable sudo"
                          }
                          title={
                            d.useSudo
                              ? "Disable sudo for this device"
                              : "Enable sudo for this device"
                          }
                          className={`rounded px-1 text-[10px] hover:bg-(--color-bg) ${
                            d.useSudo ? "text-(--color-warn)" : ""
                          }`}
                        >
                          ⚡
                        </button>
                        {!d.isLocalhost && (
                          <button
                            onClick={() => void onDelete(d.id)}
                            aria-label="Delete device"
                            title="Delete"
                            className="rounded px-1 text-(--color-fg-muted) hover:bg-(--color-bg) hover:text-(--color-error)"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-(--color-border) px-3 py-2">
          <span className="text-[10px] text-(--color-fg-muted) font-mono tracking-wide">
            v0.1
          </span>
          <ThemeToggle />
        </div>
      </aside>
      <AddDeviceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}
