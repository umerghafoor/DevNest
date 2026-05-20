/**
 * Curated color palettes. Each template is a complete map for one mode
 * (light or dark). Picking one writes all 12 color variables at once as
 * overrides in the colors-store.
 */
import type { ThemeMode } from "../store/colors-store";

export interface ThemeTemplate {
  id: string;
  name: string;
  mode: ThemeMode;
  description: string;
  /** Single representative color shown as a swatch in the picker. */
  preview: string;
  colors: {
    "color-bg": string;
    "color-surface": string;
    "color-surface-2": string;
    "color-border": string;
    "color-fg": string;
    "color-fg-muted": string;
    "color-accent": string;
    "color-accent-fg": string;
    "color-online": string;
    "color-offline": string;
    "color-warn": string;
    "color-error": string;
  };
}

export const THEME_TEMPLATES: ThemeTemplate[] = [
  // ── Dark templates ─────────────────────────────────────────────────────
  {
    id: "devnest-dark",
    name: "DevNest Dark",
    mode: "dark",
    description: "The shipped default — warm grey, amber accent.",
    preview: "#d68f3c",
    colors: {
      "color-bg": "#1f1f1d",
      "color-surface": "#2a2a27",
      "color-surface-2": "#36352f",
      "color-border": "#403d36",
      "color-fg": "#f3f1ea",
      "color-fg-muted": "#9a9588",
      "color-accent": "#d68f3c",
      "color-accent-fg": "#3a2a14",
      "color-online": "#62b069",
      "color-offline": "#5d5b54",
      "color-warn": "#d68f3c",
      "color-error": "#d05a35",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    description: "Purple haze, classic.",
    preview: "#bd93f9",
    colors: {
      "color-bg": "#282a36",
      "color-surface": "#21222c",
      "color-surface-2": "#44475a",
      "color-border": "#44475a",
      "color-fg": "#f8f8f2",
      "color-fg-muted": "#6272a4",
      "color-accent": "#bd93f9",
      "color-accent-fg": "#1e1f29",
      "color-online": "#50fa7b",
      "color-offline": "#6272a4",
      "color-warn": "#f1fa8c",
      "color-error": "#ff5555",
    },
  },
  {
    id: "nord",
    name: "Nord",
    mode: "dark",
    description: "Cool arctic blue palette.",
    preview: "#88c0d0",
    colors: {
      "color-bg": "#2e3440",
      "color-surface": "#3b4252",
      "color-surface-2": "#434c5e",
      "color-border": "#4c566a",
      "color-fg": "#eceff4",
      "color-fg-muted": "#d8dee9",
      "color-accent": "#88c0d0",
      "color-accent-fg": "#2e3440",
      "color-online": "#a3be8c",
      "color-offline": "#4c566a",
      "color-warn": "#ebcb8b",
      "color-error": "#bf616a",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    description: "Neon city after dark.",
    preview: "#7aa2f7",
    colors: {
      "color-bg": "#1a1b26",
      "color-surface": "#1f2335",
      "color-surface-2": "#292e42",
      "color-border": "#3b4261",
      "color-fg": "#c0caf5",
      "color-fg-muted": "#737aa2",
      "color-accent": "#7aa2f7",
      "color-accent-fg": "#1a1b26",
      "color-online": "#9ece6a",
      "color-offline": "#565f89",
      "color-warn": "#e0af68",
      "color-error": "#f7768e",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    mode: "dark",
    description: "Retro warm-earth tones.",
    preview: "#fabd2f",
    colors: {
      "color-bg": "#282828",
      "color-surface": "#32302f",
      "color-surface-2": "#3c3836",
      "color-border": "#504945",
      "color-fg": "#ebdbb2",
      "color-fg-muted": "#a89984",
      "color-accent": "#fabd2f",
      "color-accent-fg": "#282828",
      "color-online": "#b8bb26",
      "color-offline": "#665c54",
      "color-warn": "#fe8019",
      "color-error": "#fb4934",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    mode: "dark",
    description: "The original code-editor green/pink.",
    preview: "#a6e22e",
    colors: {
      "color-bg": "#272822",
      "color-surface": "#1e1f1c",
      "color-surface-2": "#3e3d32",
      "color-border": "#49483e",
      "color-fg": "#f8f8f2",
      "color-fg-muted": "#75715e",
      "color-accent": "#a6e22e",
      "color-accent-fg": "#272822",
      "color-online": "#a6e22e",
      "color-offline": "#75715e",
      "color-warn": "#e6db74",
      "color-error": "#f92672",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    mode: "dark",
    description: "Atom's flagship dark.",
    preview: "#61afef",
    colors: {
      "color-bg": "#282c34",
      "color-surface": "#21252b",
      "color-surface-2": "#2c313a",
      "color-border": "#3e4451",
      "color-fg": "#abb2bf",
      "color-fg-muted": "#5c6370",
      "color-accent": "#61afef",
      "color-accent-fg": "#282c34",
      "color-online": "#98c379",
      "color-offline": "#5c6370",
      "color-warn": "#e5c07b",
      "color-error": "#e06c75",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    description: "Pastel mocha with mauve accent.",
    preview: "#cba6f7",
    colors: {
      "color-bg": "#1e1e2e",
      "color-surface": "#181825",
      "color-surface-2": "#313244",
      "color-border": "#45475a",
      "color-fg": "#cdd6f4",
      "color-fg-muted": "#a6adc8",
      "color-accent": "#cba6f7",
      "color-accent-fg": "#1e1e2e",
      "color-online": "#a6e3a1",
      "color-offline": "#6c7086",
      "color-warn": "#f9e2af",
      "color-error": "#f38ba8",
    },
  },

  // ── Light templates ────────────────────────────────────────────────────
  {
    id: "devnest-light",
    name: "DevNest Light",
    mode: "light",
    description: "The shipped default — warm cream, amber accent.",
    preview: "#d68f3c",
    colors: {
      "color-bg": "#fafaf6",
      "color-surface": "#f1efe9",
      "color-surface-2": "#e6e3db",
      "color-border": "#d8d4c7",
      "color-fg": "#26221c",
      "color-fg-muted": "#807a6d",
      "color-accent": "#d68f3c",
      "color-accent-fg": "#3a2a14",
      "color-online": "#4ea255",
      "color-offline": "#a8a59c",
      "color-warn": "#d09a3c",
      "color-error": "#c84e2c",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    mode: "light",
    description: "Calm, precise, papery.",
    preview: "#268bd2",
    colors: {
      "color-bg": "#fdf6e3",
      "color-surface": "#eee8d5",
      "color-surface-2": "#e3dcc4",
      "color-border": "#93a1a1",
      "color-fg": "#073642",
      "color-fg-muted": "#586e75",
      "color-accent": "#268bd2",
      "color-accent-fg": "#fdf6e3",
      "color-online": "#859900",
      "color-offline": "#93a1a1",
      "color-warn": "#b58900",
      "color-error": "#dc322f",
    },
  },
  {
    id: "github-light",
    name: "GitHub Light",
    mode: "light",
    description: "Crisp, neutral, familiar.",
    preview: "#0969da",
    colors: {
      "color-bg": "#ffffff",
      "color-surface": "#f6f8fa",
      "color-surface-2": "#eaeef2",
      "color-border": "#d0d7de",
      "color-fg": "#1f2328",
      "color-fg-muted": "#656d76",
      "color-accent": "#0969da",
      "color-accent-fg": "#ffffff",
      "color-online": "#1a7f37",
      "color-offline": "#8c959f",
      "color-warn": "#9a6700",
      "color-error": "#cf222e",
    },
  },
  {
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    mode: "light",
    description: "Soft rosy paper.",
    preview: "#b4637a",
    colors: {
      "color-bg": "#faf4ed",
      "color-surface": "#f2e9e1",
      "color-surface-2": "#e7e0d2",
      "color-border": "#dfdad9",
      "color-fg": "#575279",
      "color-fg-muted": "#797593",
      "color-accent": "#b4637a",
      "color-accent-fg": "#faf4ed",
      "color-online": "#56949f",
      "color-offline": "#9893a5",
      "color-warn": "#ea9d34",
      "color-error": "#b4637a",
    },
  },
];
