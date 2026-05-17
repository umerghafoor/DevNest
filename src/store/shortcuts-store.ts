import { create } from "zustand";

export type ShortcutId =
  | "closePane"
  | "splitHorizontal"
  | "splitVertical"
  | "newWorkspace"
  | "openSettings"
  | "openDashboard"
  | "openCommandPalette";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  defaultBinding: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "closePane", label: "Close active pane", defaultBinding: "Mod+W" },
  {
    id: "splitHorizontal",
    label: "Split pane right",
    defaultBinding: "Mod+\\",
  },
  { id: "splitVertical", label: "Split pane down", defaultBinding: "Mod+-" },
  { id: "newWorkspace", label: "New workspace", defaultBinding: "Mod+T" },
  { id: "openSettings", label: "Open Settings", defaultBinding: "Mod+," },
  { id: "openDashboard", label: "Open Dashboard", defaultBinding: "Mod+D" },
  {
    id: "openCommandPalette",
    label: "Open command palette",
    defaultBinding: "Mod+K",
  },
];

const STORAGE_KEY = "devnest.shortcuts";

function readStored(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

interface ShortcutsState {
  bindings: Record<string, string>;
  setBinding: (id: ShortcutId, binding: string) => void;
  resetBinding: (id: ShortcutId) => void;
  resetAll: () => void;
  getBinding: (id: ShortcutId) => string;
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  bindings: readStored(),
  setBinding: (id, binding) =>
    set((s) => {
      const next = { ...s.bindings, [id]: binding };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return { bindings: next };
    }),
  resetBinding: (id) =>
    set((s) => {
      const next = { ...s.bindings };
      delete next[id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return { bindings: next };
    }),
  resetAll: () =>
    set(() => {
      localStorage.removeItem(STORAGE_KEY);
      return { bindings: {} };
    }),
  getBinding: (id) => {
    const def = SHORTCUTS.find((s) => s.id === id);
    return get().bindings[id] ?? def?.defaultBinding ?? "";
  },
}));

/**
 * Parse a binding string like "Mod+Shift+K" into a matcher object.
 * "Mod" means Cmd on mac, Ctrl elsewhere.
 */
export function matchesBinding(e: KeyboardEvent, binding: string): boolean {
  if (!binding) return false;
  const parts = binding.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));

  const needMod = mods.has("mod");
  const needCtrl = mods.has("ctrl");
  const needShift = mods.has("shift");
  const needAlt = mods.has("alt");

  const modOk = needMod ? e.metaKey || e.ctrlKey : true;
  const ctrlOk = needCtrl ? e.ctrlKey : !needMod ? !e.ctrlKey || needMod : true;
  const shiftOk = needShift === e.shiftKey;
  const altOk = needAlt === e.altKey;

  if (!modOk || !shiftOk || !altOk) return false;
  if (needCtrl && !ctrlOk) return false;

  return e.key.toLowerCase() === key.toLowerCase();
}

export function formatBinding(binding: string): string {
  if (!binding) return "";
  const isMac =
    typeof navigator !== "undefined" &&
    navigator.platform.toUpperCase().includes("MAC");
  return binding
    .split("+")
    .map((p) => {
      const x = p.trim();
      if (x.toLowerCase() === "mod") return isMac ? "⌘" : "Ctrl";
      if (x.toLowerCase() === "shift") return isMac ? "⇧" : "Shift";
      if (x.toLowerCase() === "alt") return isMac ? "⌥" : "Alt";
      if (x.toLowerCase() === "ctrl") return isMac ? "⌃" : "Ctrl";
      return x.length === 1 ? x.toUpperCase() : x;
    })
    .join(isMac ? "" : "+");
}
