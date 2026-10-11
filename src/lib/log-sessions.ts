import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errorMessage } from "./api";
import { collectPanes, useAppStore } from "../store/app-store";

export const MAX_LOG_LINES = 2000;

/**
 * A log pane's stream and buffered output. Kept outside React so switching
 * workspace tabs or adding a pane (both remount panels) doesn't stop the
 * stream or lose its lines. Torn down only when the pane itself goes away.
 */
export interface LogSession {
  deviceId: string;
  lines: string[];
  running: boolean;
  error: string | null;
  paused: boolean;
  cmd: string;
  customCmd: string;
  /** Bumped on every change; React reads it via useSyncExternalStore. */
  version: number;
  streamId: string | null;
  unlisten: (() => void) | null;
  subscribers: Set<() => void>;
}

const sessions = new Map<string, LogSession>();

function notify(s: LogSession) {
  s.version++;
  for (const fn of s.subscribers) fn();
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** The pane's session, or a fresh one if it's new or the device changed. */
export function getLogSession(
  key: string,
  deviceId: string,
  defaultCmd: string,
): LogSession {
  const existing = sessions.get(key);
  if (existing && existing.deviceId === deviceId) return existing;
  if (existing) destroyLogSession(key);
  const fresh: LogSession = {
    deviceId,
    lines: [],
    running: false,
    error: null,
    paused: false,
    cmd: defaultCmd,
    customCmd: "",
    version: 0,
    streamId: null,
    unlisten: null,
    subscribers: new Set(),
  };
  sessions.set(key, fresh);
  watchPanes();
  return fresh;
}

export function subscribeLogSession(s: LogSession, fn: () => void) {
  s.subscribers.add(fn);
  return () => {
    s.subscribers.delete(fn);
  };
}

/** Apply a field change (cmd, paused, …) and re-render subscribers. */
export function updateLogSession(
  s: LogSession,
  patch: Partial<Pick<LogSession, "cmd" | "customCmd" | "paused" | "lines">>,
) {
  Object.assign(s, patch);
  notify(s);
}

function appendLine(s: LogSession, line: string) {
  if (s.paused) return;
  if (line.startsWith("[error]")) {
    s.error = line.slice(7).trim();
  } else {
    const next = [...s.lines, line];
    s.lines = next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next;
  }
  notify(s);
}

export async function stopLogStream(s: LogSession) {
  if (s.streamId) {
    await invoke("log_stream_stop", { streamId: s.streamId }).catch(() => {});
    s.streamId = null;
  }
  s.unlisten?.();
  s.unlisten = null;
  s.running = false;
  notify(s);
}

export async function startLogStream(s: LogSession, command: string) {
  await stopLogStream(s);
  s.lines = [];
  s.error = null;

  const streamId = uid();
  s.streamId = streamId;
  notify(s);

  // Subscribe to events before invoking to avoid race
  s.unlisten = await listen<string>(`log:${streamId}`, (evt) => {
    // Ignore stragglers from a stream that has since been replaced.
    if (s.streamId === streamId) appendLine(s, evt.payload);
  });

  try {
    await invoke("log_stream_start", {
      deviceId: s.deviceId,
      streamId,
      cmd: command,
    });
    s.running = true;
  } catch (e) {
    s.unlisten?.();
    s.unlisten = null;
    s.streamId = null;
    s.error = errorMessage(e);
  }
  notify(s);
}

export function destroyLogSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  void stopLogStream(s);
}

// Stop streams whose pane no longer exists anywhere (closed, workspace
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
      if (!live.has(key)) destroyLogSession(key);
    }
  });
}
