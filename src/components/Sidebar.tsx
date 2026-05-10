import { useAppStore } from "../store/app-store";
import type { ConnectionStatus } from "../store/app-store";

const statusDot: Record<ConnectionStatus, string> = {
  connected: "bg-(--color-online)",
  connecting: "bg-(--color-warn) animate-pulse",
  offline: "bg-(--color-offline)",
  error: "bg-(--color-error)",
};

export function Sidebar() {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const activeDeviceId = useAppStore((s) => s.activeDeviceId);
  const setActiveDevice = useAppStore((s) => s.setActiveDevice);

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)">
      <div className="flex items-center justify-between px-4 py-3 border-b border-(--color-border)">
        <h1 className="text-sm font-semibold tracking-wide">DevNest</h1>
        <button
          className="rounded px-2 py-1 text-xs text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg)"
          aria-label="Add device"
        >
          + Add
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {devices.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
            No devices yet.
            <br />
            Add one to get started.
          </div>
        ) : (
          <ul className="space-y-0.5 px-2">
            {devices.map((d) => {
              const status = statuses[d.id] ?? "offline";
              const active = activeDeviceId === d.id;
              return (
                <li key={d.id}>
                  <button
                    onClick={() => setActiveDevice(d.id)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-(--color-surface-2) ${
                      active
                        ? "bg-(--color-surface-2) text-(--color-fg)"
                        : "text-(--color-fg-muted)"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${statusDot[status]}`}
                      aria-label={status}
                    />
                    <span className="truncate">{d.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
