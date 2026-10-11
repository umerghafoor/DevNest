/**
 * Minimal Agent Client Protocol (ACP) client — https://agentclientprotocol.com
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio. We are the *client*: we
 * launch the agent, open sessions and send prompts; the agent streams
 * `session/update` notifications back and may call us for file access and
 * permission to run tools.
 *
 * This file knows nothing about Tauri. The transport (`send` + `feed`) is
 * injected so the protocol logic can be unit-tested with a fake agent.
 */

export const ACP_PROTOCOL_VERSION = 1;

// ─── Protocol types (the subset we use) ───────────────────────────────────────

export interface ContentText {
  type: "text";
  text: string;
}
/** Agents may also send images/resources; we only render text. */
export type ContentBlock = ContentText | { type: string; [k: string]: unknown };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallContent {
  type: "content" | "diff" | "terminal" | string;
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
}

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
}

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & ToolCall)
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: string; [k: string]: unknown };

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** A slash command the agent advertises; sent as prompt text `/name args`. */
export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

/** An agent operating mode (e.g. Claude Code's Manual / Accept edits / Plan). */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

// ── Elicitation: the agent asks the user to fill a form (e.g. Claude Code's
// AskUserQuestion). Fields are a flat JSON Schema object. ──

export interface EnumOption {
  const: string;
  title?: string;
  description?: string;
}

export interface ElicitationField {
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  /** Single choice with labels. */
  oneOf?: EnumOption[];
  /** Single choice, bare values. */
  enum?: string[];
  /** Multi choice. */
  items?: { anyOf?: EnumOption[]; enum?: string[] };
  default?: unknown;
}

export interface ElicitationRequest {
  sessionId: string;
  mode: "form" | "url" | string;
  message: string;
  toolCallId?: string;
  requestedSchema?: {
    type: "object";
    properties: Record<string, ElicitationField>;
    required?: string[];
  };
  url?: string;
}

export type ElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  /** `{"api-key": {...}}` marks a method that takes a key the user types. */
  _meta?: Record<string, unknown> | null;
}

/** Does this auth method want an API key from the user? */
export function wantsApiKey(m: AuthMethod) {
  return !!m._meta && "api-key" in m._meta;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: AuthMethod[];
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/** Callbacks the client side of the protocol must implement. */
export interface AcpClientHandlers {
  onSessionUpdate(sessionId: string, update: SessionUpdate): void;
  requestPermission(req: PermissionRequest): Promise<PermissionOutcome>;
  elicit(req: ElicitationRequest): Promise<ElicitationResponse>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
}

export class AcpError extends Error {
  constructor(
    message: string,
    public code: number,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** JSON-RPC error codes. -32000 is what ACP agents use for "auth required". */
export const AUTH_REQUIRED = -32000;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

type Id = number | string;
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

// ─── Connection ───────────────────────────────────────────────────────────────

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private closed = false;

  constructor(
    private send: (line: string) => Promise<void>,
    private handlers: AcpClientHandlers,
  ) {}

  /** Feed one line of agent stdout. Non-JSON lines are ignored (some agents
   *  print banners before switching to protocol mode). */
  feed(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    const hasMethod = typeof msg.method === "string";
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasMethod && hasId) {
      void this.handleRequest(msg.id as Id, msg.method as string, msg.params);
    } else if (hasMethod) {
      this.handleNotification(msg.method as string, msg.params);
    } else if (hasId) {
      const p = this.pending.get(msg.id as Id);
      if (!p) return;
      this.pending.delete(msg.id as Id);
      if (msg.error) {
        const err = msg.error as {
          code: number;
          message: string;
          data?: unknown;
        };
        p.reject(new AcpError(err.message, err.code, err.data));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  /** The agent process went away — fail anything still waiting on it. */
  close(reason = "agent exited") {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new AcpError(reason, -1));
    this.pending.clear();
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new AcpError("agent exited", -1));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  // ── High-level calls ──

  initialize() {
    return this.request<InitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        // Lets agents ask structured questions (Claude Code's AskUserQuestion
        // is disabled unless the client says it can render forms).
        elicitation: { form: {} },
      },
    });
  }

  /** `apiKey` goes in `_meta["api-key"]`, as Gemini CLI expects. */
  authenticate(methodId: string, apiKey?: string) {
    return this.request<unknown>("authenticate", {
      methodId,
      ...(apiKey ? { _meta: { "api-key": apiKey } } : {}),
    });
  }

  newSession(cwd: string) {
    return this.request<{ sessionId: string; modes?: SessionModeState | null }>(
      "session/new",
      {
        cwd,
        mcpServers: [],
      },
    );
  }

  setMode(sessionId: string, modeId: string) {
    return this.request<unknown>("session/set_mode", { sessionId, modeId });
  }

  prompt(sessionId: string, text: string) {
    return this.request<{ stopReason: StopReason }>("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId: string) {
    return this.notify("session/cancel", { sessionId });
  }

  // ── Internals ──

  private write(msg: unknown) {
    return this.send(JSON.stringify(msg));
  }

  private handleNotification(method: string, params: unknown) {
    if (method === "session/update") {
      const p = params as { sessionId: string; update: SessionUpdate };
      if (p?.update) this.handlers.onSessionUpdate(p.sessionId, p.update);
    }
  }

  private async handleRequest(id: Id, method: string, params: unknown) {
    try {
      const result = await this.dispatch(method, params);
      await this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      const code = e instanceof AcpError ? e.code : INTERNAL_ERROR;
      const message = e instanceof Error ? e.message : String(e);
      await this.write({ jsonrpc: "2.0", id, error: { code, message } }).catch(
        () => {},
      );
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "session/request_permission": {
        const outcome = await this.handlers.requestPermission(
          p as unknown as PermissionRequest,
        );
        return { outcome };
      }
      case "elicitation/create": {
        const req = p as unknown as ElicitationRequest;
        // We only advertise form mode.
        if (req.mode !== "form") return { action: "decline" };
        return this.handlers.elicit(req);
      }
      case "fs/read_text_file": {
        const text = await this.handlers.readTextFile(String(p.path));
        return {
          content: sliceLines(
            text,
            p.line as number | undefined,
            p.limit as number | undefined,
          ),
        };
      }
      case "fs/write_text_file":
        await this.handlers.writeTextFile(String(p.path), String(p.content));
        return null;
      default:
        throw new AcpError(`method not supported: ${method}`, METHOD_NOT_FOUND);
    }
  }
}

/** ACP `line` is 1-based; `limit` is a line count. */
export function sliceLines(text: string, line?: number, limit?: number) {
  if (line == null && limit == null) return text;
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit != null ? start + limit : undefined;
  return lines.slice(start, end).join("\n");
}

/** True if `path` is `root` or inside it. Both must be absolute. */
export function isInside(root: string, path: string) {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const p = norm(path);
  if (p.split("/").includes("..")) return false;
  return p === r || p.startsWith(r + "/");
}

/** Text of a content block, or a placeholder for non-text blocks. */
export function contentText(c: ContentBlock | undefined): string {
  if (!c) return "";
  if (c.type === "text") return (c as ContentText).text;
  return `[${c.type}]`;
}
