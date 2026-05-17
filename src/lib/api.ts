import { invoke } from "@tauri-apps/api/core";
import { useSudoStore } from "../store/sudo-store";
import { useAppStore } from "../store/app-store";

/**
 * Wraps Tauri's `invoke` with automatic sudo retry. When the backend returns
 * `SudoPasswordRequired`, the global sudo dialog is opened; on save the call
 * is retried once. On cancel the original error is rethrown.
 *
 * This makes every panel's API call sudo-safe by default, without each call
 * site needing to wrap in `withSudo()`.
 */
async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (!isSudoRequired(e)) throw e;
    const deviceId = sudoRequiredDeviceId(e);
    if (!deviceId) throw e;
    const name =
      useAppStore.getState().devices.find((d) => d.id === deviceId)?.name ??
      deviceId;
    const saved = await useSudoStore.getState().request(deviceId, name);
    if (!saved) throw e;
    return await invoke<T>(cmd, args);
  }
}

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
  useSudo: boolean;
  keepAlive: boolean;
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
  useSudo: boolean;
  keepAlive: boolean;
}

/** PATCH shape for `updateDevice` — same fields as NewDevice, no id. */
export type DeviceUpdate = Omit<NewDevice, never>;

export interface AppErrorPayload {
  kind: "ssh" | "db" | "notFound" | "invalid" | "sudoPasswordRequired" | "io";
  message: string;
  detail: string | null;
}

export function isAppError(e: unknown): e is AppErrorPayload {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string"
  );
}

export function isSudoRequired(e: unknown): boolean {
  if (isAppError(e) && e.kind === "sudoPasswordRequired") return true;
  // Fallback for transports that flatten our struct into a string —
  // matches the Display impl in src-tauri/src/error.rs.
  const msg = typeof e === "string" ? e : isAppError(e) ? e.message : "";
  return msg.toLowerCase().includes("sudo password required");
}

export function sudoRequiredDeviceId(e: unknown): string | null {
  if (isAppError(e) && e.kind === "sudoPasswordRequired") {
    return typeof e.detail === "string" ? e.detail : null;
  }
  // Try to extract from "sudo password required for device <id>".
  const msg = typeof e === "string" ? e : isAppError(e) ? e.message : "";
  const m = /sudo password required for device ([0-9a-fA-F-]+)/.exec(msg);
  return m ? m[1] : null;
}

const PERMISSION_DENIED_PATTERNS = [
  "permission denied",
  "operation not permitted",
  "must be root",
  "are you root?",
  "got permission denied",
  "you do not have permission",
  "access is denied",
];

/**
 * True when an error message looks like an EACCES or "needs root" failure
 * that sudo would likely fix. Used to escalate to sudo automatically when
 * the user hasn't pre-enabled it on a device.
 */
export function isPermissionDeniedError(e: unknown): boolean {
  const msg = (isAppError(e) ? e.message : String(e)).toLowerCase();
  return PERMISSION_DENIED_PATTERNS.some((p) => msg.includes(p));
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return e.message;
  return String(e);
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

export interface CpuCoreTicks {
  core: number;
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

export interface MemInfo {
  totalMb: number;
  freeMb: number;
  availableMb: number;
  usedMb: number;
  buffersMb: number;
  cachedMb: number;
}

export interface SwapInfo {
  totalMb: number;
  usedMb: number;
}

export interface LoadAvg {
  one: number;
  five: number;
  fifteen: number;
}

export interface ProcessCounts {
  running: number;
  total: number;
}

export interface NetInterface {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
}

export interface ThermalZone {
  name: string;
  celsius: number;
}

export interface MetricsSnapshot {
  timestampMs: number;
  /** Aggregate cumulative idle-vs-total ratio. Frontend computes real CPU% from per-core deltas. */
  cpuPercent: number;
  cpuCores: CpuCoreTicks[];
  mem: MemInfo;
  swap: SwapInfo;
  load: LoadAvg;
  uptimeSeconds: number;
  processes: ProcessCounts;
  disks: DiskUsage[];
  net: NetInterface[];
  temperatures: ThermalZone[];
}

export interface CpuInfo {
  model: string;
  vendor: string;
  physicalCores: number;
  logicalCores: number;
  mhz: number;
  cacheKb: number;
  governor: string | null;
  architecture: string;
}

export interface DimmModule {
  locator: string;
  size: string;
  kind: string;
  speed: string;
  manufacturer: string;
  partNumber: string;
}

export type ConnectionStatus = "connected" | "offline";

export type SqlEngine = "postgres" | "mysql" | "sqlite";

export interface SqlColumnInfo {
  name: string;
  dataType: string;
}

export interface SqlQueryResult {
  columns: SqlColumnInfo[];
  rows: unknown[][];
  truncated: boolean;
  elapsedMs: number;
  rowsAffected: number | null;
}

export const api = {
  ping: () => call<string>("ping"),
  appVersion: () => call<string>("app_version"),

  listDevices: () => call<Device[]>("list_devices"),
  createDevice: (newDevice: NewDevice, secret: string | null) =>
    call<Device>("create_device", { new: newDevice, secret }),
  /**
   * Update an existing device. `secret` semantics:
   *  - `null`  → keep stored keyring entry as-is.
   *  - `""`    → clear the keyring entry.
   *  - string  → overwrite the keyring entry.
   */
  updateDevice: (
    id: string,
    patch: DeviceUpdate,
    secret: string | null,
  ) => call<Device>("update_device", { id, patch, secret }),
  deleteDevice: (id: string) => call<void>("delete_device", { id }),
  setUseSudo: (id: string, value: boolean) =>
    call<Device>("set_use_sudo", { id, value }),
  setKeepAlive: (id: string, value: boolean) =>
    call<Device>("set_keep_alive", { id, value }),
  setSudoPassword: (id: string, password: string) =>
    call<void>("set_sudo_password", { id, password }),
  hasSudoPassword: (id: string) => call<boolean>("has_sudo_password", { id }),
  clearSudoPassword: (id: string) => call<void>("clear_sudo_password", { id }),
  connectDevice: (id: string) => call<void>("connect_device", { id }),
  disconnectDevice: (id: string) => call<void>("disconnect_device", { id }),
  deviceStatus: (id: string) => call<ConnectionStatus>("device_status", { id }),
  devicePing: (id: string) => call<ConnectionStatus>("device_ping", { id }),

  // SQL client
  sqlSetPassword: (id: string, password: string) =>
    call<void>("sql_set_password", { id, password }),
  sqlClearPassword: (id: string) => call<void>("sql_clear_password", { id }),
  sqlHasPassword: (id: string) => call<boolean>("sql_has_password", { id }),
  sqlOpenTunnel: (
    id: string,
    deviceId: string,
    remoteHost: string,
    remotePort: number,
  ) =>
    call<number>("sql_open_tunnel", { id, deviceId, remoteHost, remotePort }),
  sqlCloseTunnel: (id: string) => call<void>("sql_close_tunnel", { id }),
  sqlConnect: (params: {
    id: string;
    engine: SqlEngine;
    host: string;
    port: number;
    username: string;
    database?: string | null;
  }) => call<void>("sql_connect", params),
  sqlDisconnect: (id: string) => call<void>("sql_disconnect", { id }),
  sqlIsConnected: (id: string) => call<boolean>("sql_is_connected", { id }),
  sqlQuery: (id: string, sql: string) =>
    call<SqlQueryResult>("sql_query", { id, sql }),
  sqlListTables: (id: string) => call<string[]>("sql_list_tables", { id }),
  runRemoteCommand: (deviceId: string, cmd: string) =>
    call<CommandOutput>("run_remote_command", { deviceId, cmd }),

  dockerListContainers: (deviceId: string) =>
    call<ContainerSummary[]>("docker_list_containers", { deviceId }),
  dockerAction: (deviceId: string, containerId: string, action: string) =>
    call<CommandOutput>("docker_action", { deviceId, containerId, action }),
  dockerLogs: (deviceId: string, containerId: string, tail = 200) =>
    call<string>("docker_logs", { deviceId, containerId, tail }),

  metricsSnapshot: (deviceId: string) =>
    call<MetricsSnapshot>("metrics_snapshot", { deviceId }),
  cpuInfo: (deviceId: string) => call<CpuInfo>("cpu_info", { deviceId }),
  dimmInfo: (deviceId: string) => call<DimmModule[]>("dimm_info", { deviceId }),

  gitIsRepo: (deviceId: string, path: string) =>
    call<boolean>("git_is_repo", { deviceId, path }),
  gitBranch: (deviceId: string, path: string) =>
    call<string | null>("git_branch", { deviceId, path }),
  gitClone: (url: string, parentDir: string, repoName: string) =>
    call<string>("git_clone", { url, parentDir, repoName }),
  gitLog: (deviceId: string, path: string, limit?: number) =>
    call<GitCommit[]>("git_log", { deviceId, path, limit: limit ?? null }),
  gitBranches: (deviceId: string, path: string) =>
    call<GitBranchInfo[]>("git_branches", { deviceId, path }),
  gitTags: (deviceId: string, path: string) =>
    call<GitTag[]>("git_tags", { deviceId, path }),
  gitShow: (deviceId: string, path: string, hash: string) =>
    call<GitCommitDetail>("git_show", { deviceId, path, hash }),
  gitDiff: (deviceId: string, path: string, hash: string, filePath: string) =>
    call<string>("git_diff", { deviceId, path, hash, filePath }),

  fsReadText: (path: string) => call<string>("fs_read_text", { path }),
  fsWriteText: (path: string, content: string) =>
    call<void>("fs_write_text", { path, content }),

  githubDeviceStart: (clientId: string) =>
    call<DeviceCodeResponse>("github_device_start", { clientId }),
  githubDevicePoll: (clientId: string, deviceCode: string) =>
    call<string | null>("github_device_poll", { clientId, deviceCode }),
  githubSignedIn: () => call<boolean>("github_signed_in"),
  githubSignOut: () => call<void>("github_sign_out"),
  githubUser: () => call<GhUser>("github_user"),
  githubListRepos: () => call<GhRepo[]>("github_list_repos"),

  httpRequest: (spec: HttpRequestSpec) =>
    call<HttpResponse>("http_request", { spec }),

  ngrokAvailable: () => call<boolean>("ngrok_available"),
  ngrokList: () => call<NgrokTunnel[]>("ngrok_list"),
  ngrokStart: (port: number, proto: "http" | "tcp") =>
    call<NgrokTunnel>("ngrok_start", { port, proto }),
  ngrokStop: (id: string) => call<void>("ngrok_stop", { id }),

  systemdList: (deviceId: string) =>
    call<SystemdUnit[]>("systemd_list", { deviceId }),
  systemdStatus: (deviceId: string, name: string) =>
    call<SystemdUnitStatus>("systemd_status", { deviceId, name }),
  systemdCat: (deviceId: string, name: string) =>
    call<string>("systemd_cat", { deviceId, name }),
  systemdAction: (
    deviceId: string,
    name: string,
    action: "start" | "stop" | "restart" | "reload" | "enable" | "disable",
  ) => call<string>("systemd_action", { deviceId, name, action }),
  systemdWriteUnit: (deviceId: string, name: string, content: string) =>
    call<void>("systemd_write_unit", { deviceId, name, content }),
  systemdDeleteUnit: (deviceId: string, name: string) =>
    call<void>("systemd_delete_unit", { deviceId, name }),
};

export interface SystemdUnit {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  unitFileState: string | null;
}

export interface SystemdUnitStatus {
  name: string;
  active: string;
  sub: string;
  enabled: string | null;
  mainPid: number | null;
  description: string;
}

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  timeoutMs?: number;
  followRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  binary: boolean;
  elapsedMs: number;
  finalUrl: string;
}

export type NgrokTunnelStatus = "starting" | "active" | "stopped" | "error";

export interface NgrokTunnel {
  id: string;
  port: number;
  proto: string;
  status: NgrokTunnelStatus;
  url: string | null;
  error: string | null;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GhUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string | null;
}

export interface GitCommit {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  subject: string;
  parents: string[];
  refs: string[];
}

export interface GitBranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  upstream: string | null;
  last_commit: string | null;
}

export interface GitTag {
  name: string;
  commit: string | null;
}

export interface GitChangedFile {
  status: string;
  path: string;
}

export interface GitCommitDetail {
  hash: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  subject: string;
  body: string;
  parents: string[];
  files: GitChangedFile[];
}
