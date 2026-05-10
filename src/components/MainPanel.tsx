import { useAppStore } from "../store/app-store";
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
          <div className="p-6">
            <h2 className="text-lg font-semibold">{activeTab.panel} panel</h2>
            <p className="mt-2 text-sm text-(--color-fg-muted)">
              Coming soon. Device: {activeDevice?.name ?? "(none)"}
            </p>
          </div>
        ) : (
          <EmptyState />
        )}
      </div>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <h2 className="text-base font-medium">Welcome to DevNest</h2>
        <p className="mt-2 text-sm text-(--color-fg-muted)">
          Add a device from the sidebar, then open a panel to manage Docker,
          watch metrics, or browse files over SSH.
        </p>
      </div>
    </div>
  );
}
