import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { homeDir } from "@tauri-apps/api/path";
import {
  MoreHorizontal,
  Play,
  ScrollText,
  ShieldAlert,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import {
  installAgent,
  isAgentInstalled,
  newConversation,
  openChat,
  sendPrompt,
  stopAgent,
  stopInstall,
  subscribeAgentSession,
  agentTerminalCommand,
  type AgentSession,
} from "../lib/agent-sessions";
import {
  answerApproval,
  canAlwaysAllow,
  getMasterSession,
  MASTER_KEY,
  startMaster,
  useMasterStore,
  type Approval,
} from "../lib/master";
import { useAgentsStore } from "../store/agents-store";
import { useAppStore } from "../store/app-store";
import { toast } from "./Toast";
import { Splitter } from "./Splitter";
import { ChatList } from "../panels/agent/ChatHistory";
import { chatsFor, useChatsStore, type ChatRecord } from "../lib/agent-chats";
import {
  AuthBar,
  Composer,
  InstallBanner,
  PermissionCard,
  permissionButtonClass,
  StatusDot,
  Transcript,
} from "../panels/AgentPanel";

const MIN_WIDTH = 300;
const AGENT_KEY = "devnest.master.agent";

const SUGGESTIONS = [
  "How is my machine doing right now?",
  "Show me Tailscale",
  "What's listening on port 3000?",
  "What's using the most memory?",
];

/**
 * Right-hand Master agent panel (like VS Code's secondary side bar). One
 * agent for the whole app, running on the host device rather than in a
 * project folder.
 */
export function MasterPanel() {
  const open = useMasterStore((s) => s.open);
  const width = useMasterStore((s) => s.width);
  const setWidth = useMasterStore((s) => s.setWidth);
  const host = useAppStore((s) => s.devices.find((d) => d.isLocalhost));
  const rowRef = useRef<HTMLElement | null>(null);

  // The splitter measures against the row this panel sits in.
  const self = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rowRef.current = self.current?.parentElement ?? null;
  });

  if (!open || !host) return null;

  return (
    <>
      <Splitter
        axis="x"
        containerRef={rowRef}
        onChange={(offset, total) => {
          const max = Math.max(MIN_WIDTH, total - 360);
          setWidth(
            Math.round(Math.min(max, Math.max(MIN_WIDTH, total - offset))),
          );
        }}
        onReset={() => setWidth(400)}
      />
      <div
        ref={self}
        style={{ width }}
        className="flex shrink-0 flex-col border-l border-(--color-border) bg-(--color-surface)"
      >
        <MasterBody hostId={host.id} />
      </div>
    </>
  );
}

function MasterBody({ hostId }: { hostId: string }) {
  const s = getMasterSession(hostId);
  useSyncExternalStore(
    (fn) => subscribeAgentSession(s, fn),
    () => s.version,
  );
  const setOpen = useMasterStore((st) => st.setOpen);
  const approvals = useMasterStore((st) => st.approvals);
  const agents = useAgentsStore((st) => st.agents);
  const openPane = useAppStore((st) => st.openPane);

  const [agentId, setAgentId] = useState(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(AGENT_KEY);
    } catch {
      // ignore
    }
    return s.agent?.id ?? saved ?? agents[0]?.id ?? "";
  });
  const [showLogs, setShowLogs] = useState(false);
  const agent = agents.find((a) => a.id === agentId);
  const running = s.status !== "idle" && s.status !== "exited";

  const [installed, setInstalled] = useState<boolean | null>(null);
  const installDone = s.install && !s.install.running ? s.install.exitCode : -1;
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setInstalled(null);
    isAgentInstalled(s, agent)
      .then((ok) => !cancelled && setInstalled(ok))
      .catch(() => !cancelled && setInstalled(null));
    return () => {
      cancelled = true;
    };
  }, [s, agent?.command, installDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (!agent) return toast.error("Pick an agent first.");
    try {
      localStorage.setItem(AGENT_KEY, agent.id);
    } catch {
      // ignore
    }
    try {
      await startMaster(s, agent, await homeDir());
    } catch (e) {
      toast.error(`Couldn't start the Master agent: ${String(e)}`);
    }
  };

  const install = async () => {
    if (!agent) return;
    const ok = await installAgent(s, agent);
    if (ok) toast.success(`${agent.name} installed`);
    else toast.error(`Installing ${agent.name} failed — see the log.`);
  };

  const openTerminal = (prompt?: string) => {
    const cmd = agentTerminalCommand(s, prompt);
    if (!cmd) return;
    const id = Math.random().toString(36).slice(2, 10);
    openPane({
      id,
      deviceId: hostId,
      panel: "terminal",
      instanceId: id,
      extra: { initialCommand: cmd },
    });
  };
  /** Open a saved Master chat, starting its agent if needed. */
  const resume = async (c: ChatRecord) => {
    if (!running || s.agent?.id !== c.agentId) {
      const a = agents.find((x) => x.id === c.agentId);
      if (!a) return toast.error("That chat's agent no longer exists.");
      setAgentId(a.id);
      try {
        await startMaster(s, a, c.cwd || (await homeDir()));
      } catch (e) {
        return toast.error(`Couldn't start the Master agent: ${String(e)}`);
      }
    }
    if (getMasterSession(hostId).status === "ready") await openChat(s, c);
    else toast.error("Start the agent first, then open the chat.");
  };

  const canTerminal = running && !!s.agent?.terminal;
  const installRun = s.install?.agentId === agent?.id ? s.install : null;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      {agent && !running && (installed === false || installRun) && (
        <InstallBanner
          agent={agent}
          deviceName="this computer"
          missing={installed === false}
          run={installRun}
          onInstall={() => void install()}
          onCancel={() => void stopInstall(s)}
        />
      )}

      {showLogs && (
        <pre className="max-h-40 shrink-0 overflow-auto border-b border-(--color-border) bg-(--color-bg) px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-fg-muted)">
          {s.stderr.length ? s.stderr.join("\n") : "No output on stderr."}
        </pre>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <MasterMenu
          s={s}
          agentId={agentId}
          onAgent={setAgentId}
          running={running}
          showLogs={showLogs}
          onLogs={() => setShowLogs((v) => !v)}
          onStart={() => void start()}
          onResume={(c) => void resume(c)}
          onClose={() => setOpen(false)}
        />
        <Transcript
          s={s}
          empty={<EmptyState s={s} onStart={() => void start()} />}
          waitingOn={approvals.length ? "Waiting for your approval" : null}
        />
      </div>

      {s.status === "auth" && <AuthBar s={s} paneId="" deviceId={hostId} />}

      {approvals.map((a) => (
        <ApprovalCard key={a.id} a={a} />
      ))}

      {s.permission && <PermissionCard s={s} />}

      <Composer s={s} onTerminal={canTerminal ? openTerminal : undefined} />
    </div>
  );
}

/** The panel's controls, tucked behind a ⋯ button in the top-right corner. */
function MasterMenu({
  s,
  agentId,
  onAgent,
  running,
  showLogs,
  onLogs,
  onStart,
  onResume,
  onClose,
}: {
  s: AgentSession;
  agentId: string;
  onAgent: (id: string) => void;
  running: boolean;
  showLogs: boolean;
  onLogs: () => void;
  onStart: () => void;
  onResume: (c: ChatRecord) => void;
  onClose: () => void;
}) {
  const agents = useAgentsStore((st) => st.agents);
  const allChats = useChatsStore((st) => st.chats);
  const removeChat = useChatsStore((st) => st.remove);
  const chats = chatsFor(allChats, MASTER_KEY, agentId, s.deviceId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const act = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const canNew = s.status === "ready" && s.items.some((i) => i.kind === "user");
  const busy = s.status === "prompting" || s.status === "starting";

  return (
    <div ref={ref} className="absolute top-1.5 right-2 z-20">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Master agent"
        className={`relative flex h-6 w-6 items-center justify-center rounded-md bg-(--color-surface) text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) ${open ? "bg-(--color-surface-2) text-(--color-fg)" : ""}`}
      >
        <MoreHorizontal size={14} />
        <span className="absolute top-0.5 right-0.5">
          <StatusDot status={s.status} />
        </span>
      </button>
      {open && (
        <div className="modal-content absolute top-full right-0 mt-1 w-64 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) py-1 shadow-xl">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <StatusDot status={s.status} />
            <span className="font-medium">Master</span>
            <span className="ml-auto text-[11px] text-(--color-fg-muted)">
              {s.status}
            </span>
          </div>
          <label className="flex items-center gap-2 px-3 py-1">
            <span className="w-12 shrink-0 text-(--color-fg-muted)">Agent</span>
            <select
              value={agentId}
              onChange={(e) => onAgent(e.target.value)}
              disabled={running}
              className="min-w-0 flex-1 rounded bg-(--color-surface-2) px-1.5 py-0.5 outline-none disabled:opacity-60"
              title={running ? "Stop the agent to switch" : undefined}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <div className="my-1 h-px bg-(--color-border)" />
          <div className="px-3 pt-0.5 pb-1 text-[11px] font-semibold tracking-wide text-(--color-fg-muted) uppercase">
            Chats
          </div>
          <ChatList
            chats={chats}
            currentId={s.chatId}
            onNew={canNew ? act(() => void newConversation(s)) : undefined}
            onOpen={(c) => {
              if (busy) return;
              setOpen(false);
              onResume(c);
            }}
            onDelete={(c) => removeChat(c.id)}
          />
          <div className="my-1 h-px bg-(--color-border)" />
          {running ? (
            <MenuItem
              icon={<Square size={11} />}
              onClick={act(() => void stopAgent(s))}
            >
              Stop agent
            </MenuItem>
          ) : (
            <MenuItem icon={<Play size={12} />} onClick={act(onStart)}>
              Start agent
            </MenuItem>
          )}
          {s.stderr.length > 0 && (
            <MenuItem icon={<ScrollText size={12} />} onClick={act(onLogs)}>
              {showLogs ? "Hide logs" : "Show logs"}
              <span className="ml-auto text-(--color-fg-muted)">
                {s.stderr.length}
              </span>
            </MenuItem>
          )}
          <div className="my-1 h-px bg-(--color-border)" />
          <MenuItem icon={<X size={12} />} onClick={act(onClose)}>
            Close panel
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-(--color-surface-2)"
    >
      <span className="flex w-4 shrink-0 justify-center text-(--color-fg-muted)">
        {icon}
      </span>
      {children}
    </button>
  );
}

function EmptyState({ s, onStart }: { s: AgentSession; onStart: () => void }) {
  const ready = s.status === "ready";
  return (
    <div className="flex max-w-[300px] flex-col items-center gap-2">
      <Sparkles size={20} className="text-(--color-accent)" />
      <span className="text-(--color-fg)">
        Ask about or do things on this computer.
      </span>
      <span>
        Anything that changes your machine waits for your approval here.
      </span>
      {ready ? (
        <div className="mt-1 flex flex-col gap-1">
          {SUGGESTIONS.map((t) => (
            <button
              key={t}
              className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 text-left hover:bg-(--color-surface-2) hover:text-(--color-fg)"
              onClick={() => void sendPrompt(s, t)}
            >
              {t}
            </button>
          ))}
        </div>
      ) : (
        s.status !== "starting" && (
          <button
            className="mt-1 inline-flex items-center gap-1 rounded-md bg-(--color-accent) px-3 py-1 font-medium text-(--color-accent-fg) hover:opacity-90"
            onClick={onStart}
          >
            <Play size={11} /> Start
          </button>
        )
      )}
    </div>
  );
}

function ApprovalCard({ a }: { a: Approval }) {
  return (
    <div className="shrink-0 border-t border-(--color-border) px-3 py-2">
      <div className="mx-auto max-w-3xl rounded-xl border border-(--color-warn)/40 bg-(--color-warn)/10 p-2.5">
        <div className="mb-1.5 flex items-start gap-1.5">
          <ShieldAlert
            size={14}
            className="mt-px shrink-0 text-(--color-warn)"
          />
          <div className="min-w-0">
            <div className="font-semibold">{a.title}</div>
            <div className="text-[11px] text-(--color-fg-muted)">
              on <b className="text-(--color-fg)">{a.device}</b> ·{" "}
              <span className="font-mono">{a.tool}</span>
            </div>
          </div>
        </div>
        <pre className="max-h-32 overflow-auto rounded-lg bg-(--color-bg) px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
          {a.detail}
        </pre>
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          <button
            className={permissionButtonClass("reject_once")}
            onClick={() => answerApproval(a, false)}
          >
            Deny
          </button>
          {canAlwaysAllow(a.tool) && (
            <button
              className={permissionButtonClass("allow_always")}
              onClick={() => answerApproval(a, true, true)}
              title="Until the agent is restarted"
            >
              Always allow {a.tool}
            </button>
          )}
          <button
            autoFocus
            className={permissionButtonClass("allow_once")}
            onClick={() => answerApproval(a, true)}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
