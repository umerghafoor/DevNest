import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/app-store";
import type { ConnectionStatus, Device } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { ThemeToggle } from "./ThemeToggle";
import { toast } from "./Toast";
import { confirm } from "./ConfirmDialog";
import { iconForDeviceId } from "../lib/device-icon";

type Status = ConnectionStatus | "connecting" | "error";

const statusDot: Record<Status, string> = {
  connected: "bg-(--color-online)",
  connecting: "bg-(--color-warn) animate-pulse",
  offline: "bg-(--color-offline)",
  error: "bg-(--color-error)",
};

const statusIconColor: Record<Status, string> = {
  connected: "text-(--color-online)",
  connecting: "text-(--color-warn)",
  offline: "text-(--color-fg-muted)",
  error: "text-(--color-error)",
};

const HOVER_EXPAND_DELAY_MS = 200;

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
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);

  // Effective width state: user collapsed + not hover-overriding.
  const expanded = !collapsed || hoverExpanded;

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const onMouseEnter = () => {
    if (!collapsed) return;
    if (hoverTimerRef.current !== null) return;
    hoverTimerRef.current = window.setTimeout(() => {
      setHoverExpanded(true);
      hoverTimerRef.current = null;
    }, HOVER_EXPAND_DELAY_MS);
  };

  const onMouseLeave = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoverExpanded(false);
  };

  const onSelect = async (id: string) => {
    setActiveDevice(id);
    const dev = devices.find((d) => d.id === id);
    if (!dev || dev.isLocalhost) return;
    if (statuses[id] === "connected" || statuses[id] === "connecting") return;
    setStatus(id, "connecting");
    api
      .connectDevice(id)
      .then(() => {
        setStatus(id, "connected");
        toast.success(`Connected to ${dev.name}`);
      })
      .catch((e) => {
        setStatus(id, "error");
        toast.error(`Connection failed: ${errorMessage(e)}`);
      });
  };

  const onDelete = async (id: string) => {
    const dev = devices.find((d) => d.id === id);
    const ok = await confirm(`Remove "${dev?.name ?? id}" from DevNest?`, {
      title: "Delete device",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteDevice(id);
      removeDevice(id);
      toast.success("Device removed");
    } catch (e) {
      toast.error(`Delete failed: ${errorMessage(e)}`);
    }
  };

  const onToggleSudo = async (device: Device) => {
    try {
      const updated = await api.setUseSudo(device.id, !device.useSudo);
      upsertDevice(updated);
      toast.info(
        `sudo ${updated.useSudo ? "enabled" : "disabled"} for ${device.name}`,
      );
    } catch (e) {
      toast.error(`Could not toggle sudo: ${errorMessage(e)}`);
    }
  };

  return (
    <>
      <aside
        style={{ width: expanded ? 240 : 48 }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        className="flex h-full shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)
          overflow-hidden transition-[width] duration-200 ease-in-out"
      >
        {/* Header */}
        <div
          className={`flex shrink-0 items-center border-b border-(--color-border) py-2.5 ${
            expanded ? "gap-2 px-3" : "justify-center px-0"
          }`}
        >
          {/* Logo — always visible */}
          <CradleMark size={22} stroke="var(--color-fg)" />

          {/* Items that fade out when collapsed */}
          {expanded && (
            <>
              <div
                className="flex flex-1 items-center gap-1 overflow-hidden transition-opacity duration-150"
                style={{ opacity: 1 }}
              >
                <div className="flex-1" />
                <button
                  onClick={() => setDialogOpen(true)}
                  title="Add device"
                  className="rounded px-1.5 py-0.5 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors whitespace-nowrap"
                >
                  +
                </button>
              </div>

              <button
                onClick={() => {
                  setCollapsed((c) => !c);
                  setHoverExpanded(false);
                }}
                title="Collapse sidebar"
                className="shrink-0 rounded px-1 py-0.5 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
                aria-label="Collapse sidebar"
              >
                <Chevron direction="left" />
              </button>
            </>
          )}
        </div>

        {/* Device list */}
        <nav className="flex-1 overflow-y-auto py-2">
          {devices.length === 0 && expanded ? (
            <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted) whitespace-nowrap">
              No devices yet.
              <br />
              Add one to get started.
            </div>
          ) : expanded ? (
            <ul className="space-y-0.5 px-2">
              {devices.map((d) => {
                const status: Status = d.isLocalhost
                  ? "connected"
                  : (statuses[d.id] ?? "offline");
                const active = activeDeviceId === d.id;
                return (
                  <li key={d.id}>
                    <div
                      className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm
                        transition-colors hover:bg-(--color-surface-2) ${
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
                          className={`h-2 w-2 shrink-0 rounded-full transition-colors ${statusDot[status]}`}
                          aria-label={status}
                        />
                        <span className="truncate font-medium whitespace-nowrap">
                          {d.name}
                        </span>
                        {d.useSudo && (
                          <span
                            title="sudo enabled"
                            className="shrink-0 rounded bg-(--color-warn)/20 px-1 text-[9px] font-semibold uppercase text-(--color-warn) whitespace-nowrap"
                          >
                            sudo
                          </span>
                        )}
                      </button>

                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <button
                          onClick={() => void onToggleSudo(d)}
                          aria-label={
                            d.useSudo ? "Disable sudo" : "Enable sudo"
                          }
                          title={d.useSudo ? "Disable sudo" : "Enable sudo"}
                          className={`rounded px-1 text-[10px] hover:bg-(--color-bg) transition-colors ${
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
                            className="rounded px-1 text-(--color-fg-muted) hover:bg-(--color-bg) hover:text-(--color-error) transition-colors"
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
          ) : (
            // ── Collapsed: icon column ─────────────────────────────────
            <ul className="flex flex-col items-center gap-1.5">
              {devices.map((d) => {
                const status: Status = d.isLocalhost
                  ? "connected"
                  : (statuses[d.id] ?? "offline");
                const active = activeDeviceId === d.id;
                const Icon = iconForDeviceId(d.id);
                return (
                  <li key={d.id}>
                    <button
                      onClick={() => void onSelect(d.id)}
                      title={d.name}
                      aria-label={d.name}
                      className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
                        active
                          ? "bg-(--color-accent)/15 ring-1 ring-(--color-accent)/40"
                          : "hover:bg-(--color-surface-2)"
                      }`}
                    >
                      <Icon
                        size={16}
                        strokeWidth={1.75}
                        className={
                          active ? "text-(--color-fg)" : statusIconColor[status]
                        }
                      />
                      {status === "connecting" && (
                        <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-(--color-warn) animate-pulse" />
                      )}
                      {status === "error" && (
                        <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-(--color-error)" />
                      )}
                    </button>
                  </li>
                );
              })}
              <li>
                <button
                  onClick={() => setDialogOpen(true)}
                  title="Add device"
                  aria-label="Add device"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
                >
                  +
                </button>
              </li>
            </ul>
          )}
        </nav>

        {/* Footer */}
        <div
          className={`flex shrink-0 items-center border-t border-(--color-border) py-2 ${
            expanded ? "justify-between px-3" : "flex-col gap-2 px-0"
          }`}
        >
          {expanded ? (
            <>
              <span className="text-[10px] text-(--color-fg-muted) font-mono tracking-wide whitespace-nowrap">
                v0.1
              </span>
              <ThemeToggle />
            </>
          ) : (
            <>
              <ThemeToggle />
              <button
                onClick={() => {
                  setCollapsed(false);
                  setHoverExpanded(false);
                }}
                title="Expand sidebar"
                className="flex h-7 w-7 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
                aria-label="Expand sidebar"
              >
                <Chevron direction="right" />
              </button>
            </>
          )}
        </div>
      </aside>

      <AddDeviceDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      style={{
        transform: direction === "right" ? "rotate(180deg)" : undefined,
      }}
    >
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}
