import { create } from "zustand";

/**
 * A saved VNC connection profile.
 *
 * `viaDeviceId`, when present, means the connection is opened through an
 * SSH local-port forward sourced from the named DevDash device; `host`/
 * `port` are interpreted as the remote-side address that the SSH server
 * can reach.
 *
 * Password lives in the OS keyring, not here.
 */
export interface SavedVncProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  viaDeviceId?: string;
  /** Scale 0 (resize to fit) / 1 (1:1). Cosmetic — applied by noVNC. */
  scaleViewport?: boolean;
  /** Read-only viewer (suppresses keyboard/mouse). Cosmetic. */
  viewOnly?: boolean;
  updatedAt: number;
}

const STORAGE_KEY = "devnest.vnc.saved";
const ACTIVE_KEY = "devnest.vnc.activeId";

function readStored(): SavedVncProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedVncProfile[]) : [];
  } catch {
    return [];
  }
}

function persist(list: SavedVncProfile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

interface VncState {
  saved: SavedVncProfile[];
  activeId: string | null;
  add: (
    profile: Omit<SavedVncProfile, "id" | "updatedAt">,
  ) => SavedVncProfile;
  update: (id: string, patch: Partial<SavedVncProfile>) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
}

export const useVncStore = create<VncState>((set) => ({
  saved: readStored(),
  activeId: localStorage.getItem(ACTIVE_KEY),
  add: (profile) => {
    const created: SavedVncProfile = {
      ...profile,
      id: Math.random().toString(36).slice(2, 10),
      updatedAt: Date.now(),
    };
    let next: SavedVncProfile[] = [];
    set((s) => {
      next = [created, ...s.saved];
      persist(next);
      return { saved: next };
    });
    return created;
  },
  update: (id, patch) =>
    set((s) => {
      const next = s.saved.map((c) =>
        c.id === id ? { ...c, ...patch, updatedAt: Date.now() } : c,
      );
      persist(next);
      return { saved: next };
    }),
  remove: (id) =>
    set((s) => {
      const next = s.saved.filter((c) => c.id !== id);
      persist(next);
      return { saved: next, activeId: s.activeId === id ? null : s.activeId };
    }),
  setActive: (id) => {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
    set({ activeId: id });
  },
}));
