import { useState } from "react";
import { toast } from "../components/Toast";

type Provider = "github" | "gitlab" | "bitbucket";

interface Repo {
  id: string;
  provider: Provider;
  fullName: string;
  url: string;
}

const STORAGE_KEY = "devnest.git.repos";

function readStored(): Repo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Repo[]) : [];
  } catch {
    return [];
  }
}

function persist(repos: Repo[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(repos));
}

function inferProvider(url: string): Provider {
  const u = url.toLowerCase();
  if (u.includes("gitlab")) return "gitlab";
  if (u.includes("bitbucket")) return "bitbucket";
  return "github";
}

function parseFullName(url: string): string {
  const cleaned = url
    .replace(/^git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  if (parts.length >= 3) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return cleaned;
}

export function GitPanel() {
  const [repos, setRepos] = useState<Repo[]>(readStored);
  const [url, setUrl] = useState("");

  const add = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const repo: Repo = {
      id: Math.random().toString(36).slice(2, 10),
      provider: inferProvider(trimmed),
      fullName: parseFullName(trimmed),
      url: trimmed,
    };
    const next = [...repos, repo];
    setRepos(next);
    persist(next);
    setUrl("");
    toast.info(`Bookmarked ${repo.fullName}`);
  };

  const remove = (id: string) => {
    const next = repos.filter((r) => r.id !== id);
    setRepos(next);
    persist(next);
  };

  return (
    <div className="fade-up flex h-full flex-col">
      <div className="shrink-0 border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <h2 className="text-sm font-semibold">Git repositories</h2>
        <p className="text-xs text-(--color-fg-muted)">
          Scaffold. Bookmark repos here; OAuth-backed listing for
          GitHub/GitLab/Bitbucket arrives in a later phase.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-4 py-2">
        <input
          className="input"
          placeholder="https://github.com/user/repo"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button
          onClick={add}
          className="rounded bg-(--color-accent) px-3 py-1 text-xs font-medium text-(--color-accent-fg) hover:opacity-90"
        >
          Add
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {repos.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
            No repositories bookmarked.
          </div>
        ) : (
          <ul className="space-y-2">
            {repos.map((r) => (
              <li
                key={r.id}
                className="row-animate flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2"
              >
                <span className="rounded bg-(--color-surface-2) px-1.5 py-0.5 text-[10px] uppercase text-(--color-fg-muted)">
                  {r.provider}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.fullName}</div>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-[11px] text-(--color-fg-muted) hover:text-(--color-accent)"
                  >
                    {r.url}
                  </a>
                </div>
                <button
                  onClick={() => remove(r.id)}
                  className="rounded px-1.5 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-error)/15 hover:text-(--color-error)"
                  aria-label="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
