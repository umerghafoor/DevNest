import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { McpServer } from "./acp";
import {
  addItem,
  getAgentSession,
  startAgent,
  subscribeAgentSession,
  type AgentSession,
} from "./agent-sessions";
import type { AgentDef } from "../store/agents-store";
import type { PanelKind } from "../store/app-store";

/**
 * The Master agent: one app-wide agent session on the host device, shown in
 * the right-hand panel. It isn't tied to a project folder or a pane; DevNest
 * gives it an MCP server (src-tauri/src/master.rs) whose tools inspect and
 * operate this machine or any DevNest device. Changes wait for the user's
 * approval here.
 */

export const MASTER_KEY = "__master__";

/** Tools DevNest gates; "always allow" is offered only for the narrow ones. */
const BROAD_TOOLS = new Set(["run_command", "write_file"]);

export interface Approval {
  id: string;
  tool: string;
  /** Device the action runs on, e.g. "Beetle-Eye" or "Mac (this computer)". */
  device: string;
  title: string;
  detail: string;
}

/** Widgets the agent can show, and the full panel each one opens as. */
export const WIDGETS: Record<string, { label: string; panel: PanelKind }> = {
  system_monitor: { label: "System monitor", panel: "metrics" },
  processes: { label: "Processes", panel: "processes" },
  tailscale: { label: "Tailscale", panel: "tailscale" },
  docker: { label: "Docker", panel: "docker" },
};

const LAYOUT_KEY = "devnest.master";
const DEFAULT_WIDTH = 400;

function readLayout(): { open: boolean; width: number } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const p = raw
      ? (JSON.parse(raw) as { open?: boolean; width?: number })
      : {};
    return { open: p.open ?? false, width: p.width ?? DEFAULT_WIDTH };
  } catch {
    return { open: false, width: DEFAULT_WIDTH };
  }
}

interface MasterState {
  open: boolean;
  width: number;
  approvals: Approval[];
  /** Tools the user allowed for the rest of this agent run. */
  allowed: string[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setWidth: (width: number) => void;
}

export const useMasterStore = create<MasterState>((set, get) => {
  const save = () => {
    const { open, width } = get();
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({ open, width }));
    } catch {
      // Layout just won't persist.
    }
  };
  return {
    ...readLayout(),
    approvals: [],
    allowed: [],
    setOpen: (open) => {
      set({ open });
      save();
    },
    toggle: () => {
      set((s) => ({ open: !s.open }));
      save();
    },
    setWidth: (width) => {
      set({ width });
      save();
    },
  };
});

export function canAlwaysAllow(tool: string) {
  return !BROAD_TOOLS.has(tool);
}

export function answerApproval(a: Approval, allow: boolean, always = false) {
  useMasterStore.setState((s) => ({
    approvals: s.approvals.filter((x) => x.id !== a.id),
    allowed:
      allow && always && canAlwaysAllow(a.tool) && !s.allowed.includes(a.tool)
        ? [...s.allowed, a.tool]
        : s.allowed,
  }));
  void api.masterResolve(a.id, allow).catch(() => {});
}

function denyAll() {
  if (useMasterStore.getState().approvals.length === 0) return;
  useMasterStore.setState({ approvals: [] });
  void api.masterDenyAll().catch(() => {});
}

/** The Master agent's session (always the host device). */
export function getMasterSession(hostDeviceId: string): AgentSession {
  const s = getAgentSession(MASTER_KEY, hostDeviceId);
  wire(s);
  return s;
}

/** Start `agent` as the Master agent, with DevNest's MCP server attached. */
export async function startMaster(
  s: AgentSession,
  agent: AgentDef,
  home: string,
) {
  useMasterStore.setState({ allowed: [] });
  denyAll();
  const ep = await api.masterStart();
  await startAgent(s, agent, home, {
    mcpServers: (init): McpServer[] =>
      init.agentCapabilities?.mcpCapabilities?.http
        ? [
            {
              type: "http",
              name: "devnest",
              url: ep.url,
              headers: [{ name: "Authorization", value: `Bearer ${ep.token}` }],
            },
          ]
        : [
            {
              name: "devnest",
              command: ep.bridgeCommand,
              args: ep.bridgeArgs,
              env: [
                { name: "DEVNEST_MCP_URL", value: ep.url },
                { name: "DEVNEST_MCP_TOKEN", value: ep.token },
              ],
            },
          ],
  });
}

// Backend events are app-wide; route them into the Master session once.
let wired: AgentSession | null = null;
function wire(s: AgentSession) {
  if (wired === s) return;
  const first = wired === null;
  wired = s;

  // A finished, cancelled or dead turn can't use pending approvals.
  let last = s.status;
  subscribeAgentSession(s, () => {
    if (last === "prompting" && s.status !== "prompting") denyAll();
    last = s.status;
  });

  if (!first) return;
  void listen<Approval>("master:approval", (e) => {
    const a = e.payload;
    if (useMasterStore.getState().allowed.includes(a.tool)) {
      void api.masterResolve(a.id, true).catch(() => {});
      return;
    }
    useMasterStore.setState((st) => ({ approvals: [...st.approvals, a] }));
    useMasterStore.getState().setOpen(true);
  });
  void listen<{
    id: string;
    widget: string;
    title?: string | null;
    deviceId: string;
    deviceName: string;
  }>("master:widget", (e) => {
    if (!wired) return;
    addItem(
      wired,
      {
        kind: "widget",
        id: e.payload.id,
        widget: e.payload.widget,
        title: e.payload.title ?? undefined,
        deviceId: e.payload.deviceId,
        deviceName: e.payload.deviceName,
      },
      // One live widget per device and kind: showing it again moves it
      // down to the latest message instead of stacking duplicates.
      (it) =>
        it.kind === "widget" &&
        it.widget === e.payload.widget &&
        it.deviceId === e.payload.deviceId,
    );
  });
}
