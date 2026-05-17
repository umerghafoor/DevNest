import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type {
  GitBranchInfo,
  GitCommit,
  GitCommitDetail,
  GitTag,
} from "../lib/api";
import { SkeletonCard } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { usePaneSettings } from "../store/pane-settings-store";

interface Props {
  repoPath?: string;
  paneId?: string;
  deviceId: string;
}

// ─── Lane assignment ─────────────────────────────────────────────────────────
// Simple lane allocator: each commit takes its parent's lane if available,
// otherwise the next free lane. Good enough for a readable graph without
// pulling in a full DAG layout library.

interface LaidOutCommit extends GitCommit {
  lane: number;
  laneCount: number;
  /** For each existing lane, which commit-hash currently occupies it (or null). */
  laneSnapshot: (string | null)[];
}

function layoutCommits(commits: GitCommit[]): LaidOutCommit[] {
  const result: LaidOutCommit[] = [];
  // lanes[i] === commit-hash expected to land in lane i next, or null.
  let lanes: (string | null)[] = [];

  for (const c of commits) {
    // Find or assign a lane for this commit.
    let lane = lanes.findIndex((h) => h === c.hash);
    if (lane === -1) {
      // Reuse an empty slot, else append.
      const empty = lanes.findIndex((h) => h === null);
      if (empty !== -1) {
        lane = empty;
        lanes[empty] = c.hash;
      } else {
        lane = lanes.length;
        lanes.push(c.hash);
      }
    }

    const snapshot = [...lanes];

    // Place parents: first parent inherits the lane, additional parents get
    // new lanes (these will appear as merges joining in).
    const parents = c.parents;
    // Clear this lane first.
    lanes[lane] = parents[0] ?? null;
    for (let i = 1; i < parents.length; i++) {
      const slot = lanes.findIndex((h) => h === null);
      if (slot !== -1) lanes[slot] = parents[i];
      else lanes.push(parents[i]);
    }

    // Trim trailing empty lanes to keep width tight.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();

    result.push({
      ...c,
      lane,
      laneCount: Math.max(snapshot.length, lanes.length),
      laneSnapshot: snapshot,
    });
  }
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LANE_COLORS = [
  "var(--color-accent)",
  "oklch(0.7 0.16 145)",
  "oklch(0.66 0.18 240)",
  "oklch(0.65 0.2 295)",
  "oklch(0.7 0.18 15)",
  "oklch(0.74 0.17 58)",
  "oklch(0.62 0.04 250)",
];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
}

function parseRefs(refs: string[]): {
  head: string | null;
  branches: string[];
  remotes: string[];
  tags: string[];
} {
  let head: string | null = null;
  const branches: string[] = [];
  const remotes: string[] = [];
  const tags: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("HEAD -> ")) {
      head = ref.slice("HEAD -> ".length);
      branches.push(head);
    } else if (ref === "HEAD") {
      head = "HEAD";
    } else if (ref.startsWith("tag: ")) {
      tags.push(ref.slice("tag: ".length));
    } else if (ref.includes("/")) {
      remotes.push(ref);
    } else {
      branches.push(ref);
    }
  }
  return { head, branches, remotes, tags };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function GitGraphPanel({ repoPath, paneId, deviceId }: Props) {
  const [paneSettings, updatePaneSettings] = usePaneSettings(paneId, {
    detailCollapsed: false,
  });
  const detailCollapsed = paneSettings.detailCollapsed;
  const setDetailCollapsed = (v: boolean) =>
    updatePaneSettings({ detailCollapsed: v });
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!repoPath) return;
    setError(null);
    try {
      const [c, b, t] = await Promise.all([
        api.gitLog(deviceId, repoPath, 500),
        api.gitBranches(deviceId, repoPath),
        api.gitTags(deviceId, repoPath),
      ]);
      setCommits(c);
      setBranches(b);
      setTags(t);
      if (c.length > 0 && !selected) setSelected(c[0].hash);
    } catch (e) {
      setError(errorMessage(e));
      setCommits([]);
    }
  }, [deviceId, repoPath, selected]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, repoPath]);

  // Load commit detail when selection changes.
  useEffect(() => {
    if (!repoPath || !selected) {
      setDetail(null);
      setDiffFile(null);
      setDiffText(null);
      return;
    }
    void api
      .gitShow(deviceId, repoPath, selected)
      .then((d) => {
        setDetail(d);
        setDiffFile(d.files[0]?.path ?? null);
      })
      .catch((e) => {
        toast.error(`git show: ${errorMessage(e)}`);
        setDetail(null);
      });
  }, [deviceId, repoPath, selected]);

  // Load file diff when file selection changes.
  useEffect(() => {
    if (!repoPath || !selected || !diffFile) {
      setDiffText(null);
      return;
    }
    setDiffText(null);
    void api
      .gitDiff(deviceId, repoPath, selected, diffFile)
      .then(setDiffText)
      .catch((e) => setDiffText(`Could not load diff:\n${errorMessage(e)}`));
  }, [deviceId, repoPath, selected, diffFile]);

  const laidOut = useMemo(
    () => (commits ? layoutCommits(commits) : []),
    [commits],
  );

  if (!repoPath) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
        No repository selected.
      </div>
    );
  }

  if (error && !commits) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-(--color-error)">
        {error}
      </div>
    );
  }

  if (!commits) {
    return (
      <div className="space-y-3 p-4">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="fade-up flex h-full flex-col overflow-hidden">
      <Header
        repoPath={repoPath}
        branches={branches}
        tags={tags}
        commitCount={commits.length}
        onReload={() => void reload()}
        detailCollapsed={detailCollapsed}
        onToggleDetail={() => setDetailCollapsed(!detailCollapsed)}
      />
      <div className="flex min-h-0 flex-1">
        <CommitList
          commits={laidOut}
          selected={selected}
          onSelect={setSelected}
        />
        {!detailCollapsed && (
        <DetailPane
          detail={detail}
          diffFile={diffFile}
          diffText={diffText}
          onSelectFile={setDiffFile}
        />
        )}
      </div>
    </div>
  );
}

function Header({
  repoPath,
  branches,
  tags,
  commitCount,
  onReload,
  detailCollapsed,
  onToggleDetail,
}: {
  repoPath: string;
  branches: GitBranchInfo[];
  tags: GitTag[];
  commitCount: number;
  onReload: () => void;
  detailCollapsed: boolean;
  onToggleDetail: () => void;
}) {
  const current = branches.find((b) => b.is_current);
  const localCount = branches.filter((b) => !b.is_remote).length;
  const remoteCount = branches.filter((b) => b.is_remote).length;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--color-surface) px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">
            {repoPath.split("/").pop() ?? repoPath}
          </span>
          {current && (
            <span className="rounded bg-(--color-accent)/15 px-1.5 py-0.5 font-mono text-[10px] text-(--color-accent)">
              {current.name}
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-(--color-fg-muted)">
          {repoPath}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-(--color-fg-muted)">
        <span>{commitCount} commits</span>
        <span>·</span>
        <span>{localCount} local</span>
        <span>{remoteCount} remote</span>
        <span>{tags.length} tags</span>
      </div>
      <button
        onClick={onToggleDetail}
        className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        title={detailCollapsed ? "Show commit detail" : "Hide commit detail"}
      >
        {detailCollapsed ? "⇤" : "⇥"}
      </button>
      <button
        onClick={onReload}
        className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
        title="Reload"
      >
        ↻
      </button>
    </div>
  );
}

function CommitList({
  commits,
  selected,
  onSelect,
}: {
  commits: LaidOutCommit[];
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto border-r border-(--color-border)">
      {commits.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
          No commits.
        </div>
      ) : (
        <ul>
          {commits.map((c, i) => {
            const next = commits[i + 1];
            return (
              <CommitRow
                key={c.hash}
                commit={c}
                next={next}
                isSelected={c.hash === selected}
                onSelect={() => onSelect(c.hash)}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;

function CommitRow({
  commit,
  next,
  isSelected,
  onSelect,
}: {
  commit: LaidOutCommit;
  next: LaidOutCommit | undefined;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { head, branches, remotes, tags } = parseRefs(commit.refs);
  const laneCount = Math.max(
    commit.laneCount,
    next?.laneSnapshot.length ?? 0,
    commit.lane + 1,
  );
  const graphWidth = laneCount * LANE_WIDTH + 6;

  return (
    <li
      onClick={onSelect}
      className={`group flex cursor-pointer items-center gap-2 border-b border-(--color-border)/30 px-2 hover:bg-(--color-surface-2) ${
        isSelected ? "bg-(--color-surface-2)" : ""
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <Graph
        commit={commit}
        next={next}
        width={graphWidth}
        height={ROW_HEIGHT}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-xs">
          {head === commit.refs[0]?.replace(/^HEAD -> /, "") && head && (
            <span className="rounded bg-(--color-accent) px-1 py-px font-mono text-[9px] font-semibold text-(--color-accent-fg)">
              HEAD
            </span>
          )}
          {branches.map((b) => (
            <span
              key={b}
              className="rounded bg-(--color-accent)/15 px-1 py-px font-mono text-[9px] text-(--color-accent)"
            >
              {b}
            </span>
          ))}
          {remotes.map((r) => (
            <span
              key={r}
              className="rounded bg-(--color-surface) px-1 py-px font-mono text-[9px] text-(--color-fg-muted) ring-1 ring-(--color-border)"
            >
              {r}
            </span>
          ))}
          {tags.map((t) => (
            <span
              key={t}
              className="rounded bg-(--color-warn)/15 px-1 py-px font-mono text-[9px] text-(--color-warn)"
            >
              {t}
            </span>
          ))}
          <span className="truncate text-(--color-fg)">{commit.subject}</span>
        </div>
      </div>
      <span className="hidden shrink-0 font-mono text-[10px] text-(--color-fg-muted) sm:block">
        {commit.short_hash}
      </span>
      <span className="hidden shrink-0 truncate text-[10px] text-(--color-fg-muted) md:block md:max-w-[120px]">
        {commit.author_name}
      </span>
    </li>
  );
}

function Graph({
  commit,
  next,
  width,
  height,
}: {
  commit: LaidOutCommit;
  next: LaidOutCommit | undefined;
  width: number;
  height: number;
}) {
  const cy = height / 2;
  const laneX = (i: number) => i * LANE_WIDTH + LANE_WIDTH / 2;

  // Lines that *pass through* this row (lanes that aren't this commit's lane
  // but exist both above and below it).
  const passThroughLines: React.ReactElement[] = [];
  for (let i = 0; i < commit.laneSnapshot.length; i++) {
    if (i === commit.lane) continue;
    const hash = commit.laneSnapshot[i];
    if (!hash) continue;
    // Only draw if the next row also has something in this lane (otherwise the
    // lane ends here and we don't need a passing-through line).
    const stillThere = next?.laneSnapshot[i];
    if (stillThere) {
      passThroughLines.push(
        <line
          key={`pt-${i}`}
          x1={laneX(i)}
          y1={0}
          x2={laneX(i)}
          y2={height}
          stroke={laneColor(i)}
          strokeWidth={1.5}
          strokeLinecap="round"
        />,
      );
    } else if (commit.laneSnapshot[i]) {
      // Lane terminates on this row — draw top half only.
      passThroughLines.push(
        <line
          key={`pt-${i}`}
          x1={laneX(i)}
          y1={0}
          x2={laneX(i)}
          y2={cy}
          stroke={laneColor(i)}
          strokeWidth={1.5}
        />,
      );
    }
  }

  // Top half: incoming line from previous row's lane (visible only if this
  // wasn't a new branch start).
  const incoming =
    commit.laneSnapshot[commit.lane] === commit.hash ? (
      <line
        x1={laneX(commit.lane)}
        y1={0}
        x2={laneX(commit.lane)}
        y2={cy}
        stroke={laneColor(commit.lane)}
        strokeWidth={1.5}
      />
    ) : null;

  // Bottom half: edges to each parent's lane (in the *next* row's snapshot).
  const edgesDown: React.ReactElement[] = [];
  if (next) {
    for (const parent of commit.parents) {
      const parentLane = next.laneSnapshot.findIndex((h) => h === parent);
      if (parentLane === -1) continue;
      edgesDown.push(
        <line
          key={`down-${parent}`}
          x1={laneX(commit.lane)}
          y1={cy}
          x2={laneX(parentLane)}
          y2={height}
          stroke={laneColor(parentLane)}
          strokeWidth={1.5}
        />,
      );
    }
  }

  return (
    <svg width={width} height={height} className="shrink-0">
      {passThroughLines}
      {incoming}
      {edgesDown}
      <circle
        cx={laneX(commit.lane)}
        cy={cy}
        r={4}
        fill={laneColor(commit.lane)}
        stroke="var(--color-bg)"
        strokeWidth={1.5}
      />
    </svg>
  );
}

function DetailPane({
  detail,
  diffFile,
  diffText,
  onSelectFile,
}: {
  detail: GitCommitDetail | null;
  diffFile: string | null;
  diffText: string | null;
  onSelectFile: (path: string) => void;
}) {
  if (!detail) {
    return (
      <div className="hidden w-[420px] shrink-0 items-center justify-center text-xs text-(--color-fg-muted) md:flex">
        Select a commit
      </div>
    );
  }

  return (
    <div className="hidden w-[480px] shrink-0 flex-col overflow-hidden md:flex">
      <div className="shrink-0 border-b border-(--color-border) bg-(--color-surface) p-3">
        <div className="text-sm font-semibold leading-snug">
          {detail.subject}
        </div>
        {detail.body && (
          <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-(--color-fg-muted)">
            {detail.body}
          </pre>
        )}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-(--color-fg-muted)">
          <span>
            <span className="font-mono">{detail.hash.slice(0, 12)}</span>
          </span>
          <span>{detail.author_name}</span>
          <span>{fmtDate(detail.timestamp)}</span>
          {detail.parents.length > 1 && (
            <span className="text-(--color-warn)">
              merge ({detail.parents.length})
            </span>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-44 shrink-0 overflow-y-auto border-r border-(--color-border)">
          {detail.files.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-(--color-fg-muted)">
              No file changes.
            </div>
          ) : (
            <ul>
              {detail.files.map((f) => (
                <li key={f.path}>
                  <button
                    onClick={() => onSelectFile(f.path)}
                    className={`flex w-full items-center gap-1.5 truncate px-2 py-1 text-left text-[11px] hover:bg-(--color-surface-2) ${
                      diffFile === f.path
                        ? "bg-(--color-surface-2) text-(--color-fg)"
                        : "text-(--color-fg-muted)"
                    }`}
                  >
                    <StatusBadge status={f.status} />
                    <span className="truncate" title={f.path}>
                      {f.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-w-0 flex-1 overflow-auto bg-(--color-bg)">
          {diffText === null ? (
            <div className="p-3 text-[11px] text-(--color-fg-muted)">
              Loading diff…
            </div>
          ) : (
            <DiffView text={diffText} />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const first = status.charAt(0);
  const color =
    first === "A"
      ? "text-(--color-online)"
      : first === "D"
        ? "text-(--color-error)"
        : first === "M"
          ? "text-(--color-warn)"
          : first === "R"
            ? "text-(--color-accent)"
            : "text-(--color-fg-muted)";
  return (
    <span className={`w-3 shrink-0 font-mono text-[10px] ${color}`}>
      {first}
    </span>
  );
}

function DiffView({ text }: { text: string }) {
  if (!text.trim()) {
    return (
      <div className="p-3 text-[11px] text-(--color-fg-muted)">
        No textual diff.
      </div>
    );
  }
  const lines = text.split("\n");
  return (
    <pre className="m-0 whitespace-pre p-0 font-mono text-[11px] leading-[1.5]">
      {lines.map((line, i) => {
        let cls = "text-(--color-fg)";
        if (line.startsWith("+++") || line.startsWith("---")) {
          cls = "text-(--color-fg-muted)";
        } else if (line.startsWith("@@")) {
          cls = "text-(--color-accent)";
        } else if (line.startsWith("+")) {
          cls = "bg-(--color-online)/10 text-(--color-online)";
        } else if (line.startsWith("-")) {
          cls = "bg-(--color-error)/10 text-(--color-error)";
        } else if (line.startsWith("diff ") || line.startsWith("index ")) {
          cls = "text-(--color-fg-muted)";
        }
        return (
          <div key={i} className={`block px-3 ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
