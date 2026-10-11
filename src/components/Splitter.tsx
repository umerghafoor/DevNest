import { useRef, type RefObject } from "react";

/**
 * Draggable divider between two panes. Reports the pointer's offset inside
 * `containerRef` (px along `axis`) and the container's size; the parent turns
 * that into a width / fraction and clamps it. Double-click calls `onReset`.
 */
export function Splitter({
  axis,
  containerRef,
  onChange,
  onReset,
}: {
  /** "x" = vertical bar resizing widths; "y" = horizontal bar resizing heights. */
  axis: "x" | "y";
  containerRef: RefObject<HTMLElement | null>;
  onChange: (offsetPx: number, totalPx: number) => void;
  onReset?: () => void;
}) {
  const dragging = useRef(false);

  const move = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (axis === "x") onChange(e.clientX - rect.left, rect.width);
    else onChange(e.clientY - rect.top, rect.height);
  };

  const end = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className={`group relative z-10 shrink-0 ${
        axis === "x"
          ? "-mx-1 w-2 cursor-col-resize"
          : "-my-1 h-2 cursor-row-resize"
      }`}
    >
      <div
        className={`absolute bg-(--color-border) transition-colors group-hover:bg-(--color-accent) group-active:bg-(--color-accent) ${
          axis === "x"
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2 group-hover:w-0.5"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2 group-hover:h-0.5"
        }`}
      />
    </div>
  );
}
