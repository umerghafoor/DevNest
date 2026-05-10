import { create } from "zustand";
import type { ConnectionStatus, Device } from "../lib/api";

export type PanelKind =
  | "docker"
  | "metrics"
  | "terminal"
  | "files"
  | "tailscale"
  | "logs";

export interface Tab {
  id: string;
  deviceId: string;
  panel: PanelKind;
}

interface AppState {
  devices: Device[];
  statuses: Record<string, ConnectionStatus | "connecting" | "error">;
  activeDeviceId: string | null;
  tabs: Tab[];
  activeTabId: string | null;

  setDevices: (devices: Device[]) => void;
  upsertDevice: (device: Device) => void;
  removeDevice: (id: string) => void;
  setStatus: (
    deviceId: string,
    status: ConnectionStatus | "connecting" | "error",
  ) => void;
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

  setDevices: (devices) =>
    set((s) => ({
      devices,
      activeDeviceId:
        s.activeDeviceId && devices.some((d) => d.id === s.activeDeviceId)
          ? s.activeDeviceId
          : (devices[0]?.id ?? null),
    })),
  upsertDevice: (device) =>
    set((s) => {
      const idx = s.devices.findIndex((d) => d.id === device.id);
      const devices =
        idx === -1
          ? [...s.devices, device]
          : s.devices.map((d) => (d.id === device.id ? device : d));
      return { devices };
    }),
  removeDevice: (id) =>
    set((s) => ({
      devices: s.devices.filter((d) => d.id !== id),
      activeDeviceId: s.activeDeviceId === id ? null : s.activeDeviceId,
      tabs: s.tabs.filter((t) => t.deviceId !== id),
      statuses: Object.fromEntries(
        Object.entries(s.statuses).filter(([k]) => k !== id),
      ),
    })),
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
