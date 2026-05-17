import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

type ToastKind = "info" | "success" | "error" | "warn";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastStore {
  toasts: Toast[];
  add: (message: string, kind?: ToastKind) => void;
  remove: (id: number) => void;
}

let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add: (message, kind = "info") => {
    const id = ++nextId;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (msg: string) => useToastStore.getState().add(msg, "info"),
  success: (msg: string) => useToastStore.getState().add(msg, "success"),
  error: (msg: string) => useToastStore.getState().add(msg, "error"),
  warn: (msg: string) => useToastStore.getState().add(msg, "warn"),
};

const kindStyles: Record<ToastKind, string> = {
  info: "border-(--color-border) bg-(--color-surface) text-(--color-fg)",
  success:
    "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
  error: "border-(--color-error)/30 bg-(--color-error)/10 text-(--color-error)",
  warn: "border-(--color-warn)/30 bg-(--color-warn)/10 text-(--color-warn)",
};

const kindIcon: Record<ToastKind, string> = {
  info: "ℹ",
  success: "✓",
  error: "✕",
  warn: "⚠",
};

function ToastItem({
  toast: t,
  onRemove,
}: {
  toast: Toast;
  onRemove: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    timerRef.current = setTimeout(() => setVisible(false), 3500);
    return () => {
      cancelAnimationFrame(frame);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      const t2 = setTimeout(onRemove, 300);
      return () => clearTimeout(t2);
    }
  }, [visible, onRemove]);

  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg text-xs max-w-sm
        transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]
        ${visible ? "opacity-100 translate-x-0 scale-100" : "opacity-0 translate-x-4 scale-95"}
        ${kindStyles[t.kind]}`}
    >
      <span className="mt-px shrink-0 font-semibold">{kindIcon[t.kind]}</span>
      <span className="flex-1 leading-snug">{t.message}</span>
      <button
        onClick={() => setVisible(false)}
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity ml-1"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} onRemove={() => remove(t.id)} />
        </div>
      ))}
    </div>
  );
}
