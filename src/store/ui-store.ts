import { create } from "zustand";

export type Density = "compact" | "comfortable" | "spacious";
export type FontSize = "sm" | "md" | "lg";

const STORAGE_KEY = "devnest.ui";

interface Stored {
  density: Density;
  fontSize: FontSize;
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { density: "comfortable", fontSize: "md" };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      density: parsed.density ?? "comfortable",
      fontSize: parsed.fontSize ?? "md",
    };
  } catch {
    return { density: "comfortable", fontSize: "md" };
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

interface UiState extends Stored {
  setDensity: (d: Density) => void;
  setFontSize: (f: FontSize) => void;
  init: () => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  ...readStored(),
  setDensity: (density) => {
    applyDensity(density);
    const next = { ...get(), density };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ density: next.density, fontSize: next.fontSize }),
    );
    set({ density });
  },
  setFontSize: (fontSize) => {
    applyFontSize(fontSize);
    const next = { ...get(), fontSize };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ density: next.density, fontSize: next.fontSize }),
    );
    set({ fontSize });
  },
  init: () => {
    const s = readStored();
    applyDensity(s.density);
    applyFontSize(s.fontSize);
    set(s);
  },
}));
