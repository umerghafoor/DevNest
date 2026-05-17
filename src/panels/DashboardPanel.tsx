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

interface Props {
  deviceId: string;
}

function makePane(deviceId: string, panel: PanelKind): Pane {
  const uid = Math.random().toString(36).slice(2, 10);
  return { id: uid, deviceId, panel, instanceId: uid };
}

export function DashboardPanel({ deviceId }: Props) {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const openPane = useAppStore((s) => s.openPane);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  // Prefer the live sidebar selection so newly-opened panes target the device
  // the user is currently looking at, not the one this dashboard was pinned to.
  const launchDeviceId = activeDeviceId ?? deviceId;
  const launchDevice = devices.find((d) => d.id === launchDeviceId);
  const onlineCount = devices.filter(
    (d) => d.isLocalhost || statuses[d.id] === "connected",
  ).length;

  return (
    <div className="fade-up flex h-full flex-col overflow-y-auto px-5 py-4">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
        {/* Header + inline stats */}
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-base font-semibold tracking-tight">Dashboard</h1>
          <span className="text-[11px] text-(--color-fg-muted)">
            opens panels on{" "}
            <span className="font-medium text-(--color-fg)">
              {launchDevice?.name ?? "—"}
            </span>
          </span>
          <span className="ml-auto flex items-center gap-3 text-[11px] text-(--color-fg-muted)">
            <Stat label="devices" value={devices.length} />
            <Stat label="online" value={onlineCount} />
            <Stat label="workspace" value={ws?.name ?? "—"} />
          </span>
        </header>

        {/* Quick launch — denser, single section */}
        <section className="flex-1">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-3">
            {CATEGORY_ORDER.map((category) => {
              const panels = PANEL_ORDER_IN_CATEGORY[category];
              if (panels.length === 0) return null;
              return (
                <PaneRow
                  key={category}
                  label={CATEGORY_LABELS[category]}
                  panels={panels}
                  onOpen={(kind) => openPane(makePane(launchDeviceId, kind))}
                />
              );
            })}
          </div>
        </section>

        <footer className="pt-2 text-center text-[10px] text-(--color-fg-muted)">
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span>
      <span className="font-medium text-(--color-fg) tabular-nums">
        {value}
      </span>{" "}
      {label}
    </span>
  );
}

function PaneRow({
  label,
  panels,
  onOpen,
}: {
  label: string;
  panels: PanelKind[];
  onOpen: (kind: PanelKind) => void;
}) {
  return (
    <>
      <div className="self-center pt-1 text-right text-[10px] font-semibold uppercase tracking-wide text-(--color-fg-muted)">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {panels.map((kind) => (
          <button
            key={kind}
            onClick={() => onOpen(kind)}
            title={PANEL_DESCRIPTIONS[kind]}
            className="group flex items-center gap-1.5 rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 text-[11px] transition-colors hover:border-(--color-accent)/50 hover:bg-(--color-surface-2)"
          >
            <span className="text-(--color-fg-muted) group-hover:text-(--color-accent)">
              {PANEL_ICONS[kind]}
            </span>
            <span className="truncate text-(--color-fg)">
              {PANEL_LABELS[kind]}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
