import { Clock, LayoutDashboard, Pin, Search } from "lucide-react";
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
import { usePaletteStore } from "../store/palette-store";
import { useRecentsStore } from "../store/recents-store";
import { formatBinding, useShortcutsStore } from "../store/shortcuts-store";

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
  const showPalette = usePaletteStore((s) => s.show);
  const paletteKey = useShortcutsStore((s) =>
    s.getBinding("openCommandPalette"),
  );
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

        <button
          onClick={showPalette}
          className="flex h-10 w-full items-center gap-2.5 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 text-left text-sm text-(--color-fg-muted) transition-colors hover:border-(--color-accent)/50"
        >
          <Search size={15} />
          <span className="flex-1">Search panels and widgets…</span>
          <kbd className="rounded border border-(--color-border) bg-(--color-bg) px-1.5 py-0.5 font-mono text-[10px]">
            {formatBinding(paletteKey)}
          </kbd>
        </button>

        {pinned.length > 0 && (
          <Section icon={<Pin size={11} />} title="Pinned widgets">
            <div className={GRID}>
              {pinned.map((w) => (
                <Card
                  key={w.spec.id}
                  icon={<LayoutDashboard size={15} strokeWidth={1.75} />}
                  title={w.spec.name}
                  subtitle={w.deviceName}
                  hint={w.spec.description ?? undefined}
                  onClick={() => {
                    const id = Math.random().toString(36).slice(2, 10);
                    openPane({
                      id,
                      instanceId: id,
                      deviceId: w.deviceId,
                      panel: "widgets",
                      extra: { widgetId: w.spec.id },
                    });
                  }}
                />
              ))}
            </div>
          </Section>
        )}

        {recent.length > 0 && (
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
          if (panels.length === 0) return null;
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
