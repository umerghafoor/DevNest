import { useCallback, useRef, useState } from "react";

/**
 * Track an element's content size. Returns a callback ref to attach and the
 * current `{ w, h }` (0 × 0 until first measured). Panels use it to adapt to
 * the pane they're in rather than the window.
 */
export function useElementSize<T extends HTMLElement = HTMLDivElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      const h = Math.round(entry.contentRect.height);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  return [ref, size] as const;
}
