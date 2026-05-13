import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

interface ConfirmRequest {
  id: number;
  message: string;
  title?: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
}

interface ConfirmStore {
  queue: ConfirmRequest[];
  confirm: (message: string, opts?: { title?: string; destructive?: boolean }) => Promise<boolean>;
  respond: (id: number, ok: boolean) => void;
}

let nextId = 0;

export const useConfirmStore = create<ConfirmStore>((set) => ({
  queue: [],
  confirm: (message, opts) =>
    new Promise<boolean>((resolve) => {
      const id = ++nextId;
      set((s) => ({
        queue: [...s.queue, { id, message, resolve, ...opts }],
      }));
    }),
  respond: (id, ok) =>
    set((s) => {
      const req = s.queue.find((r) => r.id === id);
      if (req) req.resolve(ok);
      return { queue: s.queue.filter((r) => r.id !== id) };
    }),
}));

// Convenience helper — call this instead of window.confirm()
export function confirm(
  message: string,
  opts?: { title?: string; destructive?: boolean },
): Promise<boolean> {
  return useConfirmStore.getState().confirm(message, opts);
}

export function ConfirmDialogHost() {
  const queue = useConfirmStore((s) => s.queue);
  const respond = useConfirmStore((s) => s.respond);
  const current = queue[0];

  const [visible, setVisible] = useState(false);
  const prevId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (current && current.id !== prevId.current) {
      prevId.current = current.id;
      // Trigger animation on next frame
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    if (!current) setVisible(false);
  }, [current]);

  const handleRespond = (ok: boolean) => {
    setVisible(false);
    // Let exit animation play before removing
    setTimeout(() => {
      if (current) respond(current.id, ok);
    }, 200);
  };

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleRespond(false);
      if (e.key === "Enter") handleRespond(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;

  return (
    <div
      className={`fixed inset-0 z-[90] flex items-center justify-center transition-all duration-200
        ${visible ? "bg-black/40" : "bg-black/0"}`}
      onClick={() => handleRespond(false)}
    >
      <div
        className={`w-80 rounded-xl border border-(--color-border) bg-(--color-bg) p-5 shadow-2xl
          transition-all duration-200 ease-out
          ${visible ? "opacity-100 scale-100" : "opacity-0 scale-95"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-sm font-semibold">
          {current.title ?? "Confirm"}
        </h3>
        <p className="mb-5 text-xs text-(--color-fg-muted) leading-relaxed">
          {current.message}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => handleRespond(false)}
            className="rounded border border-(--color-border) px-3 py-1.5 text-xs
              hover:bg-(--color-surface-2) transition-colors"
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={() => handleRespond(true)}
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors
              ${current.destructive
                ? "bg-(--color-error) text-white hover:opacity-90"
                : "bg-(--color-accent) text-(--color-accent-fg) hover:opacity-90"
              }`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
