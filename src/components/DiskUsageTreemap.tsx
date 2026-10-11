import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
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

// Depth-based color palette
const PALETTE = [
  "oklch(0.68 0.16 240)", // blue
  "oklch(0.68 0.16 160)", // emerald
  "oklch(0.72 0.18 55)", // amber
  "oklch(0.68 0.18 340)", // rose
  "oklch(0.68 0.16 290)", // purple
  "oklch(0.68 0.16 200)", // cyan
  "oklch(0.72 0.17 90)", // yellow-lime
];

function getColor(index: number, _depth: number): string {
  const base = PALETTE[index % PALETTE.length];
  return base;
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
  const [hovered, setHovered] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [chartType, setChartType] = useState<"treemap" | "sunburst">("treemap");

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

    // Find path from data to currentRoot
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

  // Treemap rects calculation
  const rects = useMemo(() => {
    if (!currentRoot) return [];
    // Container dimension assumed 1000 x 600 for SVG viewBox
    return layoutTreemap(currentRoot, 0, 0, 1000, 600, 0);
  }, [currentRoot]);

  // Handle drill down
  const handleRectClick = (r: Rect) => {
    if (r.node.children && r.node.children.length > 0) {
      setCurrentRoot(r.node);
    }
  };

  // Sunburst calculation
  const sunburstArcs = useMemo(() => {
    if (!currentRoot) return [];
    const arcs: Array<{
      node: DiskUsageNode;
      pathD: string;
      depth: number;
      index: number;
    }> = [];

    const centerX = 500;
    const centerY = 300;
    const maxRadius = 260;
    const levels = 3;
    const layerThickness = maxRadius / levels;

    function buildArcs(
      node: DiskUsageNode,
      depth: number,
      startAngle: number,
      endAngle: number,
      _idx: number,
    ) {
      if (depth >= levels || !node.children || node.children.length === 0)
        return;

      const innerR = 40 + depth * layerThickness;
      const outerR = innerR + layerThickness - 2;
      const total = node.children.reduce((acc, c) => acc + c.size, 0) || 1;
      let curAngle = startAngle;

      node.children.forEach((child, childIdx) => {
        const span = (child.size / total) * (endAngle - startAngle);
        const childStart = curAngle;
        const childEnd = curAngle + span;
        curAngle += span;

        if (span > 0.02) {
          // Generate annular sector path
          const x1 = centerX + outerR * Math.cos(childStart);
          const y1 = centerY + outerR * Math.sin(childStart);
          const x2 = centerX + outerR * Math.cos(childEnd);
          const y2 = centerY + outerR * Math.sin(childEnd);
          const x3 = centerX + innerR * Math.cos(childEnd);
          const y3 = centerY + innerR * Math.sin(childEnd);
          const x4 = centerX + innerR * Math.cos(childStart);
          const y4 = centerY + innerR * Math.sin(childStart);

          const largeArc = span > Math.PI ? 1 : 0;
          const d = `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;

          arcs.push({ node: child, pathD: d, depth, index: childIdx });
          buildArcs(child, depth + 1, childStart, childEnd, childIdx);
        }
      });
    }

    buildArcs(currentRoot, 0, 0, Math.PI * 2, 0);
    return arcs;
  }, [currentRoot]);

  return (
    <div className="flex h-full flex-col select-none overflow-hidden bg-(--color-bg)">
      {/* Treemap toolbar */}
      <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-xs">
        {/* Breadcrumb path */}
        <div className="flex items-center gap-1 overflow-x-auto py-0.5 no-scrollbar">
          {breadcrumbs.map((bc, idx) => (
            <div key={bc.path} className="flex items-center gap-1 shrink-0">
              {idx > 0 && <span className="text-(--color-fg-muted)">/</span>}
              <button
                onClick={() => setCurrentRoot(bc)}
                className={`rounded px-1.5 py-0.5 transition-colors ${
                  idx === breadcrumbs.length - 1
                    ? "font-semibold text-(--color-fg) bg-(--color-surface-2)"
                    : "text-(--color-accent) hover:underline"
                }`}
              >
                {bc.name || "/"}
              </button>
            </div>
          ))}
          {currentRoot && (
            <span className="ml-2 font-mono text-[11px] text-(--color-fg-muted)">
              ({fmtSize(currentRoot.size)})
            </span>
          )}
        </div>

        {/* View toggles & Rescan */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex rounded border border-(--color-border) p-0.5 bg-(--color-bg)">
            <button
              onClick={() => setChartType("treemap")}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                chartType === "treemap"
                  ? "bg-(--color-accent) text-white font-medium"
                  : "text-(--color-fg-muted) hover:text-(--color-fg)"
              }`}
            >
              Treemap
            </button>
            <button
              onClick={() => setChartType("sunburst")}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                chartType === "sunburst"
                  ? "bg-(--color-accent) text-white font-medium"
                  : "text-(--color-fg-muted) hover:text-(--color-fg)"
              }`}
            >
              Sunburst
            </button>
          </div>

          <button
            onClick={() => void scan(currentRoot?.path ?? path)}
            disabled={loading}
            className="rounded border border-(--color-border) px-2 py-0.5 text-[11px] hover:bg-(--color-surface-2) disabled:opacity-40 transition-colors"
          >
            {loading ? "Scanning…" : "↻ Rescan"}
          </button>
        </div>
      </div>

      {/* Main visualization area */}
      <div className="relative flex-1 min-h-0 w-full overflow-hidden p-2">
        {loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-(--color-fg-muted)">
            <span className="h-6 w-6 rounded-full border-2 border-(--color-accent) border-t-transparent animate-spin" />
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
          <div className="relative h-full w-full">
            <svg
              viewBox="0 0 1000 600"
              preserveAspectRatio="none"
              className="h-full w-full rounded border border-(--color-border)"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltipPos({
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                });
              }}
              onMouseLeave={() => setHovered(null)}
            >
              {rects.map((r, i) => {
                const isDir = Boolean(
                  r.node.children && r.node.children.length > 0,
                );
                const color = getColor(i, r.depth);
                const isHovered = hovered?.node.path === r.node.path;

                return (
                  <g
                    key={r.node.path + i}
                    onClick={() => handleRectClick(r)}
                    onMouseEnter={() => setHovered(r)}
                    className="cursor-pointer transition-all"
                  >
                    <rect
                      x={r.x + 1}
                      y={r.y + 1}
                      width={Math.max(1, r.w - 2)}
                      height={Math.max(1, r.h - 2)}
                      fill={color}
                      fillOpacity={isHovered ? 0.95 : 0.75}
                      stroke={isHovered ? "var(--color-fg)" : "var(--color-bg)"}
                      strokeWidth={isHovered ? 2 : 1}
                      rx={2}
                    />
                    {r.w > 45 && r.h > 24 && (
                      <foreignObject
                        x={r.x + 3}
                        y={r.y + 3}
                        width={r.w - 6}
                        height={r.h - 6}
                        className="pointer-events-none overflow-hidden"
                      >
                        <div className="flex h-full flex-col justify-start text-[10px] leading-tight text-white drop-shadow font-medium">
                          <span className="truncate">
                            {isDir ? "📁 " : "📄 "}
                            {r.node.name}
                          </span>
                          <span className="opacity-90 font-mono text-[9px]">
                            {fmtSize(r.node.size)}
                          </span>
                        </div>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        ) : (
          /* Sunburst chart */
          <div className="relative h-full w-full flex items-center justify-center">
            <svg
              viewBox="0 0 1000 600"
              className="h-full w-full"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setTooltipPos({
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top,
                });
              }}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Center circle */}
              <circle
                cx={500}
                cy={300}
                r={36}
                fill="var(--color-surface-2)"
                stroke="var(--color-border)"
                strokeWidth={2}
                className="cursor-pointer"
                onClick={() => {
                  if (breadcrumbs.length > 1) {
                    setCurrentRoot(breadcrumbs[breadcrumbs.length - 2]);
                  }
                }}
              />
              <text
                x={500}
                y={296}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-fg)"
                className="pointer-events-none font-medium"
              >
                {currentRoot.name || "/"}
              </text>
              <text
                x={500}
                y={312}
                textAnchor="middle"
                fontSize={9}
                fill="var(--color-fg-muted)"
                className="pointer-events-none font-mono"
              >
                {fmtSize(currentRoot.size)}
              </text>

              {sunburstArcs.map((arc, i) => {
                const isHovered = hovered?.node.path === arc.node.path;
                const color = getColor(arc.index, arc.depth);

                return (
                  <path
                    key={arc.node.path + i}
                    d={arc.pathD}
                    fill={color}
                    fillOpacity={isHovered ? 0.95 : 0.75}
                    stroke={isHovered ? "var(--color-fg)" : "var(--color-bg)"}
                    strokeWidth={isHovered ? 2 : 1}
                    className="cursor-pointer transition-all"
                    onClick={() => {
                      if (arc.node.children && arc.node.children.length > 0) {
                        setCurrentRoot(arc.node);
                      }
                    }}
                    onMouseEnter={() =>
                      setHovered({
                        node: arc.node,
                        x: 0,
                        y: 0,
                        w: 0,
                        h: 0,
                        depth: arc.depth,
                      })
                    }
                  />
                );
              })}
            </svg>
          </div>
        )}

        {/* Hover Tooltip */}
        {hovered && tooltipPos && (
          <div
            className="pointer-events-none absolute z-30 flex flex-col gap-0.5 rounded border border-(--color-border) bg-(--color-surface) px-2.5 py-1.5 text-xs shadow-lg"
            style={{
              left: Math.min(tooltipPos.x + 12, 800),
              top: Math.min(tooltipPos.y + 12, 500),
            }}
          >
            <div className="flex items-center gap-1.5 font-medium text-(--color-fg)">
              <span>{hovered.node.children?.length ? "📁" : "📄"}</span>
              <span>{hovered.node.name}</span>
            </div>
            <div className="font-mono text-[11px] text-(--color-accent)">
              {fmtSize(hovered.node.size)}
              {currentRoot && currentRoot.size > 0 && (
                <span className="ml-1 text-(--color-fg-muted)">
                  ({((hovered.node.size / currentRoot.size) * 100).toFixed(1)}%)
                </span>
              )}
            </div>
            <div className="font-mono text-[10px] text-(--color-fg-muted) truncate max-w-sm">
              {hovered.node.path}
            </div>
            {hovered.node.children && hovered.node.children.length > 0 && (
              <div className="mt-0.5 text-[10px] text-(--color-online)">
                Click to inspect {hovered.node.children.length} sub-items
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-surface) px-3 py-1 text-[11px] text-(--color-fg-muted)">
        <span>
          Click any directory to zoom in · Click breadcrumbs to return
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
