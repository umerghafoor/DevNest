import { create } from "zustand";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "devnest.theme";

function readStored(): Theme {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  const resolved =
    theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  document.documentElement.classList.toggle("theme-dark", resolved === "dark");
  document.documentElement.classList.toggle(
    "theme-light",
    resolved === "light",
  );
}

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  init: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: "system",
  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  init: () => {
    const stored = readStored();
    applyTheme(stored);
    set({ theme: stored });

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (get().theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
  },
}));
