import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, errorMessage } from "../lib/api";
import type {
  GitBranchInfo,
  GitCommit,
  GitCommitDetail,
  GitStatus,
  GitStatusFile,
  GitTag,
} from "../lib/api";
import { Splitter } from "../components/Splitter";
import { SkeletonCard } from "../components/Skeleton";
import { toast } from "../components/Toast";
import { usePaneSettings } from "../store/pane-settings-store";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN } from "../lib/ui";
import { useElementSize } from "../lib/use-element-size";
import {
  ArrowLeft,
  Check,
  Cloud,
  Minus,
  Plus,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Tag,
} from "lucide-react";

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

function relTime(unixSeconds: number, now: number): string {
  if (!unixSeconds) return "";
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d`;
  if (s < 86_400 * 365) return `${Math.floor(s / (86_400 * 30))}mo`;
  return `${Math.floor(s / (86_400 * 365))}y`;
}

/** Pseudo-selection for the "Uncommitted changes" row. */
const WORKTREE = "__worktree__";

const DEFAULT_SPLITS = {
  /** Commit list share of the width (side-by-side layout). */
  listFrac: 0.5,
  /** Commit list share of the height (stacked layout). */
  listFracV: 0.42,
  /** File list width in px inside the detail pane. */
  fileListW: 240,
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export function GitGraphPanel({ repoPath, paneId, deviceId }: Props) {
  const [paneSettings, updatePaneSettings] = usePaneSettings(paneId, {
    detailCollapsed: false,
    ...DEFAULT_SPLITS,
  });
  const detailCollapsed = paneSettings.detailCollapsed;
  const { listFrac, listFracV, fileListW } = paneSettings;
  const splitRef = useRef<HTMLDivElement>(null);
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
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  // Narrow panes show the detail on its own; this tracks that view.
  const [narrowDetailOpen, setNarrowDetailOpen] = useState(false);

  // Layout follows the pane, not the window: side-by-side when wide,
  // stacked when medium, one view at a time when narrow.
  const [measureRef, size] = useElementSize();
  const layout: "wide" | "stacked" | "narrow" =
    size.w === 0 || size.w >= 1000
      ? "wide"
      : size.w >= 640 && size.h >= 520
        ? "stacked"
        : "narrow";

  const loadStatus = useCallback(async () => {
    if (!repoPath) return;
    try {
      setStatus(await api.gitStatus(deviceId, repoPath));
    } catch {
      setStatus(null);
    }
  }, [deviceId, repoPath]);

  // Working tree changes outside the app (editor saves, …): poll lightly.
  useEffect(() => {
    void loadStatus();
    const t = setInterval(loadStatus, 10_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const reload = useCallback(async () => {
    if (!repoPath) return;
    setError(null);
    setLoading(true);
    void loadStatus();
    try {
      const [c, b, t] = await Promise.all([
        api.gitLog(deviceId, repoPath, 500),
        api.gitBranches(deviceId, repoPath),
        api.gitTags(deviceId, repoPath),
      ]);
      setCommits(c);
      setBranches(b);
      setTags(t);
      setSelected((cur) => cur ?? c[0]?.hash ?? null);
    } catch (e) {
      setError(errorMessage(e));
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId, repoPath, loadStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Load commit detail when selection changes.
  useEffect(() => {
    if (!repoPath || !selected || selected === WORKTREE) {
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
    if (!repoPath || !selected || selected === WORKTREE || !diffFile) {
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

  // Searching hides the graph: lanes only make sense for the full history.
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? laidOut.filter(
            (c) =>
              c.subject.toLowerCase().includes(q) ||
              c.author_name.toLowerCase().includes(q) ||
              c.hash.startsWith(q) ||
              c.refs.some((r) => r.toLowerCase().includes(q)),
          )
        : laidOut,
    [laidOut, q],
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

  const showDetail = !detailCollapsed;
  const narrowShowingDetail =
    layout === "narrow" && showDetail && narrowDetailOpen;

  const stagedCount = status?.files.filter((f) => isStaged(f)).length ?? 0;
  const changedCount = status?.files.filter((f) => isUnstaged(f)).length ?? 0;
  const select = (h: string) => {
    setSelected(h);
    if (layout === "narrow") setNarrowDetailOpen(true);
  };

  const list = (
    <CommitList
      commits={visible}
      showGraph={!q}
      selected={selected}
      worktree={
        status && status.files.length > 0 && !q
          ? { staged: stagedCount, changed: changedCount }
          : null
      }
      onSelectWorktree={() => select(WORKTREE)}
      compact={
        layout === "narrow" ||
        (layout === "wide" && showDetail && size.w < 1300)
      }
      onSelect={select}
    />
  );
  const fileListWidth = layout === "narrow" ? 0 : fileListW;
  const onFileListWidth = (w: number) =>
    updatePaneSettings({ fileListW: Math.round(w) });
  const onBack =
    layout === "narrow" ? () => setNarrowDetailOpen(false) : undefined;
  const detailPane =
    selected === WORKTREE ? (
      <ChangesPane
        deviceId={deviceId}
        repoPath={repoPath}
        status={status}
        fileListWidth={fileListWidth}
        onFileListWidth={onFileListWidth}
        onBack={onBack}
        onChanged={() => void loadStatus()}
        onCommitted={() => {
          setSelected(null);
          void reload();
        }}
      />
    ) : (
      <DetailPane
        detail={detail}
        diffFile={diffFile}
        diffText={diffText}
        onSelectFile={setDiffFile}
        fileListWidth={fileListWidth}
        onFileListWidth={onFileListWidth}
        onBack={onBack}
      />
    );

  return (
    <div
      ref={measureRef}
      className="fade-up flex h-full flex-col overflow-hidden"
    >
      <Header
        repoPath={repoPath}
        branches={branches}
        tags={tags}
        commitCount={commits.length}
        shownCount={visible.length}
        query={query}
        onQuery={setQuery}
        loading={loading}
        onReload={() => void reload()}
        detailCollapsed={detailCollapsed}
        onToggleDetail={() => setDetailCollapsed(!detailCollapsed)}
        narrow={layout === "narrow"}
      />
      {!showDetail ? (
        <div className="flex min-h-0 flex-1">{list}</div>
      ) : layout === "wide" ? (
        <div ref={splitRef} className="flex min-h-0 flex-1">
          <div
            className="flex min-w-0 shrink-0"
            style={{ width: `${listFrac * 100}%` }}
          >
            {list}
          </div>
          <Splitter
            axis="x"
            containerRef={splitRef}
            onChange={(x, total) =>
              updatePaneSettings({ listFrac: clamp(x / total, 0.2, 0.8) })
            }
            onReset={() =>
              updatePaneSettings({ listFrac: DEFAULT_SPLITS.listFrac })
            }
          />
          <div className="flex min-w-0 flex-1">{detailPane}</div>
        </div>
      ) : layout === "stacked" ? (
        <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex min-h-0 shrink-0"
            style={{ height: `${listFracV * 100}%` }}
          >
            {list}
          </div>
          <Splitter
            axis="y"
            containerRef={splitRef}
            onChange={(y, total) =>
              updatePaneSettings({ listFracV: clamp(y / total, 0.15, 0.85) })
            }
            onReset={() =>
              updatePaneSettings({ listFracV: DEFAULT_SPLITS.listFracV })
            }
          />
          <div className="flex min-h-0 flex-1">{detailPane}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {narrowShowingDetail ? detailPane : list}
        </div>
      )}
    </div>
  );
}

function Header({
  repoPath,
  branches,
  tags,
  commitCount,
  shownCount,
  query,
  onQuery,
  loading,
  onReload,
  detailCollapsed,
  onToggleDetail,
  narrow,
}: {
  repoPath: string;
  branches: GitBranchInfo[];
  tags: GitTag[];
  commitCount: number;
  shownCount: number;
  query: string;
  onQuery: (q: string) => void;
  loading: boolean;
  onReload: () => void;
  detailCollapsed: boolean;
  onToggleDetail: () => void;
  narrow: boolean;
}) {
  const current = branches.find((b) => b.is_current);
  const localCount = branches.filter((b) => !b.is_remote).length;
  const remoteCount = branches.filter((b) => b.is_remote).length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-(--color-border) px-2 py-1 text-xs">
      <span
        className="flex min-w-0 items-center gap-1.5"
        title={`${repoPath}\n${commitCount} commits · ${localCount} local / ${remoteCount} remote branches · ${tags.length} tags`}
      >
        <span className="truncate font-semibold">
          {repoPath.split("/").pop() ?? repoPath}
        </span>
        {current && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-(--color-accent)/12 px-1.5 font-mono text-[11px] text-(--color-accent)">
            <GitBranch size={11} />
            {current.name}
          </span>
        )}
        {!narrow && (
          <span className="truncate text-[11px] text-(--color-fg-muted)">
            {query
              ? `${shownCount} of ${commitCount} commits`
              : `${commitCount} commits · ${localCount} local · ${remoteCount} remote · ${tags.length} tags`}
          </span>
        )}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-(--color-fg-muted)"
          />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search commits…"
            className={`${SMALL_INPUT} ${narrow ? "w-32" : "w-44"} pl-6`}
          />
        </span>
        <div className={BTN_GROUP}>
          <button
            onClick={onToggleDetail}
            className={TOOL_BTN}
            title={
              detailCollapsed ? "Show commit details" : "Hide commit details"
            }
          >
            {detailCollapsed ? (
              <PanelRightOpen size={13} />
            ) : (
              <PanelRightClose size={13} />
            )}
          </button>
          <button
            onClick={onReload}
            disabled={loading}
            className={TOOL_BTN}
            title="Reload"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
    </div>
  );
}

function CommitList({
  commits,
  showGraph,
  selected,
  compact,
  worktree,
  onSelectWorktree,
  onSelect,
}: {
  commits: LaidOutCommit[];
  showGraph: boolean;
  selected: string | null;
  compact: boolean;
  /** Counts for the "Uncommitted changes" row; null hides it. */
  worktree: { staged: number; changed: number } | null;
  onSelectWorktree: () => void;
  onSelect: (hash: string) => void;
}) {
  const now = Date.now();
  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      {commits.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
          No commits match.
        </div>
      ) : (
        <ul>
          {worktree && (
            <li
              onClick={onSelectWorktree}
              className={`flex cursor-pointer items-center gap-2 pr-2 pl-1 text-xs ${
                selected === WORKTREE
                  ? "bg-(--color-accent)/10"
                  : "hover:bg-(--color-surface)"
              }`}
              style={{ height: ROW_HEIGHT }}
            >
              <svg
                width={LANE_WIDTH + 4}
                height={ROW_HEIGHT}
                className="shrink-0"
              >
                <line
                  x1={LANE_WIDTH / 2}
                  y1={ROW_HEIGHT / 2}
                  x2={LANE_WIDTH / 2}
                  y2={ROW_HEIGHT}
                  stroke="var(--color-fg-muted)"
                  strokeDasharray="2 2"
                />
                <circle
                  cx={LANE_WIDTH / 2}
                  cy={ROW_HEIGHT / 2}
                  r={4}
                  fill="var(--color-bg)"
                  stroke="var(--color-fg-muted)"
                  strokeWidth={1.5}
                />
              </svg>
              <span className="min-w-0 flex-1 truncate font-medium">
                Uncommitted changes
              </span>
              <span className="shrink-0 text-[11px] text-(--color-fg-muted)">
                {worktree.staged > 0 && (
                  <span className="text-(--color-online)">
                    {worktree.staged} staged
                  </span>
                )}
                {worktree.staged > 0 && worktree.changed > 0 && " · "}
                {worktree.changed > 0 && `${worktree.changed} changed`}
              </span>
            </li>
          )}
          {commits.map((c, i) => (
            <CommitRow
              key={c.hash}
              commit={c}
              next={showGraph ? commits[i + 1] : undefined}
              showGraph={showGraph}
              compact={compact}
              now={now}
              isSelected={c.hash === selected}
              onSelect={() => onSelect(c.hash)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const ROW_HEIGHT = 26;
const LANE_WIDTH = 12;
const MAX_REF_CHIPS = 2;

interface RefChip {
  label: string;
  kind: "head" | "branch" | "synced" | "remote" | "tag";
}

/**
 * Turn raw refs into display chips. A local branch whose remote twin
 * (origin/main) points at the same commit becomes one "synced" chip, and
 * origin/HEAD is dropped — they're noise that used to crowd out the message.
 */
function refChips(refs: string[]): RefChip[] {
  const { head, branches, remotes, tags } = parseRefs(refs);
  const remoteSet = new Set(remotes.filter((r) => !r.endsWith("/HEAD")));
  const chips: RefChip[] = [];
  for (const b of branches) {
    const twin = [...remoteSet].find(
      (r) => r.split("/").slice(1).join("/") === b,
    );
    if (twin) remoteSet.delete(twin);
    chips.push({
      label: b,
      kind: b === head ? "head" : twin ? "synced" : "branch",
    });
  }
  for (const r of remoteSet) chips.push({ label: r, kind: "remote" });
  for (const t of tags) chips.push({ label: t, kind: "tag" });
  return chips;
}

const CHIP_CLASS: Record<RefChip["kind"], string> = {
  head: "bg-(--color-accent) text-(--color-accent-fg) font-semibold",
  branch: "bg-(--color-accent)/15 text-(--color-accent)",
  synced: "bg-(--color-accent)/15 text-(--color-accent)",
  remote: "text-(--color-fg-muted) ring-1 ring-(--color-border)",
  tag: "bg-(--color-warn)/15 text-(--color-warn)",
};

function Chip({ chip }: { chip: RefChip }) {
  return (
    <span
      className={`inline-flex max-w-40 shrink-0 items-center gap-0.5 rounded px-1 font-mono text-[10px] leading-4 ${CHIP_CLASS[chip.kind]}`}
      title={
        chip.kind === "synced"
          ? `${chip.label} (in sync with remote)`
          : chip.kind === "head"
            ? `${chip.label} (checked out)`
            : chip.label
      }
    >
      {chip.kind === "tag" && <Tag size={9} className="shrink-0" />}
      <span className="truncate">{chip.label}</span>
      {chip.kind === "synced" && (
        <Cloud size={9} className="shrink-0 opacity-70" />
      )}
    </span>
  );
}

function CommitRow({
  commit,
  next,
  showGraph,
  compact,
  now,
  isSelected,
  onSelect,
}: {
  commit: LaidOutCommit;
  next: LaidOutCommit | undefined;
  showGraph: boolean;
  compact: boolean;
  now: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const chips = refChips(commit.refs);
  const shown = chips.slice(0, MAX_REF_CHIPS);
  const hidden = chips.slice(MAX_REF_CHIPS);
  const laneCount = Math.max(
    commit.laneCount,
    next?.laneSnapshot.length ?? 0,
    commit.lane + 1,
  );
  const graphWidth = laneCount * LANE_WIDTH + 4;

  return (
    <li
      onClick={onSelect}
      className={`flex cursor-pointer items-center gap-2 pr-2 pl-1 text-xs ${
        isSelected ? "bg-(--color-accent)/10" : "hover:bg-(--color-surface)"
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      {showGraph ? (
        <Graph
          commit={commit}
          next={next}
          width={graphWidth}
          height={ROW_HEIGHT}
        />
      ) : (
        <span className="w-2" />
      )}
      <span className="flex min-w-0 flex-1 items-center gap-1">
        {shown.map((c) => (
          <Chip key={c.label} chip={c} />
        ))}
        {hidden.length > 0 && (
          <span
            className="shrink-0 rounded px-1 font-mono text-[10px] text-(--color-fg-muted) ring-1 ring-(--color-border)"
            title={hidden.map((c) => c.label).join("\n")}
          >
            +{hidden.length}
          </span>
        )}
        <span
          className={`ml-0.5 truncate ${isSelected ? "font-medium" : ""}`}
          title={commit.subject}
        >
          {commit.subject}
        </span>
      </span>
      {!compact && (
        <span className="w-28 shrink-0 truncate text-[11px] text-(--color-fg-muted)">
          {commit.author_name}
        </span>
      )}
      <span
        className="w-8 shrink-0 text-right text-[11px] tabular-nums text-(--color-fg-muted)"
        title={fmtDate(commit.timestamp)}
      >
        {relTime(commit.timestamp, now)}
      </span>
      {!compact && (
        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-(--color-fg-muted)">
          {commit.short_hash}
        </span>
      )}
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
  fileListWidth,
  onFileListWidth,
  onBack,
}: {
  detail: GitCommitDetail | null;
  diffFile: string | null;
  diffText: string | null;
  onSelectFile: (path: string) => void;
  /** 0 = narrow: pick the file from a dropdown instead of a side list. */
  fileListWidth: number;
  onFileListWidth: (w: number) => void;
  onBack?: () => void;
}) {
  const filesRef = useRef<HTMLDivElement>(null);
  if (!detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-(--color-fg-muted)">
        Select a commit
      </div>
    );
  }

  const copyHash = () =>
    void navigator.clipboard
      .writeText(detail.hash)
      .then(() => toast.success("Commit hash copied"));

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Commit header */}
      <div className="shrink-0 border-b border-(--color-border) px-3 py-2">
        <div className="flex items-start gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className={`${TOOL_BTN} -ml-1 shrink-0`}
              title="Back to commits"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <div className="min-w-0 flex-1 text-sm leading-snug font-semibold">
            {detail.subject}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-(--color-fg-muted)">
          <button
            onClick={copyHash}
            className="font-mono hover:text-(--color-fg)"
            title="Copy full hash"
          >
            {detail.hash.slice(0, 10)}
          </button>
          <span>·</span>
          <span className="text-(--color-fg)">{detail.author_name}</span>
          <span>·</span>
          <span title={fmtDate(detail.timestamp)}>
            {relTime(detail.timestamp, Date.now())} ago
          </span>
          <span>·</span>
          <span>
            {detail.files.length} file{detail.files.length === 1 ? "" : "s"}
          </span>
          {detail.parents.length > 1 && (
            <span className="rounded bg-(--color-warn)/15 px-1 text-(--color-warn)">
              merge
            </span>
          )}
        </div>
        {detail.body && (
          <pre className="mt-1.5 max-h-24 overflow-auto font-sans text-[11px] break-words whitespace-pre-wrap text-(--color-fg-muted)">
            {detail.body}
          </pre>
        )}
      </div>

      {detail.files.length === 0 ? (
        <div className="p-3 text-[11px] text-(--color-fg-muted)">
          No file changes.
        </div>
      ) : (
        <div ref={filesRef} className="flex min-h-0 flex-1">
          {fileListWidth > 0 && (
            <ul
              className="shrink-0 overflow-y-auto py-0.5"
              style={{ width: fileListWidth }}
            >
              {detail.files.map((f) => {
                const { name, dir } = splitPath(f.path);
                return (
                  <li key={f.path}>
                    <button
                      onClick={() => onSelectFile(f.path)}
                      className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-[11px] ${
                        diffFile === f.path
                          ? "bg-(--color-accent)/10 text-(--color-fg)"
                          : "text-(--color-fg) hover:bg-(--color-surface)"
                      }`}
                      title={f.path}
                    >
                      <StatusBadge status={f.status} />
                      <span className="shrink-0 truncate">{name}</span>
                      <span className="min-w-0 truncate text-(--color-fg-muted)">
                        {dir}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {fileListWidth > 0 && (
            <Splitter
              axis="x"
              containerRef={filesRef}
              onChange={(x, total) =>
                onFileListWidth(clamp(x, 140, Math.max(160, total - 240)))
              }
              onReset={() => onFileListWidth(DEFAULT_SPLITS.fileListW)}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <DiffHeader
              files={detail.files.map((f) => f.path)}
              diffFile={diffFile}
              diffText={diffText}
              onSelectFile={fileListWidth === 0 ? onSelectFile : undefined}
            />
            <div className="min-h-0 flex-1 overflow-auto">
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
      )}
    </div>
  );
}

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { name: path, dir: "" }
    : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

function diffStats(text: string | null): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of text?.split("\n") ?? []) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

function DiffHeader({
  files,
  diffFile,
  diffText,
  onSelectFile,
}: {
  files: string[];
  diffFile: string | null;
  diffText: string | null;
  /** Narrow panes: switch files from here. */
  onSelectFile?: (path: string) => void;
}) {
  const { add, del } = diffStats(diffText);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) px-2 py-1 text-[11px]">
      {onSelectFile ? (
        <select
          value={diffFile ?? ""}
          onChange={(e) => onSelectFile(e.target.value)}
          className={`${SMALL_INPUT} min-w-0 flex-1 font-mono`}
        >
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      ) : (
        <span
          className="min-w-0 flex-1 truncate font-mono text-(--color-fg-muted)"
          title={diffFile ?? ""}
        >
          {diffFile}
        </span>
      )}
      {diffText !== null && (
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-(--color-online)">+{add}</span>{" "}
          <span className="text-(--color-error)">−{del}</span>
        </span>
      )}
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

/** Unified diff with old/new line numbers; file headers live in DiffHeader. */
function DiffView({ text }: { text: string }) {
  if (!text.trim()) {
    return (
      <div className="p-3 text-[11px] text-(--color-fg-muted)">
        No textual diff (binary or mode change).
      </div>
    );
  }
  const rows: { oldNo: string; newNo: string; line: string; cls: string }[] =
    [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({
        oldNo: "",
        newNo: "",
        line,
        cls: "bg-(--color-accent)/8 text-(--color-accent)",
      });
      continue;
    }
    // Skip the file preamble (diff --git / index / --- / +++).
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      rows.push({
        oldNo: "",
        newNo: String(newNo++),
        line,
        cls: "bg-(--color-online)/10 text-(--color-online)",
      });
    } else if (line.startsWith("-")) {
      rows.push({
        oldNo: String(oldNo++),
        newNo: "",
        line,
        cls: "bg-(--color-error)/10 text-(--color-error)",
      });
    } else if (line.startsWith("\\")) {
      rows.push({ oldNo: "", newNo: "", line, cls: "text-(--color-fg-muted)" });
    } else if (line.startsWith("diff ")) {
      inHunk = false;
    } else {
      rows.push({
        oldNo: String(oldNo++),
        newNo: String(newNo++),
        line,
        cls: "text-(--color-fg)",
      });
    }
  }
  // A trailing newline in git output leaves one empty context row; drop it.
  if (rows.length && rows[rows.length - 1].line === "") rows.pop();

  return (
    <table className="w-full border-collapse font-mono text-[11px] leading-[1.55]">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.cls}>
            <td className="w-9 min-w-9 pr-1.5 text-right align-top text-(--color-fg-muted)/70 select-none">
              {r.oldNo}
            </td>
            <td className="w-9 min-w-9 border-r border-(--color-border) pr-1.5 text-right align-top text-(--color-fg-muted)/70 select-none">
              {r.newNo}
            </td>
            <td className="pl-2 whitespace-pre">{r.line || " "}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Working tree (uncommitted changes) ─────────────────────────────────────

function isStaged(f: GitStatusFile): boolean {
  return !f.untracked && !f.conflicted && f.index !== ".";
}

function isUnstaged(f: GitStatusFile): boolean {
  return f.untracked || f.conflicted || f.worktree !== ".";
}

interface WorkSel {
  path: string;
  staged: boolean;
  untracked: boolean;
}

function ChangesPane({
  deviceId,
  repoPath,
  status,
  fileListWidth,
  onFileListWidth,
  onBack,
  onChanged,
  onCommitted,
}: {
  deviceId: string;
  repoPath: string;
  status: GitStatus | null;
  /** 0 = narrow: list and diff take turns. */
  fileListWidth: number;
  onFileListWidth: (w: number) => void;
  onBack?: () => void;
  onChanged: () => void;
  onCommitted: () => void;
}) {
  const files = useMemo(() => status?.files ?? [], [status]);
  const staged = files.filter(isStaged);
  const changed = files.filter(isUnstaged);
  const [sel, setSel] = useState<WorkSel | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [narrowDiff, setNarrowDiff] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const narrow = fileListWidth === 0;

  // Keep the selection valid as files move between sections.
  useEffect(() => {
    const stillThere =
      sel &&
      files.some(
        (f) =>
          f.path === sel.path && (sel.staged ? isStaged(f) : isUnstaged(f)),
      );
    if (stillThere) return;
    const f = files.find(isStaged) ?? files.find(isUnstaged);
    setSel(
      f ? { path: f.path, staged: isStaged(f), untracked: f.untracked } : null,
    );
  }, [files, sel]);

  useEffect(() => {
    if (!sel) {
      setDiff(null);
      return;
    }
    setDiff(null);
    void api
      .gitWorkingDiff(deviceId, repoPath, sel.path, sel.staged, sel.untracked)
      .then(setDiff)
      .catch((e) => setDiff(`Could not load diff:\n${errorMessage(e)}`));
    // Re-run when the status refreshes so the diff tracks edits on disk.
  }, [deviceId, repoPath, sel, status]);

  const run = async (fn: () => Promise<unknown>, failMsg: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(`${failMsg}: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  // A rename touches two paths; act on both so it moves as one change.
  const pathsOf = (list: GitStatusFile[]) =>
    list.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const stage = (list: GitStatusFile[]) =>
    run(() => api.gitStage(deviceId, repoPath, pathsOf(list)), "Stage failed");
  const unstage = (list: GitStatusFile[]) =>
    run(
      () => api.gitUnstage(deviceId, repoPath, pathsOf(list)),
      "Unstage failed",
    );

  const canCommit =
    !busy && message.trim().length > 0 && (staged.length > 0 || amend);
  const commit = async () => {
    if (!canCommit) return;
    setBusy(true);
    try {
      const out = await api.gitCommit(deviceId, repoPath, message, amend);
      toast.success(out.split("\n")[0] || "Committed");
      setMessage("");
      setAmend(false);
      onCommitted();
    } catch (e) {
      toast.error(`Commit failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const fileRow = (f: GitStatusFile, inStaged: boolean) => {
    const { name, dir } = splitPath(f.path);
    const active = sel?.path === f.path && sel.staged === inStaged;
    const letter = f.conflicted
      ? "!"
      : f.untracked
        ? "U"
        : inStaged
          ? f.index
          : f.worktree;
    return (
      <li key={`${inStaged ? "s" : "w"}:${f.path}`} className="group">
        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 text-[11px] ${
            active ? "bg-(--color-accent)/10" : "hover:bg-(--color-surface)"
          }`}
        >
          <button
            onClick={() => {
              setSel({
                path: f.path,
                staged: inStaged,
                untracked: f.untracked,
              });
              if (narrow) setNarrowDiff(true);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
          >
            <StatusBadge status={letter === "U" ? "A" : letter} />
            <span
              className={`shrink-0 truncate ${f.conflicted ? "text-(--color-error)" : ""}`}
            >
              {name}
            </span>
            <span className="min-w-0 truncate text-(--color-fg-muted)">
              {dir}
            </span>
          </button>
          <button
            onClick={() => void (inStaged ? unstage([f]) : stage([f]))}
            disabled={busy}
            className={`${TOOL_BTN} h-5 px-1 ${active ? "" : "opacity-0 group-hover:opacity-100"}`}
            title={inStaged ? "Unstage" : "Stage"}
          >
            {inStaged ? <Minus size={12} /> : <Plus size={12} />}
          </button>
        </div>
      </li>
    );
  };

  const section = (title: string, list: GitStatusFile[], inStaged: boolean) => (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-1 bg-(--color-bg) px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-(--color-fg-muted)">
        <span className="flex-1">
          {title} <span className="tabular-nums">{list.length}</span>
        </span>
        {list.length > 0 && (
          <button
            onClick={() => void (inStaged ? unstage(list) : stage(list))}
            disabled={busy}
            className={`${TOOL_BTN} h-5 px-1.5 font-normal`}
          >
            {inStaged ? "Unstage all" : "Stage all"}
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="px-2 pb-1 text-[11px] text-(--color-fg-muted)/70">
          {inStaged ? "Nothing staged yet." : "No other changes."}
        </div>
      ) : (
        <ul>{list.map((f) => fileRow(f, inStaged))}</ul>
      )}
    </div>
  );

  const fileColumn = (
    <div
      className="flex min-h-0 shrink-0 flex-col"
      style={narrow ? { flex: 1 } : { width: fileListWidth }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {section("Staged", staged, true)}
        {section("Changes", changed, false)}
      </div>
      {/* Commit box */}
      <div className="shrink-0 border-t border-(--color-border) p-2">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          rows={3}
          placeholder="Commit message (⌘/Ctrl+Enter to commit)"
          className="w-full resize-none rounded-md border border-transparent bg-(--color-surface) px-2 py-1 text-xs text-(--color-fg) outline-none placeholder:text-(--color-fg-muted) focus:border-(--color-accent)"
        />
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          <label className="flex items-center gap-1 text-(--color-fg-muted)">
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => setAmend(e.target.checked)}
            />
            Amend last commit
          </label>
          <button
            onClick={() => void commit()}
            disabled={!canCommit}
            className="ml-auto flex items-center gap-1 rounded bg-(--color-accent) px-2.5 py-1 font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            title={
              staged.length === 0 && !amend
                ? "Stage some changes first"
                : !message.trim()
                  ? "Write a commit message"
                  : "Commit staged changes"
            }
          >
            <Check size={12} />
            {busy
              ? "Working…"
              : amend
                ? "Amend"
                : `Commit${staged.length ? ` ${staged.length}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );

  const diffColumn = (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-(--color-border) px-2 py-1 text-[11px]">
        {narrow && (
          <button
            onClick={() => setNarrowDiff(false)}
            className={`${TOOL_BTN} -ml-1`}
            title="Back to files"
          >
            <ArrowLeft size={13} />
          </button>
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-(--color-fg-muted)"
          title={sel?.path}
        >
          {sel?.path ?? "No file selected"}
        </span>
        {sel && (
          <span
            className={`shrink-0 rounded px-1 ${
              sel.staged
                ? "bg-(--color-online)/15 text-(--color-online)"
                : "bg-(--color-surface-2) text-(--color-fg-muted)"
            }`}
          >
            {sel.untracked ? "new file" : sel.staged ? "staged" : "unstaged"}
          </span>
        )}
        {diff !== null && (
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-(--color-online)">
              +{diffStats(diff).add}
            </span>{" "}
            <span className="text-(--color-error)">−{diffStats(diff).del}</span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!sel ? (
          <div className="p-3 text-[11px] text-(--color-fg-muted)">
            Working tree is clean.
          </div>
        ) : diff === null ? (
          <div className="p-3 text-[11px] text-(--color-fg-muted)">
            Loading diff…
          </div>
        ) : (
          <DiffView text={diff} />
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-(--color-border) px-3 py-2">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className={`${TOOL_BTN} -ml-1 shrink-0`}
              title="Back to commits"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <span className="text-sm font-semibold">Uncommitted changes</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-(--color-fg-muted)">
          {status?.branch && (
            <span className="flex items-center gap-1 font-mono text-(--color-accent)">
              <GitBranch size={11} />
              {status.branch}
            </span>
          )}
          {status?.upstream && (
            <span title={`Compared with ${status.upstream}`}>
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
          <span>·</span>
          <span>
            {staged.length} staged · {changed.length} changed
          </span>
        </div>
      </div>
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        {narrow ? (
          narrowDiff ? (
            diffColumn
          ) : (
            fileColumn
          )
        ) : (
          <>
            {fileColumn}
            <Splitter
              axis="x"
              containerRef={bodyRef}
              onChange={(x, total) =>
                onFileListWidth(clamp(x, 180, Math.max(200, total - 240)))
              }
              onReset={() => onFileListWidth(DEFAULT_SPLITS.fileListW)}
            />
            {diffColumn}
          </>
        )}
      </div>
    </div>
  );
}
