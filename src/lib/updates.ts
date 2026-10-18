import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../components/Toast";
import { notifyCompleted } from "./notify";

/**
 * "Is there a newer DevNest?" — compares this build's version with the
 * latest GitHub release (the release workflow publishes `vX.Y.Z` for every
 * version that lands on main). Notify-only: it links to the release page,
 * it doesn't download or install anything.
 */

const RELEASES_API =
  "https://api.github.com/repos/umerghafoor/DevNest/releases/latest";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;
/** Last version we told the user about, so each one is announced once. */
const ANNOUNCED_KEY = "devnest.update.announced";

export interface Release {
  version: string;
  url: string;
  publishedAt: string | null;
}

interface UpdateState {
  current: string | null;
  /** The latest release, when it's newer than `current`. */
  available: Release | null;
  checking: boolean;
  lastChecked: number | null;
  error: string | null;
}

export const useUpdateStore = create<UpdateState>(() => ({
  current: null,
  available: null,
  checking: false,
  lastChecked: null,
  error: null,
}));

/** -1 / 0 / 1 for x.y.z versions (a leading "v" and suffixes are ignored). */
export function compareVersions(a: string, b: string) {
  const parts = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** Check now. `manual` reports "up to date" too; quiet checks only speak up
 *  for a new version, once per version. */
export async function checkForUpdates(manual = false) {
  const st = useUpdateStore.getState();
  if (st.checking) return;
  useUpdateStore.setState({ checking: true, error: null });
  try {
    const current = st.current ?? (await invoke<string>("app_version"));
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    if (!body.tag_name || body.draft || body.prerelease)
      throw new Error("No published release found");
    const latest: Release = {
      version: body.tag_name.replace(/^v/i, ""),
      url: body.html_url ?? "https://github.com/umerghafoor/DevNest/releases",
      publishedAt: body.published_at ?? null,
    };
    const newer = compareVersions(latest.version, current) > 0;
    useUpdateStore.setState({
      current,
      available: newer ? latest : null,
      lastChecked: Date.now(),
    });
    if (newer) announce(latest, manual);
    else if (manual) toast.success(`DevNest ${current} is the latest version`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useUpdateStore.setState({ error: message, lastChecked: Date.now() });
    if (manual) toast.error(`Couldn't check for updates: ${message}`);
  } finally {
    useUpdateStore.setState({ checking: false });
  }
}

function announce(r: Release, manual: boolean) {
  let told: string | null = null;
  try {
    told = localStorage.getItem(ANNOUNCED_KEY);
  } catch {
    // no storage: announce every time
  }
  if (!manual && told === r.version) return;
  try {
    localStorage.setItem(ANNOUNCED_KEY, r.version);
  } catch {
    // ignore
  }
  toast.info(
    `DevNest ${r.version} is available — click the version in the status bar to get it`,
  );
  // System notification too when the window isn't in front.
  notifyCompleted(
    `DevNest ${r.version} is available`,
    "Open DevNest to see what's new.",
  );
}

let started = false;
/** Check shortly after launch, then every few hours. Call once. */
export function startUpdateChecks() {
  if (started) return;
  started = true;
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
}
