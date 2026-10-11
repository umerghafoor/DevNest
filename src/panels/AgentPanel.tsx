import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  answerElicitation,
  answerPermission,
  authenticate,
  cancelTurn,
  getAgentSession,
  installAgent,
  isAgentInstalled,
  logout,
  retryAfterLogin,
  sendPrompt,
  setConfig,
  setMode,
  startAgent,
  stopAgent,
  stopInstall,
  subscribeAgentSession,
  terminalLoginCommand,
  type AgentSession,
  type TranscriptItem,
} from "../lib/agent-sessions";
import type { AuthMethod, PermissionOption, ToolCall } from "../lib/acp";
import { contentText, wantsApiKey } from "../lib/acp";
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
import { SafeMarkdown } from "../components/SafeMarkdown";
import {
  allCommands,
  runLocalCommand,
  type MenuCommand,
} from "../lib/agent-local-commands";
import { QuestionForm } from "./agent/QuestionForm";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  LogOut,
  Play,
  ScrollText,
  Settings2,
  Square,
} from "lucide-react";

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
        <div className="flex h-6 min-w-[160px] flex-1 items-center rounded-md bg-(--color-surface-2)/60 pr-0.5 focus-within:ring-1 focus-within:ring-(--color-accent)">
          <input
            className="h-6 min-w-0 flex-1 bg-transparent px-2 font-mono text-xs text-(--color-fg) outline-none placeholder:text-(--color-fg-muted) disabled:opacity-70"
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
            className="inline-flex h-5 w-6 items-center justify-center rounded text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) disabled:opacity-40"
            onClick={() => void browse()}
            disabled={running}
            title="Choose folder"
          >
            <FolderOpen size={13} />
          </button>
        </div>
        {running && s.account && s.account.kind !== "none" && (
          <div className={BTN_GROUP}>
            <span
              className="max-w-[180px] truncate px-1.5 text-(--color-fg-muted)"
              title={[s.account.label, s.account.account?.email]
                .filter(Boolean)
                .join(" · ")}
            >
              {s.account.label}
            </span>
            {s.canLogout && (
              <button
                className={TOOL_BTN}
                onClick={() => void logout(s)}
                title="Sign out / switch account"
              >
                <LogOut size={12} />
              </button>
            )}
          </div>
        )}
        <div className={BTN_GROUP}>
          {running ? (
            <button className={TOOL_BTN} onClick={() => void stopAgent(s)}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className={TOOL_BTN} onClick={start}>
              <Play size={11} /> Start
            </button>
          )}
          <button
            className={TOOL_BTN}
            onClick={() => setShowLogs((v) => !v)}
            title="Agent stderr"
          >
            <ScrollText size={12} />
            Logs
            {s.stderr.length > 0 && (
              <span className="text-(--color-fg-muted)">{s.stderr.length}</span>
            )}
          </button>
          <button
            className={TOOL_BTN}
            onClick={() => setManaging((v) => !v)}
            title="Configure agents"
          >
            <Settings2 size={12} />
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
        <AuthBar s={s} paneId={paneId} deviceId={deviceId} />
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

function AuthBar({
  s,
  paneId,
  deviceId,
}: {
  s: AgentSession;
  paneId: string;
  deviceId: string;
}) {
  // Method whose API-key field is open.
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState("");
  // A terminal sign-in is in progress in a split pane.
  const [termLogin, setTermLogin] = useState(false);
  const splitPane = useAppStore((st) => st.splitPane);
  const method = s.authMethods.find((m) => m.id === keyFor);

  const choose = (m: AuthMethod) => {
    if (wantsApiKey(m)) return setKeyFor(m.id);
    if (m.type === "terminal") {
      const cmd = terminalLoginCommand(s, m);
      if (!cmd) return;
      // Interactive login (browser / device code) needs a real TTY: open a
      // terminal beside the agent with the command typed in.
      const id = Math.random().toString(36).slice(2, 10);
      splitPane(paneId, "horizontal", {
        id,
        deviceId,
        panel: "terminal",
        instanceId: id,
        extra: { initialCommand: cmd },
      });
      setTermLogin(true);
      return;
    }
    void authenticate(s, m.id);
  };

  return (
    <div className="shrink-0 border-t border-(--color-border) bg-(--color-warn)/10 px-4 py-2">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-1.5">
        <span className="mr-1">Sign in with</span>
        {s.authMethods.map((m) => (
          <button
            key={m.id}
            className={`h-6 rounded-md px-2 ${
              keyFor === m.id
                ? "bg-(--color-accent) text-(--color-accent-fg)"
                : "bg-(--color-surface) hover:bg-(--color-surface-2)"
            }`}
            title={m.description ?? undefined}
            onClick={() => choose(m)}
          >
            {m.name}
          </button>
        ))}
      </div>
      {termLogin && (
        <div className="mx-auto mt-2 flex max-w-3xl items-center gap-2">
          <span className="text-(--color-fg-muted)">
            Finish signing in in the terminal beside this pane, then
          </span>
          <button
            className="h-6 rounded-md bg-(--color-accent) px-3 font-medium text-(--color-accent-fg) hover:opacity-90"
            onClick={() => {
              setTermLogin(false);
              void retryAfterLogin(s);
            }}
          >
            Continue
          </button>
        </div>
      )}
      {method && (
        <form
          className="mx-auto mt-2 flex max-w-3xl items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            void authenticate(s, method.id, key.trim());
            setKey("");
          }}
        >
          <input
            type="password"
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={`${method.name}…`}
            className={`${SMALL_INPUT} flex-1 font-mono`}
          />
          <button
            type="submit"
            disabled={!key.trim()}
            className="h-6 rounded-md bg-(--color-accent) px-3 font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            Sign in
          </button>
          <span className="text-[11px] text-(--color-fg-muted)">
            Saved in your system keychain
          </span>
        </form>
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
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
    >
      {s.items.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-(--color-fg-muted)">
          <span>Pick an agent and a project folder, then Start.</span>
          <span>
            Any Agent Client Protocol agent works — add your own in settings.
          </span>
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {s.items.map((it) => (
            <Item key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-(--color-accent)/15 px-3.5 py-2 leading-relaxed whitespace-pre-wrap">
            {item.text}
          </div>
        </div>
      );
    case "agent":
      // SafeMarkdown never injects HTML: agent output is untrusted and this
      // webview can invoke backend commands.
      return <SafeMarkdown text={item.text} className="agent-md" />;
    case "thought":
      return (
        <details className="text-(--color-fg-muted)">
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

/**
 * Every setting the agent exposes (model, effort, mode, fast mode, persona,
 * …) as compact pickers, built from its `configOptions` — nothing hard-coded,
 * so new agent options show up automatically.
 */
function SettingsRow({ s }: { s: AgentSession }) {
  const hasModeOption = s.config.some((o) => o.category === "mode");
  const legacyMode =
    !hasModeOption && s.modes
      ? s.modes.availableModes.find((m) => m.id === s.modes?.currentModeId)
      : null;
  if (s.config.length === 0 && !s.modes) return null;

  return (
    <div className="flex items-center">
      {s.config.map((o) =>
        o.type === "boolean" ? (
          <button
            key={o.id}
            onClick={() => void setConfig(s, o.id, !o.currentValue)}
            disabled={!s.sessionId}
            title={o.description ?? undefined}
            className={`${PILL} ${o.currentValue ? "text-(--color-accent)" : ""}`}
          >
            {o.name}: {o.currentValue ? "On" : "Off"}
          </button>
        ) : (
          <SelectPill
            key={o.id}
            // Model and mode read fine on their own; others need the name.
            label={
              o.category === "model" || o.category === "mode" ? null : o.name
            }
            title={o.description ?? o.name}
            value={o.currentValue}
            disabled={!s.sessionId}
            onChange={(v) => void setConfig(s, o.id, v)}
          >
            {o.options.map((opt) =>
              "group" in opt ? (
                <optgroup key={opt.group} label={opt.name}>
                  {opt.options.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={opt.value} value={opt.value}>
                  {opt.name}
                </option>
              ),
            )}
          </SelectPill>
        ),
      )}
      {legacyMode && s.modes && (
        <SelectPill
          label={null}
          title={legacyMode.description ?? "Agent mode"}
          value={s.modes.currentModeId}
          disabled={!s.sessionId}
          onChange={(v) => void setMode(s, v)}
        >
          {s.modes.availableModes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </SelectPill>
      )}
    </div>
  );
}

const PILL =
  "relative inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[11px] text-(--color-fg-muted) hover:bg-(--color-surface-2) hover:text-(--color-fg) disabled:opacity-50";

/** Compact pill showing the selected option, with the native menu on click. */
function SelectPill({
  label,
  title,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string | null;
  title: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<React.ComponentRef<"select">>(null);
  // Name of the selected option, read from the rendered <option>s so groups
  // and agent-provided names are respected.
  const [shown, setShown] = useState("");
  useEffect(() => {
    const el = ref.current;
    setShown(el?.selectedOptions[0]?.text ?? value);
  }, [value, children]);

  return (
    <label className={PILL} title={title}>
      <span className="pointer-events-none flex items-center gap-0.5">
        {label && <span className="opacity-70">{label}:</span>}
        <span className="text-(--color-fg)">{shown}</span>
        <ChevronDown size={10} />
      </span>
      {/* Invisible native select on top: native menu, compact look. */}
      <select
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label ?? title}
        className="no-focus-ring absolute inset-0 cursor-pointer opacity-0"
      >
        {children}
      </select>
    </label>
  );
}

/** Commands matching a `/partial` with no space typed yet; else none. */
function matchCommands(text: string, commands: MenuCommand[]) {
  const m = /^\/(\S*)$/.exec(text);
  if (!m || commands.length === 0) return [];
  const q = m[1].toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter(
    (c) =>
      !c.name.toLowerCase().startsWith(q) &&
      (c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q)),
  );
  // No cap: agents can offer dozens (Claude Code sends 70+ incl. skills);
  // the menu scrolls.
  return [...starts, ...contains];
}

function Composer({ s }: { s: AgentSession }) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const ready = s.status === "ready";
  const busy = s.status === "prompting";

  const commands = allCommands(s);
  const suggestions = dismissed ? [] : matchCommands(text, commands);
  const active = Math.min(sel, Math.max(0, suggestions.length - 1));
  const menuRef = useRef<React.ComponentRef<"ul">>(null);

  // Keep the highlighted command visible while arrowing through the list.
  useEffect(() => {
    menuRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Grow with the content up to a cap, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const edit = (v: string) => {
    setText(v);
    setSel(0);
    setDismissed(false);
  };

  const pick = (c: MenuCommand) => {
    edit(`/${c.name} `);
    ref.current?.focus();
  };

  const submit = () => {
    const t = text.trim();
    if (!t || !ready) return;
    edit("");
    if (runLocalCommand(s, t)) return;
    void sendPrompt(s, t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSel((active + d + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pick(suggestions[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const hint = (() => {
    const m = /^\/(\S+)\s*$/.exec(text);
    const cmd = m && commands.find((c) => c.name === m[1]);
    return cmd?.input?.hint ?? null;
  })();

  return (
    <div className="shrink-0 border-t border-(--color-border) px-3 py-2">
      <div className="relative mx-auto max-w-3xl">
        {s.elicitation ? (
          // A pending question replaces the input: answering it is the only
          // thing the agent is waiting on.
          <QuestionForm
            key={s.elicitation.req.toolCallId ?? s.elicitation.req.message}
            req={s.elicitation.req}
            onAnswer={(r) => answerElicitation(s, r)}
            onStop={() => cancelTurn(s)}
          />
        ) : (
          <>
            {suggestions.length > 0 && (
              <ul
                ref={menuRef}
                className="absolute right-0 bottom-full left-0 mb-1.5 max-h-72 overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-surface) py-1 shadow-lg"
              >
                {suggestions.map((c, i) => (
                  <li key={c.name} data-idx={i}>
                    <button
                      className={`flex w-full items-baseline gap-3 px-3 py-1 text-left ${
                        i === active
                          ? "bg-(--color-accent)/15"
                          : "hover:bg-(--color-surface-2)"
                      }`}
                      onMouseEnter={() => setSel(i)}
                      onMouseDown={(e) => {
                        e.preventDefault(); // keep focus in the textarea
                        pick(c);
                      }}
                    >
                      <span className="shrink-0 font-mono">/{c.name}</span>
                      <span className="min-w-0 flex-1 truncate text-(--color-fg-muted)">
                        {c.description}
                      </span>
                      {c.local && (
                        <span
                          className="shrink-0 rounded bg-(--color-surface-2) px-1 text-[10px] text-(--color-fg-muted)"
                          title="Handled by DevNest, not sent to the agent"
                        >
                          DevNest
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-end gap-x-1 rounded-xl border border-(--color-border) bg-(--color-surface) p-1 pl-3 transition-colors focus-within:border-(--color-accent)">
              <textarea
                ref={ref}
                rows={1}
                className="no-focus-ring max-h-40 min-h-7 min-w-48 flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-snug text-(--color-fg) outline-none placeholder:text-(--color-fg-muted) disabled:cursor-not-allowed"
                placeholder={
                  ready
                    ? commands.length
                      ? "Ask the agent… / for commands"
                      : "Ask the agent…"
                    : busy
                      ? "Agent is working…"
                      : "Start an agent to chat"
                }
                value={text}
                disabled={!ready && !busy}
                onChange={(e) => edit(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <SettingsRow s={s} />
                {busy ? (
                  <button
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-2) hover:opacity-80"
                    onClick={() => cancelTurn(s)}
                    title="Stop this turn"
                  >
                    <Square size={11} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--color-accent) text-(--color-accent-fg) hover:opacity-90 disabled:opacity-30"
                    onClick={submit}
                    disabled={!ready || !text.trim()}
                    title="Send (Enter) · Newline (Shift+Enter)"
                  >
                    <ArrowUp size={15} />
                  </button>
                )}
              </div>
            </div>

            {hint && (
              <div className="mt-1 truncate px-1 text-[11px] text-(--color-fg-muted)">
                Argument: {hint}
              </div>
            )}
          </>
        )}
      </div>
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
