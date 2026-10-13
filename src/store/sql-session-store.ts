import { useCallback, useState, type SetStateAction } from "react";
import { create } from "zustand";
import type { TableColumn } from "../panels/sql/sql-utils";

export type SqlConnState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/**
 * Live state of one SQL connection. Kept outside React so it survives the
 * SqlPanel unmounting — switching workspace or re-splitting the pane tree
 * remounts panels, and the backend pool / SSH tunnel stay open meanwhile.
 */
export interface SqlSession {
  state: SqlConnState;
  error: string | null;
  tables: string[];
  columns: Record<string, TableColumn[]>;
}

export const EMPTY_SESSION: SqlSession = {
  state: "disconnected",
  error: null,
  tables: [],
  columns: {},
};

interface SqlSessionState {
  sessions: Record<string, SqlSession>;
  patch: (id: string, patch: Partial<SqlSession>) => void;
  setColumns: (id: string, table: string, cols: TableColumn[]) => void;
}

export const useSqlSessionStore = create<SqlSessionState>((set) => ({
  sessions: {},
  patch: (id, patch) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...(s.sessions[id] ?? EMPTY_SESSION), ...patch },
      },
    })),
  setColumns: (id, table, cols) =>
    set((s) => {
      const prev = s.sessions[id] ?? EMPTY_SESSION;
      return {
        sessions: {
          ...s.sessions,
          [id]: { ...prev, columns: { ...prev.columns, [table]: cols } },
        },
      };
    }),
}));

// ── Per-pane UI state that should survive remount (not app restart) ────────

const paneCache = new Map<string, unknown>();

/**
 * `useState` whose value is remembered under `key` for the app's lifetime, so
 * a remounted panel picks up where it left off. With a null key it behaves
 * like plain `useState`.
 */
export function useCachedState<T>(
  key: string | null,
  initial: T,
): [T, (u: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() =>
    key && paneCache.has(key) ? (paneCache.get(key) as T) : initial,
  );
  const set = useCallback(
    (u: SetStateAction<T>) => {
      // Write plain values straight away so results that land after an
      // unmount (e.g. a slow query) are still there on remount.
      if (key && typeof u !== "function") paneCache.set(key, u);
      setValue((prev) => {
        const next = typeof u === "function" ? (u as (p: T) => T)(prev) : u;
        if (key) paneCache.set(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, set];
}
