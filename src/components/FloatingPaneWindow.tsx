import { useEffect, useMemo, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  collectPanes,
  findPaneInTree,
  syncAppStoreFromStorage,
  useAppStore,
} from "../store/app-store";
import { PanelContent, PANEL_ICONS, PANEL_LABELS } from "./PaneTile";
import {
  getFloatingPaneIdFromLocation,
  getFloatingPaneWorkspaceIdFromLocation,
  WORKSPACE_SYNC_EVENT,
} from "../lib/pane-window";

export function FloatingPaneWindow() {
  const paneId = getFloatingPaneIdFromLocation();
  const workspaceId = getFloatingPaneWorkspaceIdFromLocation();
  const allowCloseRef = useRef(false);
  const sawPaneRef = useRef(false);
  const windowHandle = useMemo(() => getCurrentWindow(), []);

  const workspace = useAppStore((s) =>
    workspaceId ? s.workspaces.find((w) => w.id === workspaceId) ?? null : null,
  );
  const pane = workspace?.floatingPanes.find((p) => p.id === paneId) ?? null;

  const destroyWindow = () => {
    allowCloseRef.current = true;
    void windowHandle.destroy();
  };

  const closeDetachedPane = () => {
    if (!paneId || !workspaceId) return;
    const state = useAppStore.getState();
    state.closeFloatingPane(workspaceId, paneId);
    void emitTo("main", WORKSPACE_SYNC_EVENT);
    destroyWindow();
  };

  const resolveDockTarget = () => {
    if (!paneId || !workspace) {
      return { targetPaneId: paneId ?? "", position: "center" as const };
    }
    if (!workspace.paneRoot) {
      return { targetPaneId: paneId, position: "center" as const };
    }
    const activeTreePane = workspace.activePaneId
      ? findPaneInTree(workspace.paneRoot, workspace.activePaneId)
      : undefined;
    const fallbackTreePane = collectPanes(workspace.paneRoot)[0];
    const targetPaneId = activeTreePane?.id ?? fallbackTreePane?.id ?? paneId;
    return { targetPaneId, position: "right" as const };
  };

  useEffect(() => {
    if (pane) return;
    const id = window.setInterval(() => {
      syncAppStoreFromStorage();
    }, 150);
    return () => {
      window.clearInterval(id);
    };
  }, [pane]);

  useEffect(() => {
    if (!paneId || !workspaceId) return;
    let unlisten: (() => void) | null = null;
    void windowHandle
      .onCloseRequested((event) => {
        if (allowCloseRef.current) return;
        event.preventDefault();
        closeDetachedPane();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [paneId, workspaceId, windowHandle]);

  useEffect(() => {
    if (!paneId || !workspaceId) return;
    if (pane) {
      sawPaneRef.current = true;
      return;
    }
    if (!sawPaneRef.current) return;
    destroyWindow();
  }, [pane, paneId, workspaceId, windowHandle]);

  const dockBack = () => {
    if (!paneId || !workspaceId) return;
    const state = useAppStore.getState();
    const { targetPaneId, position } = resolveDockTarget();
    allowCloseRef.current = true;
    state.dockPane(workspaceId, paneId, targetPaneId, position);
    void emitTo("main", WORKSPACE_SYNC_EVENT);
    destroyWindow();
  };

  if (!paneId || !workspaceId) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--color-bg) text-xs text-(--color-fg-muted)">
        Detached pane missing
      </div>
    );
  }

  if (!pane) {
    return (
      <div className="flex h-screen items-center justify-center bg-(--color-bg) text-xs text-(--color-fg-muted)">
        Opening detached pane…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-(--color-bg) text-(--color-fg)">
      <div
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-2 text-xs select-none"
      >
        <span className="opacity-40 text-[10px]">{PANEL_ICONS[pane.panel]}</span>
        <span className="font-medium">{PANEL_LABELS[pane.panel]}</span>
        <span className="ml-2 text-(--color-fg-muted)">{workspace?.name ?? "Floating pane"}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={dockBack}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded border border-(--color-accent) px-2 py-0.5 text-(--color-accent) hover:bg-(--color-accent) hover:text-white"
          >
            Dock
          </button>
          <button
            onClick={closeDetachedPane}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
          >
            Close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelContent pane={pane} />
      </div>
    </div>
  );
}
