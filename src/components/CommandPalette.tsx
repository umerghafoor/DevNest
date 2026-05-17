import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../store/app-store";
import type { Pane, PanelKind } from "../store/app-store";
import { useRecentsStore } from "../store/recents-store";
import { usePaletteStore } from "../store/palette-store";
import {
  PANEL_ICONS,
  PANEL_LABELS,
  PANEL_DESCRIPTIONS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  PANEL_CATEGORY,
  PANEL_ORDER_IN_CATEGORY,
} from "./PaneTile";
import { fuzzyScore } from "../lib/fuzzy";

interface PaletteItem {
  kind: PanelKind;
  label: string;
  description: string;
  category: string;
  /** "Recent" when surfaced via the recents list; else the panel's category label. */
  sectionLabel: string;
  isSectionStart: boolean;
}

const ALL_KINDS: PanelKind[] = CATEGORY_ORDER.flatMap(
  (c) => PANEL_ORDER_IN_CATEGORY[c],
);

export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const hide = usePaletteStore((s) => s.hide);
  const recents = useRecentsStore((s) => s.recents);
  const pushRecent = useRecentsStore((s) => s.push);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const openPane = useAppStore((s) => s.openPane);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state on open/close.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      const f = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(f);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();

    if (q) {
      // Fuzzy search across labels + descriptions; sort by score.
      type Scored = { kind: PanelKind; score: number };
      const scored: Scored[] = [];
      for (const kind of ALL_KINDS) {
        const labelScore = fuzzyScore(q, PANEL_LABELS[kind]);
        const descScore = fuzzyScore(q, PANEL_DESCRIPTIONS[kind]);
        // Label matches dominate description matches.
        const best =
          labelScore !== null && descScore !== null
            ? Math.max(labelScore * 2, descScore)
            : labelScore !== null
              ? labelScore * 2
              : descScore;
        if (best !== null) scored.push({ kind, score: best });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map(({ kind }, i) => ({
        kind,
        label: PANEL_LABELS[kind],
        description: PANEL_DESCRIPTIONS[kind],
        category: CATEGORY_LABELS[PANEL_CATEGORY[kind]],
        sectionLabel: "Results",
        isSectionStart: i === 0,
      }));
    }

    // No query: Recents first, then category-ordered list.
    const out: PaletteItem[] = [];
    const used = new Set<PanelKind>();
    recents.forEach((kind, i) => {
      used.add(kind);
      out.push({
        kind,
        label: PANEL_LABELS[kind],
        description: PANEL_DESCRIPTIONS[kind],
        category: CATEGORY_LABELS[PANEL_CATEGORY[kind]],
        sectionLabel: "Recent",
        isSectionStart: i === 0,
      });
    });
    for (const cat of CATEGORY_ORDER) {
      const kinds = PANEL_ORDER_IN_CATEGORY[cat].filter((k) => !used.has(k));
      kinds.forEach((kind, i) => {
        used.add(kind);
        out.push({
          kind,
          label: PANEL_LABELS[kind],
          description: PANEL_DESCRIPTIONS[kind],
          category: CATEGORY_LABELS[cat],
          sectionLabel: CATEGORY_LABELS[cat],
          isSectionStart: i === 0,
        });
      });
    }
    return out;
  }, [query, recents]);

  // Keep cursor in bounds when items change.
  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(0);
  }, [items.length, activeIdx]);

  // Auto-scroll active item into view.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-idx="${activeIdx}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  if (!open) return null;

  const pick = (kind: PanelKind) => {
    const deviceId = activeDeviceId ?? "local";
    const uid = Math.random().toString(36).slice(2, 10);
    const pane: Pane = { id: uid, instanceId: uid, deviceId, panel: kind };
    openPane(pane);
    pushRecent(kind);
    hide();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIdx];
      if (item) pick(item.kind);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(items.length - 1);
    }
  };

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={hide}
    >
      <div
        className="modal-content w-full max-w-xl overflow-hidden rounded-xl border border-(--color-border) bg-(--color-surface) shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-3 py-2">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="shrink-0 text-(--color-fg-muted)"
            aria-hidden
          >
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3 3" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to search panels…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-(--color-fg-muted)"
          />
          <kbd className="rounded border border-(--color-border) bg-(--color-surface) px-1.5 py-0.5 font-mono text-[10px] text-(--color-fg-muted)">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          className="max-h-[55vh] overflow-y-auto py-1"
          role="listbox"
        >
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
              No matches for &quot;{query}&quot;.
            </div>
          ) : (
            items.map((it, i) => (
              <Row
                key={`${it.kind}-${i}`}
                item={it}
                idx={i}
                active={i === activeIdx}
                searching={query.trim().length > 0}
                onHover={() => setActiveIdx(i)}
                onPick={() => pick(it.kind)}
              />
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-bg) px-3 py-1.5 text-[10px] text-(--color-fg-muted)">
          <span>
            <Kbd>↑↓</Kbd> navigate · <Kbd>↵</Kbd> open · <Kbd>Esc</Kbd> close
          </span>
          <span>
            {items.length} {items.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

function Row({
  item,
  idx,
  active,
  searching,
  onHover,
  onPick,
}: {
  item: PaletteItem;
  idx: number;
  active: boolean;
  searching: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <>
      {item.isSectionStart && (
        <div className="mt-1.5 px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-(--color-fg-muted) first:mt-0">
          {item.sectionLabel}
        </div>
      )}
      <button
        data-idx={idx}
        onMouseEnter={onHover}
        onClick={onPick}
        role="option"
        aria-selected={active}
        className={`group relative flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
          active ? "bg-(--color-accent)/15" : "hover:bg-(--color-surface-2)"
        }`}
      >
        {active && (
          <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-(--color-accent)" />
        )}
        <span
          className={`w-5 shrink-0 text-center text-base ${
            active ? "text-(--color-accent)" : "text-(--color-fg-muted)"
          }`}
        >
          {PANEL_ICONS[item.kind]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-(--color-fg)">
              {item.label}
            </span>
            {searching && (
              <span className="truncate text-[10px] text-(--color-fg-muted)">
                {item.category}
              </span>
            )}
          </span>
          <span className="truncate text-[11px] text-(--color-fg-muted)">
            {item.description}
          </span>
        </span>
      </button>
    </>
  );
}
