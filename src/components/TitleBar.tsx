import { useState, useRef, useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import type { PanelKind, Pane } from "../store/app-store";
import { useRecentsStore } from "../store/recents-store";
import { usePaletteStore } from "../store/palette-store";
import {
  useShortcutsStore,
  formatBinding,
} from "../store/shortcuts-store";
import {
  PANEL_ICONS,
  PANEL_LABELS,
  PANEL_DESCRIPTIONS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  PANEL_ORDER_IN_CATEGORY,
} from "./PaneTile";

// DevNest Cradle mark — matches the brand guidelines SVG
function CradleMark({
  size = 20,
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
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized);
      })
      .then((fn) => {
        unlistenFn = fn;
      });
    return () => {
      unlistenFn?.();
    };
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
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          >
            <rect x="2.5" y="0.5" width="7" height="7" rx="0.75" />
            <rect
              x="0.5"
              y="2.5"
              width="7"
              height="7"
              rx="0.75"
              fill="var(--color-surface)"
            />
          </svg>
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          >
            <rect x="0.5" y="0.5" width="9" height="9" rx="0.75" />
          </svg>
        )}
      </button>
      <button
        onClick={close}
        title="Close"
        className="flex h-full w-9 items-center justify-center text-(--color-fg-muted) hover:bg-red-500 hover:text-white transition-colors"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}

// ─── Workspace tab ────────────────────────────────────────────────────────────

function WorkspaceTab({
  id,
  name,
  active,
}: {
  id: string;
  name: string;
  active: boolean;
}) {
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const removeWorkspace = useAppStore((s) => s.removeWorkspace);
  const renameWorkspace = useAppStore((s) => s.renameWorkspace);
  const workspaceCount = useAppStore((s) => s.workspaces.length);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) renameWorkspace(id, trimmed);
    else setDraft(name);
    setEditing(false);
  };

  return (
    // Intentionally no data-tauri-drag-region — tabs must be clickable
    <div
      className="group flex shrink-0 items-center px-0.5 select-none"
      onClick={() => !editing && setActiveWorkspace(id)}
    >
      <div
        className={`flex h-6 items-center gap-1 rounded-md px-2.5 text-xs cursor-pointer transition-colors ${
          active
            ? "bg-(--color-accent)/15 text-(--color-fg) ring-1 ring-(--color-accent)/40"
            : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        }`}
      >
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(name);
                setEditing(false);
              }
              e.stopPropagation();
            }}
            className="w-20 border-0 bg-transparent p-0 text-xs text-(--color-fg) outline-none focus:outline-none focus:ring-0"
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
            onClick={(e) => {
              e.stopPropagation();
              removeWorkspace(id);
            }}
            aria-label="Close workspace"
            className="ml-0.5 flex h-4 w-4 items-center justify-center rounded opacity-0 hover:bg-(--color-bg) group-hover:opacity-100 transition-opacity"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

// ─── New-panel dropdown ───────────────────────────────────────────────────────

interface MenuItem {
  kind: PanelKind;
  /** "Recents" / category label / null for "all (filter result)" */
  sectionLabel: string | null;
  /** First item of a section gets a header rendered above it. */
  isSectionStart: boolean;
}

function NewPanelMenu() {
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const openPane = useAppStore((s) => s.openPane);
  const recents = useRecentsStore((s) => s.recents);
  const pushRecent = useRecentsStore((s) => s.push);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build the flat list of menu items with section headers attached.
  const items = useMemo<MenuItem[]>(() => {
    const q = query.trim().toLowerCase();

    if (q) {
      // Search mode: flat list across all panels, no recents, no categories.
      const all: PanelKind[] = CATEGORY_ORDER.flatMap(
        (c) => PANEL_ORDER_IN_CATEGORY[c],
      );
      const matches = all.filter(
        (k) =>
          PANEL_LABELS[k].toLowerCase().includes(q) ||
          PANEL_DESCRIPTIONS[k].toLowerCase().includes(q),
      );
      return matches.map((kind, i) => ({
        kind,
        sectionLabel: i === 0 ? "Results" : null,
        isSectionStart: i === 0,
      }));
    }

    const result: MenuItem[] = [];
    const used = new Set<PanelKind>();

    // Recents first
    if (recents.length > 0) {
      recents.forEach((kind, i) => {
        used.add(kind);
        result.push({
          kind,
          sectionLabel: i === 0 ? "Recent" : null,
          isSectionStart: i === 0,
        });
      });
    }

    // Then categories — but skip items already shown in Recents, and only emit
    // the section header on the first *remaining* item of the category.
    for (const cat of CATEGORY_ORDER) {
      const kinds = PANEL_ORDER_IN_CATEGORY[cat].filter((k) => !used.has(k));
      kinds.forEach((kind, i) => {
        used.add(kind);
        result.push({
          kind,
          sectionLabel: i === 0 ? CATEGORY_LABELS[cat] : null,
          isSectionStart: i === 0,
        });
      });
    }
    return result;
  }, [query, recents]);

  // Reset cursor whenever the list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [items.length]);

  // Outside click / focus management.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  useEffect(() => {
    if (open) {
      // focus the input on next frame so the menu finishes mounting first
      const f = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(f);
    }
    setQuery("");
  }, [open]);

  // Keep active item in view when navigating.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-idx="${activeIdx}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  if (!activeDeviceId) return null;

  const pick = (kind: PanelKind, keepOpen = false) => {
    openPane(makePane(activeDeviceId, kind));
    pushRecent(kind);
    if (!keepOpen) setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIdx];
      if (item) pick(item.kind, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={ref} className="relative flex items-center">
      {/* <button
        onClick={() => setOpen((o) => !o)}
        title="Open panel"
        className={`flex h-full items-center gap-1 px-2.5 text-xs transition-colors ${
          open
            ? "bg-(--color-surface-2) text-(--color-fg)"
            : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        }`}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        <span>Panel</span>
      </button> */}
      {open && (
        <div
          className="modal-content absolute right-0 top-full z-50 mt-1 w-[300px] overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) shadow-2xl"
          onKeyDown={onKeyDown}
        >
          <div className="border-b border-(--color-border) bg-(--color-bg) px-2 py-1.5">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search panels…"
              className="w-full bg-transparent px-2 py-1 text-xs outline-none placeholder:text-(--color-fg-muted)"
            />
          </div>

          <div
            ref={listRef}
            className="max-h-[60vh] overflow-y-auto py-1"
            role="listbox"
          >
            {items.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-(--color-fg-muted)">
                No matches for &quot;{query}&quot;.
              </div>
            ) : (
              items.map((it, i) => (
                <MenuRow
                  key={`${it.kind}-${i}`}
                  item={it}
                  idx={i}
                  active={i === activeIdx}
                  onHover={() => setActiveIdx(i)}
                  onPick={(keepOpen) => pick(it.kind, keepOpen)}
                />
              ))
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-(--color-border) bg-(--color-bg) px-3 py-1.5 text-[10px] text-(--color-fg-muted)">
            <span>
              <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
              <kbd className="font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="font-mono">⇧↵</kbd> open + keep
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuRow({
  item,
  idx,
  active,
  onHover,
  onPick,
}: {
  item: MenuItem;
  idx: number;
  active: boolean;
  onHover: () => void;
  onPick: (keepOpen: boolean) => void;
}) {
  return (
    <>
      {item.isSectionStart && item.sectionLabel && (
        <div className="mt-1.5 px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-fg-muted) first:mt-0">
          {item.sectionLabel}
        </div>
      )}
      <button
        data-idx={idx}
        onMouseEnter={onHover}
        onClick={(e) => onPick(e.shiftKey)}
        role="option"
        aria-selected={active}
        className={`group relative flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${
          active
            ? "bg-(--color-accent)/15 text-(--color-fg)"
            : "text-(--color-fg) hover:bg-(--color-surface-2)"
        }`}
      >
        {active && (
          <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-(--color-accent)" />
        )}
        <span
          className={`w-4 shrink-0 text-center text-sm ${
            active ? "text-(--color-accent)" : "text-(--color-fg-muted)"
          }`}
        >
          {PANEL_ICONS[item.kind]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">
            {PANEL_LABELS[item.kind]}
          </span>
          <span
            className={`truncate text-[10px] ${
              active ? "text-(--color-fg-muted)" : "text-(--color-fg-muted)/80"
            }`}
          >
            {PANEL_DESCRIPTIONS[item.kind]}
          </span>
        </span>
      </button>
    </>
  );
}


// ─── Command palette trigger ──────────────────────────────────────────────────

function PaletteButton() {
  const open = usePaletteStore((s) => s.show);
  const binding = useShortcutsStore((s) =>
    s.getBinding("openCommandPalette"),
  );
  return (
    <button
      onClick={open}
      title={`Command palette (${formatBinding(binding)})`}
      className="flex h-full items-center gap-1.5 px-2.5 text-xs text-(--color-fg-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-fg)"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l3 3" />
      </svg>
      <kbd className="hidden font-mono text-[10px] opacity-70 sm:inline">
        {formatBinding(binding)}
      </kbd>
    </button>
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
    if (n.type === "leaf")
      return n.pane.id === activePaneId ? n.pane : undefined;
    return findPane(n.first) ?? findPane(n.second);
  };
  const activePaneData = findPane(paneRoot);

  const doSplit = (dir: "horizontal" | "vertical") => {
    if (!activePaneId || !activeDeviceId) return;
    splitPane(
      activePaneId,
      dir,
      makePane(activeDeviceId, activePaneData?.panel ?? "terminal"),
    );
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
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3">
          <CradleMark size={22} stroke="var(--color-fg)" />
          <span
            style={{ letterSpacing: "-0.03em", fontWeight: 400 }}
            className="text-sm select-none"
          >
            <span style={{ fontWeight: 400 }}>dev</span>
            <span style={{ fontWeight: 700 }}>nest</span>
          </span>
        </div>

        <div className="flex items-center overflow-x-auto overflow-y-hidden py-1">
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
            className="ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) transition-colors"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>
      </div>

      {/* Draggable center gap */}
      <div data-tauri-drag-region className="flex-1 min-w-4" />

      {/* Right-side actions */}
      <div className="flex items-stretch border-l border-(--color-border)">
        <PaletteButton />
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
    <svg
      width="12"
      height="12"
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
      width="12"
      height="12"
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

function CloseIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M1 1l9 9M10 1L1 10" />
    </svg>
  );
}
