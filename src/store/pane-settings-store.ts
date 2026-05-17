import { create } from "zustand";

/**
 * Per-pane UI state that should survive remount and restart — log filters,
 * column sort, "collapsed" toggles, etc. Keyed by `pane.id`, which is
 * stable across reloads because the pane tree itself is persisted in
 * app-store.
 *
 * Each panel owns the shape of its own settings; this store is just the
 * transport. Panels narrow the value with their own helper (see
 * `usePaneSettings` below).
 */
type PaneSettings = Record<string, unknown>;

/**
 * Constraint for caller-defined settings types. Using a generic object
 * here (instead of `Record<string, unknown>`) lets typed interfaces like
 * `{ filter: string; sortKey: SortKey }` satisfy it — TypeScript requires
 * an index signature on the latter, which we don't want consumers to add.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PaneSettingsLike = Record<string, any>;

const STORAGE_KEY = "devnest.paneSettings.v1";

function readStored(): Record<string, PaneSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, PaneSettings>)
      : {};
  } catch {
    return {};
  }
}

function persist(value: Record<string, PaneSettings>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable / quota exceeded — degrade silently.
  }
}

interface PaneSettingsState {
  byPaneId: Record<string, PaneSettings>;
  patch: (paneId: string, patch: PaneSettings) => void;
  clear: (paneId: string) => void;
}

export const usePaneSettingsStore = create<PaneSettingsState>((set) => ({
  byPaneId: readStored(),
  patch: (paneId, paneSettings) =>
    set((s) => {
      const prev = s.byPaneId[paneId] ?? {};
      const next = {
        ...s.byPaneId,
        [paneId]: { ...prev, ...paneSettings },
      };
      persist(next);
      return { byPaneId: next };
    }),
  clear: (paneId) =>
    set((s) => {
      if (!(paneId in s.byPaneId)) return s;
      const { [paneId]: _drop, ...rest } = s.byPaneId;
      persist(rest);
      return { byPaneId: rest };
    }),
}));

/**
 * Typed accessor: returns `[settings, update]` for a single pane, where
 * `settings` is narrowed to `T` and merged with the caller-supplied
 * defaults so the panel can treat it as fully populated.
 */
export function usePaneSettings<T extends PaneSettingsLike>(
  paneId: string | undefined,
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const raw = usePaneSettingsStore((s) =>
    paneId ? s.byPaneId[paneId] : undefined,
  );
  const patch = usePaneSettingsStore((s) => s.patch);

  const merged = { ...defaults, ...(raw as Partial<T> | undefined) } as T;
  const update = (p: Partial<T>) => {
    if (!paneId) return;
    patch(paneId, p);
  };
  return [merged, update];
}
