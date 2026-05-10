import { useAppStore } from "../store/app-store";
import type { PanelKind } from "../store/app-store";
import { DockerPanel } from "../panels/DockerPanel";
import { MetricsPanel } from "../panels/MetricsPanel";
import { TabBar } from "./TabBar";

const PANELS: { kind: PanelKind; label: string; ready: boolean }[] = [
  { kind: "docker", label: "Docker", ready: true },
  { kind: "metrics", label: "Metrics", ready: true },
  { kind: "terminal", label: "Terminal", ready: false },
  { kind: "files", label: "Files", ready: false },
  { kind: "tailscale", label: "Tailscale", ready: false },
  { kind: "logs", label: "Logs", ready: false },
];

export function MainPanel() {
  const activeTab = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const activeDevice = useAppStore((s) =>
    s.devices.find((d) => d.id === s.activeDeviceId),
  );
  const openTab = useAppStore((s) => s.openTab);

  const open = (kind: PanelKind) => {
    if (!activeDevice) return;
    openTab({
      id: `${activeDevice.id}:${kind}`,
      deviceId: activeDevice.id,
      panel: kind,
    });
  };

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden">
      <TabBar />
      {activeDevice && (
        <div className="flex items-center gap-1 border-b border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-xs">
          <span className="mr-2 text-(--color-fg-muted)">Open:</span>
          {PANELS.map((p) => (
            <button
              key={p.kind}
              onClick={() => p.ready && open(p.kind)}
              disabled={!p.ready}
              className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
              title={p.ready ? "" : "Coming in a later phase"}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {activeTab ? (
          <PanelView panel={activeTab.panel} deviceId={activeTab.deviceId} />
        ) : (
          <EmptyState hasDevice={Boolean(activeDevice)} />
        )}
      </div>
    </main>
  );
}

function PanelView({
  panel,
  deviceId,
}: {
  panel: PanelKind;
  deviceId: string;
}) {
  switch (panel) {
    case "docker":
      return <DockerPanel deviceId={deviceId} />;
    case "metrics":
      return <MetricsPanel deviceId={deviceId} />;
    default:
      return (
        <div className="flex h-full items-center justify-center text-sm text-(--color-fg-muted)">
          {panel} panel — coming in a later phase.
        </div>
      );
  }
}

function EmptyState({ hasDevice }: { hasDevice: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <h2 className="text-base font-medium">Welcome to DevNest</h2>
        <p className="mt-2 text-sm text-(--color-fg-muted)">
          {hasDevice
            ? "Pick a panel above to start managing this device."
            : "Add a device from the sidebar, then open a panel to manage Docker, watch metrics, or browse files over SSH."}
        </p>
      </div>
    </div>
  );
}
