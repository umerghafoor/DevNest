import { useAppStore } from "../store/app-store";
import type { PanelKind } from "../store/app-store";
import { DockerPanel } from "../panels/DockerPanel";
import { MetricsPanel } from "../panels/MetricsPanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import { TailscalePanel } from "../panels/TailscalePanel";
import { FileBrowserPanel } from "../panels/FileBrowserPanel";
import { LogViewerPanel } from "../panels/LogViewerPanel";
import { TabBar } from "./TabBar";

export function MainPanel() {
  const activeTab = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId),
  );
  const activeDevice = useAppStore((s) =>
    s.devices.find((d) => d.id === s.activeDeviceId),
  );

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden">
      <TabBar />
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
    case "terminal":
      return <TerminalPanel deviceId={deviceId} />;
    case "tailscale":
      return <TailscalePanel deviceId={deviceId} />;
    case "files":
      return <FileBrowserPanel deviceId={deviceId} />;
    case "logs":
      return <LogViewerPanel deviceId={deviceId} />;
  }
}

function EmptyState({ hasDevice }: { hasDevice: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        {/* Cradle mark, large */}
        <svg
          width="56"
          height="56"
          viewBox="0 0 100 100"
          fill="none"
          className="opacity-30"
        >
          <path
            d="M 8 60 Q 50 92 92 60"
            stroke="oklch(0.74 0.17 58)"
            strokeWidth="9"
            strokeLinecap="round"
          />
          <path
            d="M 22 50 Q 50 76 78 50"
            stroke="currentColor"
            strokeWidth="9"
            strokeLinecap="round"
          />
          <ellipse cx="50" cy="34" rx="11" ry="13" fill="oklch(0.74 0.17 58)" />
        </svg>
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            {hasDevice ? "Open a panel" : "Welcome to DevNest"}
          </h2>
          <p className="mt-1 max-w-xs text-xs text-(--color-fg-muted)">
            {hasDevice
              ? "Click + Panel in the tab bar to open Terminal, Docker, Files, and more."
              : "Add a device from the sidebar to get started."}
          </p>
        </div>
      </div>
    </div>
  );
}
