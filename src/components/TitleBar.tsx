import { useState, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import type { PanelKind, Pane } from "../store/app-store";
import { PANEL_ICONS, PANEL_LABELS } from "./PaneTile";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_PANELS: PanelKind[] = [
  "terminal",
  "docker",
  "metrics",
  "files",
  "logs",
  "tailscale",
  "processes",
  "ports",
  "cron",
];

function makePane(deviceId: string, panel: PanelKind): Pane {
  const uid = Math.random().toString(36).slice(2, 10);
  return { id: uid, deviceId, panel, instanceId: uid };
}

// ─── Window controls ──────────────────────────────────────────────────────────

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    void win.isMaximized().then(setMaximized);
    let unlistenFn: (() => void) | null = null;
    void win.onResized(() => {
      void win.isMaximized().then(setMaximized);
    }).then((fn) => { unlistenFn = fn; });
    return () => { unlistenFn?.(); };
  }, []);

  const minimize = () => void getCurrentWindow().minimize();
  const toggleMax = () =>
    maximized
      ? void getCurrentWindow().unmaximize()
      : void getCurrentWindow().maximize();
  const close = () => void getCurrentWindow().close();

  return (
    // no data-tauri-drag-region here — controls must be clickable
    <div className="flex items-stretch ml-1 shrink-0">
      <button
        onClick={minimize}
        title="Minimize"
        className="flex h-full w-9 items-center justify-center text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
      >
        <svg width="10" height="1.5" viewBox="0 0 10 1.5" fill="currentColor">
          <rect width="10" height="1.5" rx="0.75" />
        </svg>
      </button>
      <button
        onClick={toggleMax}
        title={maximized ? "Restore" : "Maximize"}
        className="flex h-full w-9 items-center justify-center text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="2.5" y="0.5" width="7" height="7" rx="0.75" />
            <rect x="0.5" y="2.5" width="7" height="7" rx="0.75" fill="var(--color-surface)" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.75" />
          </svg>
        )}
      </button>
      <button
        onClick={close}
        title="Close"
        className="flex h-full w-9 items-center justify-center text-(--color-fg-muted) hover:bg-red-500 hover:text-white transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}

// ─── Workspace tab ────────────────────────────────────────────────────────────

function WorkspaceTab({ id, name, active }: { id: string; name: string; active: boolean }) {
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const renameWorkspace = useAppStore((s) => s.renameWorkspace);
  const workspaceCount = useAppStore((s) => s.workspaces.length);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(name); }, [name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) renameWorkspace(id, trimmed);
    else setDraft(name);
    setEditing(false);
  };

  return (
    // Intentionally no data-tauri-drag-region — tabs must be clickable
    <div
      className={`group relative flex h-full items-center gap-1 border-r border-(--color-border) px-3 text-xs cursor-pointer select-none transition-colors shrink-0 ${
        active
          ? "bg-(--color-bg) text-(--color-fg)"
          : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
      }`}
      onClick={() => !editing && setActiveWorkspace(id)}
    >
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-(--color-accent)" />
      )}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(name); setEditing(false); }
            e.stopPropagation();
          }}
          className="w-20 bg-transparent outline-none text-xs"
          autoFocus
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="max-w-[100px] truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
            setTimeout(() => inputRef.current?.select(), 0);
          }}
        >
          {name}
        </span>
      )}
      {workspaceCount > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); removeWorkspace(id); }}
          aria-label="Close workspace"
          className="ml-0.5 flex h-4 w-4 items-center justify-center rounded opacity-0 hover:bg-(--color-surface-2) group-hover:opacity-100 transition-opacity"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── New-panel dropdown ───────────────────────────────────────────────────────

function NewPanelMenu() {
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const openPane = useAppStore((s) => s.openPane);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  if (!activeDeviceId) return null;

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Open panel"
        className="flex h-full items-center gap-1 px-2.5 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        <span>Panel</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-0.5 min-w-[152px] rounded-lg border border-(--color-border) bg-(--color-surface) py-1 shadow-xl">
          {ALL_PANELS.map((kind) => (
            <button
              key={kind}
              onClick={() => { openPane(makePane(activeDeviceId, kind)); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-(--color-fg) hover:bg-(--color-surface-2)"
            >
              <span className="text-(--color-fg-muted) w-3 text-center">{PANEL_ICONS[kind]}</span>
              {PANEL_LABELS[kind]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Split / close active pane ────────────────────────────────────────────────

function PaneActions() {
  const ws = useAppStore(selectActiveWorkspace);
  const splitPane = useAppStore((s) => s.splitPane);
  const closePane = useAppStore((s) => s.closePane);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);

  const { activePaneId, paneRoot } = ws;
  if (!activePaneId || !paneRoot) return null;

  const findPane = (n: typeof paneRoot): Pane | undefined => {
    if (!n) return undefined;
    if (n.type === "leaf") return n.pane.id === activePaneId ? n.pane : undefined;
    return findPane(n.first) ?? findPane(n.second);
  };
  const activePaneData = findPane(paneRoot);

  const doSplit = (dir: "horizontal" | "vertical") => {
    if (!activePaneId || !activeDeviceId) return;
    splitPane(activePaneId, dir, makePane(activeDeviceId, activePaneData?.panel ?? "terminal"));
  };

  return (
    <div className="flex items-center border-l border-(--color-border)">
      <button
        title="Split right (⌘\)"
        onClick={() => doSplit("horizontal")}
        className="flex h-full items-center px-2 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
      >
        <SplitHIcon />
      </button>
      <button
        title="Split down (⌘–)"
        onClick={() => doSplit("vertical")}
        className="flex h-full items-center px-2 text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
      >
        <SplitVIcon />
      </button>
      <button
        title="Close pane (⌘W)"
        onClick={() => closePane(activePaneId)}
        className="flex h-full items-center px-2 text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error) transition-colors"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// ─── Full title bar ───────────────────────────────────────────────────────────

export function TitleBar() {
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const addWorkspace = useAppStore((s) => s.addWorkspace);

  const isMac = navigator.platform.toUpperCase().includes("MAC");

  return (
    /*
     * data-tauri-drag-region on the outer element makes the whole bar
     * draggable. Child elements that need to be interactive must stop
     * propagation or simply not carry the attribute — Tauri 2 only
     * initiates drag from elements that explicitly have the attribute.
     */
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-stretch border-b border-(--color-border) bg-(--color-surface) select-none"
    >
      {/* macOS: space for native traffic lights (~72px) */}
      {isMac && (
        <div
          data-tauri-drag-region
          className="shrink-0"
          style={{ width: 72 }}
        />
      )}

      {/* Workspace tabs — each tab is individually clickable, no drag attr */}
      <div className="flex items-stretch overflow-x-auto">
        {workspaces.map((ws) => (
          <WorkspaceTab
            key={ws.id}
            id={ws.id}
            name={ws.name}
            active={ws.id === activeWorkspaceId}
          />
        ))}
        <button
          onClick={addWorkspace}
          title="New workspace"
          className="flex h-full w-8 shrink-0 items-center justify-center text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </div>

      {/* Draggable center gap */}
      <div data-tauri-drag-region className="flex-1 min-w-4" />

      {/* Right-side actions */}
      <div className="flex items-stretch border-l border-(--color-border)">
        <NewPanelMenu />
        <PaneActions />
      </div>

      {/* Linux/Windows window controls */}
      {!isMac && (
        <div className="flex items-stretch border-l border-(--color-border)">
          <WindowControls />
        </div>
      )}
    </header>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function SplitHIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="4" height="10" rx="1" />
      <rect x="7" y="1" width="4" height="10" rx="1" />
    </svg>
  );
}

function SplitVIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="10" height="4" rx="1" />
      <rect x="1" y="7" width="10" height="4" rx="1" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M1 1l9 9M10 1L1 10" />
    </svg>
  );
}
