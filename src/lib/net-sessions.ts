import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./api";
import { collectPanes, useAppStore } from "../store/app-store";
import { usePaneSettingsStore } from "../store/pane-settings-store";

/** Ping samples kept per host (5 min at 1 s). */
export const PING_WINDOW = 300;
export const SPEED_HISTORY_MAX = 20;

export interface PingResult {
  host: string;
  rttMs: number | null;
  error: string | null;
}

export interface SpeedProbe {
  ip: string | null;
  colo: string | null;
  loc: string | null;
  latencyMs: number;
  jitterMs: number;
}

interface SpeedSample {
  bytes: number;
  seconds: number;
  mbps: number;
}

export interface PingSeries {
  /** RTT in ms per tick; `null` = lost. Oldest first. */
  rtts: (number | null)[];
  error: string | null;
}

export type SpeedPhase =
  | "latency"
  | "download"
  | "upload"
  | "done"
  | "error"
  | "cancelled";

export interface SpeedRun {
  phase: SpeedPhase;
  probe: SpeedProbe | null;
  /** Mbps per measurement, in order. */
  down: number[];
  up: number[];
  downMbps: number | null;
  upMbps: number | null;
  bytes: number;
  error: string | null;
}

/** A finished test, kept in the pane's settings. */
export interface SpeedResult {
  at: number;
  downMbps: number;
  upMbps: number;
  latencyMs: number;
  jitterMs: number;
  colo: string | null;
}

/**
 * A network pane's ping loop and speed test. Kept outside React so switching
 * workspace tabs or adding a pane (both remount panels) doesn't stop the
 * monitor, lose its history or abort a running test. Torn down only when the
 * pane itself goes away.
 */
export interface NetSession {
  key: string;
  deviceId: string;
  hosts: string[];
  intervalMs: number;
  paused: boolean;
  series: Map<string, PingSeries>;
  pingError: string | null;
  speed: SpeedRun | null;
  /** Bumped on every change; React reads it via useSyncExternalStore. */
  version: number;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
  /** Bumped to abandon a running speed test. */
  speedToken: number;
  subscribers: Set<() => void>;
}

const sessions = new Map<string, NetSession>();

function notify(s: NetSession) {
  s.version++;
  for (const fn of s.subscribers) fn();
}

/** The pane's session, or a fresh one if it's new or the device changed. */
export function getNetSession(key: string, deviceId: string): NetSession {
  const existing = sessions.get(key);
  if (existing && existing.deviceId === deviceId) return existing;
  if (existing) destroyNetSession(key);
  const fresh: NetSession = {
    key,
    deviceId,
    hosts: [],
    intervalMs: 2000,
    paused: true,
    series: new Map(),
    pingError: null,
    speed: null,
    version: 0,
    timer: null,
    inflight: false,
    speedToken: 0,
    subscribers: new Set(),
  };
  sessions.set(key, fresh);
  watchPanes();
  return fresh;
}

export function subscribeNetSession(s: NetSession, fn: () => void) {
  s.subscribers.add(fn);
  return () => {
    s.subscribers.delete(fn);
  };
}

// ─── Ping ────────────────────────────────────────────────────────────────────

/** Apply the pane's ping settings; restarts the loop only when they change. */
export function configurePing(
  s: NetSession,
  cfg: { hosts: string[]; intervalMs: number; paused: boolean },
) {
  const same =
    s.intervalMs === cfg.intervalMs &&
    s.paused === cfg.paused &&
    s.hosts.join("\n") === cfg.hosts.join("\n");
  if (same && (s.timer !== null || cfg.paused)) return;

  s.hosts = [...cfg.hosts];
  s.intervalMs = cfg.intervalMs;
  s.paused = cfg.paused;
  for (const h of [...s.series.keys()]) {
    if (!s.hosts.includes(h)) s.series.delete(h);
  }
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  if (!s.paused && s.hosts.length > 0) {
    void pingTick(s);
    s.timer = setInterval(() => void pingTick(s), s.intervalMs);
  }
  notify(s);
}

export function clearPingHistory(s: NetSession) {
  s.series.clear();
  notify(s);
}

async function pingTick(s: NetSession) {
  // A slow device (lost packets wait ~2 s) shouldn't stack up requests.
  if (s.inflight || s.paused || s.hosts.length === 0) return;
  s.inflight = true;
  const hosts = s.hosts;
  try {
    const results = await invoke<PingResult[]>("net_ping", {
      deviceId: s.deviceId,
      hosts,
    });
    if (!sessions.has(s.key) || s.hosts !== hosts) return;
    for (const r of results) {
      const series = s.series.get(r.host) ?? { rtts: [], error: null };
      series.rtts = [...series.rtts, r.rttMs].slice(-PING_WINDOW);
      series.error = r.error;
      s.series.set(r.host, series);
    }
    s.pingError = null;
  } catch (e) {
    s.pingError = errorMessage(e);
  } finally {
    s.inflight = false;
  }
  notify(s);
}

export interface PingStats {
  last: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** Mean change between consecutive replies. */
  jitter: number | null;
  /** 0–100 over the kept window. */
  loss: number;
  sent: number;
}

export function pingStats(rtts: (number | null)[]): PingStats {
  const ok = rtts.filter((v): v is number => v !== null);
  let jitter: number | null = null;
  if (ok.length > 1) {
    let sum = 0;
    for (let i = 1; i < ok.length; i++) sum += Math.abs(ok[i] - ok[i - 1]);
    jitter = sum / (ok.length - 1);
  }
  return {
    last: rtts.length ? rtts[rtts.length - 1] : null,
    avg: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
    min: ok.length ? Math.min(...ok) : null,
    max: ok.length ? Math.max(...ok) : null,
    jitter,
    loss: rtts.length ? ((rtts.length - ok.length) / rtts.length) * 100 : 0,
    sent: rtts.length,
  };
}

// ─── Speed test ──────────────────────────────────────────────────────────────

const STREAMS = 4;
/** Aim for ~2 s per measurement so the number updates while it runs. */
const TARGET_SECONDS = 2;
const PHASE_MS = { download: 9000, upload: 7000 };
const MAX_SAMPLES = 6;
const MAX_BYTES = { download: 50_000_000, upload: 15_000_000 };

/** 90th percentile, ignoring the warm-up sample when there are enough. */
export function speedEstimate(samples: number[]): number | null {
  const use = samples.length > 2 ? samples.slice(1) : samples;
  if (use.length === 0) return null;
  const sorted = [...use].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

export function cancelSpeedTest(s: NetSession) {
  if (!s.speed || !isRunning(s.speed.phase)) return;
  s.speedToken++;
  s.speed = { ...s.speed, phase: "cancelled" };
  notify(s);
}

export function isRunning(phase: SpeedPhase | undefined): boolean {
  return phase === "latency" || phase === "download" || phase === "upload";
}

export async function runSpeedTest(s: NetSession) {
  if (s.speed && isRunning(s.speed.phase)) return;
  const token = ++s.speedToken;
  const live = () => s.speedToken === token && sessions.has(s.key);
  const set = (patch: Partial<SpeedRun>) => {
    if (!live() || !s.speed) return;
    s.speed = { ...s.speed, ...patch };
    notify(s);
  };
  s.speed = {
    phase: "latency",
    probe: null,
    down: [],
    up: [],
    downMbps: null,
    upMbps: null,
    bytes: 0,
    error: null,
  };
  notify(s);

  try {
    const probe = await invoke<SpeedProbe>("net_speed_probe", {
      deviceId: s.deviceId,
    });
    set({ probe, phase: "download" });

    for (const dir of ["download", "upload"] as const) {
      if (!live()) return;
      set({ phase: dir });
      const started = Date.now();
      let perStream = 1_000_000;
      const samples: number[] = [];
      while (
        live() &&
        samples.length < MAX_SAMPLES &&
        Date.now() - started < PHASE_MS[dir]
      ) {
        const r = await invoke<SpeedSample>("net_speed_sample", {
          deviceId: s.deviceId,
          upload: dir === "upload",
          bytes: perStream,
          streams: STREAMS,
        });
        if (!live() || !s.speed) return;
        samples.push(r.mbps);
        const est = speedEstimate(samples);
        set(
          dir === "download"
            ? { down: [...samples], downMbps: est, bytes: s.speed.bytes + r.bytes }
            : { up: [...samples], upMbps: est, bytes: s.speed.bytes + r.bytes },
        );
        // Size the next round to take ~TARGET_SECONDS at the rate just seen.
        const bytesPerSec = r.bytes / Math.max(r.seconds, 0.05);
        perStream = Math.round(
          Math.min(
            MAX_BYTES[dir],
            Math.max(1_000_000, (bytesPerSec * TARGET_SECONDS) / STREAMS),
          ),
        );
      }
    }
    if (!live() || !s.speed) return;
    set({ phase: "done" });
    const run = s.speed;
    if (run.downMbps !== null && run.upMbps !== null && run.probe) {
      saveResult(s.key, {
        at: Date.now(),
        downMbps: run.downMbps,
        upMbps: run.upMbps,
        latencyMs: run.probe.latencyMs,
        jitterMs: run.probe.jitterMs,
        colo: run.probe.colo,
      });
    }
  } catch (e) {
    set({ phase: "error", error: errorMessage(e) });
  }
}

/** Results live in pane settings so they survive restarts. */
export function readSpeedHistory(paneSettings: unknown): SpeedResult[] {
  const h = (paneSettings as { speedHistory?: unknown } | undefined)
    ?.speedHistory;
  return Array.isArray(h) ? (h as SpeedResult[]) : [];
}

function saveResult(paneId: string, r: SpeedResult) {
  const store = usePaneSettingsStore.getState();
  const prev = readSpeedHistory(store.byPaneId[paneId]);
  store.patch(paneId, { speedHistory: [r, ...prev].slice(0, SPEED_HISTORY_MAX) });
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function destroyNetSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.speedToken++;
}

// Stop loops whose pane no longer exists anywhere (closed, workspace
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
      if (!live.has(key)) destroyNetSession(key);
    }
  });
}
