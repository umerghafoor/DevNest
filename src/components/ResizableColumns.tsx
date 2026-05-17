import { useCallback, useRef, useState } from "react";
import { usePaneSettings } from "../store/pane-settings-store";

export interface ColumnSpec {
  /** Stable id used in the persisted width map and as the React key. */
  id: string;
  /** Initial width in px (used until the user drags). */
  defaultWidth: number;
  /** Minimum width in px after drag. Default 32. */
  minWidth?: number;
}

interface PersistShape {
  colWidths?: Record<string, number>;
}

/**
 * Drives column widths for any `<table class="table-fixed">` that wants
 * drag-to-resize headers.
 *
 * Returns:
 *  - `widthFor(id)` — number of px to set in `<col style={{ width }}>`
 *  - `ResizeHandle` — render this inside each `<th>` (positioned absolute on
 *    its right edge). Hover shows the handle; drag updates width; double-click
 *    resets to the column's default.
 *
 * Persistence: if `paneId` is provided, widths are stored under
 * `colWidths` in the pane-settings blob, so they survive remount and
 * app restart.
 */
export function useResizableColumns(
  columns: ColumnSpec[],
  paneId?: string,
): {
  widthFor: (id: string) => number;
  ResizeHandle: React.FC<{ columnId: string }>;
} {
  const [paneSettings, updatePaneSettings] = usePaneSettings<PersistShape>(
    paneId,
    { colWidths: {} },
  );
  const persisted = paneSettings.colWidths ?? {};

  // In-memory widths during a drag, applied immediately for smooth UI.
  // Persist debounced once the drag ends so we don't write on every mousemove.
  const [draft, setDraft] = useState<Record<string, number> | null>(null);

  const widthFor = useCallback(
    (id: string) => {
      const col = columns.find((c) => c.id === id);
      const fallback = col?.defaultWidth ?? 100;
      return draft?.[id] ?? persisted[id] ?? fallback;
    },
    [draft, persisted, columns],
  );

  const onDragStart = (columnId: string, startX: number, startWidth: number) => {
    const col = columns.find((c) => c.id === columnId);
    const minWidth = col?.minWidth ?? 32;
    const live = { ...persisted, ...(draft ?? {}) };

    const onMove = (e: MouseEvent) => {
      const next = Math.max(minWidth, startWidth + (e.clientX - startX));
      live[columnId] = next;
      setDraft({ ...live });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Commit to persistence in one go.
      updatePaneSettings({ colWidths: live });
      setDraft(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const reset = (columnId: string) => {
    const next = { ...persisted, ...(draft ?? {}) };
    delete next[columnId];
    updatePaneSettings({ colWidths: next });
    setDraft(null);
  };

  const ResizeHandle: React.FC<{ columnId: string }> = ({ columnId }) => {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div
        ref={ref}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const startWidth = widthFor(columnId);
          onDragStart(columnId, e.clientX, startWidth);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          reset(columnId);
        }}
        title="Drag to resize · double-click to reset"
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none
          before:absolute before:right-[2px] before:top-1/4 before:h-1/2 before:w-px
          before:bg-(--color-border) before:opacity-0 hover:before:opacity-100
          before:transition-opacity"
      />
    );
  };

  return { widthFor, ResizeHandle };
}

/**
 * Drop-in `<th>` that hosts the resize handle. Use inside a thead row.
 * The cell needs `position: relative` for the handle to anchor — already
 * applied here.
 */
export function ResizableTh({
  columnId,
  children,
  className = "",
  ResizeHandle,
  onClick,
}: {
  columnId: string;
  children: React.ReactNode;
  className?: string;
  ResizeHandle: React.FC<{ columnId: string }>;
  onClick?: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className={`relative px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted) ${
        onClick ? "cursor-pointer select-none hover:text-(--color-fg) transition-colors" : ""
      } ${className}`}
    >
      {children}
      <ResizeHandle columnId={columnId} />
    </th>
  );
}
