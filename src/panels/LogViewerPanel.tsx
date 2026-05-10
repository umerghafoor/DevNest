import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

interface Props {
  deviceId: string;
}

const PRESETS = [
  {
    label: "syslog",
    cmd: "tail -F /var/log/syslog 2>/dev/null || tail -F /var/log/messages 2>/dev/null",
  },
  {
    label: "auth.log",
    cmd: "tail -F /var/log/auth.log 2>/dev/null || tail -F /var/log/secure 2>/dev/null",
  },
  { label: "journalctl", cmd: "journalctl -f --no-pager 2>/dev/null" },
  { label: "dmesg", cmd: "dmesg -w 2>/dev/null || dmesg | tail -50" },
];

const MAX_LINES = 2000;

export function LogViewerPanel({ deviceId }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [paused, setPaused] = useState(false);
  const [cmd, setCmd] = useState(PRESETS[0].cmd);
  const [customCmd, setCustomCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  pausedRef.current = paused;

  const appendLines = useCallback((raw: string) => {
    if (pausedRef.current) return;
    const newLines = raw.split(/\r?\n/).filter(Boolean);
    if (newLines.length === 0) return;
    setLines((prev) => {
      const next = [...prev, ...newLines];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const stopAll = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    unlistenRef.current?.();
    unlistenRef.current = null;
    setRunning(false);
  }, []);

  const start = async (command: string) => {
    stopAll();
    setLines([]);
    setError(null);

    try {
      // First invocation to verify the command works
      await invoke("run_remote_command", { deviceId, cmd: command });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }

    setRunning(true);

    // Poll every 2s — pull last 50 lines each tick.
    // True streaming (tail -F) requires a background Tauri task; deferred to Phase 3.
    const pollCmd = command.includes("tail -F")
      ? command.replace("-F", "-n 50 --")
      : command;

    pollRef.current = setInterval(async () => {
      try {
        const out = await invoke<{ stdout: string; exitCode: number }>(
          "run_remote_command",
          { deviceId, cmd: `${pollCmd} 2>&1 | tail -50` },
        );
        appendLines(out.stdout);
      } catch {
        // ignore poll errors — will retry next interval
      }
    }, 2000);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAll();
    };
  }, [stopAll]);

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, paused]);

  const displayed = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) px-3 py-2 text-xs">
        <div className="flex gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => setCmd(p.cmd)}
              className={`rounded border px-2 py-0.5 ${
                cmd === p.cmd
                  ? "border-(--color-accent) bg-(--color-accent) text-white"
                  : "border-(--color-border) hover:bg-(--color-surface-2)"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCmd(customCmd || "")}
            className={`rounded border px-2 py-0.5 ${
              !PRESETS.some((p) => p.cmd === cmd)
                ? "border-(--color-accent) bg-(--color-accent) text-white"
                : "border-(--color-border) hover:bg-(--color-surface-2)"
            }`}
          >
            Custom
          </button>
        </div>

        {!PRESETS.some((p) => p.cmd === cmd) && (
          <input
            value={customCmd}
            onChange={(e) => {
              setCustomCmd(e.target.value);
              setCmd(e.target.value);
            }}
            placeholder="journalctl -u nginx -f"
            className="input flex-1"
          />
        )}

        <div className="ml-auto flex gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="input w-36"
          />
          {running ? (
            <button
              onClick={stopAll}
              className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void start(cmd)}
              className="rounded bg-(--color-accent) px-2 py-0.5 text-white hover:opacity-90"
            >
              Start
            </button>
          )}
          <button
            onClick={() => setPaused((p) => !p)}
            className={`rounded border px-2 py-0.5 ${
              paused
                ? "border-(--color-warn) text-(--color-warn)"
                : "border-(--color-border) hover:bg-(--color-surface-2)"
            }`}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => setLines([])}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-(--color-error)">{error}</div>
      )}

      <div className="flex-1 overflow-auto bg-(--color-bg) p-3 font-mono text-xs text-(--color-fg)">
        {displayed.length === 0 ? (
          <div className="text-(--color-fg-muted)">
            {running ? "Waiting for output…" : "Press Start to tail a log."}
          </div>
        ) : (
          displayed.map((line, i) => (
            <LogLine key={i} line={line} filter={filter} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogLine({ line, filter }: { line: string; filter: string }) {
  const color = line.match(/\b(error|crit|alert|emerg|fail)\b/i)
    ? "text-(--color-error)"
    : line.match(/\b(warn|warning)\b/i)
      ? "text-(--color-warn)"
      : "";

  if (!filter) {
    return (
      <div className={`whitespace-pre-wrap leading-5 ${color}`}>{line}</div>
    );
  }

  const idx = line.toLowerCase().indexOf(filter.toLowerCase());
  if (idx === -1)
    return (
      <div className={`whitespace-pre-wrap leading-5 ${color}`}>{line}</div>
    );

  return (
    <div className={`whitespace-pre-wrap leading-5 ${color}`}>
      {line.slice(0, idx)}
      <mark className="rounded bg-(--color-warn)/30 text-(--color-warn)">
        {line.slice(idx, idx + filter.length)}
      </mark>
      {line.slice(idx + filter.length)}
    </div>
  );
}
