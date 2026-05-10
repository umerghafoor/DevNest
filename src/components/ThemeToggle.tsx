import { useThemeStore } from "../store/theme-store";
import type { Theme } from "../store/theme-store";

const order: Theme[] = ["light", "dark", "system"];
const icon: Record<Theme, string> = {
  light: "☀",
  dark: "☾",
  system: "⌬",
};
const label: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const cycle = () => {
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  return (
    <button
      onClick={cycle}
      title={`Theme: ${label[theme]} (click to change)`}
      aria-label={`Theme: ${label[theme]}`}
      className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
    >
      {icon[theme]} {label[theme]}
    </button>
  );
}
