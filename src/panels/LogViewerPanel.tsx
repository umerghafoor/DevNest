import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  destroyLogSession,
  getLogSession,
  startLogStream,
  stopLogStream,
  subscribeLogSession,
  updateLogSession,
} from "../lib/log-sessions";
import { usePaneSettings } from "../store/pane-settings-store";
import { BTN_GROUP, SMALL_INPUT, TOOL_BTN, segBtn } from "../lib/ui";

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

export function LogViewerPanel({ deviceId, paneId }: Props) {
  const [settings, updateSettings] = usePaneSettings(paneId, { filter: "" });
  const filter = settings.filter;
  const setFilter = (v: string) => updateSettings({ filter: v });

  // The stream and its lines live in a registry keyed by pane, so they keep
  // going when this panel unmounts (tab switch, adding a pane). Without a
  // pane id there's nothing stable to key on; fall back to one per mount.
  const transientKey = useRef(
    `transient-${Math.random().toString(36).slice(2, 10)}`,
  );
  const sessionKey = paneId ?? transientKey.current;
  const session = getLogSession(sessionKey, deviceId, PRESETS[0].cmd);
  const subscribe = useCallback(
    (fn: () => void) => subscribeLogSession(session, fn),
    [session],
  );
  useSyncExternalStore(subscribe, () => session.version);
  const { lines, paused, cmd, customCmd, running, error } = session;
  const setCmd = (v: string) => updateLogSession(session, { cmd: v });
  const setCustomCmd = (v: string) =>
    updateLogSession(session, { customCmd: v });

  useEffect(() => {
    if (paneId) return;
    return () => destroyLogSession(sessionKey);
  }, [paneId, sessionKey]);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
      {/* Toolbar — one slim row */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-(--color-border) px-2 py-1 text-xs">
        {/* Presets as a segmented control */}
        <div className={BTN_GROUP}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => setCmd(p.cmd)}
              className={segBtn(cmd === p.cmd)}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => setCmd(customCmd || "")}
            className={segBtn(isCustom)}
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
            className={`${SMALL_INPUT} min-w-40 flex-1 font-mono`}
          />
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className={`${SMALL_INPUT} w-36`}
          />
          <div className={BTN_GROUP}>
            {running ? (
              <button
                onClick={() => void stopLogStream(session)}
                className={TOOL_BTN}
                title="Stop streaming"
              >
                ■ Stop
              </button>
            ) : (
              <button
                onClick={() => void startLogStream(session, cmd)}
                disabled={!cmd.trim()}
                className={`${TOOL_BTN} text-(--color-accent)`}
                title="Start streaming"
              >
                ▶ Start
              </button>
            )}
            <button
              onClick={() => updateLogSession(session, { paused: !paused })}
              className={`${TOOL_BTN} ${paused ? "text-(--color-warn)" : ""}`}
              title={
                paused
                  ? "Resume"
                  : "Pause (keeps streaming, stops adding lines)"
              }
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={() => updateLogSession(session, { lines: [] })}
              className={TOOL_BTN}
              title="Clear output"
            >
              Clear
            </button>
          </div>
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

// ─── Line coloring ──────────────────────────────────────────────────────────

const C = {
  time: "text-sky-700 dark:text-sky-400",
  host: "text-(--color-fg-muted)",
  proc: "text-violet-700 dark:text-violet-400",
  pid: "text-(--color-fg-muted)",
  module: "text-teal-700 dark:text-teal-400",
  ip: "text-fuchsia-700 dark:text-fuchsia-400",
  error: "font-semibold text-(--color-error)",
  warn: "font-semibold text-(--color-warn)",
  info: "font-semibold text-(--color-online)",
  debug: "font-semibold text-(--color-fg-muted)",
};

interface Seg {
  text: string;
  cls: string;
}

// "Oct 11 13:41:10 host proc[123]: " (syslog / journalctl)
const SYSLOG_PREFIX =
  /^([A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2})(\s+)(\S+)(\s+)([^\s[:]+)(\[\d+\])?(:\s?)/;
// "2026-10-11 13:41:21,397" / "2026-10-11T13:41:21.397Z" at the start
const ISO_PREFIX =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;
// "[   12.345678]" (dmesg)
const DMESG_PREFIX = /^(\[\s*\d+\.\d+\])/;

// Tokens inside the message body, in priority order.
const INLINE =
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)|\b(ERROR|ERR|CRITICAL|CRIT|FATAL|EMERG|ALERT|FAIL(?:ED)?)\b|\b(WARNING|WARN)\b|\b(INFO|NOTICE)\b|\b(DEBUG|TRACE)\b|\b(\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)\b|\b([a-z_][\w]*(?:\.[a-z_][\w]*){2,})\b/g;

function tokenize(line: string, base: string): Seg[] {
  const segs: Seg[] = [];
  let rest = line;

  const sys = SYSLOG_PREFIX.exec(rest);
  if (sys) {
    const [all, time, s1, host, s2, proc, pid, colon] = sys;
    segs.push(
      { text: time, cls: C.time },
      { text: s1, cls: "" },
      { text: host, cls: C.host },
      { text: s2, cls: "" },
      { text: proc, cls: C.proc },
    );
    if (pid) segs.push({ text: pid, cls: C.pid });
    segs.push({ text: colon, cls: C.pid });
    rest = rest.slice(all.length);
  } else {
    const pre = ISO_PREFIX.exec(rest) ?? DMESG_PREFIX.exec(rest);
    if (pre) {
      segs.push({ text: pre[1], cls: C.time });
      rest = rest.slice(pre[1].length);
    }
  }

  let last = 0;
  for (const m of rest.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) segs.push({ text: rest.slice(last, i), cls: base });
    const cls = m[1]
      ? C.time
      : m[2]
        ? C.error
        : m[3]
          ? C.warn
          : m[4]
            ? C.info
            : m[5]
              ? C.debug
              : m[6]
                ? C.ip
                : C.module;
    segs.push({ text: m[0], cls });
    last = i + m[0].length;
  }
  if (last < rest.length) segs.push({ text: rest.slice(last), cls: base });
  return segs;
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
  // Message text keeps a tint on error / warning lines; tokens get their own
  // colors on top.
  const base = /\b(error|crit|alert|emerg|fail(ed)?)\b/i.test(line)
    ? "text-(--color-error)"
    : /\b(warn|warning)\b/i.test(line)
      ? "text-(--color-warn)"
      : "";

  const activeRing = isActiveMatch
    ? "bg-(--color-accent)/10 ring-1 ring-(--color-accent)/40 rounded"
    : "";

  const needle = (search || filter).toLowerCase();
  const segs = tokenize(line, base);

  return (
    <div
      data-log-line={index}
      className={`whitespace-pre-wrap leading-5 ${activeRing}`}
    >
      {segs.map((seg, i) => (
        <span key={i} className={seg.cls}>
          {needle ? highlight(seg.text, needle) : seg.text}
        </span>
      ))}
    </div>
  );
}

/** Wrap filter / search hits inside one colored segment. */
function highlight(text: string, needle: string): React.ReactNode {
  const lower = text.toLowerCase();
  if (!lower.includes(needle)) return text;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx === -1) {
      out.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(
      <mark
        key={idx}
        className="rounded bg-(--color-warn)/30 text-(--color-fg)"
      >
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    cursor = idx + needle.length;
  }
  return out;
}
