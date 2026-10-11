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
  type AuthMethod,
  type PermissionOutcome,
  type PermissionRequest,
  type PlanEntry,
  type SessionUpdate,
  type ToolCall,
} from "./acp";
import type { AgentDef } from "../store/agents-store";
import { collectPanes, useAppStore } from "../store/app-store";

/** One entry in the conversation transcript. */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "plan"; id: string; entries: PlanEntry[] }
  | { kind: "system"; id: string; text: string; error?: boolean };

export type AgentStatus =
  | "idle" // nothing launched
  | "starting" // process up, handshaking
  | "auth" // agent wants the user to pick an auth method
  | "ready" // waiting for a prompt
  | "prompting" // turn in progress
  | "exited";

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
  permission: PendingPermission | null;
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
      permission: null,
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
    default:
      return; // user_message_chunk (replay), commands, modes — not shown
  }
  notify(s);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function startAgent(
  s: AgentSession,
  agent: AgentDef,
  cwd: string,
) {
  await stopAgent(s);
  s.agent = agent;
  s.cwd = cwd;
  s.items = [];
  s.stderr = [];
  s.authMethods = [];
  s.status = "starting";
  const processId = uid();
  s.processId = processId;
  system(s, `Launching ${agent.name} in ${cwd}…`);

  const conn = new AcpConnection((line) => api.agentSend(processId, line), {
    onSessionUpdate: (sessionId, update) => {
      if (sessionId === s.sessionId) applyUpdate(s, update);
    },
    requestPermission: (req) =>
      new Promise<PermissionOutcome>((resolve) => {
        s.permission?.resolve({ outcome: "cancelled" });
        s.permission = { req, resolve };
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
      s.permission?.resolve({ outcome: "cancelled" });
      s.permission = null;
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
    await openSession(s);
  } catch (e) {
    // The exit listener may have already reported the failure.
    if (!isCurrent() || statusOf(s) === "exited") return;
    system(s, `Failed to start: ${describe(e)}`, true);
    await stopAgent(s, "exited");
  }
}

async function openSession(s: AgentSession) {
  if (!s.conn) return;
  try {
    const { sessionId } = await s.conn.newSession(s.cwd);
    s.sessionId = sessionId;
    s.status = "ready";
    system(s, `${s.agent?.name ?? "Agent"} ready.`);
  } catch (e) {
    if (
      e instanceof AcpError &&
      e.code === AUTH_REQUIRED &&
      s.authMethods.length
    ) {
      s.status = "auth";
      system(s, "The agent needs you to sign in.");
      return;
    }
    throw e;
  }
}

export async function authenticate(s: AgentSession, methodId: string) {
  if (!s.conn) return;
  s.status = "starting";
  notify(s);
  try {
    await s.conn.authenticate(methodId);
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
    notify(s);
  }
}

export function cancelTurn(s: AgentSession) {
  if (!s.conn || !s.sessionId || s.status !== "prompting") return;
  s.permission?.resolve({ outcome: "cancelled" });
  s.permission = null;
  void s.conn.cancel(s.sessionId);
  notify(s);
}

export function answerPermission(s: AgentSession, outcome: PermissionOutcome) {
  s.permission?.resolve(outcome);
  s.permission = null;
  notify(s);
}

export async function stopAgent(s: AgentSession, status: AgentStatus = "idle") {
  const pid = s.processId;
  s.processId = null;
  for (const fn of s.unlisten) fn();
  s.unlisten = [];
  s.conn?.close("stopped");
  s.conn = null;
  s.sessionId = null;
  s.permission?.resolve({ outcome: "cancelled" });
  s.permission = null;
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
      if (!live.has(key)) destroyAgentSession(key);
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
