import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { homeDir } from "@tauri-apps/api/path";
import {
  Play,
  RotateCcw,
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
  startMaster,
  useMasterStore,
  type Approval,
} from "../lib/master";
import { useAgentsStore } from "../store/agents-store";
import { useAppStore } from "../store/app-store";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN } from "../lib/ui";
import { toast } from "./Toast";
import { Splitter } from "./Splitter";
import {
  AuthBar,
  Composer,
  InstallBanner,
  PermissionCard,
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
        className="flex shrink-0 flex-col border-l border-(--color-border) bg-(--color-bg)"
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
  const canTerminal = running && !!s.agent?.terminal;
  const installRun = s.install?.agentId === agent?.id ? s.install : null;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--color-surface) px-2 select-none">
        <span className="text-[10px] opacity-40">✧</span>
        <span className="font-medium">Master</span>
        <StatusDot status={s.status} />
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={running}
          className={`${SMALL_INPUT} min-w-0 max-w-[140px] flex-1`}
          title="Agent that powers the Master"
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className={`${BTN_GROUP} ml-auto`}>
          {s.status === "ready" && s.items.some((i) => i.kind === "user") && (
            <button
              className={TOOL_BTN}
              onClick={() => void newConversation(s)}
              title="New conversation"
            >
              <RotateCcw size={11} />
            </button>
          )}
          {running ? (
            <button
              className={TOOL_BTN}
              onClick={() => void stopAgent(s)}
              title="Stop"
            >
              <Square size={11} />
            </button>
          ) : (
            <button className={TOOL_BTN} onClick={() => void start()}>
              <Play size={11} /> Start
            </button>
          )}
          <button
            className={TOOL_BTN}
            onClick={() => setShowLogs((v) => !v)}
            title="Agent stderr"
          >
            <ScrollText size={12} />
          </button>
          <button
            className={TOOL_BTN}
            onClick={() => setOpen(false)}
            title="Close"
          >
            <X size={12} />
          </button>
        </div>
      </div>

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

      <Transcript
        s={s}
        empty={<EmptyState s={s} onStart={() => void start()} />}
      />

      {s.status === "auth" && <AuthBar s={s} paneId="" deviceId={hostId} />}

      {approvals.map((a) => (
        <ApprovalCard key={a.id} a={a} />
      ))}

      {s.permission && <PermissionCard s={s} />}

      <Composer s={s} onTerminal={canTerminal ? openTerminal : undefined} />
    </div>
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
    <div className="shrink-0 border-t border-(--color-border) bg-(--color-warn)/10 px-3 py-2">
      <div className="mb-1 flex items-start gap-1.5">
        <ShieldAlert size={13} className="mt-px shrink-0 text-(--color-warn)" />
        <div className="min-w-0">
          <div className="font-semibold">{a.title}</div>
          <div className="text-[11px] text-(--color-fg-muted)">
            on <b className="text-(--color-fg)">{a.device}</b> ·{" "}
            <span className="font-mono">{a.tool}</span>
          </div>
        </div>
      </div>
      <pre className="mb-2 max-h-40 overflow-auto rounded bg-(--color-bg) p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
        {a.detail}
      </pre>
      <div className="flex flex-wrap gap-1.5">
        <button
          autoFocus
          className="rounded bg-(--color-accent) px-2 py-1 font-medium text-(--color-accent-fg) hover:opacity-90"
          onClick={() => answerApproval(a, true)}
        >
          Allow once
        </button>
        {canAlwaysAllow(a.tool) && (
          <button
            className="rounded bg-(--color-surface-2) px-2 py-1 hover:opacity-90"
            onClick={() => answerApproval(a, true, true)}
            title="Until the agent is restarted"
          >
            Always allow {a.tool}
          </button>
        )}
        <button
          className="rounded bg-(--color-surface-2) px-2 py-1 hover:opacity-90"
          onClick={() => answerApproval(a, false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
