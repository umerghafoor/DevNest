import { useEffect, useState } from "react";
import { useThemeStore, type Theme } from "../store/theme-store";
import { useUiStore, type Density, type FontSize } from "../store/ui-store";
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
import { THEME_TEMPLATES, type ThemeTemplate } from "../lib/theme-templates";
import { checkForUpdates, useUpdateStore } from "../lib/updates";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage } from "../lib/api";
import { toast } from "../components/Toast";

type Tab = "appearance" | "shortcuts" | "integrations" | "about";

const GITHUB_CLIENT_ID_KEY = "devnest.github.clientId";

/**
 * Resolution order:
 * 1. User-set value in localStorage (Settings → Integrations).
 * 2. Build-time default from VITE_GITHUB_CLIENT_ID (set in .env to ship a
 *    baked-in OAuth app, like VS Code does).
 * 3. Empty string — UI prompts the user to configure.
 */
export function getGithubClientId(): string {
  try {
    const stored = localStorage.getItem(GITHUB_CLIENT_ID_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // ignore
  }
  const baked =
    (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? "";
  return baked.trim();
}

export const GITHUB_CLIENT_ID_HAS_DEFAULT = Boolean(
  (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined)?.trim(),
);

export function SettingsPanel() {
  const [tab, setTab] = useState<Tab>("appearance");

  return (
    <div className="fade-up flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 gap-1 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <TabButton
          active={tab === "appearance"}
          onClick={() => setTab("appearance")}
        >
          Appearance
        </TabButton>
        <TabButton
          active={tab === "shortcuts"}
          onClick={() => setTab("shortcuts")}
        >
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
      </div>

      <div className="mt-6">
        <ThemeTemplatesPicker />
      </div>

      <div className="mt-6">
        <ColorEditor />
      </div>
    </div>
  );
}

function ThemeTemplatesPicker() {
  const setTheme = useThemeStore((s) => s.setTheme);
  const applyTemplate = useColorsStore((s) => s.applyTemplate);
  const lightOverrides = useColorsStore((s) => s.light);
  const darkOverrides = useColorsStore((s) => s.dark);

  // A template is "active" when every color in its palette equals the current
  // overrides for that mode.
  const isActive = (t: ThemeTemplate) => {
    const overrides = t.mode === "dark" ? darkOverrides : lightOverrides;
    return Object.entries(t.colors).every(
      ([k, v]) => overrides[k]?.toLowerCase() === v.toLowerCase(),
    );
  };

  const pick = (t: ThemeTemplate) => {
    setTheme(t.mode);
    applyTemplate(t.mode, t.colors);
  };

  const darkTemplates = THEME_TEMPLATES.filter((t) => t.mode === "dark");
  const lightTemplates = THEME_TEMPLATES.filter((t) => t.mode === "light");

  return (
    <div>
      <SectionTitle>Templates</SectionTitle>
      <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--color-fg-muted)">
          Dark
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {darkTemplates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              active={isActive(t)}
              onPick={() => pick(t)}
            />
          ))}
        </div>
        <div className="mt-4 mb-2 text-[10px] font-semibold uppercase tracking-wider text-(--color-fg-muted)">
          Light
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {lightTemplates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              active={isActive(t)}
              onPick={() => pick(t)}
            />
          ))}
        </div>
        <p className="mt-3 text-[11px] text-(--color-fg-muted)">
          Picking a template replaces all 12 colors for that mode. You can
          fine-tune any single color afterward in Advanced colors below.
        </p>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  active,
  onPick,
}: {
  template: ThemeTemplate;
  active: boolean;
  onPick: () => void;
}) {
  const c = template.colors;
  return (
    <button
      onClick={onPick}
      title={template.description}
      aria-pressed={active}
      className={`group flex flex-col overflow-hidden rounded-md text-left transition-all ${
        active
          ? "ring-2 ring-(--color-accent)/60"
          : "ring-1 ring-transparent hover:ring-1 hover:ring-(--color-fg-muted)/30"
      }`}
    >
      {/* Preview strip: bg, surface, accent, fg */}
      <div className="flex h-10" style={{ backgroundColor: c["color-bg"] }}>
        <div className="flex-1" style={{ backgroundColor: c["color-bg"] }} />
        <div
          className="flex-1"
          style={{ backgroundColor: c["color-surface"] }}
        />
        <div
          className="flex-1"
          style={{ backgroundColor: c["color-surface-2"] }}
        />
        <div
          className="flex-1"
          style={{ backgroundColor: c["color-accent"] }}
        />
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="truncate text-xs font-medium">{template.name}</span>
        {active && (
          <span className="shrink-0 text-(--color-accent)" aria-hidden>
            ✓
          </span>
        )}
      </div>
    </button>
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
          switch the toggle above. Picking a template above applies all 12
          colors at once.
        </p>
      </div>
    </details>
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
                  className={`min-w-[110px] rounded px-2 py-1 text-xs font-mono ${
                    capturing
                      ? "bg-(--color-accent)/15 text-(--color-fg) ring-1 ring-(--color-accent)/40"
                      : "bg-(--color-surface-2) text-(--color-fg-muted) hover:text-(--color-fg)"
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
  const stored =
    (typeof localStorage !== "undefined" &&
      localStorage.getItem(GITHUB_CLIENT_ID_KEY)) ||
    "";
  const [clientId, setClientId] = useState(stored);
  const [saved, setSaved] = useState(false);

  const save = () => {
    localStorage.setItem(GITHUB_CLIENT_ID_KEY, clientId.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const clear = () => {
    localStorage.removeItem(GITHUB_CLIENT_ID_KEY);
    setClientId("");
  };

  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle>GitHub</SectionTitle>
      <GithubTokenCard />
      <div className="mt-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
        <div className="text-sm font-medium text-(--color-fg)">
          OAuth Client ID
        </div>
        <p className="mt-1 text-xs text-(--color-fg-muted)">
          {GITHUB_CLIENT_ID_HAS_DEFAULT
            ? "A default Client ID is built into this build. You can override it here for custom OAuth Apps. Tokens are stored in your OS keychain, never in plaintext."
            : "Register an OAuth App at github.com/settings/developers (any GitHub account works) and enable “Device Flow”. Paste the Client ID here — you only do this once. Tokens are stored in your OS keychain."}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder={
              GITHUB_CLIENT_ID_HAS_DEFAULT ? "(using default)" : "Iv1.abc123…"
            }
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
          {stored && (
            <button
              onClick={clear}
              className="shrink-0 rounded border border-(--color-border) px-3 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            >
              Clear
            </button>
          )}
        </div>
        <details className="mt-3 text-xs text-(--color-fg-muted)">
          <summary className="cursor-pointer select-none hover:text-(--color-fg)">
            Setup guide
          </summary>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5">
            <li>
              Open{" "}
              <button
                onClick={() =>
                  void openUrl("https://github.com/settings/applications/new")
                }
                className="underline hover:text-(--color-fg)"
              >
                github.com/settings/applications/new
              </button>{" "}
              (Settings → Developer settings → OAuth Apps → New OAuth App).
            </li>
            <li>
              Fill in any <strong>Application name</strong> (e.g.{" "}
              <code className="font-mono">DevNest</code>) and use{" "}
              <code className="font-mono">http://localhost</code> for both{" "}
              <strong>Homepage URL</strong> and{" "}
              <strong>Authorization callback URL</strong> — they aren't used.
            </li>
            <li>
              Tick <strong>Enable Device Flow</strong>, then click{" "}
              <strong>Register application</strong>.
            </li>
            <li>
              Copy the <strong>Client ID</strong> from the app page (no client
              secret needed), paste it above and click <strong>Save</strong>.
            </li>
            <li>
              In the Git panel, click <strong>Sign in to GitHub</strong> and
              enter the code it shows on the page that opens.
            </li>
          </ol>
        </details>
      </div>
    </div>
  );
}

/** One token that authenticates git fetch on every device. */
function GithubTokenCard() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .githubSignedIn()
      .then(setSignedIn)
      .catch(() => setSignedIn(false));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await api.githubSetToken(token);
      const user = await api.githubUser().catch(() => null);
      setToken("");
      setSignedIn(true);
      if (user) toast.success(`Token saved for ${user.login}`);
      else toast.error("Token saved, but GitHub rejected it — check it");
    } catch (e) {
      toast.error(`Could not save token: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.githubSignOut();
      setSignedIn(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-(--color-fg)">
        Access token
        {signedIn && (
          <span className="rounded bg-(--color-accent)/12 px-1.5 text-[11px] font-normal text-(--color-accent)">
            saved
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-(--color-fg-muted)">
        Used to fetch private GitHub repos on every device — local and over SSH
        — without setting up git credentials on each machine. It stays in your
        OS keychain and is only passed to a device for the duration of a fetch.
        Signing in from the Git panel sets it too.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          className="input"
          type="password"
          placeholder={
            signedIn ? "•••••••• (replace)" : "ghp_… or github_pat_…"
          }
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && token.trim() && void save()}
          spellCheck={false}
        />
        <button
          onClick={() => void save()}
          disabled={busy || !token.trim()}
          className="shrink-0 rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
        >
          Save
        </button>
        {signedIn && (
          <button
            onClick={() => void remove()}
            className="shrink-0 rounded border border-(--color-border) px-3 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            Remove
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-(--color-fg-muted)">
        Create one at{" "}
        <button
          onClick={() =>
            void openUrl(
              "https://github.com/settings/tokens/new?scopes=repo&description=DevNest",
            )
          }
          className="underline hover:text-(--color-fg)"
        >
          github.com/settings/tokens
        </button>{" "}
        with the <code className="font-mono">repo</code> scope.
      </p>
    </div>
  );
}

function AboutTab() {
  const update = useUpdateStore((s) => s.available);
  const checking = useUpdateStore((s) => s.checking);
  const lastChecked = useUpdateStore((s) => s.lastChecked);
  const error = useUpdateStore((s) => s.error);
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
            Version <span className="text-(--color-fg) font-mono">1.3.1</span>
          </div>
          <div>
            Engine <span className="text-(--color-fg) font-mono">Tauri 2</span>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--color-border) pt-3 text-xs">
          {update ? (
            <>
              <span className="text-(--color-accent)">
                DevNest {update.version} is available.
              </span>
              <button
                onClick={() => void openUrl(update.url)}
                className="rounded-md bg-(--color-accent) px-2.5 py-1 font-medium text-(--color-accent-fg) hover:opacity-90"
              >
                Get it
              </button>
            </>
          ) : (
            <span className="text-(--color-fg-muted)">
              {checking
                ? "Checking for updates…"
                : error
                  ? `Last check failed: ${error}`
                  : lastChecked
                    ? "You're on the latest version."
                    : "DevNest checks for new versions on launch and every 6 hours."}
            </span>
          )}
          <button
            onClick={() => void checkForUpdates(true)}
            disabled={checking}
            className="ml-auto rounded-md border border-(--color-border) px-2.5 py-1 hover:bg-(--color-surface-2) disabled:opacity-50"
          >
            Check for updates
          </button>
        </div>
      </div>
    </div>
  );
}
