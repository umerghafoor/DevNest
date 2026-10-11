import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  answerPermission,
  authenticate,
  cancelTurn,
  getAgentSession,
  installAgent,
  isAgentInstalled,
  sendPrompt,
  startAgent,
  stopAgent,
  stopInstall,
  subscribeAgentSession,
  type AgentSession,
  type TranscriptItem,
} from "../lib/agent-sessions";
import type { PermissionOption, ToolCall } from "../lib/acp";
import { contentText } from "../lib/acp";
import {
  joinArgs,
  splitArgs,
  useAgentsStore,
  type AgentDef,
} from "../store/agents-store";
import { useAppStore } from "../store/app-store";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN } from "../lib/ui";
import { toast } from "../components/Toast";
import { RemoteFilePicker } from "../components/RemoteFilePicker";

/**
 * Chat with a third-party coding agent (Claude Code, Codex, Gemini CLI, …)
 * over the Agent Client Protocol. The agent runs on the pane&apos;s device —
 * locally, or over SSH — in the chosen project folder.
 */
export function AgentPanel({
  deviceId,
  paneId,
}: {
  deviceId: string;
  paneId: string;
}) {
  const s = getAgentSession(paneId, deviceId);
  useSyncExternalStore(
    (fn) => subscribeAgentSession(s, fn),
    () => s.version,
  );

  const device = useAppStore((st) => st.devices.find((d) => d.id === deviceId));
  const isLocal = device?.isLocalhost ?? true;
  const agents = useAgentsStore((st) => st.agents);
  const lastAgentId = useAgentsStore((st) => st.lastAgentId);
  const lastCwd = useAgentsStore((st) => st.lastCwd[deviceId] ?? "");
  const setLast = useAgentsStore((st) => st.setLast);

  const [agentId, setAgentId] = useState(
    s.agent?.id ?? lastAgentId ?? agents[0]?.id ?? "",
  );
  const [cwd, setCwd] = useState(s.cwd || lastCwd);
  const [managing, setManaging] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [picking, setPicking] = useState(false);

  // Switching the pane to another device: start from that device's folder.
  const [seenDevice, setSeenDevice] = useState(deviceId);
  if (seenDevice !== deviceId) {
    setSeenDevice(deviceId);
    setCwd(lastCwd);
  }

  const running = s.status !== "idle" && s.status !== "exited";
  const agent = agents.find((a) => a.id === agentId);

  // Is the agent's command available on this device? Re-check after an
  // install finishes. null = unknown / checking.
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

  const start = () => {
    if (!agent) return toast.error("Pick an agent first.");
    if (!cwd.trim()) return toast.error("Pick a project folder first.");
    setLast(agent.id, deviceId, cwd.trim());
    void startAgent(s, agent, cwd.trim());
  };

  const install = async () => {
    if (!agent) return;
    const ok = await installAgent(s, agent);
    if (ok) toast.success(`${agent.name} installed`);
    else toast.error(`Installing ${agent.name} failed — see the log.`);
  };

  const browse = async () => {
    if (!isLocal) return setPicking(true);
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir === "string") setCwd(dir);
  };

  const installRun = s.install?.agentId === agent?.id ? s.install : null;

  return (
    <div className="fade-up flex h-full flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-1.5">
        <StatusDot status={s.status} />
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={running}
          className={`${SMALL_INPUT} max-w-[160px]`}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="flex min-w-[160px] flex-1 items-center gap-1">
          <input
            className={`${SMALL_INPUT} min-w-0 flex-1 font-mono`}
            placeholder={
              isLocal
                ? "/path/to/project"
                : "~/project on " + (device?.name ?? "device")
            }
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={running}
          />
          <button
            className={TOOL_BTN}
            onClick={() => void browse()}
            disabled={running}
            title="Choose folder"
          >
            …
          </button>
        </div>
        <div className={BTN_GROUP}>
          {running ? (
            <button className={TOOL_BTN} onClick={() => void stopAgent(s)}>
              Stop
            </button>
          ) : (
            <button className={TOOL_BTN} onClick={start}>
              Start
            </button>
          )}
          <button
            className={TOOL_BTN}
            onClick={() => setShowLogs((v) => !v)}
            title="Agent stderr"
          >
            Logs{s.stderr.length ? ` (${s.stderr.length})` : ""}
          </button>
          <button
            className={TOOL_BTN}
            onClick={() => setManaging((v) => !v)}
            title="Configure agents"
          >
            ⚙
          </button>
        </div>
      </div>

      {managing && <AgentManager onClose={() => setManaging(false)} />}

      {agent && !running && (installed === false || installRun) && (
        <InstallBanner
          agent={agent}
          deviceName={device?.name ?? "this device"}
          missing={installed === false}
          run={installRun}
          onInstall={() => void install()}
          onCancel={() => void stopInstall(s)}
        />
      )}

      {picking && (
        <RemoteFilePicker
          deviceId={deviceId}
          dirOnly
          onPick={(path) => {
            setCwd(path);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {showLogs && (
        <pre className="max-h-40 shrink-0 overflow-auto border-b border-(--color-border) bg-(--color-bg) px-3 py-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-fg-muted)">
          {s.stderr.length ? s.stderr.join("\n") : "No output on stderr."}
        </pre>
      )}

      <Transcript s={s} />

      {s.status === "auth" && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-(--color-border) bg-(--color-warn)/10 px-3 py-2">
          <span>Sign in with:</span>
          {s.authMethods.map((m) => (
            <button
              key={m.id}
              className="rounded bg-(--color-accent) px-2 py-1 text-(--color-accent-fg) hover:opacity-90"
              title={m.description ?? undefined}
              onClick={() => void authenticate(s, m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}

      {s.permission && <PermissionCard s={s} />}

      <Composer s={s} />
    </div>
  );
}

function InstallBanner({
  agent,
  deviceName,
  missing,
  run,
  onInstall,
  onCancel,
}: {
  agent: AgentDef;
  deviceName: string;
  missing: boolean;
  run: AgentSession["install"];
  onInstall: () => void;
  onCancel: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.log.length]);

  return (
    <div className="shrink-0 border-b border-(--color-border) bg-(--color-warn)/10 px-3 py-2">
      {missing && !run?.running && (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            <code className="font-mono">{agent.command}</code> isn&apos;t
            installed on {deviceName}.
          </span>
          {agent.install ? (
            <button
              className="rounded bg-(--color-accent) px-2 py-0.5 font-medium text-(--color-accent-fg) hover:opacity-90"
              onClick={onInstall}
              title={agent.install}
            >
              Install {agent.name}
            </button>
          ) : (
            <span className="text-(--color-fg-muted)">
              Add an install command for it with ⚙.
            </span>
          )}
        </div>
      )}
      {missing && agent.install && !run && (
        <code className="mt-1 block truncate font-mono text-[11px] text-(--color-fg-muted)">
          {agent.install}
        </code>
      )}
      {run && (
        <>
          <div className="flex items-center gap-2">
            <span className="font-semibold">
              {run.running
                ? `Installing ${agent.name} on ${deviceName}…`
                : run.exitCode === 0
                  ? `${agent.name} installed.`
                  : `Install failed.`}
            </span>
            {run.running && (
              <button className={TOOL_BTN} onClick={onCancel}>
                Cancel
              </button>
            )}
          </div>
          <div
            ref={logRef}
            className="mt-1 max-h-40 overflow-auto rounded bg-(--color-bg) p-2 font-mono text-[11px] whitespace-pre-wrap text-(--color-fg-muted)"
          >
            {run.log.join("\n")}
          </div>
        </>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: AgentSession["status"] }) {
  const cls =
    status === "ready"
      ? "bg-(--color-online)"
      : status === "prompting" || status === "starting"
        ? "bg-(--color-warn) animate-pulse"
        : status === "auth"
          ? "bg-(--color-warn)"
          : "bg-(--color-offline)";
  return (
    <span className={`h-2 w-2 shrink-0 rounded-full ${cls}`} title={status} />
  );
}

// ─── Transcript ───────────────────────────────────────────────────────────────

function Transcript({ s }: { s: AgentSession }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.version]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3"
    >
      {s.items.length === 0 ? (
        <div className="flex h-full items-center justify-center text-center text-(--color-fg-muted)">
          Pick an agent and a project folder, then Start.
          <br />
          Any Agent Client Protocol agent works — add your own with ⚙.
        </div>
      ) : (
        s.items.map((it) => <Item key={it.id} item={it} />)
      )}
    </div>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-8 rounded-lg bg-(--color-accent)/15 px-3 py-2 whitespace-pre-wrap">
          {item.text}
        </div>
      );
    case "agent":
      // Rendered as plain text on purpose: agent output is untrusted and
      // this webview can invoke backend commands, so no HTML injection.
      return (
        <div className="mr-8 px-1 leading-relaxed whitespace-pre-wrap">
          {item.text}
        </div>
      );
    case "thought":
      return (
        <details className="mr-8 px-1 text-(--color-fg-muted)">
          <summary className="cursor-pointer select-none">Thinking…</summary>
          <div className="mt-1 whitespace-pre-wrap italic">{item.text}</div>
        </details>
      );
    case "tool":
      return <ToolCard call={item.call} />;
    case "plan":
      return (
        <div className="rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2">
          <div className="mb-1 font-semibold">Plan</div>
          <ul className="space-y-0.5">
            {item.entries.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span>
                  {e.status === "completed"
                    ? "✓"
                    : e.status === "in_progress"
                      ? "▸"
                      : "○"}
                </span>
                <span
                  className={
                    e.status === "completed"
                      ? "text-(--color-fg-muted) line-through"
                      : ""
                  }
                >
                  {e.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "system":
      return (
        <div
          className={`text-center text-[11px] whitespace-pre-wrap ${
            item.error ? "text-(--color-error)" : "text-(--color-fg-muted)"
          }`}
        >
          {item.text}
        </div>
      );
  }
}

const TOOL_STATUS_ICON: Record<string, string> = {
  pending: "○",
  in_progress: "◌",
  completed: "✓",
  failed: "✕",
};

function ToolCard({ call }: { call: ToolCall }) {
  const status = call.status ?? "pending";
  return (
    <details className="rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-1.5">
      <summary className="flex cursor-pointer items-center gap-2 select-none">
        <span
          className={
            status === "failed"
              ? "text-(--color-error)"
              : status === "completed"
                ? "text-(--color-online)"
                : "animate-pulse text-(--color-warn)"
          }
        >
          {TOOL_STATUS_ICON[status] ?? "○"}
        </span>
        <span className="truncate font-mono">
          {call.title ?? call.kind ?? "tool"}
        </span>
      </summary>
      <div className="mt-1 space-y-1">
        {call.locations?.map((l, i) => (
          <div key={i} className="font-mono text-(--color-fg-muted)">
            {l.path}
            {l.line != null ? `:${l.line}` : ""}
          </div>
        ))}
        {call.content?.map((c, i) =>
          c.type === "diff" ? (
            <pre
              key={i}
              className="max-h-64 overflow-auto rounded bg-(--color-bg) p-2 font-mono text-[11px]"
            >
              <div className="text-(--color-fg-muted)">{c.path}</div>
              {simpleDiff(c.oldText ?? "", c.newText ?? "")}
            </pre>
          ) : (
            <pre
              key={i}
              className="max-h-64 overflow-auto rounded bg-(--color-bg) p-2 font-mono text-[11px] whitespace-pre-wrap"
            >
              {c.type === "content" ? contentText(c.content) : `[${c.type}]`}
            </pre>
          ),
        )}
      </div>
    </details>
  );
}

/** Cheap line diff: common prefix/suffix kept, middle shown as -/+. */
function simpleDiff(oldText: string, newText: string) {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  return (
    <>
      {removed.map((l, i) => (
        <div key={`r${i}`} className="text-(--color-error)">
          - {l}
        </div>
      ))}
      {added.map((l, i) => (
        <div key={`a${i}`} className="text-(--color-online)">
          + {l}
        </div>
      ))}
    </>
  );
}

// ─── Permission prompt ────────────────────────────────────────────────────────

function PermissionCard({ s }: { s: AgentSession }) {
  const { req } = s.permission!;
  const style = (o: PermissionOption) =>
    o.kind.startsWith("allow")
      ? "bg-(--color-accent) text-(--color-accent-fg)"
      : "bg-(--color-surface-2)";
  return (
    <div className="shrink-0 border-t border-(--color-border) bg-(--color-warn)/10 px-3 py-2">
      <div className="mb-1.5">
        <span className="font-semibold">Permission requested: </span>
        <span className="font-mono">
          {req.toolCall.title ?? req.toolCall.kind ?? req.toolCall.toolCallId}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {req.options.map((o) => (
          <button
            key={o.optionId}
            className={`rounded px-2 py-1 hover:opacity-90 ${style(o)}`}
            onClick={() =>
              answerPermission(s, { outcome: "selected", optionId: o.optionId })
            }
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Composer ─────────────────────────────────────────────────────────────────

function Composer({ s }: { s: AgentSession }) {
  const [text, setText] = useState("");
  const ready = s.status === "ready";
  const busy = s.status === "prompting";

  const submit = () => {
    const t = text.trim();
    if (!t || !ready) return;
    setText("");
    void sendPrompt(s, t);
  };

  return (
    <div className="flex shrink-0 items-end gap-2 border-t border-(--color-border) bg-(--color-surface) px-3 py-2">
      <textarea
        rows={2}
        className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-transparent bg-(--color-bg) px-2 py-1.5 text-xs outline-none placeholder:text-(--color-fg-muted) focus:border-(--color-accent)"
        placeholder={
          ready
            ? "Ask the agent… (Enter to send, Shift+Enter for newline)"
            : busy
              ? "Agent is working…"
              : "Start an agent to chat"
        }
        value={text}
        disabled={!ready && !busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button
          className="h-7 rounded bg-(--color-surface-2) px-3 hover:opacity-90"
          onClick={() => cancelTurn(s)}
        >
          Cancel
        </button>
      ) : (
        <button
          className="h-7 rounded bg-(--color-accent) px-3 font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          onClick={submit}
          disabled={!ready || !text.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
}

// ─── Agent registry editor ────────────────────────────────────────────────────

function AgentManager({ onClose }: { onClose: () => void }) {
  const agents = useAgentsStore((st) => st.agents);
  const upsert = useAgentsStore((st) => st.upsert);
  const remove = useAgentsStore((st) => st.remove);
  const resetBuiltin = useAgentsStore((st) => st.resetBuiltin);

  const add = () =>
    upsert({
      id: `custom-${Math.random().toString(36).slice(2, 8)}`,
      name: "My agent",
      command: "",
      args: [],
    });

  return (
    <div className="max-h-[50%] shrink-0 overflow-y-auto border-b border-(--color-border) bg-(--color-bg) px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">Agents</span>
        <div className={BTN_GROUP}>
          <button className={TOOL_BTN} onClick={add}>
            + Add
          </button>
          <button className={TOOL_BTN} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      <p className="mb-2 text-(--color-fg-muted)">
        Any command that speaks the Agent Client Protocol over stdio. It runs
        through your login shell on the pane&apos;s device, so anything on your
        PATH works. The install command runs when the agent is missing.
      </p>
      <div className="space-y-1.5">
        {agents.map((a) => (
          <AgentRow
            // Re-key on args so a reset (external change) resyncs the field.
            key={`${a.id}:${joinArgs(a.args)}`}
            def={a}
            onChange={upsert}
            onRemove={() => remove(a.id)}
            onReset={() => resetBuiltin(a.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentRow({
  def,
  onChange,
  onRemove,
  onReset,
}: {
  def: AgentDef;
  onChange: (d: AgentDef) => void;
  onRemove: () => void;
  onReset: () => void;
}) {
  // Edit args as text; only re-split on blur so typing spaces isn't eaten.
  const [args, setArgs] = useState(joinArgs(def.args));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        className={`${SMALL_INPUT} w-28`}
        value={def.name}
        onChange={(e) => onChange({ ...def, name: e.target.value })}
        placeholder="Name"
      />
      <input
        className={`${SMALL_INPUT} w-28 font-mono`}
        value={def.command}
        onChange={(e) => onChange({ ...def, command: e.target.value })}
        placeholder="command"
      />
      <input
        className={`${SMALL_INPUT} min-w-[120px] flex-1 font-mono`}
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        onBlur={() => onChange({ ...def, args: splitArgs(args) })}
        placeholder="args"
      />
      <input
        className={`${SMALL_INPUT} min-w-[160px] flex-1 font-mono`}
        value={def.install ?? ""}
        onChange={(e) =>
          onChange({ ...def, install: e.target.value || undefined })
        }
        placeholder="install command (optional)"
        title={def.install}
      />
      {def.builtin ? (
        <button
          className={TOOL_BTN}
          onClick={onReset}
          title="Restore default command"
        >
          Reset
        </button>
      ) : (
        <button className={TOOL_BTN} onClick={onRemove} title="Remove">
          ✕
        </button>
      )}
    </div>
  );
}
