import { invoke } from "@tauri-apps/api/core";

export type AuthType = "key" | "password" | "localhost";

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  keyPath: string | null;
  isLocalhost: boolean;
  sudoPrefix: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewDevice {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  keyPath: string | null;
  sudoPrefix: string | null;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  created: string;
}

export interface DiskUsage {
  mount: string;
  total: string;
  used: string;
  usePercent: number;
}

export interface MetricsSnapshot {
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  disks: DiskUsage[];
  timestamp: number;
}

export type ConnectionStatus = "connected" | "offline";

export const api = {
  ping: () => invoke<string>("ping"),
  appVersion: () => invoke<string>("app_version"),

  listDevices: () => invoke<Device[]>("list_devices"),
  createDevice: (newDevice: NewDevice, secret: string | null) =>
    invoke<Device>("create_device", { new: newDevice, secret }),
  deleteDevice: (id: string) => invoke<void>("delete_device", { id }),
  connectDevice: (id: string) => invoke<void>("connect_device", { id }),
  disconnectDevice: (id: string) => invoke<void>("disconnect_device", { id }),
  deviceStatus: (id: string) =>
    invoke<ConnectionStatus>("device_status", { id }),
  runRemoteCommand: (deviceId: string, cmd: string) =>
    invoke<CommandOutput>("run_remote_command", { deviceId, cmd }),

  dockerListContainers: (deviceId: string) =>
    invoke<ContainerSummary[]>("docker_list_containers", { deviceId }),
  dockerAction: (deviceId: string, containerId: string, action: string) =>
    invoke<CommandOutput>("docker_action", {
      deviceId,
      containerId,
      action,
    }),
  dockerLogs: (deviceId: string, containerId: string, tail = 200) =>
    invoke<string>("docker_logs", { deviceId, containerId, tail }),

  metricsSnapshot: (deviceId: string) =>
    invoke<MetricsSnapshot>("metrics_snapshot", { deviceId }),
};
