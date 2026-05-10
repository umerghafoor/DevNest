import { create } from "zustand";

export type PanelKind =
  | "docker"
  | "metrics"
  | "terminal"
  | "files"
  | "tailscale"
  | "logs";

export type ConnectionStatus = "connected" | "connecting" | "offline" | "error";

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "key" | "password" | "localhost";
  isLocalhost: boolean;
}

export interface Tab {
  id: string;
  deviceId: string;
  panel: PanelKind;
}

interface AppState {
  devices: Device[];
  statuses: Record<string, ConnectionStatus>;
  activeDeviceId: string | null;
  tabs: Tab[];
  activeTabId: string | null;

  setDevices: (devices: Device[]) => void;
  setStatus: (deviceId: string, status: ConnectionStatus) => void;
  setActiveDevice: (deviceId: string | null) => void;
  openTab: (tab: Tab) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  devices: [],
  statuses: {},
  activeDeviceId: null,
  tabs: [],
  activeTabId: null,

  setDevices: (devices) => set({ devices }),
  setStatus: (deviceId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [deviceId]: status } })),
  setActiveDevice: (deviceId) => set({ activeDeviceId: deviceId }),
  openTab: (tab) =>
    set((s) =>
      s.tabs.some((t) => t.id === tab.id)
        ? { activeTabId: tab.id }
        : { tabs: [...s.tabs, tab], activeTabId: tab.id },
    ),
  closeTab: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      const activeTabId =
        s.activeTabId === tabId ? (tabs.at(-1)?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    }),
  setActiveTab: (tabId) => set({ activeTabId: tabId }),
}));
