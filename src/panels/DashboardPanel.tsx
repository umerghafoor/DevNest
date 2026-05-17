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
  const openPane = useAppStore((s) => s.openPane);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const ws = workspaces.find((w) => w.id === activeWorkspaceId);
  const device = devices.find((d) => d.id === deviceId);

  const onlineCount = devices.filter(
    (d) => d.isLocalhost || statuses[d.id] === "connected",
  ).length;

  return (
    <div className="fade-up h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-xs text-(--color-fg-muted)">
            Quick overview of {device ? device.name : "this workspace"}.
          </p>
        </header>

        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Devices" value={String(devices.length)} />
          <StatCard label="Online" value={String(onlineCount)} />
          <StatCard label="Workspace" value={ws?.name ?? "—"} />
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
            Quick launch
          </h2>
          <div className="space-y-4">
            {CATEGORY_ORDER.map((category) => {
              const panels = PANEL_ORDER_IN_CATEGORY[category];
              if (panels.length === 0) return null;
              return (
                <div key={category}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-(--color-fg-muted)">
                    {CATEGORY_LABELS[category]}
                  </h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {panels.map((kind) => (
                      <button
                        key={kind}
                        onClick={() => openPane(makePane(deviceId, kind))}
                        title={PANEL_DESCRIPTIONS[kind]}
                        className="group flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2 text-left text-xs transition-colors hover:border-(--color-accent)/50 hover:bg-(--color-surface-2)"
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
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
            Devices
          </h2>
          <div className="overflow-hidden rounded-lg border border-(--color-border)">
            {devices.length === 0 ? (
              <div className="bg-(--color-surface) px-4 py-6 text-center text-xs text-(--color-fg-muted)">
                No devices yet. Add one from the sidebar.
              </div>
            ) : (
              devices.map((d) => {
                const status = d.isLocalhost
                  ? "connected"
                  : (statuses[d.id] ?? "offline");
                return (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-surface) px-4 py-2 text-sm last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          status === "connected"
                            ? "bg-(--color-online)"
                            : status === "error"
                              ? "bg-(--color-error)"
                              : "bg-(--color-offline)"
                        }`}
                      />
                      <span className="truncate text-(--color-fg)">
                        {d.name}
                      </span>
                      <span className="truncate text-xs text-(--color-fg-muted)">
                        {d.host}
                      </span>
                    </div>
                    <span className="text-xs text-(--color-fg-muted)">
                      {status}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <footer className="pt-4 text-center text-[11px] text-(--color-fg-muted)">
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

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface) px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-(--color-fg-muted)">
        {label}
      </div>
      <div className="mt-1 truncate text-lg font-semibold text-(--color-fg)">
        {value}
      </div>
    </div>
  );
}
