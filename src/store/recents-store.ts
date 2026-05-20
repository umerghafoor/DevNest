import { create } from "zustand";
import type { PanelKind } from "./app-store";

const STORAGE_KEY = "devnest.recentPanels";
const MAX = 4;

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
