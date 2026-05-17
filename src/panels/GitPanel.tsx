import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { api, errorMessage, type GhRepo, type GhUser } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { getGithubClientId } from "./SettingsPanel";
import { useAppStore } from "../store/app-store";

interface FolderBookmark {
  id: string;
  path: string;
  branch: string | null;
}

const FOLDERS_KEY = "devnest.git.folders";

function readFolders(): FolderBookmark[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FolderBookmark[]) : [];
  } catch {
    return [];
  }
}

function persistFolders(folders: FolderBookmark[]) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function GitPanel() {
  const [folders, setFolders] = useState<FolderBookmark[]>(readFolders);
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [user, setUser] = useState<GhUser | null>(null);
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const openPane = useAppStore((s) => s.openPane);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);

  const openGraph = (path: string) => {
    const uid = Math.random().toString(36).slice(2, 10);
    openPane({
      id: uid,
      instanceId: uid,
      deviceId: activeDeviceId ?? "local",
      panel: "gitGraph",
      extra: { repoPath: path },
    });
  };

  useEffect(() => {
    void api
      .githubSignedIn()
      .then(setSignedIn)
      .catch(() => setSignedIn(false));
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setUser(null);
      setRepos(null);
      return;
    }
    void api
      .githubUser()
      .then(setUser)
      .catch((e) => toast.error(`GitHub user: ${errorMessage(e)}`));
  }, [signedIn]);

  // Refresh branches for all folders on mount + after add.
  const refreshBranches = async (current: FolderBookmark[]) => {
    const updated = await Promise.all(
      current.map(async (f) => {
        try {
          const branch = await api.gitBranch(f.path);
          return { ...f, branch };
        } catch {
          return f;
        }
      }),
    );
    setFolders(updated);
    persistFolders(updated);
  };

  useEffect(() => {
    if (folders.length > 0) void refreshBranches(folders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickAndAddFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    const isRepo = await api.gitIsRepo(selected).catch(() => false);
    if (!isRepo) {
      toast.error("That folder is not a git repository.");
      return;
    }
    if (folders.some((f) => f.path === selected)) {
      toast.info("Already bookmarked.");
      return;
    }
    const branch = await api.gitBranch(selected).catch(() => null);
    const next: FolderBookmark[] = [
      ...folders,
      { id: Math.random().toString(36).slice(2, 10), path: selected, branch },
    ];
    setFolders(next);
    persistFolders(next);
    toast.success(`Added ${folderName(selected)}`);
  };

  const removeFolder = (id: string) => {
    const next = folders.filter((f) => f.id !== id);
    setFolders(next);
    persistFolders(next);
  };

  const openInFileManager = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      toast.error(`Open failed: ${errorMessage(e)}`);
    }
  };

  return (
    <div className="fade-up flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <h2 className="text-sm font-semibold">Git</h2>
        <p className="text-xs text-(--color-fg-muted)">
          Track local git folders and clone from GitHub.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-3xl space-y-6">
          <LocalFoldersSection
            folders={folders}
            onPick={pickAndAddFolder}
            onRemove={removeFolder}
            onOpen={openGraph}
            onOpenInFileManager={openInFileManager}
            onRefresh={() => void refreshBranches(folders)}
          />

          <GitHubSection
            signedIn={signedIn}
            user={user}
            repos={repos}
            reposLoading={reposLoading}
            onSignedInChange={setSignedIn}
            onLoadRepos={async () => {
              setReposLoading(true);
              try {
                const list = await api.githubListRepos();
                setRepos(list);
              } catch (e) {
                toast.error(`Load repos: ${errorMessage(e)}`);
              } finally {
                setReposLoading(false);
              }
            }}
            onClone={async (repo) => {
              const parent = await openDialog({
                directory: true,
                multiple: false,
              });
              if (typeof parent !== "string") return;
              try {
                toast.info(`Cloning ${repo.full_name}…`);
                const cloned = await api.gitClone(
                  repo.clone_url,
                  parent,
                  repo.name,
                );
                const branch = await api.gitBranch(cloned).catch(() => null);
                const next: FolderBookmark[] = [
                  ...folders,
                  {
                    id: Math.random().toString(36).slice(2, 10),
                    path: cloned,
                    branch,
                  },
                ];
                setFolders(next);
                persistFolders(next);
                toast.success(`Cloned to ${cloned}`);
              } catch (e) {
                toast.error(`Clone failed: ${errorMessage(e)}`);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

function LocalFoldersSection({
  folders,
  onPick,
  onRemove,
  onOpen,
  onOpenInFileManager,
  onRefresh,
}: {
  folders: FolderBookmark[];
  onPick: () => void;
  onRemove: (id: string) => void;
  onOpen: (path: string) => void;
  onOpenInFileManager: (path: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
          Local folders
        </h3>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            ↻ Refresh
          </button>
          <button
            onClick={onPick}
            className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
          >
            Open folder…
          </button>
        </div>
      </div>
      {folders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-(--color-border) bg-(--color-surface) px-4 py-6 text-center text-xs text-(--color-fg-muted)">
          No local repositories bookmarked. Click &quot;Open folder…&quot; to add
          one.
        </div>
      ) : (
        <ul className="space-y-2">
          {folders.map((f) => (
            <li
              key={f.id}
              className="row-animate flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {folderName(f.path)}
                  </span>
                  {f.branch && (
                    <span className="rounded bg-(--color-surface-2) px-1.5 py-0.5 font-mono text-[10px] text-(--color-fg-muted)">
                      {f.branch}
                    </span>
                  )}
                </div>
                <div
                  className="truncate font-mono text-[11px] text-(--color-fg-muted)"
                  title={f.path}
                >
                  {f.path}
                </div>
              </div>
              <button
                onClick={() => onOpen(f.path)}
                title="Open Git Graph"
                className="rounded bg-(--color-accent) px-2 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
              >
                Graph
              </button>
              <button
                onClick={() => onOpenInFileManager(f.path)}
                title="Open in file manager"
                aria-label="Open in file manager"
                className="rounded border border-(--color-border) px-1.5 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
              >
                ⎘
              </button>
              <button
                onClick={async () => {
                  const ok = await confirm(`Remove "${folderName(f.path)}"?`, {
                    title: "Remove bookmark",
                  });
                  if (ok) onRemove(f.id);
                }}
                className="rounded px-1.5 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
                aria-label="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GitHubSection({
  signedIn,
  user,
  repos,
  reposLoading,
  onSignedInChange,
  onLoadRepos,
  onClone,
}: {
  signedIn: boolean;
  user: GhUser | null;
  repos: GhRepo[] | null;
  reposLoading: boolean;
  onSignedInChange: (v: boolean) => void;
  onLoadRepos: () => void;
  onClone: (repo: GhRepo) => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered =
    repos?.filter((r) =>
      filter ? r.full_name.toLowerCase().includes(filter.toLowerCase()) : true,
    ) ?? [];

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
          GitHub
        </h3>
        {signedIn ? (
          <button
            onClick={async () => {
              const ok = await confirm("Sign out of GitHub?", {
                title: "Sign out",
              });
              if (!ok) return;
              await api.githubSignOut().catch(() => undefined);
              onSignedInChange(false);
            }}
            className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          >
            Sign out
          </button>
        ) : null}
      </div>

      {!signedIn ? (
        <SignInCard onSignedIn={() => onSignedInChange(true)} />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2">
            {user && (
              <img
                src={user.avatar_url}
                alt={user.login}
                className="h-8 w-8 rounded-full"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {user?.name ?? user?.login ?? "Signed in"}
              </div>
              <div className="truncate text-xs text-(--color-fg-muted)">
                @{user?.login ?? "—"}
              </div>
            </div>
            <button
              onClick={onLoadRepos}
              disabled={reposLoading}
              className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            >
              {reposLoading
                ? "Loading…"
                : repos
                  ? "Reload repos"
                  : "Load my repos"}
            </button>
          </div>

          {repos && (
            <>
              <input
                className="input"
                placeholder={`Filter ${repos.length} repos…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <ul className="space-y-1.5">
                {filtered.slice(0, 200).map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm">{r.full_name}</span>
                        {r.private && (
                          <span className="rounded bg-(--color-surface-2) px-1 text-[9px] uppercase text-(--color-fg-muted)">
                            private
                          </span>
                        )}
                      </div>
                      {r.description && (
                        <div className="truncate text-[11px] text-(--color-fg-muted)">
                          {r.description}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => onClone(r)}
                      className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
                    >
                      Clone
                    </button>
                  </li>
                ))}
                {filtered.length > 200 && (
                  <li className="text-center text-xs text-(--color-fg-muted)">
                    {filtered.length - 200} more — narrow the filter.
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

interface SignInState {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
}

function SignInCard({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<SignInState | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Poll for token while a device code is active.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    const clientId = getGithubClientId();
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() > state.expiresAt) {
        setError("Code expired. Try again.");
        setState(null);
        return;
      }
      try {
        const token = await api.githubDevicePoll(clientId, state.deviceCode);
        if (cancelled) return;
        if (token) {
          setState(null);
          onSignedIn();
          toast.success("Signed in to GitHub");
        } else {
          setTimeout(tick, state.interval * 1000);
        }
      } catch (e) {
        if (cancelled) return;
        setError(errorMessage(e));
        setState(null);
      }
    };
    const t = setTimeout(tick, state.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [state, onSignedIn]);

  const start = async () => {
    setError(null);
    const clientId = getGithubClientId().trim();
    if (!clientId) {
      setError(
        "Set your GitHub OAuth Client ID in Settings → Integrations first.",
      );
      return;
    }
    setStarting(true);
    try {
      const res = await api.githubDeviceStart(clientId);
      setState({
        userCode: res.user_code,
        verificationUri: res.verification_uri,
        deviceCode: res.device_code,
        interval: Math.max(5, res.interval),
        expiresAt: Date.now() + res.expires_in * 1000,
      });
      void openUrl(res.verification_uri).catch(() => undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) p-4">
      {!state ? (
        <>
          <div className="text-sm">Not signed in to GitHub.</div>
          <p className="mt-1 text-xs text-(--color-fg-muted)">
            Sign in to list and clone your repositories. Uses device-code OAuth;
            tokens are stored in your OS keychain.
          </p>
          {error && (
            <div className="mt-2 text-xs text-(--color-error)">{error}</div>
          )}
          <button
            onClick={start}
            disabled={starting}
            className="mt-3 rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            {starting ? "Starting…" : "Sign in to GitHub"}
          </button>
        </>
      ) : (
        <>
          <div className="text-sm font-medium">
            Your browser is opening GitHub. Enter this code there:
          </div>
          <div className="my-3 flex items-center justify-center gap-2">
            <code className="select-all rounded bg-(--color-bg) px-3 py-1.5 font-mono text-2xl tracking-widest text-(--color-accent)">
              {state.userCode}
            </code>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.userCode);
                  toast.success("Code copied");
                } catch {
                  toast.error("Could not copy");
                }
              }}
              className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
              title="Copy code"
            >
              Copy
            </button>
          </div>
          <div className="text-xs text-(--color-fg-muted)">
            Browser didn&apos;t open?{" "}
            <button
              onClick={() => void openUrl(state.verificationUri)}
              className="text-(--color-accent) hover:underline"
            >
              Open {state.verificationUri}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-(--color-fg-muted)">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-(--color-accent)" />
            Waiting for authorization…
          </div>
          <button
            onClick={() => setState(null)}
            className="mt-3 rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2)"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
