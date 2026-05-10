import { useRef, useCallback } from "react";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import type { PaneNode, SplitDirection, Pane } from "../store/app-store";
import { DockerPanel } from "../panels/DockerPanel";
import { MetricsPanel } from "../panels/MetricsPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { TailscalePanel } from "../panels/TailscalePanel";
import { FileBrowserPanel } from "../panels/FileBrowserPanel";
import { LogViewerPanel } from "../panels/LogViewerPanel";
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

function PanelContent({ pane }: { pane: Pane }) {
  switch (pane.panel) {
    case "docker":
      return <DockerPanel deviceId={pane.deviceId} />;
    case "metrics":
      return <MetricsPanel deviceId={pane.deviceId} />;
    case "terminal":
      return <TerminalPanel deviceId={pane.deviceId} instanceId={pane.instanceId} />;
    case "tailscale":
      return <TailscalePanel deviceId={pane.deviceId} />;
    case "files":
      return <FileBrowserPanel deviceId={pane.deviceId} />;
    case "logs":
      return <LogViewerPanel deviceId={pane.deviceId} />;
  }
}

function PaneHeader({ pane }: { pane: Pane }) {
  const ws = useAppStore(selectActiveWorkspace);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const closePane = useAppStore((s) => s.closePane);
  const splitPane = useAppStore((s) => s.splitPane);
  const devices = useAppStore((s) => s.devices);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);

  const isActive = pane.id === ws.activePaneId;
  const device = devices.find((d) => d.id === pane.deviceId);

  const makeNewPane = (panel: PanelKind): Pane => {
    const uid = Math.random().toString(36).slice(2, 10);
    return { id: uid, deviceId: activeDeviceId ?? pane.deviceId, panel, instanceId: uid };
  };

  return (
    <div
      className="relative flex h-8 shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) px-2 text-xs select-none cursor-default"
      onMouseDown={() => setActivePane(pane.id)}
    >
      {isActive && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-(--color-accent)" />
      )}

      <span className="opacity-40 text-[10px]">{PANEL_ICONS[pane.panel]}</span>
      <span className={`font-medium ${isActive ? "text-(--color-fg)" : "text-(--color-fg-muted)"}`}>
        {PANEL_LABELS[pane.panel]}
      </span>
      {device && (
        <span className="text-(--color-fg-muted) text-[11px]">· {device.name}</span>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <button
          title="Split right"
          onClick={(e) => { e.stopPropagation(); splitPane(pane.id, "horizontal", makeNewPane(pane.panel)); }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          <SplitHIcon />
        </button>
        <button
          title="Split down"
          onClick={(e) => { e.stopPropagation(); splitPane(pane.id, "vertical", makeNewPane(pane.panel)); }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          <SplitVIcon />
        </button>
        <button
          title="Close pane"
          onClick={(e) => { e.stopPropagation(); closePane(pane.id); }}
          className="flex h-5 w-5 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-error)/20 hover:text-(--color-error)"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function LeafPane({ pane }: { pane: Pane }) {
  const ws = useAppStore(selectActiveWorkspace);
  const setActivePane = useAppStore((s) => s.setActivePane);
  const isActive = pane.id === ws.activePaneId;

  return (
    <div
      className={`relative flex h-full flex-col overflow-hidden ${
        isActive ? "ring-1 ring-inset ring-(--color-accent)/30" : ""
      }`}
      onMouseDown={() => setActivePane(pane.id)}
    >
      <PaneHeader pane={pane} />
      <div className="min-h-0 flex-1 overflow-hidden">
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

  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 bg-(--color-border) transition-colors hover:bg-(--color-accent)/50 active:bg-(--color-accent) ${
        isH
          ? "w-px cursor-col-resize hover:w-[3px]"
          : "h-px cursor-row-resize hover:h-[3px]"
      }`}
      style={
        isH
          ? { marginLeft: "-0.5px", marginRight: "-0.5px" }
          : { marginTop: "-0.5px", marginBottom: "-0.5px" }
      }
    />
  );
}

export function PaneTile({ node }: { node: PaneNode }) {
  if (node.type === "leaf") {
    return <LeafPane pane={node.pane} />;
  }

  const isH = node.direction === "horizontal";
  const firstSize = `${node.ratio * 100}%`;
  const secondSize = `${(1 - node.ratio) * 100}%`;

  return (
    <div className={`flex h-full w-full ${isH ? "flex-row" : "flex-col"}`}>
      <div style={isH ? { width: firstSize } : { height: firstSize }} className="min-w-0 min-h-0">
        <PaneTile node={node.first} />
      </div>
      <Divider direction={node.direction} splitId={node.id} />
      <div style={isH ? { width: secondSize } : { height: secondSize }} className="min-w-0 min-h-0">
        <PaneTile node={node.second} />
      </div>
    </div>
  );
}

function SplitHIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="4" height="10" rx="1" />
      <rect x="7" y="1" width="4" height="10" rx="1" />
    </svg>
  );
}

function SplitVIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="10" height="4" rx="1" />
      <rect x="1" y="7" width="10" height="4" rx="1" />
    </svg>
  );
}
