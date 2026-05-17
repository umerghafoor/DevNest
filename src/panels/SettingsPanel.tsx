import { useState } from "react";
import { useThemeStore, type Theme } from "../store/theme-store";
import {
  useUiStore,
  ACCENTS,
  type Density,
  type FontSize,
  type AccentId,
} from "../store/ui-store";
import {
  useColorsStore,
  COLOR_VARS,
  type ThemeMode,
} from "../store/colors-store";
import {
  SHORTCUTS,
  useShortcutsStore,
  formatBinding,
  type ShortcutId,
} from "../store/shortcuts-store";

type Tab = "appearance" | "shortcuts" | "integrations" | "about";

const GITHUB_CLIENT_ID_KEY = "devnest.github.clientId";

export function getGithubClientId(): string {
  try {
    return localStorage.getItem(GITHUB_CLIENT_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

export function SettingsPanel() {
  const [tab, setTab] = useState<Tab>("appearance");

  return (
    <div className="fade-up flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 gap-1 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <TabButton active={tab === "appearance"} onClick={() => setTab("appearance")}>
          Appearance
        </TabButton>
        <TabButton active={tab === "shortcuts"} onClick={() => setTab("shortcuts")}>
          Keyboard
        </TabButton>
        <TabButton
          active={tab === "integrations"}
          onClick={() => setTab("integrations")}
        >
          Integrations
        </TabButton>
        <TabButton active={tab === "about"} onClick={() => setTab("about")}>
          About
        </TabButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {tab === "appearance" && <AppearanceTab />}
        {tab === "shortcuts" && <ShortcutsTab />}
        {tab === "integrations" && <IntegrationsTab />}
        {tab === "about" && <AboutTab />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs transition-colors ${
        active
          ? "bg-(--color-surface-2) text-(--color-fg)"
          : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
      }`}
    >
      {children}
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
      {children}
    </h3>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-(--color-border) py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-(--color-fg)">{label}</div>
        {hint && (
          <div className="mt-0.5 text-xs text-(--color-fg-muted)">{hint}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-(--color-border)">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 text-xs transition-colors ${
            value === o.value
              ? "bg-(--color-accent) text-(--color-accent-fg)"
              : "bg-(--color-bg) text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AppearanceTab() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const fontSize = useUiStore((s) => s.fontSize);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const accent = useUiStore((s) => s.accent);
  const setAccent = useUiStore((s) => s.setAccent);

  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle>Theme</SectionTitle>
      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) px-4">
        <Row label="Color theme" hint="Pick light, dark, or follow your OS.">
          <Segment<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </Row>
        <Row label="Font size" hint="Applied across the app.">
          <Segment<FontSize>
            value={fontSize}
            onChange={setFontSize}
            options={[
              { value: "sm", label: "Small" },
              { value: "md", label: "Medium" },
              { value: "lg", label: "Large" },
            ]}
          />
        </Row>
        <Row label="Density" hint="How tightly content is packed.">
          <Segment<Density>
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Cozy" },
              { value: "spacious", label: "Spacious" },
            ]}
          />
        </Row>
        <Row label="Accent preset" hint="Quick swatches for the accent color.">
          <AccentSwatches value={accent} onChange={setAccent} />
        </Row>
      </div>

      <div className="mt-6">
        <ColorEditor />
      </div>
    </div>
  );
}

function ColorEditor() {
  const lightOverrides = useColorsStore((s) => s.light);
  const darkOverrides = useColorsStore((s) => s.dark);
  const setOverride = useColorsStore((s) => s.setOverride);
  const resetOverride = useColorsStore((s) => s.resetOverride);
  const resetAll = useColorsStore((s) => s.resetAll);
  const currentTheme = useThemeStore((s) => s.theme);
  // Editor mode follows the *resolved* theme so what you see is what you get.
  const resolved: ThemeMode =
    currentTheme === "dark"
      ? "dark"
      : currentTheme === "light"
        ? "light"
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  const [mode, setMode] = useState<ThemeMode>(resolved);
  const overrides = mode === "light" ? lightOverrides : darkOverrides;

  return (
    <details className="rounded-lg border border-(--color-border) bg-(--color-surface)">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted) hover:text-(--color-fg)">
        Advanced colors
      </summary>
      <div className="border-t border-(--color-border) px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <Segment<ThemeMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "light", label: "Light theme" },
              { value: "dark", label: "Dark theme" },
            ]}
          />
          <button
            onClick={resetAll}
            className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            Reset all
          </button>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2">
          {COLOR_VARS.map((v) => {
            const override = overrides[v.name];
            const value = override ?? v.defaults[mode];
            return (
              <div
                key={v.name}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-(--color-bg)"
              >
                <input
                  type="color"
                  value={value}
                  onChange={(e) => setOverride(mode, v.name, e.target.value)}
                  className="h-7 w-7 cursor-pointer rounded border border-(--color-border) bg-transparent p-0"
                  aria-label={v.label}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-(--color-fg)">
                    {v.label}
                  </div>
                  <div className="truncate text-[10px] text-(--color-fg-muted)">
                    {v.description}
                  </div>
                </div>
                {override && (
                  <button
                    onClick={() => resetOverride(mode, v.name)}
                    title="Reset to default"
                    className="rounded px-1.5 py-0.5 text-[10px] text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
                  >
                    ↺
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-(--color-fg-muted)">
          Customize any color. Each theme (light/dark) is edited separately —
          switch the toggle above. The Accent preset above writes to{" "}
          <span className="font-mono">color-accent</span> for both themes.
        </p>
      </div>
    </details>
  );
}

function AccentSwatches({
  value,
  onChange,
}: {
  value: AccentId;
  onChange: (a: AccentId) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          onClick={() => onChange(a.id)}
          title={a.label}
          aria-label={a.label}
          className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-(--color-surface) transition-all ${
            value === a.id
              ? "ring-2 ring-(--color-fg)"
              : "ring-1 ring-(--color-border) hover:scale-110"
          }`}
          style={{ backgroundColor: a.color }}
        />
      ))}
    </div>
  );
}

function ShortcutsTab() {
  const bindings = useShortcutsStore((s) => s.bindings);
  const setBinding = useShortcutsStore((s) => s.setBinding);
  const resetBinding = useShortcutsStore((s) => s.resetBinding);
  const resetAll = useShortcutsStore((s) => s.resetAll);
  const [capturingId, setCapturingId] = useState<ShortcutId | null>(null);

  const onCapture = (e: React.KeyboardEvent, id: ShortcutId) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturingId(null);
      return;
    }
    if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;

    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("Mod");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    setBinding(id, parts.join("+"));
    setCapturingId(null);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>Keyboard shortcuts</SectionTitle>
        <button
          onClick={resetAll}
          className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        >
          Reset all
        </button>
      </div>
      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) px-4">
        {SHORTCUTS.map((s) => {
          const current = bindings[s.id] ?? s.defaultBinding;
          const capturing = capturingId === s.id;
          return (
            <Row key={s.id} label={s.label}>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCapturingId(s.id)}
                  onKeyDown={(e) => capturing && onCapture(e, s.id)}
                  className={`min-w-[110px] rounded border px-2 py-1 text-xs font-mono ${
                    capturing
                      ? "border-(--color-accent) bg-(--color-accent)/10 text-(--color-fg)"
                      : "border-(--color-border) bg-(--color-bg) text-(--color-fg-muted) hover:text-(--color-fg)"
                  }`}
                >
                  {capturing ? "Press keys…" : formatBinding(current)}
                </button>
                <button
                  onClick={() => resetBinding(s.id)}
                  title="Reset to default"
                  className="rounded px-1.5 py-0.5 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
                >
                  ↺
                </button>
              </div>
            </Row>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-(--color-fg-muted)">
        Use <span className="font-mono">Mod</span> for ⌘ on macOS and{" "}
        <span className="font-mono">Ctrl</span> elsewhere. Press{" "}
        <span className="font-mono">Esc</span> while capturing to cancel.
      </p>
    </div>
  );
}

function IntegrationsTab() {
  const [clientId, setClientId] = useState(() => getGithubClientId());
  const [saved, setSaved] = useState(false);

  const save = () => {
    localStorage.setItem(GITHUB_CLIENT_ID_KEY, clientId.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle>GitHub</SectionTitle>
      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
        <div className="text-sm font-medium text-(--color-fg)">
          OAuth Client ID
        </div>
        <p className="mt-1 text-xs text-(--color-fg-muted)">
          Register an OAuth App at{" "}
          <span className="font-mono">github.com/settings/developers</span> and
          enable &quot;Device Flow&quot;. Paste the Client ID here. Tokens are
          stored in your OS keychain, never in plaintext.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder="Iv1.abc123…"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            spellCheck={false}
          />
          <button
            onClick={save}
            className="shrink-0 rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
          >
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle>About</SectionTitle>
      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4 text-sm">
        <div className="text-(--color-fg)">DevNest</div>
        <div className="mt-1 text-xs text-(--color-fg-muted)">
          A unified desktop control panel for developers and self-hosters.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-(--color-fg-muted)">
          <div>
            Version <span className="text-(--color-fg) font-mono">0.1.0</span>
          </div>
          <div>
            Engine <span className="text-(--color-fg) font-mono">Tauri 2</span>
          </div>
        </div>
      </div>
    </div>
  );
}
