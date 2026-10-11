import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { RemoteFilePicker } from "../components/RemoteFilePicker";
import { api, errorMessage, type GhRepo, type GhUser } from "../lib/api";
import { toast } from "../components/Toast";
import { confirm } from "../components/ConfirmDialog";
import { getGithubClientId } from "./SettingsPanel";
import { useAppStore } from "../store/app-store";
import { iconForDeviceId } from "../lib/device-icon";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN } from "../lib/ui";
import {
  Download,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitGraph,
  Lock,
  LogOut,
  RefreshCw,
  X,
} from "lucide-react";

interface FolderBookmark {
  id: string;
  deviceId: string;
  path: string;
  branch: string | null;
}

const FOLDERS_KEY = "devnest.git.folders";

function readFolders(): FolderBookmark[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Migration: pre-multi-device bookmarks had no deviceId — default to "local".
    return parsed.map(
      (
        b: Partial<FolderBookmark> & {
          path: string;
          id?: string;
          branch?: string | null;
        },
      ) => ({
        id: b.id ?? Math.random().toString(36).slice(2, 10),
        deviceId: b.deviceId ?? "local",
        path: b.path,
        branch: b.branch ?? null,
      }),
    );
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
  const devices = useAppStore((s) => s.devices);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const openPane = useAppStore((s) => s.openPane);

  const [folders, setFolders] = useState<FolderBookmark[]>(readFolders);
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [user, setUser] = useState<GhUser | null>(null);
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);

  const deviceById = useMemo(() => {
    const m = new Map<string, { name: string; isLocalhost: boolean }>();
    for (const d of devices)
      m.set(d.id, { name: d.name, isLocalhost: d.isLocalhost });
    return m;
  }, [devices]);

  const openGraph = (deviceId: string, path: string) => {
    const uid = Math.random().toString(36).slice(2, 10);
    openPane({
      id: uid,
      instanceId: uid,
      deviceId,
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
          const branch = await api.gitBranch(f.deviceId, f.path);
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

  const addBookmark = async (deviceId: string, path: string) => {
    const trimmed = path.trim();
    if (!trimmed) {
      toast.error("Path required.");
      return;
    }
    const dev = deviceById.get(deviceId);
    if (!dev) {
      toast.error("Pick a device.");
      return;
    }
    if (folders.some((f) => f.deviceId === deviceId && f.path === trimmed)) {
      toast.info("Already bookmarked.");
      return;
    }
    const isRepo = await api.gitIsRepo(deviceId, trimmed).catch(() => false);
    if (!isRepo) {
      toast.error(`Not a git repository on ${dev.name}: ${trimmed}`);
      return;
    }
    const branch = await api.gitBranch(deviceId, trimmed).catch(() => null);
    const next: FolderBookmark[] = [
      ...folders,
      {
        id: Math.random().toString(36).slice(2, 10),
        deviceId,
        path: trimmed,
        branch,
      },
    ];
    setFolders(next);
    persistFolders(next);
    toast.success(`Added ${folderName(trimmed)} on ${dev.name}`);
  };

  const pickLocalFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    await addBookmark("local", selected);
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FoldersSection
          folders={folders}
          devices={devices.map((d) => ({
            id: d.id,
            name: d.name,
            isLocalhost: d.isLocalhost,
          }))}
          defaultDeviceId={activeDeviceId ?? "local"}
          onPickLocal={pickLocalFolder}
          onAddRemote={addBookmark}
          onRemove={removeFolder}
          onOpen={(b) => openGraph(b.deviceId, b.path)}
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
              const branch = await api
                .gitBranch("local", cloned)
                .catch(() => null);
              const next: FolderBookmark[] = [
                ...folders,
                {
                  id: Math.random().toString(36).slice(2, 10),
                  deviceId: "local",
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
  );
}

interface DeviceLite {
  id: string;
  name: string;
  isLocalhost: boolean;
}

/** "/home/beetle/projects/very/deep/EdgeVision_Core" → "/home/beetle/…/EdgeVision_Core" */
function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  const tail = parts.slice(-2).join("/");
  const head = parts.slice(0, 3).join("/");
  const s = `${head}/…/${tail}`;
  return s.length < path.length ? s : `…${path.slice(-max)}`;
}

function SectionHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 flex min-h-8 flex-wrap items-center gap-1.5 border-b border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs">
      <span className="font-semibold">{title}</span>
      {children}
    </div>
  );
}

function FoldersSection({
  folders,
  devices,
  defaultDeviceId,
  onPickLocal,
  onAddRemote,
  onRemove,
  onOpen,
  onOpenInFileManager,
  onRefresh,
}: {
  folders: FolderBookmark[];
  devices: DeviceLite[];
  defaultDeviceId: string;
  onPickLocal: () => void;
  onAddRemote: (deviceId: string, path: string) => Promise<void>;
  onRemove: (id: string) => void;
  onOpen: (bookmark: FolderBookmark) => void;
  onOpenInFileManager: (path: string) => void;
  onRefresh: () => void;
}) {
  const [deviceId, setDeviceId] = useState<string>(defaultDeviceId);
  const [adding, setAdding] = useState(false);
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const selectedDevice = devices.find((d) => d.id === deviceId);
  const isLocal = !!selectedDevice?.isLocalhost;

  const pickRemoteFolder = async (path: string) => {
    setShowRemotePicker(false);
    setAdding(true);
    try {
      await onAddRemote(deviceId, path);
    } finally {
      setAdding(false);
    }
  };

  return (
    <section>
      <SectionHeader title="Repositories">
        <span className="tabular-nums text-(--color-fg-muted)">
          {folders.length}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <select
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            className={`${SMALL_INPUT} max-w-36`}
            title="Device to add a folder from"
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.isLocalhost ? " (local)" : ""}
              </option>
            ))}
          </select>
          <div className={BTN_GROUP}>
            <button
              onClick={isLocal ? onPickLocal : () => setShowRemotePicker(true)}
              disabled={adding}
              className={`${TOOL_BTN} text-(--color-accent)`}
              title={`Bookmark a git folder on ${selectedDevice?.name ?? "device"}`}
            >
              <FolderPlus size={13} />
              {adding ? "Checking…" : "Add folder"}
            </button>
            <button
              onClick={onRefresh}
              className={TOOL_BTN}
              title="Refresh branches"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>
      </SectionHeader>

      {showRemotePicker && (
        <RemoteFilePicker
          deviceId={deviceId}
          dirOnly
          onPick={(path) => void pickRemoteFolder(path)}
          onClose={() => setShowRemotePicker(false)}
        />
      )}

      {folders.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
          No repositories yet. Choose a device above and click{" "}
          <span className="text-(--color-fg)">Add folder</span>.
        </div>
      ) : (
        <ul>
          {folders.map((f) => {
            const dev = devices.find((d) => d.id === f.deviceId);
            const DevIcon = iconForDeviceId(f.deviceId);
            return (
              <li
                key={f.id}
                className="group flex items-center gap-2 border-b border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface)"
              >
                <button
                  onClick={() => onOpen(f)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  title={`Open Git Graph for ${f.path}`}
                >
                  <GitBranch
                    size={15}
                    className="shrink-0 text-(--color-fg-muted)"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">
                        {folderName(f.path)}
                      </span>
                      {f.branch && (
                        <span className="min-w-0 truncate rounded bg-(--color-accent)/12 px-1.5 font-mono text-[11px] text-(--color-accent)">
                          {f.branch}
                        </span>
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-(--color-fg-muted)">
                      <DevIcon size={11} className="shrink-0" />
                      <span
                        className={`shrink-0 ${dev ? "" : "text-(--color-warn)"}`}
                        title={
                          dev
                            ? undefined
                            : `Device ${f.deviceId} no longer exists`
                        }
                      >
                        {dev?.name ?? "missing device"}
                      </span>
                      <span className="shrink-0">·</span>
                      <span className="truncate font-mono" title={f.path}>
                        {shortPath(f.path)}
                      </span>
                    </span>
                  </span>
                </button>
                <div className={`${BTN_GROUP} shrink-0`}>
                  <button
                    onClick={() => onOpen(f)}
                    className={TOOL_BTN}
                    title="Open Git Graph"
                  >
                    <GitGraph size={13} />
                  </button>
                  {dev?.isLocalhost && (
                    <button
                      onClick={() => onOpenInFileManager(f.path)}
                      className={TOOL_BTN}
                      title="Open in file manager"
                    >
                      <FolderOpen size={13} />
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      const ok = await confirm(
                        `Remove "${folderName(f.path)}" from the list? The folder itself isn't touched.`,
                        { title: "Remove bookmark" },
                      );
                      if (ok) onRemove(f.id);
                    }}
                    className={`${TOOL_BTN} hover:text-(--color-error)`}
                    title="Remove bookmark"
                  >
                    <X size={13} />
                  </button>
                </div>
              </li>
            );
          })}
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
    <section className="mt-3">
      <SectionHeader title="GitHub">
        {signedIn && user && (
          <span className="flex min-w-0 items-center gap-1.5 text-(--color-fg-muted)">
            <img
              src={user.avatar_url}
              alt=""
              className="h-4 w-4 shrink-0 rounded-full"
            />
            <span className="truncate">@{user.login}</span>
          </span>
        )}
        {signedIn && (
          <div className="ml-auto flex items-center gap-1.5">
            {repos && (
              <input
                className={`${SMALL_INPUT} w-36`}
                placeholder={`Filter ${repos.length} repos…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            <div className={BTN_GROUP}>
              <button
                onClick={onLoadRepos}
                disabled={reposLoading}
                className={TOOL_BTN}
              >
                {reposLoading ? "Loading…" : repos ? "Reload" : "Load repos"}
              </button>
              <button
                onClick={async () => {
                  const ok = await confirm("Sign out of GitHub?", {
                    title: "Sign out",
                  });
                  if (!ok) return;
                  await api.githubSignOut().catch(() => undefined);
                  onSignedInChange(false);
                }}
                className={TOOL_BTN}
                title="Sign out"
              >
                <LogOut size={12} />
              </button>
            </div>
          </div>
        )}
      </SectionHeader>

      {!signedIn ? (
        <SignInCard onSignedIn={() => onSignedInChange(true)} />
      ) : repos ? (
        <ul>
          {filtered.slice(0, 200).map((r) => (
            <li
              key={r.id}
              className="flex h-9 items-center gap-2 border-b border-(--color-border) px-3 text-xs hover:bg-(--color-surface)"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{r.full_name}</span>
                  {r.private && (
                    <Lock
                      size={11}
                      className="shrink-0 text-(--color-fg-muted)"
                    />
                  )}
                </span>
                {r.description && (
                  <span className="block truncate text-[11px] text-(--color-fg-muted)">
                    {r.description}
                  </span>
                )}
              </span>
              <div className={`${BTN_GROUP} shrink-0`}>
                <button
                  onClick={() => onClone(r)}
                  className={TOOL_BTN}
                  title="Clone to a folder on this computer"
                >
                  <Download size={12} />
                  Clone
                </button>
              </div>
            </li>
          ))}
          {filtered.length > 200 && (
            <li className="py-2 text-center text-xs text-(--color-fg-muted)">
              {filtered.length - 200} more — narrow the filter.
            </li>
          )}
        </ul>
      ) : (
        <div className="px-3 py-3 text-xs text-(--color-fg-muted)">
          Load your repositories to clone one.
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
    <div className="px-3 py-2 text-xs">
      {!state ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-(--color-fg-muted)">
              Sign in to list and clone your repositories.
            </span>
            <button
              onClick={start}
              disabled={starting}
              className="rounded bg-(--color-accent) px-2.5 py-1 font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            >
              {starting ? "Starting…" : "Sign in to GitHub"}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-(--color-fg-muted)/80">
            Uses device-code OAuth; the token is stored in your OS keychain.
          </p>
          {error && <div className="mt-1 text-(--color-error)">{error}</div>}
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
