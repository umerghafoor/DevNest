import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  Home,
  LayoutGrid,
  PieChart,
  RefreshCw,
} from "lucide-react";
import { errorMessage } from "../lib/api";

export interface DiskUsageNode {
  name: string;
  path: string;
  size: number;
  children: DiskUsageNode[];
}

interface Props {
  deviceId: string;
  path: string;
  onNavigate?: (path: string) => void;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

interface Rect {
  node: DiskUsageNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

// Colors are keyed by top-level branch (hue) and tinted by depth (lightness),
// so a branch reads as one family in both the treemap and the sunburst.
const HUES = [240, 160, 55, 340, 290, 200, 100, 20];

function getColor(branch: number, depth: number): string {
  const hue = HUES[branch % HUES.length];
  const l = Math.max(0.55, 0.74 - Math.max(0, depth - 1) * 0.06);
  return `oklch(${l} 0.14 ${hue})`;
}

// Squarified treemap calculation
function layoutTreemap(
  node: DiskUsageNode,
  x: number,
  y: number,
  w: number,
  h: number,
  depth: number = 0,
): Rect[] {
  if (w <= 0 || h <= 0) return [];
  if (!node.children || node.children.length === 0) {
    return [{ node, x, y, w, h, depth }];
  }

  const rects: Rect[] = [];
  const totalSize = node.children.reduce((acc, c) => acc + c.size, 0) || 1;

  // Layout children within the current rectangle
  let curX = x;
  let curY = y;
  let remW = w;
  let remH = h;

  // Filter children with size > 0, sorted descending
  const sorted = [...node.children].sort((a, b) => b.size - a.size);

  for (let i = 0; i < sorted.length; i++) {
    const child = sorted[i];
    const fraction = child.size / totalSize;

    if (remW >= remH) {
      // Split horizontally
      const childW =
        i === sorted.length - 1 ? remW : Math.max(1, remW * fraction);
      rects.push({
        node: child,
        x: curX,
        y: curY,
        w: childW,
        h: remH,
        depth: depth + 1,
      });
      curX += childW;
      remW = Math.max(0, remW - childW);
    } else {
      // Split vertically
      const childH =
        i === sorted.length - 1 ? remH : Math.max(1, remH * fraction);
      rects.push({
        node: child,
        x: curX,
        y: curY,
        w: remW,
        h: childH,
        depth: depth + 1,
      });
      curY += childH;
      remH = Math.max(0, remH - childH);
    }
  }

  return rects;
}

export function DiskUsageTreemap({ deviceId, path, onNavigate }: Props) {
  const [data, setData] = useState<DiskUsageNode | null>(null);
  const [currentRoot, setCurrentRoot] = useState<DiskUsageNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<DiskUsageNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [chartType, setChartType] = useState<"treemap" | "sunburst">(
    "sunburst",
  );
  const chartRef = useRef<HTMLDivElement>(null);

  const scan = useCallback(
    async (scanPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const root = await invoke<DiskUsageNode>("sftp_disk_usage", {
          deviceId,
          path: scanPath,
          maxDepth: 4,
        });
        setData(root);
        setCurrentRoot(root);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [deviceId],
  );

  useEffect(() => {
    void scan(path);
  }, [scan, path]);

  // Breadcrumbs to zoom back out
  const breadcrumbs = useMemo(() => {
    if (!data || !currentRoot) return [];
    if (data.path === currentRoot.path) return [data];

    const trail: DiskUsageNode[] = [];
    function find(node: DiskUsageNode): boolean {
      trail.push(node);
      if (node.path === currentRoot?.path) return true;
      for (const child of node.children) {
        if (find(child)) return true;
      }
      trail.pop();
      return false;
    }
    find(data);
    return trail;
  }, [data, currentRoot]);

  // Children ranked by size; their rank is the branch color index.
  const ranked = useMemo(
    () =>
      currentRoot
        ? [...currentRoot.children].sort((a, b) => b.size - a.size)
        : [],
    [currentRoot],
  );

  const rects = useMemo(() => {
    if (!currentRoot) return [];
    return layoutTreemap(currentRoot, 0, 0, 1000, 600, 0);
  }, [currentRoot]);

  const zoomInto = (node: DiskUsageNode) => {
    if (node.children && node.children.length > 0) setCurrentRoot(node);
  };

  // Sunburst: starts at 12 o'clock, branches sorted by size.
  const sunburstArcs = useMemo(() => {
    if (!currentRoot) return [];
    const arcs: Array<{
      node: DiskUsageNode;
      pathD: string;
      depth: number;
      branch: number;
    }> = [];

    const cx = 300;
    const cy = 300;
    const holeR = 62;
    const maxR = 292;
    const levels = 3;
    const thickness = (maxR - holeR) / levels;
    const START = -Math.PI / 2;

    function buildArcs(
      node: DiskUsageNode,
      depth: number,
      startAngle: number,
      endAngle: number,
      parentBranch: number,
    ) {
      if (depth >= levels || !node.children || node.children.length === 0)
        return;

      const innerR = holeR + depth * thickness;
      const outerR = innerR + thickness - 2;
      const total = node.children.reduce((acc, c) => acc + c.size, 0) || 1;
      let cur = startAngle;

      [...node.children]
        .sort((a, b) => b.size - a.size)
        .forEach((child, idx) => {
          const span = (child.size / total) * (endAngle - startAngle);
          const a0 = cur;
          const a1 = cur + span;
          cur += span;
          if (span <= 0.012) return;

          const branch = depth === 0 ? idx : parentBranch;
          // Leave a hairline gap so neighbours stay distinct.
          const g = Math.min(0.004, span / 4);
          const p = (r: number, a: number) =>
            `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
          const large = span - 2 * g > Math.PI ? 1 : 0;
          const d = `M ${p(outerR, a0 + g)} A ${outerR} ${outerR} 0 ${large} 1 ${p(outerR, a1 - g)} L ${p(innerR, a1 - g)} A ${innerR} ${innerR} 0 ${large} 0 ${p(innerR, a0 + g)} Z`;

          arcs.push({ node: child, pathD: d, depth, branch });
          buildArcs(child, depth + 1, a0, a1, branch);
        });
    }

    buildArcs(currentRoot, 0, START, START + Math.PI * 2, 0);
    return arcs;
  }, [currentRoot]);

  const onChartMove = (e: React.MouseEvent) => {
    const box = chartRef.current?.getBoundingClientRect();
    if (!box) return;
    setTooltipPos({ x: e.clientX - box.left, y: e.clientY - box.top });
  };

  const goUp = () => {
    if (breadcrumbs.length > 1)
      setCurrentRoot(breadcrumbs[breadcrumbs.length - 2]);
  };

  const rootSize = currentRoot?.size ?? 0;
  const pct = (n: DiskUsageNode) =>
    rootSize > 0 ? (n.size / rootSize) * 100 : 0;
  const centerNode = hovered ?? currentRoot;

  const tipW = 260;
  const boxW = chartRef.current?.clientWidth ?? 800;
  const boxH = chartRef.current?.clientHeight ?? 500;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-bg) select-none">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-surface) px-3 py-2 text-xs">
        <div className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap">
          {breadcrumbs.map((bc, idx) => {
            const last = idx === breadcrumbs.length - 1;
            return (
              <div key={bc.path} className="flex shrink-0 items-center">
                {idx > 0 && (
                  <ChevronRight className="h-3 w-3 text-(--color-fg-muted)/60" />
                )}
                <button
                  onClick={() => setCurrentRoot(bc)}
                  className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors ${
                    last
                      ? "bg-(--color-surface-2) font-semibold text-(--color-fg)"
                      : "text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
                  }`}
                >
                  {idx === 0 && <Home className="h-3 w-3" />}
                  {bc.name || "/"}
                </button>
              </div>
            );
          })}
          {currentRoot && (
            <span className="ml-2 rounded-full bg-(--color-accent)/15 px-2 py-0.5 font-mono text-[11px] text-(--color-fg)">
              {fmtSize(currentRoot.size)}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="flex rounded-md bg-(--color-surface-2) p-0.5">
            {(
              [
                ["sunburst", "Sunburst", PieChart],
                ["treemap", "Treemap", LayoutGrid],
              ] as const
            ).map(([type, label, Icon]) => (
              <button
                key={type}
                onClick={() => setChartType(type)}
                className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] font-medium transition-all ${
                  chartType === type
                    ? "bg-(--color-bg) text-(--color-fg) shadow-sm"
                    : "text-(--color-fg-muted) hover:text-(--color-fg)"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => void scan(currentRoot?.path ?? path)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium text-(--color-fg-muted) transition-colors hover:bg-(--color-surface-2) hover:text-(--color-fg) disabled:opacity-40"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            {loading ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Visualization */}
        <div ref={chartRef} className="relative min-w-0 flex-1 p-3">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-(--color-fg-muted)">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-(--color-accent) border-t-transparent" />
              <span>Scanning directory disk usage…</span>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-xs text-(--color-error)">
              {error}
            </div>
          ) : !currentRoot ||
            (currentRoot.children.length === 0 && currentRoot.size === 0) ? (
            <div className="flex h-full items-center justify-center text-xs text-(--color-fg-muted)">
              Directory is empty or inaccessible
            </div>
          ) : chartType === "treemap" ? (
            <svg
              viewBox="0 0 1000 600"
              preserveAspectRatio="none"
              className="h-full w-full overflow-hidden rounded-lg"
              onMouseMove={onChartMove}
              onMouseLeave={() => setHovered(null)}
            >
              {rects.map((r, i) => {
                const isDir = r.node.children?.length > 0;
                const isHovered = hovered?.path === r.node.path;
                return (
                  <g
                    key={r.node.path + i}
                    onClick={() => zoomInto(r.node)}
                    onMouseEnter={() => setHovered(r.node)}
                    className={isDir ? "cursor-pointer" : "cursor-default"}
                  >
                    <rect
                      x={r.x + 1}
                      y={r.y + 1}
                      width={Math.max(1, r.w - 2)}
                      height={Math.max(1, r.h - 2)}
                      fill={getColor(i, 1)}
                      fillOpacity={isHovered ? 1 : 0.82}
                      stroke="var(--color-bg)"
                      strokeWidth={2}
                      rx={4}
                    />
                    {r.w > 60 && r.h > 30 && (
                      <foreignObject
                        x={r.x + 6}
                        y={r.y + 5}
                        width={r.w - 12}
                        height={r.h - 10}
                        className="pointer-events-none overflow-hidden"
                      >
                        <div className="flex h-full flex-col justify-start text-[11px] font-medium leading-tight text-white drop-shadow">
                          <span className="truncate">{r.node.name}</span>
                          <span className="font-mono text-[10px] opacity-90">
                            {fmtSize(r.node.size)} · {pct(r.node).toFixed(1)}%
                          </span>
                        </div>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>
          ) : (
            <svg
              viewBox="0 0 600 600"
              className="h-full w-full"
              onMouseMove={onChartMove}
              onMouseLeave={() => setHovered(null)}
            >
              {sunburstArcs.map((arc, i) => {
                const isHovered = hovered?.path === arc.node.path;
                const dim = hovered && !isHovered;
                const isDir = arc.node.children?.length > 0;
                return (
                  <path
                    key={arc.node.path + i}
                    d={arc.pathD}
                    fill={getColor(arc.branch, arc.depth + 1)}
                    fillOpacity={isHovered ? 1 : dim ? 0.45 : 0.88}
                    className={`transition-[fill-opacity] duration-100 ${
                      isDir ? "cursor-pointer" : "cursor-default"
                    }`}
                    onClick={() => zoomInto(arc.node)}
                    onMouseEnter={() => setHovered(arc.node)}
                  />
                );
              })}

              {/* Center: hovered item, or current folder. Click to go up. */}
              <g
                onClick={goUp}
                className={breadcrumbs.length > 1 ? "cursor-pointer" : ""}
              >
                <circle
                  cx={300}
                  cy={300}
                  r={56}
                  fill="var(--color-surface)"
                  stroke="var(--color-border)"
                  strokeWidth={1.5}
                />
                <text
                  x={300}
                  y={296}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill="var(--color-fg)"
                  className="pointer-events-none"
                >
                  {(() => {
                    const n = centerNode?.name || "/";
                    return n.length > 12 ? n.slice(0, 11) + "…" : n;
                  })()}
                </text>
                <text
                  x={300}
                  y={314}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-fg-muted)"
                  className="pointer-events-none font-mono"
                >
                  {centerNode ? fmtSize(centerNode.size) : ""}
                </text>
                {!hovered && breadcrumbs.length > 1 && (
                  <text
                    x={300}
                    y={332}
                    textAnchor="middle"
                    fontSize={9}
                    fill="var(--color-fg-muted)"
                    className="pointer-events-none"
                  >
                    ↑ click to go up
                  </text>
                )}
              </g>
            </svg>
          )}

          {/* Hover tooltip */}
          {hovered && tooltipPos && !loading && (
            <div
              className="pointer-events-none absolute z-30 flex flex-col gap-0.5 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2 text-xs shadow-lg"
              style={{
                width: tipW,
                left:
                  tooltipPos.x + 14 + tipW > boxW
                    ? tooltipPos.x - tipW - 14
                    : tooltipPos.x + 14,
                top: Math.min(tooltipPos.y + 14, boxH - 90),
              }}
            >
              <div className="flex items-center gap-1.5 font-medium text-(--color-fg)">
                {hovered.children?.length ? (
                  <Folder className="h-3.5 w-3.5 text-(--color-accent)" />
                ) : (
                  <FileIcon className="h-3.5 w-3.5 text-(--color-fg-muted)" />
                )}
                <span className="truncate">{hovered.name}</span>
              </div>
              <div className="font-mono text-[11px] text-(--color-accent)">
                {fmtSize(hovered.size)}
                <span className="ml-1 text-(--color-fg-muted)">
                  ({pct(hovered).toFixed(1)}% of {currentRoot?.name || "/"})
                </span>
              </div>
              <div className="truncate font-mono text-[10px] text-(--color-fg-muted)">
                {hovered.path}
              </div>
              {hovered.children?.length > 0 && (
                <div className="mt-0.5 text-[10px] text-(--color-online)">
                  Click to zoom into {hovered.children.length} items
                </div>
              )}
            </div>
          )}
        </div>

        {/* Ranked list */}
        {currentRoot && !loading && !error && ranked.length > 0 && (
          <aside className="hidden w-72 shrink-0 flex-col border-l border-(--color-border) bg-(--color-surface) md:flex">
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-(--color-fg-muted)">
              Largest items
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto pb-2">
              {ranked.map((n, i) => {
                const isDir = n.children?.length > 0;
                const active = hovered?.path === n.path;
                return (
                  <li key={n.path}>
                    <button
                      onClick={() => zoomInto(n)}
                      onMouseEnter={() => setHovered(n)}
                      onMouseLeave={() => setHovered(null)}
                      className={`block w-full px-3 py-1.5 text-left transition-colors ${
                        active ? "bg-(--color-surface-2)" : ""
                      } ${isDir ? "cursor-pointer" : "cursor-default"}`}
                    >
                      <div className="flex items-center gap-2 text-xs">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-sm"
                          style={{ background: getColor(i, 1) }}
                        />
                        {isDir ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-(--color-fg-muted)" />
                        ) : (
                          <FileIcon className="h-3.5 w-3.5 shrink-0 text-(--color-fg-muted)" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-(--color-fg)">
                          {n.name}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-(--color-fg-muted)">
                          {fmtSize(n.size)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 pl-[18px]">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-(--color-surface-2)">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(1, pct(n))}%`,
                              background: getColor(i, 1),
                            }}
                          />
                        </div>
                        <span className="w-9 text-right font-mono text-[10px] text-(--color-fg-muted)">
                          {pct(n).toFixed(1)}%
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-surface) px-3 py-1 text-[11px] text-(--color-fg-muted)">
        <span>
          Click a folder to zoom in · click the center or breadcrumbs to go back
        </span>
        {onNavigate && currentRoot && (
          <button
            onClick={() => onNavigate(currentRoot.path)}
            className="text-(--color-accent) hover:underline"
          >
            Open in Files list →
          </button>
        )}
      </div>
    </div>
  );
}
