import { useAppStore } from "../store/app-store";

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const devices = useAppStore((s) => s.devices);
  const deviceById = (id: string) => devices.find((d) => d.id === id);

  if (tabs.length === 0) {
    return (
      <div className="flex h-9 items-center border-b border-(--color-border) px-3 text-xs text-(--color-fg-muted)">
        No open tabs
      </div>
    );
  }

  return (
    <div className="flex h-9 items-center gap-0.5 border-b border-(--color-border) bg-(--color-surface) px-2">
      {tabs.map((t) => {
        const dev = deviceById(t.deviceId);
        const active = t.id === activeTabId;
        return (
          <div
            key={t.id}
            className={`group flex h-7 items-center gap-2 rounded-t px-3 text-xs ${
              active
                ? "bg-(--color-bg) text-(--color-fg)"
                : "text-(--color-fg-muted) hover:bg-(--color-surface-2)"
            }`}
          >
            <button
              onClick={() => setActiveTab(t.id)}
              className="cursor-pointer"
            >
              {dev?.name ?? "?"} · {t.panel}
            </button>
            <button
              onClick={() => closeTab(t.id)}
              aria-label="Close tab"
              className="opacity-0 transition group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
