import { useState, useRef, useEffect } from "react";
import { useAppStore } from "../store/app-store";
import type { PanelKind } from "../store/app-store";

const PANEL_ICONS: Record<PanelKind, string> = {
  docker: "▣",
  metrics: "◈",
  terminal: "⌨",
  files: "◫",
  tailscale: "⬡",
  logs: "≡",
};

const PANEL_LABELS: Record<PanelKind, string> = {
  docker: "Docker",
  metrics: "Metrics",
  terminal: "Terminal",
  files: "Files",
  tailscale: "Tailscale",
  logs: "Logs",
};

const ALL_PANELS: PanelKind[] = [
  "terminal",
  "docker",
  "metrics",
  "files",
  "logs",
  "tailscale",
];

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const openTab = useAppStore((s) => s.openTab);
  const devices = useAppStore((s) => s.devices);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const deviceById = (id: string) => devices.find((d) => d.id === id);

  const openPanel = (kind: PanelKind) => {
    if (!activeDeviceId) return;
    openTab({
      id: `${activeDeviceId}:${kind}`,
      deviceId: activeDeviceId,
      panel: kind,
    });
    setMenuOpen(false);
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div className="flex h-9 items-stretch border-b border-(--color-border) bg-(--color-surface)">
      {/* Tabs */}
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.length === 0 ? (
          <div className="flex items-center px-3 text-xs text-(--color-fg-muted) select-none">
            {activeDeviceId
              ? "Open a panel →"
              : "Select a device from the sidebar"}
          </div>
        ) : (
          tabs.map((t) => {
            const dev = deviceById(t.deviceId);
            const active = t.id === activeTabId;
            return (
              <div
                key={t.id}
                className={`group relative flex items-center gap-1.5 border-r border-(--color-border) px-3 text-xs cursor-pointer select-none transition-colors ${
                  active
                    ? "bg-(--color-bg) text-(--color-fg)"
                    : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
                }`}
                onClick={() => setActiveTab(t.id)}
              >
                {active && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-(--color-accent)" />
                )}
                <span className="opacity-60">{PANEL_ICONS[t.panel]}</span>
                <span className="whitespace-nowrap">
                  {dev?.name ?? "?"}{" "}
                  <span className="text-(--color-fg-muted)">
                    · {PANEL_LABELS[t.panel]}
                  </span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  aria-label="Close tab"
                  className="ml-0.5 flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity hover:bg-(--color-surface-2) group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* New panel button */}
      {activeDeviceId && (
        <div
          ref={menuRef}
          className="relative flex items-center border-l border-(--color-border)"
        >
          <button
            onClick={() => setMenuOpen((o) => !o)}
            title="Open panel"
            className="flex h-full items-center gap-1 px-3 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
            <span>Panel</span>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-0.5 min-w-[160px] rounded-lg border border-(--color-border) bg-(--color-surface) py-1 shadow-lg">
              {ALL_PANELS.map((kind) => (
                <button
                  key={kind}
                  onClick={() => openPanel(kind)}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-(--color-fg) hover:bg-(--color-surface-2)"
                >
                  <span className="text-(--color-fg-muted)">
                    {PANEL_ICONS[kind]}
                  </span>
                  {PANEL_LABELS[kind]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
