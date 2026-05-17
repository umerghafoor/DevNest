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
  useSudo: boolean;
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
}

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
  setUseSudo: (id: string, value: boolean) =>
    invoke<Device>("set_use_sudo", { id, value }),
  setSudoPassword: (id: string, password: string) =>
    invoke<void>("set_sudo_password", { id, password }),
  hasSudoPassword: (id: string) => invoke<boolean>("has_sudo_password", { id }),
  clearSudoPassword: (id: string) =>
    invoke<void>("clear_sudo_password", { id }),
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

  gitIsRepo: (path: string) => invoke<boolean>("git_is_repo", { path }),
  gitBranch: (path: string) => invoke<string | null>("git_branch", { path }),
  gitClone: (url: string, parentDir: string, repoName: string) =>
    invoke<string>("git_clone", { url, parentDir, repoName }),
  gitLog: (path: string, limit?: number) =>
    invoke<GitCommit[]>("git_log", { path, limit: limit ?? null }),
  gitBranches: (path: string) =>
    invoke<GitBranchInfo[]>("git_branches", { path }),
  gitTags: (path: string) => invoke<GitTag[]>("git_tags", { path }),
  gitShow: (path: string, hash: string) =>
    invoke<GitCommitDetail>("git_show", { path, hash }),
  gitDiff: (path: string, hash: string, filePath: string) =>
    invoke<string>("git_diff", { path, hash, filePath }),

  fsReadText: (path: string) => invoke<string>("fs_read_text", { path }),
  fsWriteText: (path: string, content: string) =>
    invoke<void>("fs_write_text", { path, content }),

  githubDeviceStart: (clientId: string) =>
    invoke<DeviceCodeResponse>("github_device_start", { clientId }),
  githubDevicePoll: (clientId: string, deviceCode: string) =>
    invoke<string | null>("github_device_poll", { clientId, deviceCode }),
  githubSignedIn: () => invoke<boolean>("github_signed_in"),
  githubSignOut: () => invoke<void>("github_sign_out"),
  githubUser: () => invoke<GhUser>("github_user"),
  githubListRepos: () => invoke<GhRepo[]>("github_list_repos"),

  ngrokAvailable: () => invoke<boolean>("ngrok_available"),
  ngrokList: () => invoke<NgrokTunnel[]>("ngrok_list"),
  ngrokStart: (port: number, proto: "http" | "tcp") =>
    invoke<NgrokTunnel>("ngrok_start", { port, proto }),
  ngrokStop: (id: string) => invoke<void>("ngrok_stop", { id }),
};

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
