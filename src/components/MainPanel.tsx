import { useAppStore, selectActiveWorkspace } from "../store/app-store";
import { DashboardPanel } from "../panels/DashboardPanel";
import { PaneTile } from "./PaneTile";

export function MainPanel() {
  const ws = useAppStore(selectActiveWorkspace);
  const activeDevice = useAppStore((s) =>
    s.devices.find((d) => d.id === s.activeDeviceId),
  );

  return (
    <main className="flex h-full flex-1 flex-col overflow-hidden min-w-0">
      <div className="min-h-0 flex-1 overflow-hidden">
        {ws.paneRoot ? (
          <PaneTile node={ws.paneRoot} />
        ) : activeDevice ? (
          <DashboardPanel deviceId={activeDevice.id} />
        ) : (
          <NoDeviceState />
        )}
      </div>
    </main>
  );
}

function NoDeviceState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
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
            Welcome to DevNest
          </h2>
          <p className="mt-1 max-w-xs text-xs text-(--color-fg-muted)">
            Add a device from the sidebar to get started.
          </p>
        </div>
      </div>
    </div>
  );
}
