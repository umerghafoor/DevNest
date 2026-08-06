import { useRef, useCallback, lazy, Suspense, useState } from "react";
import { iconForDeviceId } from "../lib/device-icon";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import type { PaneNode, SplitDirection, Pane, DockPosition } from "../store/app-store";
import { terminalRegistry } from "../lib/terminal-registry";
import { openFloatingPaneWindow } from "../lib/pane-window";
import { DockerPanel } from "../panels/DockerPanel";
import { MetricsPanel } from "../panels/MetricsPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { TailscalePanel } from "../panels/TailscalePanel";
import { FileBrowserPanel } from "../panels/FileBrowserPanel";
import { LogViewerPanel } from "../panels/LogViewerPanel";
import { ProcessPanel } from "../panels/ProcessPanel";
import { PortsPanel } from "../panels/PortsPanel";
import { CronPanel } from "../panels/CronPanel";
import { DashboardPanel } from "../panels/DashboardPanel";
import { SettingsPanel } from "../panels/SettingsPanel";
import { ServicesPanel } from "../panels/ServicesPanel";
import { NgrokPanel } from "../panels/NgrokPanel";
import { SysInfoPanel } from "../panels/SysInfoPanel";
import { EditorPanel } from "../panels/EditorPanel";
import { MarkdownPanel } from "../panels/MarkdownPanel";
import { GitPanel } from "../panels/GitPanel";
import { GitGraphPanel } from "../panels/GitGraphPanel";
import { SystemdPanel } from "../panels/SystemdPanel";
import { HttpPanel } from "../panels/HttpPanel";
import type { PanelKind } from "../store/app-store";

// SqlPanel pulls in Monaco (~3 MB). Lazy-load it so the rest of the app
// isn't paying for it unless the user opens the SQL Client.
const SqlPanel = lazy(() =>
  import("../panels/SqlPanel").then((m) => ({ default: m.SqlPanel })),
);

export const PANEL_ICONS: Record<PanelKind, string> = {
  docker: "▣",
  metrics: "◈",
  terminal: "⌨",
  files: "◫",
  tailscale: "⬡",
  logs: "≡",
  processes: "◎",
  ports: "⊕",
  cron: "⏱",
  dashboard: "◉",
  settings: "✦",
  services: "✪",
  ngrok: "⇄",
  sysinfo: "ℹ",
  editor: "✎",
  git: "⎇",
  gitGraph: "⌥",
  systemd: "⚙",
  http: "⇨",
  sql: "◰",
  markdown: "◧",
};

export const PANEL_LABELS: Record<PanelKind, string> = {
  docker: "Docker",
  metrics: "Metrics",
  terminal: "Terminal",
  files: "Files",
  tailscale: "Tailscale",
  logs: "Logs",
  processes: "Processes",
  ports: "Ports",
  cron: "Cron",
  dashboard: "Dashboard",
  settings: "Settings",
  services: "Services",
  ngrok: "Ngrok",
  sysinfo: "System Info",
  editor: "Editor",
  git: "Git",
  gitGraph: "Git Graph",
  systemd: "systemd",
  http: "HTTP Client",
  sql: "SQL Client",
  markdown: "Markdown",
};

export const PANEL_DESCRIPTIONS: Record<PanelKind, string> = {
  dashboard: "Quick overview of devices and panels",
  sysinfo: "Browser-side host info",
  terminal: "Interactive shell session",
  files: "Browse and edit files",
  processes: "Top processes by CPU and memory",
  ports: "Listening TCP / UDP ports",
  docker: "Containers, images, logs",
  metrics: "CPU, memory, disk, network",
  logs: "Tail logs from files or journals",
  systemd: "Manage systemd unit files",
  services: "Local service definitions",
  cron: "Scheduled jobs (crontab)",
  tailscale: "Tailnet status and routes",
  ngrok: "Public tunnels to local ports",
  git: "Local repos + GitHub bookmarks",
  gitGraph: "Commit graph and diffs",
  editor: "Edit a text or config file",
  settings: "Theme, shortcuts, integrations",
  http: "Send HTTP requests, save collections",
  sql: "Connect to Postgres / MySQL / SQLite",
  markdown: "Write and preview Markdown with live rendering",
};

export type PanelCategory =
  | "overview"
  | "remote"
  | "containers"
  | "observability"
  | "services"
  | "network"
  | "code"
  | "app";

export const PANEL_CATEGORY: Record<PanelKind, PanelCategory> = {
  dashboard: "overview",
  sysinfo: "overview",
  terminal: "remote",
  files: "remote",
  processes: "remote",
  ports: "remote",
  docker: "containers",
  metrics: "observability",
  logs: "observability",
  systemd: "services",
  services: "services",
  cron: "services",
  tailscale: "network",
  ngrok: "network",
  git: "code",
  gitGraph: "code",
  editor: "code",
  settings: "app",
  http: "network",
  sql: "code",
  markdown: "code",
};

export const CATEGORY_LABELS: Record<PanelCategory, string> = {
  overview: "Overview",
  remote: "Remote",
  containers: "Containers",
  observability: "Observability",
  services: "Services",
  network: "Network",
  code: "Code",
  app: "App",
};

/** Display order — both for category sections and within a category. */
export const CATEGORY_ORDER: PanelCategory[] = [
  "overview",
  "remote",
  "containers",
  "observability",
  "services",
  "network",
  "code",
  "app",
];

export const PANEL_ORDER_IN_CATEGORY: Record<PanelCategory, PanelKind[]> = {
  overview: ["dashboard", "sysinfo"],
  remote: ["terminal", "files", "processes", "ports"],
  containers: ["docker"],
  observability: ["metrics", "logs"],
  services: ["systemd", "services", "cron"],
  network: ["http", "tailscale", "ngrok"],
  code: ["git", "gitGraph", "editor", "markdown", "sql"],
  app: ["settings"],
};

export function PanelContent({ pane }: { pane: Pane }) {
  switch (pane.panel) {
    case "docker":
      return <DockerPanel deviceId={pane.deviceId} />;
    case "metrics":
      return <MetricsPanel deviceId={pane.deviceId} />;
    case "terminal":
      return (
        <TerminalPanel deviceId={pane.deviceId} instanceId={pane.instanceId} />
      );
    case "tailscale":
      return <TailscalePanel deviceId={pane.deviceId} />;
    case "files":
      return <FileBrowserPanel deviceId={pane.deviceId} />;
    case "logs":
      return <LogViewerPanel deviceId={pane.deviceId} paneId={pane.id} />;
    case "processes":
      return <ProcessPanel deviceId={pane.deviceId} paneId={pane.id} />;
    case "ports":
      return <PortsPanel deviceId={pane.deviceId} paneId={pane.id} />;
    case "cron":
      return <CronPanel deviceId={pane.deviceId} />;
    case "dashboard":
      return <DashboardPanel deviceId={pane.deviceId} />;
    case "settings":
      return <SettingsPanel />;
    case "services":
      return <ServicesPanel />;
    case "ngrok":
      return <NgrokPanel deviceId={pane.deviceId} />;
    case "sysinfo":
      return <SysInfoPanel />;
    case "editor":
      return <EditorPanel deviceId={pane.deviceId} />;
    case "markdown":
      return <MarkdownPanel deviceId={pane.deviceId} />;
    case "git":
      return <GitPanel />;
    case "gitGraph":
      return (
        <GitGraphPanel
          deviceId={pane.deviceId}
          repoPath={pane.extra?.repoPath}
          paneId={pane.id}
        />
      );
    case "systemd":
      return <SystemdPanel deviceId={pane.deviceId} />;
    case "http":
      return <HttpPanel />;
    case "sql":
      return (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
              Loading editor…
            </div>
          }
        >
          <SqlPanel paneId={pane.id} />
        </Suspense>
      );
  }
}

// Panels that don't operate on a specific device — no switcher for these.
const DEVICE_AGNOSTIC: Set<PanelKind> = new Set([
  "settings",
  "services",
  "sysinfo",
  "editor",
  "git",
  "http",
  "sql",
]);

const statusIconColor: Record<string, string> = {
  connected: "text-(--color-online)",
  connecting: "text-(--color-warn) animate-pulse",
  offline: "text-(--color-fg-muted)",
  error: "text-(--color-error)",
};

const PANE_DRAG_MIME = "application/x-devnest-pane";

function dropIndicatorClass(position: DockPosition): string {
  switch (position) {
    case "left":
      return "left-0 top-0 h-full w-1/2 border-r border-(--color-accent)";
    case "right":
      return "right-0 top-0 h-full w-1/2 border-l border-(--color-accent)";
    case "top":
      return "left-0 top-0 h-1/2 w-full border-b border-(--color-accent)";
    case "bottom":
      return "bottom-0 left-0 h-1/2 w-full border-t border-(--color-accent)";
    case "center":
      return "inset-[12%] border border-(--color-accent)";
  }
}

function getDockPosition(
  event: React.DragEvent,
  rect: ReturnType<HTMLElement["getBoundingClientRect"]>,
): DockPosition {
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const threshold = 0.25;
  if (x < threshold) return "left";
  if (x > 1 - threshold) return "right";
  if (y < threshold) return "top";
  if (y > 1 - threshold) return "bottom";
  return "center";
}

function DeviceSwitcher({ pane }: { pane: Pane }) {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const updatePaneDevice = useAppStore((s) => s.updatePaneDevice);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = devices.find((d) => d.id === pane.deviceId);
  const status = current?.isLocalhost
    ? "connected"
    : (statuses[current?.id ?? ""] ?? "offline");

  // Close on outside click.
  const onDocMouseDown = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
  }, []);

  const toggleOpen = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setOpen((o) => {
        const next = !o;
        if (next) document.addEventListener("mousedown", onDocMouseDown);
        else document.removeEventListener("mousedown", onDocMouseDown);
        return next;
      });
    },
    [onDocMouseDown],
  );

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onMouseDown={toggleOpen}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
        title="Switch device"
      >
        {(() => {
          const Icon = iconForDeviceId(current?.id ?? "");
          return (
            <Icon
              size={12}
              strokeWidth={1.75}
              className={`shrink-0 ${statusIconColor[status] ?? statusIconColor.offline}`}
            />
          );
        })()}
        <span>{current?.name ?? "unknown"}</span>
        <span className="opacity-40">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-50 mt-0.5 min-w-[140px] rounded border border-(--color-border) bg-(--color-surface) py-1 shadow-lg">
          {devices.map((d) => {
            const s = d.isLocalhost
              ? "connected"
              : (statuses[d.id] ?? "offline");
            const active = d.id === pane.deviceId;
            const Icon = iconForDeviceId(d.id);
            return (
              <button
                key={d.id}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  updatePaneDevice(pane.id, d.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-(--color-surface-2) ${
                  active
                    ? "text-(--color-fg) font-medium"
                    : "text-(--color-fg-muted)"
                }`}
              >
                <Icon
                  size={13}
                  strokeWidth={1.75}
                  className={`shrink-0 ${statusIconColor[s] ?? statusIconColor.offline}`}
                />
                {d.name}
                {active && <span className="ml-auto opacity-40">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PaneHeader({ pane, workspaceId }: { pane: Pane; workspaceId: string }) {
  const ws = useAppStore(selectActiveWorkspace);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const detachPane = useAppStore((s) => s.detachPane);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);

  const isActive = pane.id === ws.activePaneId;

  const makeNewPane = (panel: PanelKind): Pane => {
    const uid = Math.random().toString(36).slice(2, 10);
    return {
      id: uid,
      deviceId: activeDeviceId ?? pane.deviceId,
      panel,
      instanceId: uid,
    };
  };

  return (
    <div
      draggable
      className="relative flex h-8 shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) px-2 text-xs select-none cursor-default"
      onMouseDown={() => setActivePane(pane.id)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          PANE_DRAG_MIME,
          JSON.stringify({ paneId: pane.id, workspaceId }),
        );
      }}
    >
      {isActive && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-(--color-accent)" />
      )}

      <span className="opacity-40 text-[10px]">{PANEL_ICONS[pane.panel]}</span>
      <span
        className={`font-medium ${isActive ? "text-(--color-fg)" : "text-(--color-fg-muted)"}`}
      >
        {PANEL_LABELS[pane.panel]}
      </span>
      {!DEVICE_AGNOSTIC.has(pane.panel) && (
        <>
          <span className="text-(--color-fg-muted) opacity-40">·</span>
          <DeviceSwitcher pane={pane} />
        </>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <button
          title="Split right"
          onClick={(e) => {
            e.stopPropagation();
            splitPane(pane.id, "horizontal", makeNewPane(pane.panel));
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          <SplitHIcon />
        </button>
        <button
          title="Split down"
          onClick={(e) => {
            e.stopPropagation();
            splitPane(pane.id, "vertical", makeNewPane(pane.panel));
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          <SplitVIcon />
        </button>
        <button
          title="Detach pane"
          onClick={async (e) => {
            e.stopPropagation();
            const opened = await openFloatingPaneWindow(pane.id, workspaceId);
            if (opened) {
              detachPane(workspaceId, pane.id);
            }
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          ↗
        </button>
        <button
          title="Close pane"
          onClick={(e) => {
            e.stopPropagation();
            if (pane.panel === "terminal") {
              terminalRegistry.destroy(pane.instanceId);
            }
            closePane(pane.id);
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-error)/20 hover:text-(--color-error)"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function LeafPane({ pane, workspaceId }: { pane: Pane; workspaceId: string }) {
  const ws = useAppStore(selectActiveWorkspace);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const dockPane = useAppStore((s) => s.dockPane);
  const isActive = pane.id === ws.activePaneId;
  const [dropPosition, setDropPosition] = useState<DockPosition | null>(null);

  const finishDrop = useCallback(() => setDropPosition(null), []);

  return (
    <div
      key={pane.id}
      className={`pane-enter ring-smooth relative flex h-full flex-col overflow-hidden ${
        isActive ? "ring-1 ring-inset ring-(--color-accent)/30" : ""
      }`}
      onMouseDown={() => setActivePane(pane.id)}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
        e.preventDefault();
        setDropPosition(getDockPosition(e, e.currentTarget.getBoundingClientRect()));
      }}
      onDragLeave={finishDrop}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(PANE_DRAG_MIME);
        finishDrop();
        if (!raw) return;
        e.preventDefault();
        try {
          const payload = JSON.parse(raw) as { paneId?: string };
          if (!payload.paneId) return;
          dockPane(workspaceId, payload.paneId, pane.id, dropPosition ?? "center");
        } catch {
          // ignore malformed drag payloads
        }
      }}
    >
      {dropPosition && (
        <>
          <div className="pointer-events-none absolute inset-0 z-20 bg-(--color-accent)/6" />
          <div
            className={`pointer-events-none absolute z-[21] bg-(--color-accent)/16 shadow-[inset_0_0_0_2px_var(--color-accent)] ${dropIndicatorClass(dropPosition)}`}
          />
        </>
      )}
      <PaneHeader pane={pane} workspaceId={workspaceId} />
      <div className="min-h-0 flex-1 overflow-hidden" key={pane.instanceId}>
        <PanelContent pane={pane} />
      </div>
    </div>
  );
}

function Divider({
  direction,
  splitId,
}: {
  direction: SplitDirection;
  splitId: string;
}) {
  const updateSplitRatio = useAppStore((s) => s.updateSplitRatio);
  const dragging = useRef(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const container = (e.currentTarget as HTMLElement).parentElement;
      if (!container) return;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const rect = container.getBoundingClientRect();
        let r: number;
        if (direction === "horizontal") {
          r = (ev.clientX - rect.left) / rect.width;
        } else {
          r = (ev.clientY - rect.top) / rect.height;
        }
        r = Math.max(0.1, Math.min(0.9, r));
        updateSplitRatio(splitId, r);
      };

      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [direction, splitId, updateSplitRatio],
  );

  const isH = direction === "horizontal";

  // Wider invisible hit target around a 1px visible line so the divider is
  // easy to grab. Negative margins keep it from pushing siblings apart.
  return (
    <div
      onMouseDown={onMouseDown}
      className={`group relative z-10 shrink-0 ${
        isH
          ? "w-[7px] cursor-col-resize -mx-[3px]"
          : "h-[7px] cursor-row-resize -my-[3px]"
      }`}
    >
      <div
        className={`absolute bg-(--color-border) transition-colors group-hover:bg-(--color-accent)/60 group-active:bg-(--color-accent) ${
          isH
            ? "left-[3px] top-0 bottom-0 w-px group-hover:w-[3px] group-hover:left-[2px]"
            : "top-[3px] left-0 right-0 h-px group-hover:h-[3px] group-hover:top-[2px]"
        }`}
      />
    </div>
  );
}

export function PaneTile({ node }: { node: PaneNode }) {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);

  if (node.type === "leaf") {
    return <LeafPane pane={node.pane} workspaceId={activeWorkspaceId} />;
  }

  const isH = node.direction === "horizontal";
  const firstSize = `${node.ratio * 100}%`;
  const secondSize = `${(1 - node.ratio) * 100}%`;

  return (
    <div className={`flex h-full w-full ${isH ? "flex-row" : "flex-col"}`}>
      <div
        style={isH ? { width: firstSize } : { height: firstSize }}
        className="min-w-0 min-h-0"
      >
        <PaneTile node={node.first} />
      </div>
      <Divider direction={node.direction} splitId={node.id} />
      <div
        style={isH ? { width: secondSize } : { height: secondSize }}
        className="min-w-0 min-h-0"
      >
        <PaneTile node={node.second} />
      </div>
    </div>
  );
}

function SplitHIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="1" y="1" width="4" height="10" rx="1" />
      <rect x="7" y="1" width="4" height="10" rx="1" />
    </svg>
  );
}

function SplitVIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="1" y="1" width="10" height="4" rx="1" />
      <rect x="1" y="7" width="10" height="4" rx="1" />
    </svg>
  );
}
