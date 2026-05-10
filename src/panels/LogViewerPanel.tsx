import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  { label: "dmesg", cmd: "dmesg -w 2>/dev/null || dmesg | tail -n 50" },
];

const MAX_LINES = 2000;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

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
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  pausedRef.current = paused;

  const appendLine = useCallback((line: string) => {
    if (pausedRef.current) return;
    if (line.startsWith("[error]")) {
      setError(line.slice(7).trim());
      return;
    }
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  const stopStream = useCallback(async () => {
    if (streamIdRef.current) {
      await invoke("log_stream_stop", { streamId: streamIdRef.current }).catch(() => {});
      streamIdRef.current = null;
    }
    unlistenRef.current?.();
    unlistenRef.current = null;
    setRunning(false);
  }, []);

  const startStream = useCallback(async (command: string) => {
    await stopStream();
    setLines([]);
    setError(null);

    const streamId = uid();
    streamIdRef.current = streamId;

    // Subscribe to events before invoking to avoid race
    unlistenRef.current = await listen<string>(`log:${streamId}`, (evt) => {
      appendLine(evt.payload);
    });

    try {
      await invoke("log_stream_start", { deviceId, streamId, cmd: command });
      setRunning(true);
    } catch (e) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      streamIdRef.current = null;
      setError(errorMessage(e));
    }
  }, [deviceId, stopStream, appendLine]);

  // Stop stream on unmount
  useEffect(() => {
    return () => {
      void stopStream();
    };
  }, [stopStream]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, paused]);

  const displayed = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  const isCustom = !PRESETS.some((p) => p.cmd === cmd);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) px-3 py-2 text-xs">
        {/* Presets */}
        <div className="flex gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => setCmd(p.cmd)}
              className={`rounded border px-2 py-0.5 transition-colors ${
                cmd === p.cmd
                  ? "border-(--color-accent) bg-(--color-accent) text-(--color-accent-fg)"
                  : "border-(--color-border) hover:bg-(--color-surface-2)"
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCmd(customCmd || "")}
            className={`rounded border px-2 py-0.5 transition-colors ${
              isCustom
                ? "border-(--color-accent) bg-(--color-accent) text-(--color-accent-fg)"
                : "border-(--color-border) hover:bg-(--color-surface-2)"
            }`}
          >
            Custom
          </button>
        </div>

        {isCustom && (
          <input
            value={customCmd}
            onChange={(e) => {
              setCustomCmd(e.target.value);
              setCmd(e.target.value);
            }}
            placeholder="journalctl -u nginx -f"
            className="input flex-1 py-1 text-xs"
          />
        )}

        <div className="ml-auto flex gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="input w-36 py-1 text-xs"
          />
          {running ? (
            <button
              onClick={() => void stopStream()}
              className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void startStream(cmd)}
              disabled={!cmd.trim()}
              className="rounded bg-(--color-accent) px-2 py-0.5 text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
            >
              Start
            </button>
          )}
          <button
            onClick={() => setPaused((p) => !p)}
            className={`rounded border px-2 py-0.5 transition-colors ${
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

      {/* Log output */}
      <div className="flex-1 overflow-auto bg-(--color-bg) p-3 font-mono text-xs text-(--color-fg)">
        {displayed.length === 0 ? (
          <div className="text-(--color-fg-muted)">
            {running ? "Waiting for output…" : "Press Start to stream a log."}
          </div>
        ) : (
          displayed.map((line, i) => <LogLine key={i} line={line} filter={filter} />)
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
    return <div className={`whitespace-pre-wrap leading-5 ${color}`}>{line}</div>;
  }

  const idx = line.toLowerCase().indexOf(filter.toLowerCase());
  if (idx === -1) {
    return <div className={`whitespace-pre-wrap leading-5 ${color}`}>{line}</div>;
  }

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
