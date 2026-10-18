import { useEffect, useRef, useState } from "react";
import { Clock, LayoutDashboard, Pin, Search, X } from "lucide-react";
import { useAppStore } from "../store/app-store";
import type { PanelKind, Pane } from "../store/app-store";
import {
  PANEL_ICONS,
  PANEL_LABELS,
  PANEL_DESCRIPTIONS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  PANEL_ORDER_IN_CATEGORY,
} from "../components/PaneTile";
import { useWidgetsStore } from "../lib/custom-widgets";
import { useRecentsStore } from "../store/recents-store";
import { fuzzyScore } from "../lib/fuzzy";
import type { SavedWidget } from "../lib/custom-widgets";

interface Props {
  deviceId: string;
}

function makePane(deviceId: string, panel: PanelKind): Pane {
  const uid = Math.random().toString(36).slice(2, 10);
  return { id: uid, deviceId, panel, instanceId: uid };
}

const OFFERED = new Set<PanelKind>(
  CATEGORY_ORDER.flatMap((c) => PANEL_ORDER_IN_CATEGORY[c]),
);

/** Responsive card grid shared by every section. */
const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-2";

/**
 * What an empty workspace shows: a launcher for panels, pinned widgets and
 * recently used panels, opening on the device selected in the sidebar.
 */
export function DashboardPanel({ deviceId }: Props) {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const openPane = useAppStore((s) => s.openPane);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const saved = useWidgetsStore((s) => s.saved);
  const recents = useRecentsStore((s) => s.recents);
  const pushRecent = useRecentsStore((s) => s.push);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Type anywhere to search: a printable key pressed while nothing editable
  // has focus goes into the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      // Space still presses a focused button.
      if (e.key === " " && t?.closest("button, a")) return;
      if (
        t?.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable=true], .xterm, .monaco-editor, .cm-editor",
        )
      )
        return;
      const input = searchRef.current;
      // Skip if this dashboard isn't on screen (e.g. another workspace).
      if (!input || input.offsetParent === null) return;
      e.preventDefault();
      input.focus();
      setQuery((v) => v + e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  // Prefer the live sidebar selection so newly-opened panes target the device
  // the user is currently looking at, not the one this dashboard was pinned to.
  const launchDeviceId = activeDeviceId ?? deviceId;
  const launchDevice = devices.find((d) => d.id === launchDeviceId);
  const onlineCount = devices.filter(
    (d) => d.isLocalhost || statuses[d.id] === "connected",
  ).length;
  const pinned = saved.filter((w) => w.pinned);
  const recent = recents.filter((k) => OFFERED.has(k)).slice(0, 6);

  const open = (kind: PanelKind) => {
    openPane(makePane(launchDeviceId, kind));
    pushRecent(kind);
  };
  const openWidget = (w: SavedWidget) => {
    const id = Math.random().toString(36).slice(2, 10);
    openPane({
      id,
      instanceId: id,
      deviceId: w.deviceId,
      panel: "widgets",
      extra: { widgetId: w.spec.id },
    });
  };

  // Searching filters the dashboard in place: panels by name or
  // description, saved widgets by name.
  const q = query.trim();
  /** Name matches rank above description matches; null = no match. */
  const panelScore = (k: PanelKind) => {
    const name = fuzzyScore(q, PANEL_LABELS[k]);
    return name !== null ? name * 2 : fuzzyScore(q, PANEL_DESCRIPTIONS[k]);
  };
  const panelHits = q
    ? [...OFFERED]
        .map((k) => ({ k, score: panelScore(k) }))
        .filter((x): x is { k: PanelKind; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.k)
    : [];
  const widgetHits = q
    ? saved.filter((w) => fuzzyScore(q, w.spec.name) !== null)
    : [];
  const openFirst = () => {
    if (panelHits[0]) open(panelHits[0]);
    else if (widgetHits[0]) openWidget(widgetHits[0]);
  };

  return (
    <div className="fade-up h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {ws?.name ?? "Workspace"}
            </h1>
            <p className="text-xs text-(--color-fg-muted)">
              Open a panel on{" "}
              <span className="font-medium text-(--color-fg)">
                {launchDevice?.name ?? "—"}
              </span>
              <span className="opacity-70"> · pick another in the sidebar</span>
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Stat label="Devices" value={devices.length} />
            <Stat label="Online" value={onlineCount} accent />
          </div>
        </header>

        <label className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 text-sm text-(--color-fg-muted) transition-colors focus-within:border-(--color-accent)">
          <Search size={15} className="shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") openFirst();
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Start typing to search panels and widgets…"
            className="no-focus-ring min-w-0 flex-1 bg-transparent text-(--color-fg) outline-none placeholder:text-(--color-fg-muted)"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear"
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-(--color-surface-2) hover:text-(--color-fg)"
            >
              <X size={13} />
            </button>
          )}
        </label>

        {q && (
          <Section title="Results">
            {panelHits.length + widgetHits.length === 0 ? (
              <p className="text-xs text-(--color-fg-muted)">
                Nothing matches “{q}”.
              </p>
            ) : (
              <div className={GRID}>
                {panelHits.map((kind) => (
                  <PanelCard key={kind} kind={kind} onOpen={open} />
                ))}
                {widgetHits.map((w) => (
                  <WidgetCard key={w.spec.id} w={w} onOpen={openWidget} />
                ))}
              </div>
            )}
          </Section>
        )}

        {!q && pinned.length > 0 && (
          <Section icon={<Pin size={11} />} title="Pinned widgets">
            <div className={GRID}>
              {pinned.map((w) => (
                <WidgetCard key={w.spec.id} w={w} onOpen={openWidget} />
              ))}
            </div>
          </Section>
        )}

        {!q && recent.length > 0 && (
          <Section icon={<Clock size={11} />} title="Recent">
            <div className={GRID}>
              {recent.map((kind) => (
                <PanelCard key={kind} kind={kind} onOpen={open} />
              ))}
            </div>
          </Section>
        )}

        {CATEGORY_ORDER.map((category) => {
          const panels = PANEL_ORDER_IN_CATEGORY[category];
          if (q || panels.length === 0) return null;
          return (
            <Section key={category} title={CATEGORY_LABELS[category]}>
              <div className={GRID}>
                {panels.map((kind) => (
                  <PanelCard key={kind} kind={kind} onOpen={open} />
                ))}
              </div>
            </Section>
          );
        })}

        <footer className="mt-auto pt-2 text-center text-[10px] text-(--color-fg-muted)">
          Created by{" "}
          <a
            href="https://github.com/umerghafoor"
            target="_blank"
            rel="noreferrer"
            className="text-(--color-fg) hover:text-(--color-accent)"
          >
            Umer Ghafoor
          </a>
        </footer>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-1.5">
      <div className="text-[10px] font-medium tracking-wide text-(--color-fg-muted) uppercase">
        {label}
      </div>
      <div
        className={`text-base leading-tight font-semibold tabular-nums ${accent ? "text-(--color-online)" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-(--color-fg-muted) uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function PanelCard({
  kind,
  onOpen,
}: {
  kind: PanelKind;
  onOpen: (kind: PanelKind) => void;
}) {
  return (
    <Card
      icon={<span className="text-sm leading-none">{PANEL_ICONS[kind]}</span>}
      title={PANEL_LABELS[kind]}
      subtitle={PANEL_DESCRIPTIONS[kind]}
      onClick={() => onOpen(kind)}
    />
  );
}

function WidgetCard({
  w,
  onOpen,
}: {
  w: SavedWidget;
  onOpen: (w: SavedWidget) => void;
}) {
  return (
    <Card
      icon={<LayoutDashboard size={15} strokeWidth={1.75} />}
      title={w.spec.name}
      subtitle={w.deviceName}
      hint={w.spec.description ?? undefined}
      onClick={() => onOpen(w)}
    />
  );
}

function Card({
  icon,
  title,
  subtitle,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={hint ?? subtitle}
      className="group flex min-w-0 items-center gap-2.5 rounded-lg border border-(--color-border) bg-(--color-surface) p-2 text-left transition-all hover:-translate-y-px hover:border-(--color-accent)/50 hover:shadow-sm"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-(--color-surface-2) text-(--color-fg-muted) transition-colors group-hover:bg-(--color-accent)/15 group-hover:text-(--color-accent)">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-(--color-fg)">
          {title}
        </span>
        {subtitle && (
          <span className="block truncate text-[11px] text-(--color-fg-muted)">
            {subtitle}
          </span>
        )}
      </span>
    </button>
  );
}
