import { create } from "zustand";

export type Density = "compact" | "comfortable" | "spacious";
export type FontSize = "sm" | "md" | "lg";

const STORAGE_KEY = "devnest.ui";

interface Stored {
  density: Density;
  fontSize: FontSize;
  sidebarCollapsed: boolean;
}

function readStored(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
      return {
        density: "comfortable",
        fontSize: "md",
        sidebarCollapsed: false,
      };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      density: parsed.density ?? "comfortable",
      fontSize: parsed.fontSize ?? "md",
      sidebarCollapsed: parsed.sidebarCollapsed ?? false,
    };
  } catch {
    return {
      density: "comfortable",
      fontSize: "md",
      sidebarCollapsed: false,
    };
  }
}

function applyFontSize(size: FontSize) {
  const px = size === "sm" ? "13px" : size === "lg" ? "16px" : "14px";
  // Drives `html { font-size }` via the --app-font-size-base custom property
  // defined in styles.css. Tailwind's rem-based utilities pick this up
  // automatically so text-xs / text-sm / padding / gap all scale together.
  document.documentElement.style.setProperty("--app-font-size-base", px);
}

function applyDensity(density: Density) {
  // Composes with font-size: density tweaks the *scale* multiplier, font-size
  // sets the *base*. Final root font-size = base * scale.
  const scale =
    density === "compact" ? "0.95" : density === "spacious" ? "1.06" : "1";
  document.documentElement.style.setProperty("--app-font-scale", scale);
  document.documentElement.dataset.density = density;
}

// WebKitGTK doesn't always repaint at the new backing scale when the window
// is dragged to a monitor with a different OS scale factor: devicePixelRatio
// updates, but already-painted content stays rendered at the stale scale
// until something forces a relayout. `matchMedia` resolution queries don't
// auto-track a moving target, so we re-subscribe on every change to keep
// catching the next transition.
function watchDisplayScaleChanges(onChange: () => void) {
  let mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const listener = () => {
    onChange();
    mq.removeEventListener("change", listener);
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", listener);
  };
  mq.addEventListener("change", listener);
}

function forceRepaint() {
  const el = document.documentElement;
  const prevDisplay = el.style.display;
  el.style.display = "none";
  void el.offsetHeight; // flush layout so the toggle actually forces a reflow
  el.style.display = prevDisplay;
}

interface UiState extends Stored {
  setDensity: (d: Density) => void;
  setFontSize: (f: FontSize) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
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
    persist({
      density: next.density,
      fontSize: next.fontSize,
      sidebarCollapsed: next.sidebarCollapsed,
    });
    set({ density });
  },
  setFontSize: (fontSize) => {
    applyFontSize(fontSize);
    const next = { ...get(), fontSize };
    persist({
      density: next.density,
      fontSize: next.fontSize,
      sidebarCollapsed: next.sidebarCollapsed,
    });
    set({ fontSize });
  },
  setSidebarCollapsed: (sidebarCollapsed) => {
    const next = { ...get(), sidebarCollapsed };
    persist({
      density: next.density,
      fontSize: next.fontSize,
      sidebarCollapsed: next.sidebarCollapsed,
    });
    set({ sidebarCollapsed });
  },
  init: () => {
    const s = readStored();
    applyDensity(s.density);
    applyFontSize(s.fontSize);
    set(s);
    watchDisplayScaleChanges(forceRepaint);
  },
}));
