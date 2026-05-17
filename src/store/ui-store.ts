import { create } from "zustand";

export type Density = "compact" | "comfortable" | "spacious";
export type FontSize = "sm" | "md" | "lg";
export type AccentId =
  | "amber"
  | "rose"
  | "violet"
  | "blue"
  | "emerald"
  | "slate";

export const ACCENTS: { id: AccentId; label: string; color: string; fg: string }[] = [
  { id: "amber", label: "Amber", color: "oklch(0.74 0.17 58)", fg: "oklch(0.22 0.05 50)" },
  { id: "rose", label: "Rose", color: "oklch(0.7 0.18 15)", fg: "oklch(0.99 0.01 15)" },
  { id: "violet", label: "Violet", color: "oklch(0.65 0.2 295)", fg: "oklch(0.99 0.01 295)" },
  { id: "blue", label: "Blue", color: "oklch(0.66 0.18 240)", fg: "oklch(0.99 0.01 240)" },
  { id: "emerald", label: "Emerald", color: "oklch(0.7 0.16 155)", fg: "oklch(0.2 0.05 155)" },
  { id: "slate", label: "Slate", color: "oklch(0.62 0.04 250)", fg: "oklch(0.99 0.01 250)" },
];

const STORAGE_KEY = "devnest.ui";

interface Stored {
  density: Density;
  fontSize: FontSize;
  accent: AccentId;
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { density: "comfortable", fontSize: "md", accent: "amber" };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      density: parsed.density ?? "comfortable",
      fontSize: parsed.fontSize ?? "md",
      accent: parsed.accent ?? "amber",
    };
  } catch {
    return { density: "comfortable", fontSize: "md", accent: "amber" };
  }
}

function applyFontSize(size: FontSize) {
  const px = size === "sm" ? "13px" : size === "lg" ? "16px" : "14px";
  document.documentElement.style.setProperty("--app-font-size", px);
  document.body.style.fontSize = px;
}

function applyDensity(density: Density) {
  document.documentElement.dataset.density = density;
}

function applyAccent(id: AccentId) {
  const a = ACCENTS.find((x) => x.id === id) ?? ACCENTS[0];
  document.documentElement.style.setProperty("--color-accent", a.color);
  document.documentElement.style.setProperty("--color-accent-fg", a.fg);
}

interface UiState extends Stored {
  setDensity: (d: Density) => void;
  setFontSize: (f: FontSize) => void;
  setAccent: (a: AccentId) => void;
  init: () => void;
}

function persist(s: Stored) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export const useUiStore = create<UiState>((set, get) => ({
  ...readStored(),
  setDensity: (density) => {
    applyDensity(density);
    const next = { ...get(), density };
    persist({ density: next.density, fontSize: next.fontSize, accent: next.accent });
    set({ density });
  },
  setFontSize: (fontSize) => {
    applyFontSize(fontSize);
    const next = { ...get(), fontSize };
    persist({ density: next.density, fontSize: next.fontSize, accent: next.accent });
    set({ fontSize });
  },
  setAccent: (accent) => {
    applyAccent(accent);
    const next = { ...get(), accent };
    persist({ density: next.density, fontSize: next.fontSize, accent: next.accent });
    set({ accent });
  },
  init: () => {
    const s = readStored();
    applyDensity(s.density);
    applyFontSize(s.fontSize);
    applyAccent(s.accent);
    set(s);
  },
}));
