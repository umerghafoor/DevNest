import { create } from "zustand";
import { collectPanes, useAppStore, type PanelKind } from "./app-store";

const STORAGE_KEY = "devnest.recentPanels";
const MAX = 6;

function readStored(): PanelKind[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PanelKind[]) : [];
  } catch {
    return [];
  }
}

function persist(list: PanelKind[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

interface RecentsState {
  recents: PanelKind[];
  push: (kind: PanelKind) => void;
  clear: () => void;
}

export const useRecentsStore = create<RecentsState>((set) => ({
  recents: readStored(),
  push: (kind) =>
    set((s) => {
      const filtered = s.recents.filter((k) => k !== kind);
      const next = [kind, ...filtered].slice(0, MAX);
      persist(next);
      return { recents: next };
    }),
  clear: () =>
    set(() => {
      persist([]);
      return { recents: [] };
    }),
}));

// Record every pane that gets opened — palette, Dashboard, shortcuts,
// splits, agents — not just the launchers that call push().
function paneIds() {
  const ids = new Map<string, PanelKind>();
  for (const w of useAppStore.getState().workspaces) {
    const panes = [
      ...(w.paneRoot ? collectPanes(w.paneRoot) : []),
      ...w.floatingPanes,
    ];
    for (const p of panes) ids.set(p.id, p.panel);
  }
  return ids;
}
let known = paneIds();
let lastWorkspaces = useAppStore.getState().workspaces;
useAppStore.subscribe((s) => {
  if (s.workspaces === lastWorkspaces) return;
  lastWorkspaces = s.workspaces;
  const now = paneIds();
  for (const [id, panel] of now) {
    // The Dashboard is the empty-workspace screen, not a panel to reopen.
    if (!known.has(id) && panel !== "dashboard")
      useRecentsStore.getState().push(panel);
  }
  known = now;
});
