import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errorMessage } from "../lib/api";
import { usePaneSettings } from "../store/pane-settings-store";

interface Props {
  deviceId: string;
  paneId?: string;
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

export function LogViewerPanel({ deviceId, paneId }: Props) {
  const [settings, updateSettings] = usePaneSettings(paneId, { filter: "" });
  const [lines, setLines] = useState<string[]>([]);
  const filter = settings.filter;
  const setFilter = (v: string) => updateSettings({ filter: v });
  const [paused, setPaused] = useState(false);
  const [cmd, setCmd] = useState(PRESETS[0].cmd);
  const [customCmd, setCustomCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
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
      await invoke("log_stream_stop", { streamId: streamIdRef.current }).catch(
        () => {},
      );
      streamIdRef.current = null;
    }
    unlistenRef.current?.();
    unlistenRef.current = null;
    setRunning(false);
  }, []);

  const startStream = useCallback(
    async (command: string) => {
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
    },
    [deviceId, stopStream, appendLine],
  );

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

  const matchLineIndices = useMemo(() => {
    if (!search) return [];
    const needle = search.toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < displayed.length; i++) {
      if (displayed[i].toLowerCase().includes(needle)) out.push(i);
    }
    return out;
  }, [displayed, search]);

  useEffect(() => {
    if (matchLineIndices.length === 0) {
      setMatchIndex(0);
      return;
    }
    setMatchIndex((i) =>
      i >= matchLineIndices.length ? matchLineIndices.length - 1 : i,
    );
  }, [matchLineIndices.length]);

  const activeMatchLine = matchLineIndices[matchIndex];

  useEffect(() => {
    if (activeMatchLine == null) return;
    const el = rootRef.current?.querySelector(
      `[data-log-line="${activeMatchLine}"]`,
    );
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeMatchLine]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.select());
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
      } else if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [openSearch, searchOpen]);

  const nextMatch = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    setMatchIndex((i) => (i + 1) % matchLineIndices.length);
  }, [matchLineIndices.length]);

  const prevMatch = useCallback(() => {
    if (matchLineIndices.length === 0) return;
    setMatchIndex(
      (i) => (i - 1 + matchLineIndices.length) % matchLineIndices.length,
    );
  }, [matchLineIndices.length]);

  const isCustom = !PRESETS.some((p) => p.cmd === cmd);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      className="flex h-full flex-col outline-none"
    >
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

      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-xs">
          <input
            ref={searchInputRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) prevMatch();
                else nextMatch();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
              }
            }}
            placeholder="Search…"
            className="input flex-1 py-1 text-xs"
          />
          <span className="text-(--color-fg-muted) tabular-nums">
            {search
              ? matchLineIndices.length === 0
                ? "0/0"
                : `${matchIndex + 1}/${matchLineIndices.length}`
              : ""}
          </span>
          <button
            onClick={prevMatch}
            disabled={matchLineIndices.length === 0}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={nextMatch}
            disabled={matchLineIndices.length === 0}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2) disabled:opacity-40"
            title="Next (Enter)"
          >
            ↓
          </button>
          <button
            onClick={() => setSearchOpen(false)}
            className="rounded border border-(--color-border) px-2 py-0.5 hover:bg-(--color-surface-2)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      )}

      {/* Log output */}
      <div className="flex-1 overflow-auto bg-(--color-bg) p-3 font-mono text-xs text-(--color-fg)">
        {displayed.length === 0 ? (
          <div className="text-(--color-fg-muted)">
            {running ? "Waiting for output…" : "Press Start to stream a log."}
          </div>
        ) : (
          displayed.map((line, i) => (
            <LogLine
              key={i}
              index={i}
              line={line}
              filter={filter}
              search={search}
              isActiveMatch={i === activeMatchLine}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogLine({
  index,
  line,
  filter,
  search,
  isActiveMatch,
}: {
  index: number;
  line: string;
  filter: string;
  search: string;
  isActiveMatch: boolean;
}) {
  const color = line.match(/\b(error|crit|alert|emerg|fail)\b/i)
    ? "text-(--color-error)"
    : line.match(/\b(warn|warning)\b/i)
      ? "text-(--color-warn)"
      : "";

  const activeRing = isActiveMatch
    ? "bg-(--color-accent)/10 ring-1 ring-(--color-accent)/40 rounded"
    : "";

  const needle = search || filter;
  const lower = line.toLowerCase();
  const needleLower = needle.toLowerCase();

  const segments: Array<{ text: string; hit: boolean }> = [];
  if (needle) {
    let cursor = 0;
    while (cursor < line.length) {
      const idx = lower.indexOf(needleLower, cursor);
      if (idx === -1) {
        segments.push({ text: line.slice(cursor), hit: false });
        break;
      }
      if (idx > cursor)
        segments.push({ text: line.slice(cursor, idx), hit: false });
      segments.push({ text: line.slice(idx, idx + needle.length), hit: true });
      cursor = idx + needle.length;
    }
  } else {
    segments.push({ text: line, hit: false });
  }

  return (
    <div
      data-log-line={index}
      className={`whitespace-pre-wrap leading-5 ${color} ${activeRing}`}
    >
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark
            key={i}
            className="rounded bg-(--color-warn)/30 text-(--color-warn)"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  );
}
