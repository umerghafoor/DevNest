import { create } from "zustand";

export type ThemeMode = "light" | "dark";

export interface ColorVar {
  /** CSS var name without the leading `--`. */
  name: string;
  label: string;
  description: string;
  /** Hex preview shown when no override is set, per theme. */
  defaults: { light: string; dark: string };
}

/**
 * Hex equivalents of the oklch defaults in styles.css. Approximate — used as
 * the initial value for the color input when no override is set.
 */
export const COLOR_VARS: ColorVar[] = [
  {
    name: "color-bg",
    label: "Background",
    description: "App background.",
    defaults: { light: "#fafaf6", dark: "#1f1f1d" },
  },
  {
    name: "color-surface",
    label: "Surface",
    description: "Panels, sidebar, title bar.",
    defaults: { light: "#f1efe9", dark: "#2a2a27" },
  },
  {
    name: "color-surface-2",
    label: "Surface 2",
    description: "Hovered surfaces, inputs.",
    defaults: { light: "#e6e3db", dark: "#36352f" },
  },
  {
    name: "color-border",
    label: "Border",
    description: "Dividers and outlines.",
    defaults: { light: "#d8d4c7", dark: "#403d36" },
  },
  {
    name: "color-fg",
    label: "Foreground",
    description: "Primary text.",
    defaults: { light: "#26221c", dark: "#f3f1ea" },
  },
  {
    name: "color-fg-muted",
    label: "Foreground muted",
    description: "Secondary text, hints.",
    defaults: { light: "#807a6d", dark: "#9a9588" },
  },
  {
    name: "color-accent",
    label: "Accent",
    description: "Buttons, links, highlights.",
    defaults: { light: "#d68f3c", dark: "#d68f3c" },
  },
  {
    name: "color-accent-fg",
    label: "Accent foreground",
    description: "Text on accent backgrounds.",
    defaults: { light: "#3a2a14", dark: "#3a2a14" },
  },
  {
    name: "color-online",
    label: "Online",
    description: "Connected/healthy status.",
    defaults: { light: "#4ea255", dark: "#62b069" },
  },
  {
    name: "color-offline",
    label: "Offline",
    description: "Disconnected status.",
    defaults: { light: "#a8a59c", dark: "#5d5b54" },
  },
  {
    name: "color-warn",
    label: "Warning",
    description: "Sudo, warnings.",
    defaults: { light: "#d09a3c", dark: "#d68f3c" },
  },
  {
    name: "color-error",
    label: "Error",
    description: "Failures and destructive actions.",
    defaults: { light: "#c84e2c", dark: "#d05a35" },
  },
];

type OverrideMap = Record<string, string>;

interface Stored {
  light: OverrideMap;
  dark: OverrideMap;
}

const STORAGE_KEY = "devnest.colors";

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { light: {}, dark: {} };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      light: parsed.light ?? {},
      dark: parsed.dark ?? {},
    };
  } catch {
    return { light: {}, dark: {} };
  }
}

function persist(s: Stored) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function currentMode(): ThemeMode {
  return document.documentElement.classList.contains("theme-dark")
    ? "dark"
    : "light";
}

function applyOverrides(s: Stored) {
  const mode = currentMode();
  const map = s[mode];
  // Clear any inline overrides for vars we manage, then re-apply.
  for (const v of COLOR_VARS) {
    document.documentElement.style.removeProperty(`--${v.name}`);
  }
  for (const [name, value] of Object.entries(map)) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
}

interface ColorsState extends Stored {
  setOverride: (mode: ThemeMode, name: string, value: string) => void;
  resetOverride: (mode: ThemeMode, name: string) => void;
  resetAll: () => void;
  /** Replace ALL overrides for one mode with the given map. Used by theme
   * templates. */
  applyTemplate: (mode: ThemeMode, overrides: Record<string, string>) => void;
  reapply: () => void;
  init: () => void;
}

export const useColorsStore = create<ColorsState>((set, get) => ({
  ...readStored(),
  setOverride: (mode, name, value) => {
    const s = get();
    const next: Stored = {
      light: s.light,
      dark: s.dark,
      [mode]: { ...s[mode], [name]: value },
    };
    persist(next);
    set(next);
    applyOverrides(next);
  },
  resetOverride: (mode, name) => {
    const s = get();
    const newMode = { ...s[mode] };
    delete newMode[name];
    const next: Stored = { light: s.light, dark: s.dark, [mode]: newMode };
    persist(next);
    set(next);
    applyOverrides(next);
  },
  resetAll: () => {
    const next: Stored = { light: {}, dark: {} };
    persist(next);
    set(next);
    applyOverrides(next);
  },
  applyTemplate: (mode, overrides) => {
    const s = get();
    const next: Stored = {
      light: s.light,
      dark: s.dark,
      [mode]: { ...overrides },
    };
    persist(next);
    set(next);
    applyOverrides(next);
  },
  reapply: () => applyOverrides(get()),
  init: () => {
    applyOverrides(get());
  },
}));
