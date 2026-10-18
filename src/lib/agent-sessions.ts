import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, errorMessage } from "./api";
import {
  AcpConnection,
  AcpError,
  AUTH_REQUIRED,
  contentText,
  type ContentBlock,
  isInside,
  wantsApiKey,
  type AuthMethod,
  type AuthStatus,
  type AvailableCommand,
  type ConfigOption,
  type ElicitationRequest,
  type ElicitationResponse,
  type InitializeResult,
  type McpServer,
  type SessionModeState,
  type PermissionOutcome,
  type PermissionRequest,
  type PlanEntry,
  type SessionUpdate,
  type ToolCall,
} from "./acp";
import type { AgentDef } from "../store/agents-store";
import {
  chatTitle,
  compactItems,
  useChatsStore,
  type ChatRecord,
} from "./agent-chats";
import { collectPanes, useAppStore } from "../store/app-store";

/** One entry in the conversation transcript. */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | { kind: "system"; id: string; text: string; error?: boolean }
  /** A live widget the Master agent asked to show. */
  | {
      kind: "widget";
      id: string;
      widget: string;
      title?: string;
      /** Device the widget watches; the session's device if unset. */
      deviceId?: string;
      deviceName?: string;
    };

export type AgentStatus =
  | "idle" // nothing launched
  | "starting" // process up, handshaking
  | "auth" // agent wants the user to pick an auth method
  | "ready" // waiting for a prompt
  | "prompting" // turn in progress
  | "exited";

export interface PendingElicitation {
  req: ElicitationRequest;
  resolve: (r: ElicitationResponse) => void;
}

export interface PendingPermission {
  req: PermissionRequest;
  resolve: (o: PermissionOutcome) => void;
}

/**
 * An agent pane's process + ACP session. Kept outside React so remounts
 * (workspace switch, splitting) don't kill the agent or lose the transcript.
 */
export interface AgentSession {
  /** Device the agent runs on (localhost or an SSH host). */
  deviceId: string;
  agent: AgentDef | null;
  cwd: string;
  status: AgentStatus;
  items: TranscriptItem[];
  stderr: string[];
  authMethods: AuthMethod[];
  /** Signed-in account, when the agent reports it. */
  account: AuthStatus | null;
  /** Agent supports the `logout` request. */
  canLogout: boolean;
  /** Slash commands the agent currently offers. */
  commands: AvailableCommand[];
  /** Agent modes (legacy API; hidden when `config` has a mode option). */
  modes: SessionModeState | null;
  /** Every setting the agent exposes: model, effort, mode, … */
  config: ConfigOption[];
  permission: PendingPermission | null;
  /** A question form the agent is waiting on. */
  elicitation: PendingElicitation | null;
  /** Prompts typed while a turn was running; sent in order once it ends. */
  queued: { id: string; text: string }[];
  /** MCP servers handed to the agent with every new session. */
  mcpServers: McpServer[];
  /** Saved-chat scope: "pane", or the session key for app-wide agents. */
  scope: string;
  /** Saved chat this conversation is stored as (once it has a prompt). */
  chatId: string | null;
  /** Agent supports `session/load`, so past chats can be resumed. */
  canLoad: boolean;
  /** A `session/load` is replaying history we already show; ignore it. */
  replaying: boolean;
  processId: string | null;
  sessionId: string | null;
  conn: AcpConnection | null;
  unlisten: UnlistenFn[];
  /** Agent installer run (separate process from the agent itself). */
  install: InstallRun | null;
  version: number;
  subscribers: Set<() => void>;
}

export interface InstallRun {
  agentId: string;
  processId: string;
  running: boolean;
  /** Exit code once finished; null if killed / unknown. */
  exitCode: number | null;
  log: string[];
  unlisten: UnlistenFn[];
}

const MAX_STDERR = 300;
const INIT_TIMEOUT_MS = 180_000; // first `npx -y` run downloads the adapter

const sessions = new Map<string, AgentSession>();

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function notify(s: AgentSession) {
  s.version++;
  for (const fn of s.subscribers) fn();
}

/** The pane's session, or a fresh one if it's new or the device changed. */
export function getAgentSession(key: string, deviceId: string): AgentSession {
  let s = sessions.get(key);
  if (s && s.deviceId !== deviceId) {
    // The agent lives on the old device — stop it rather than leave it
    // running out of sight.
    destroyAgentSession(key);
    s = undefined;
  }
  if (!s) {
    s = {
      deviceId,
      agent: null,
      cwd: "",
      status: "idle",
      items: [],
      stderr: [],
      authMethods: [],
      account: null,
      canLogout: false,
      commands: [],
      modes: null,
      config: [],
      permission: null,
      elicitation: null,
      queued: [],
      mcpServers: [],
      scope: key.startsWith("__") ? key : "pane",
      chatId: null,
      canLoad: false,
      replaying: false,
      processId: null,
      sessionId: null,
      conn: null,
      unlisten: [],
      install: null,
      version: 0,
      subscribers: new Set(),
    };
    sessions.set(key, s);
    watchPanes();
  }
  return s;
}

/**
 * Append an item to the transcript (e.g. a widget the agent showed). Items
 * matching `replaces` are removed first, so the new one takes their place.
 */
export function addItem(
  s: AgentSession,
  item: TranscriptItem,
  replaces?: (it: TranscriptItem) => boolean,
) {
  const kept = replaces ? s.items.filter((it) => !replaces(it)) : s.items;
  s.items = [...kept, item];
  notify(s);
}

export function subscribeAgentSession(s: AgentSession, fn: () => void) {
  s.subscribers.add(fn);
  return () => {
    s.subscribers.delete(fn);
  };
}

// ─── Transcript ───────────────────────────────────────────────────────────────

function system(s: AgentSession, text: string, error = false) {
  s.items = [...s.items, { kind: "system", id: uid(), text, error }];
  notify(s);
}

/** Streamed chunks extend the previous item of the same kind. */
function appendChunk(
  s: AgentSession,
  kind: "agent" | "thought" | "user",
  text: string,
) {
  const last = s.items[s.items.length - 1];
  if (last && last.kind === kind) {
    s.items = [...s.items.slice(0, -1), { ...last, text: last.text + text }];
  } else {
    s.items = [...s.items, { kind, id: uid(), text }];
  }
}

function applyUpdate(s: AgentSession, u: SessionUpdate) {
  if (s.replaying) return;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const kind =
        u.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
      appendChunk(
        s,
        kind,
        contentText((u as { content?: ContentBlock }).content),
      );
      break;
    }
    case "tool_call":
    case "tool_call_update": {
      const { sessionUpdate: _, ...call } = u as {
        sessionUpdate: string;
      } & ToolCall;
      const idx = s.items.findIndex(
        (i) => i.kind === "tool" && i.id === call.toolCallId,
      );
      if (idx === -1) {
        s.items = [...s.items, { kind: "tool", id: call.toolCallId, call }];
      } else {
        const prev = s.items[idx] as Extract<TranscriptItem, { kind: "tool" }>;
        const merged = { ...prev.call, ...stripUndefined(call) };
        s.items = s.items.map((it, i) =>
          i === idx ? { ...prev, call: merged } : it,
        );
      }
      break;
    }
    case "plan": {
      // A plan update replaces the whole plan; keep one plan item.
      const entries = (u as { entries: PlanEntry[] }).entries ?? [];
      const others = s.items.filter((i) => i.kind !== "plan");
      s.items = [...others, { kind: "plan", id: "plan", entries }];
      break;
    }
    case "available_commands_update":
      s.commands =
        (u as { availableCommands?: AvailableCommand[] }).availableCommands ??
        [];
      break;
    case "config_option_update":
      s.config =
        (u as { configOptions?: ConfigOption[] }).configOptions ?? s.config;
      break;
    case "current_mode_update":
      if (s.modes) {
        s.modes = {
          ...s.modes,
          currentModeId: String(
            (u as { currentModeId?: unknown }).currentModeId,
          ),
        };
      }
      break;
    default:
      return; // user_message_chunk (history replay) etc. — not shown
  }
  notify(s);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export interface StartOptions {
  /** MCP servers for the agent, chosen once its capabilities are known. */
  mcpServers?: (init: InitializeResult) => McpServer[] | Promise<McpServer[]>;
}

export async function startAgent(
  s: AgentSession,
  agent: AgentDef,
  cwd: string,
  opts: StartOptions = {},
) {
  await stopAgent(s);
  s.agent = agent;
  s.cwd = cwd;
  s.items = [];
  s.queued = [];
  s.stderr = [];
  s.authMethods = [];
  s.account = null;
  s.canLogout = false;
  s.commands = [];
  s.modes = null;
  s.config = [];
  s.mcpServers = [];
  s.chatId = null;
  s.canLoad = false;
  s.status = "starting";
  const processId = uid();
  s.processId = processId;
  system(s, `Launching ${agent.name} in ${cwd}…`);

  const conn = new AcpConnection((line) => api.agentSend(processId, line), {
    onSessionUpdate: (sessionId, update) => {
      if (sessionId === s.sessionId) applyUpdate(s, update);
    },
    onAuthStatus: (status) => {
      s.account = status;
      notify(s);
    },
    requestPermission: (req) =>
      new Promise<PermissionOutcome>((resolve) => {
        s.permission?.resolve({ outcome: "cancelled" });
        s.permission = { req, resolve };
        notify(s);
      }),
    elicit: (req) =>
      new Promise<ElicitationResponse>((resolve) => {
        s.elicitation?.resolve({ action: "cancel" });
        s.elicitation = { req, resolve };
        notify(s);
      }),
    readTextFile: (path) => {
      if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) {
        throw new AcpError(`path must be absolute: ${path}`, -32602);
      }
      return invoke<string>("sftp_read_file", { deviceId: s.deviceId, path });
    },
    writeTextFile: async (path, content) => {
      // Agents may read anywhere they could anyway, but only write inside
      // the project folder the user launched them in.
      if (!isInside(s.cwd, path)) {
        throw new AcpError(`write outside ${s.cwd} refused: ${path}`, -32602);
      }
      await invoke("sftp_write_file", { deviceId: s.deviceId, path, content });
    },
  });
  s.conn = conn;

  // Subscribe before spawning so no early output / exit is missed.
  const isCurrent = () => s.processId === processId;
  s.unlisten = await Promise.all([
    listen<string>(`agent:${processId}:out`, (e) => {
      if (isCurrent()) conn.feed(e.payload);
    }),
    listen<string>(`agent:${processId}:err`, (e) => {
      if (!isCurrent()) return;
      const next = [...s.stderr, e.payload];
      s.stderr = next.length > MAX_STDERR ? next.slice(-MAX_STDERR) : next;
      notify(s);
    }),
    listen<number | null>(`agent:${processId}:exit`, (e) => {
      if (!isCurrent()) return;
      conn.close();
      s.status = "exited";
      s.queued = [];
      s.permission?.resolve({ outcome: "cancelled" });
      s.permission = null;
      s.elicitation?.resolve({ action: "cancel" });
      s.elicitation = null;
      const tail = s.stderr.slice(-3).join("\n");
      system(
        s,
        `Agent exited${e.payload != null ? ` (code ${e.payload})` : ""}.` +
          (e.payload ? (tail ? `\n${tail}` : "") : ""),
        !!e.payload,
      );
    }),
  ]);

  try {
    await api.agentSpawn(
      s.deviceId,
      processId,
      agent.command,
      agent.args,
      cwd,
      agent.env,
    );
    const init = await withTimeout(conn.initialize(), INIT_TIMEOUT_MS);
    s.authMethods = init.authMethods ?? [];
    s.canLogout = !!init.agentCapabilities?.auth?.logout;
    s.canLoad = !!init.agentCapabilities?.loadSession;
    if (opts.mcpServers) s.mcpServers = await opts.mcpServers(init);
    await openSession(s);
  } catch (e) {
    // The exit listener may have already reported the failure.
    if (!isCurrent() || statusOf(s) === "exited") return;
    system(s, `Failed to start: ${describe(e)}`, true);
    await stopAgent(s, "exited");
  }
}

async function openSession(s: AgentSession, quiet = false) {
  if (!s.conn) return;
  try {
    const { sessionId, modes, configOptions } = await s.conn.newSession(
      s.cwd,
      s.mcpServers,
    );
    s.sessionId = sessionId;
    s.modes = modes?.availableModes?.length ? modes : null;
    s.config = configOptions ?? [];
    s.status = "ready";
    if (quiet) notify(s);
    else system(s, `${s.agent?.name ?? "Agent"} ready.`);
  } catch (e) {
    if (
      e instanceof AcpError &&
      e.code === AUTH_REQUIRED &&
      s.authMethods.length
    ) {
      // Sign in silently with a key saved from an earlier session.
      if (await trySavedKey(s)) return;
      s.status = "auth";
      system(s, "The agent needs you to sign in.");
      return;
    }
    throw e;
  }
}

/** Sign out of the agent's account; the auth bar then offers sign-in. */
export async function logout(s: AgentSession) {
  if (!s.conn || !s.canLogout) return;
  if (s.status === "prompting") cancelTurn(s);
  try {
    await s.conn.logout();
    // A logged-out session can't prompt; sign in again to get a new one.
    s.sessionId = null;
    s.modes = null;
    s.config = [];
    s.commands = [];
    s.status = "auth";
    system(s, "Signed out. Sign in to continue.");
  } catch (e) {
    system(s, `Sign-out failed: ${describe(e)}`, true);
  }
}

function shellQuote(a: string) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

/** `cd <cwd> && <parts…>`, quoted for a POSIX shell. */
function shellLine(s: AgentSession, parts: string[]) {
  const cd = s.cwd ? `cd ${shellQuote(s.cwd)} && ` : "";
  return cd + parts.map(shellQuote).join(" ");
}

/** Shell command a "terminal" auth method wants the user to run. */
export function terminalLoginCommand(s: AgentSession, m: AuthMethod) {
  if (!s.agent) return null;
  return shellLine(s, [s.agent.command, ...s.agent.args, ...(m.args ?? [])]);
}

/**
 * Command that opens the agent's own terminal UI on (a copy of) this
 * conversation, optionally starting with `prompt` — e.g. a slash command
 * only the terminal UI supports. Null if the agent doesn't define one.
 */
export function agentTerminalCommand(s: AgentSession, prompt?: string) {
  const t = s.agent?.terminal;
  if (!s.agent || !t) return null;
  // Only resume once the agent has a transcript to resume (a turn ran).
  const hasHistory = s.items.some((i) => i.kind === "user");
  const resume =
    hasHistory && s.sessionId && t.resumeArgs
      ? t.resumeArgs.map((a) => a.replace("{sessionId}", s.sessionId!))
      : [];
  return shellLine(s, [
    s.agent.command,
    ...t.args,
    ...resume,
    ...(prompt ? [prompt] : []),
  ]);
}

/** After a terminal sign-in finished: open the session the user was missing. */
export async function retryAfterLogin(s: AgentSession) {
  if (!s.conn) return;
  s.status = "starting";
  notify(s);
  try {
    await openSession(s);
  } catch (e) {
    s.status = "auth";
    system(s, `Still not signed in: ${describe(e)}`, true);
  }
}

/** Keychain id for an agent's API key for one auth method. */
function keyId(s: AgentSession, methodId: string) {
  return `${s.agent?.id ?? "agent"}:${methodId}`;
}

async function trySavedKey(s: AgentSession): Promise<boolean> {
  if (!s.conn) return false;
  for (const m of s.authMethods.filter(wantsApiKey)) {
    const key = await api.agentSecretGet(keyId(s, m.id)).catch(() => null);
    if (!key) continue;
    try {
      await s.conn.authenticate(m.id, key);
      const { sessionId, modes, configOptions } = await s.conn.newSession(
        s.cwd,
        s.mcpServers,
      );
      s.sessionId = sessionId;
      s.modes = modes?.availableModes?.length ? modes : null;
      s.config = configOptions ?? [];
      s.status = "ready";
      system(s, `${s.agent?.name ?? "Agent"} ready (${m.name}).`);
      return true;
    } catch {
      // Saved key no longer works — fall through to asking the user.
    }
  }
  return false;
}

/**
 * Sign in with `methodId`. For API-key methods pass the key; it's saved in
 * the system keychain and reused on later launches.
 */
export async function authenticate(
  s: AgentSession,
  methodId: string,
  apiKey?: string,
) {
  if (!s.conn) return;
  s.status = "starting";
  notify(s);
  try {
    await s.conn.authenticate(methodId, apiKey);
    if (apiKey) {
      await api.agentSecretSet(keyId(s, methodId), apiKey).catch(() => {});
    }
    await openSession(s);
  } catch (e) {
    s.status = "auth";
    system(s, `Sign-in failed: ${describe(e)}`, true);
  }
}

export async function sendPrompt(s: AgentSession, text: string) {
  if (!s.conn || !s.sessionId || s.status !== "ready") return;
  s.items = [...s.items, { kind: "user", id: uid(), text }];
  s.status = "prompting";
  notify(s);
  try {
    const { stopReason } = await s.conn.prompt(s.sessionId, text);
    if (stopReason !== "end_turn") system(s, `Turn ended: ${stopReason}`);
  } catch (e) {
    if (statusOf(s) !== "exited")
      system(s, `Prompt failed: ${describe(e)}`, true);
  } finally {
    if (s.status === "prompting") s.status = "ready";
    saveChat(s);
    notify(s);
  }
  // Next queued prompt, if the agent is still there to take it.
  const next = s.status === "ready" ? s.queued[0] : undefined;
  if (next) {
    s.queued = s.queued.slice(1);
    void sendPrompt(s, next.text);
  }
}

/** Send now if the agent is idle, else queue it behind the running turn. */
export function queuePrompt(s: AgentSession, text: string) {
  if (s.status === "ready") return void sendPrompt(s, text);
  if (s.status !== "prompting") return;
  s.queued = [...s.queued, { id: uid(), text }];
  notify(s);
}

export function unqueuePrompt(s: AgentSession, id: string) {
  s.queued = s.queued.filter((q) => q.id !== id);
  notify(s);
}

// ─── Saved chats ──────────────────────────────────────────────────────────────

/** Store the conversation in the chat history (once it has a prompt). */
export function saveChat(s: AgentSession) {
  if (!s.agent || !s.items.some((i) => i.kind === "user")) return;
  const now = Date.now();
  const prev = s.chatId
    ? useChatsStore.getState().chats.find((c) => c.id === s.chatId)
    : undefined;
  s.chatId ??= uid();
  useChatsStore.getState().upsert({
    id: s.chatId,
    scope: s.scope,
    agentId: s.agent.id,
    deviceId: s.deviceId,
    cwd: s.cwd,
    sessionId: s.sessionId,
    title: prev?.title ?? chatTitle(s.items),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    items: compactItems(s.items),
  });
}

/**
 * Switch to a saved chat. The agent must be running (same agent). Resumes
 * the agent's own session when it supports `session/load`; otherwise shows
 * the old transcript and continues in a fresh session.
 */
export async function openChat(s: AgentSession, chat: ChatRecord) {
  if (!s.conn || s.status === "prompting" || s.chatId === chat.id) return;
  saveChat(s);
  s.items = chat.items;
  s.chatId = chat.id;
  s.cwd = chat.cwd;
  s.sessionId = null;
  s.status = "starting";
  notify(s);
  if (s.canLoad && chat.sessionId) {
    s.replaying = true;
    try {
      const r = await s.conn.loadSession(
        chat.sessionId,
        chat.cwd,
        s.mcpServers,
      );
      s.sessionId = chat.sessionId;
      if (r?.modes?.availableModes?.length) s.modes = r.modes;
      if (r?.configOptions) s.config = r.configOptions;
      s.status = "ready";
      system(s, "Resumed this chat.");
      return;
    } catch (e) {
      system(s, `Couldn't resume this chat: ${describe(e)}`, true);
    } finally {
      s.replaying = false;
    }
  }
  try {
    await openSession(s, true);
    system(
      s,
      "This agent can't resume past chats, so it doesn't remember the messages above. New messages start a fresh conversation.",
    );
  } catch (e) {
    s.status = "ready";
    system(s, `Couldn't open a session: ${describe(e)}`, true);
  }
}

/** Drop the transcript and start a fresh session on the same agent. */
export async function newConversation(s: AgentSession) {
  if (!s.conn || s.status === "prompting") return;
  saveChat(s);
  s.chatId = null;
  s.items = [];
  s.sessionId = null;
  s.status = "starting";
  notify(s);
  try {
    await openSession(s);
  } catch (e) {
    s.status = "ready";
    system(s, `Couldn't start a new conversation: ${describe(e)}`, true);
  }
}

/** Show the sign-in choices (e.g. to switch account). */
export function showSignIn(s: AgentSession) {
  if (!s.conn || s.authMethods.length === 0) {
    system(s, "This agent doesn't offer sign-in methods.", true);
    return;
  }
  s.status = "auth";
  notify(s);
}

/** Note in the transcript (used by DevNest's own slash commands). */
export function note(s: AgentSession, text: string, error = false) {
  system(s, text, error);
}

/** Change one agent setting; the agent answers with the full new list. */
export async function setConfig(
  s: AgentSession,
  configId: string,
  value: string | boolean,
) {
  if (!s.conn || !s.sessionId) return;
  const prev = s.config;
  // Optimistic, so the picker doesn't snap back while the agent applies it.
  s.config = s.config.map((o) =>
    o.id === configId ? ({ ...o, currentValue: value } as ConfigOption) : o,
  );
  notify(s);
  try {
    const { configOptions } = await s.conn.setConfigOption(
      s.sessionId,
      configId,
      value,
    );
    if (Array.isArray(configOptions)) s.config = configOptions;
  } catch (e) {
    s.config = prev;
    system(s, `Couldn't change setting: ${describe(e)}`, true);
  }
  notify(s);
}

export async function setMode(s: AgentSession, modeId: string) {
  if (!s.conn || !s.sessionId || !s.modes) return;
  const prev = s.modes.currentModeId;
  s.modes = { ...s.modes, currentModeId: modeId };
  notify(s);
  try {
    await s.conn.setMode(s.sessionId, modeId);
  } catch (e) {
    if (s.modes) s.modes = { ...s.modes, currentModeId: prev };
    system(s, `Couldn't switch mode: ${describe(e)}`, true);
  }
}

export function cancelTurn(s: AgentSession) {
  if (!s.conn || !s.sessionId || s.status !== "prompting") return;
  s.permission?.resolve({ outcome: "cancelled" });
  s.permission = null;
  s.elicitation?.resolve({ action: "cancel" });
  s.elicitation = null;
  void s.conn.cancel(s.sessionId);
  notify(s);
}

export function answerElicitation(
  s: AgentSession,
  response: ElicitationResponse,
) {
  s.elicitation?.resolve(response);
  s.elicitation = null;
  notify(s);
}

export function answerPermission(s: AgentSession, outcome: PermissionOutcome) {
  s.permission?.resolve(outcome);
  s.permission = null;
  notify(s);
}

export async function stopAgent(s: AgentSession, status: AgentStatus = "idle") {
  saveChat(s);
  const pid = s.processId;
  s.processId = null;
  for (const fn of s.unlisten) fn();
  s.unlisten = [];
  s.conn?.close("stopped");
  s.conn = null;
  s.sessionId = null;
  s.permission?.resolve({ outcome: "cancelled" });
  s.permission = null;
  s.elicitation?.resolve({ action: "cancel" });
  s.elicitation = null;
  if (s.status !== "idle") s.status = status;
  notify(s);
  if (pid) await api.agentKill(pid).catch(() => {});
}

function destroyAgentSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  void stopAgent(s);
  void stopInstall(s);
}

// ─── Installing agents ────────────────────────────────────────────────────────

const MAX_INSTALL_LOG = 500;

/** Whether `agent.command` resolves in a login shell on the session's device. */
export function isAgentInstalled(s: AgentSession, agent: AgentDef) {
  return api.agentCommandExists(s.deviceId, agent.command);
}

/**
 * Run the agent's install command on the session's device, streaming output
 * into `s.install.log`. Resolves true if it exited 0.
 */
export async function installAgent(
  s: AgentSession,
  agent: AgentDef,
): Promise<boolean> {
  if (!agent.install) return false;
  await stopInstall(s);
  const processId = uid();
  const run: InstallRun = {
    agentId: agent.id,
    processId,
    running: true,
    exitCode: null,
    log: [`$ ${agent.install}`],
    unlisten: [],
  };
  s.install = run;
  notify(s);

  const push = (line: string) => {
    const next = [...run.log, line];
    run.log =
      next.length > MAX_INSTALL_LOG ? next.slice(-MAX_INSTALL_LOG) : next;
    notify(s);
  };

  return new Promise<boolean>((resolve) => {
    const finish = (code: number | null) => {
      run.running = false;
      run.exitCode = code;
      for (const fn of run.unlisten) fn();
      run.unlisten = [];
      push(
        code === 0 ? "✓ Installed." : `✕ Install failed (exit ${code ?? "?"}).`,
      );
      resolve(code === 0);
    };
    void (async () => {
      run.unlisten = await Promise.all([
        listen<string>(`agent:${processId}:out`, (e) => push(e.payload)),
        listen<string>(`agent:${processId}:err`, (e) => push(e.payload)),
        listen<number | null>(`agent:${processId}:exit`, (e) =>
          finish(e.payload),
        ),
      ]);
      try {
        // Same transport as agents: login shell (so PATH/nvm apply), home dir.
        await api.agentSpawn(
          s.deviceId,
          processId,
          "sh",
          ["-c", agent.install!],
          "",
        );
      } catch (e) {
        push(`[error] ${describe(e)}`);
        finish(null);
      }
    })();
  });
}

export async function stopInstall(s: AgentSession) {
  const run = s.install;
  if (!run?.running) return;
  await api.agentKill(run.processId).catch(() => {});
}

// Kill agents whose pane no longer exists anywhere (closed, workspace
// removed, …) by watching the pane tree instead of hooking each close path.
let watching = false;
function watchPanes() {
  if (watching) return;
  watching = true;
  useAppStore.subscribe((state) => {
    if (sessions.size === 0) return;
    const live = new Set<string>();
    for (const w of state.workspaces) {
      if (w.paneRoot) for (const p of collectPanes(w.paneRoot)) live.add(p.id);
      for (const p of w.floatingPanes) live.add(p.id);
    }
    for (const key of [...sessions.keys()]) {
      // "__"-prefixed sessions (the Master agent) aren't tied to a pane.
      if (!key.startsWith("__") && !live.has(key)) destroyAgentSession(key);
    }
  });
}

/** Read status without TS narrowing — event handlers change it under us. */
function statusOf(s: AgentSession): AgentStatus {
  return s.status;
}

function describe(e: unknown) {
  return e instanceof Error ? e.message : errorMessage(e);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`no response from agent after ${ms / 1000}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
