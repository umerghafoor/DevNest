import { create } from "zustand";
import type { SqlEngine } from "../lib/api";

/**
 * A saved SQL connection. `viaDeviceId`, when present, means the connection
 * is opened through an SSH local-port forward sourced from the named DevDash
 * device; `host`/`port` are interpreted as the remote-side address that the
 * SSH server can reach.
 */
export interface SavedSqlConnection {
  id: string;
  name: string;
  engine: SqlEngine;
  host: string;
  port: number;
  username: string;
  database?: string;
  viaDeviceId?: string;
  updatedAt: number;
}

const STORAGE_KEY = "devnest.sql.saved";
const ACTIVE_KEY = "devnest.sql.activeId";

function readStored(): SavedSqlConnection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedSqlConnection[]) : [];
  } catch {
    return [];
  }
}

function persist(list: SavedSqlConnection[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}

interface SqlState {
  saved: SavedSqlConnection[];
  activeId: string | null;
  add: (
    conn: Omit<SavedSqlConnection, "id" | "updatedAt">,
  ) => SavedSqlConnection;
  update: (id: string, patch: Partial<SavedSqlConnection>) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
}

export const useSqlStore = create<SqlState>((set) => ({
  saved: readStored(),
  activeId: localStorage.getItem(ACTIVE_KEY),
  add: (conn) => {
    const created: SavedSqlConnection = {
      ...conn,
      id: Math.random().toString(36).slice(2, 10),
      updatedAt: Date.now(),
    };
    let next: SavedSqlConnection[] = [];
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
