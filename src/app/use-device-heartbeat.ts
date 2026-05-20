import { useEffect, useRef } from "react";
import { api, errorMessage } from "../lib/api";
import { useAppStore } from "../store/app-store";
import { toast } from "../components/Toast";

const HEARTBEAT_MS = 15_000;
const BACKOFF_MS = [15_000, 30_000, 60_000, 60_000];

type DeviceState = {
  attempts: number;
  nextRetryAt: number;
  inFlight: boolean;
  // Only auto-reconnect devices that have successfully connected at least once
  // this session — avoids surprising the user by auto-connecting devices they
  // have never opened.
  hasConnected: boolean;
};

/**
 * Per-device liveness probe + reconnect with exponential backoff.
 * - Every HEARTBEAT_MS ticks each non-localhost device.
 * - If a "connected" device fails its ping, mark offline and try to reconnect.
 * - If an "offline" device has a stored attempt count, retry once its backoff
 *   window has elapsed (15s, 30s, 60s, 60s…).
 * - "connecting" devices are skipped — the in-flight connect owns the status.
 */
export function useDeviceHeartbeat() {
  const devices = useAppStore((s) => s.devices);
  const statuses = useAppStore((s) => s.statuses);
  const setStatus = useAppStore((s) => s.setStatus);
  const stateRef = useRef<Map<string, DeviceState>>(new Map());

  useEffect(() => {
    const tick = async () => {
      const now = Date.now();
      const snapshot = useAppStore.getState();
      const ds = snapshot.devices.filter((d) => !d.isLocalhost);

      for (const d of ds) {
        const status = snapshot.statuses[d.id] ?? "offline";
        if (status === "connecting") continue;

        let entry = stateRef.current.get(d.id);
        if (!entry) {
          entry = {
            attempts: 0,
            nextRetryAt: 0,
            inFlight: false,
            hasConnected: false,
          };
          stateRef.current.set(d.id, entry);
        }
        if (entry.inFlight) continue;

        if (status === "connected") {
          entry.hasConnected = true;
          entry.inFlight = true;
          try {
            const result = await api.devicePing(d.id);
            if (result === "connected") {
              entry.attempts = 0;
              entry.nextRetryAt = 0;
            } else {
              setStatus(d.id, "offline");
              entry.attempts = 0;
              entry.nextRetryAt = now;
            }
          } catch {
            setStatus(d.id, "offline");
            entry.attempts = 0;
            entry.nextRetryAt = now;
          } finally {
            entry.inFlight = false;
          }
          continue;
        }

        // status is "offline" or "error" — try reconnect once backoff elapses,
        // but only if this device was connected at least once this session.
        if (!entry.hasConnected) continue;
        if (now < entry.nextRetryAt) continue;

        entry.inFlight = true;
        setStatus(d.id, "connecting");
        try {
          await api.connectDevice(d.id);
          setStatus(d.id, "connected");
          entry.attempts = 0;
          entry.nextRetryAt = 0;
          toast.success(`Reconnected to ${d.name}`);
        } catch (e) {
          setStatus(d.id, "offline");
          const delay =
            BACKOFF_MS[Math.min(entry.attempts, BACKOFF_MS.length - 1)];
          entry.attempts += 1;
          entry.nextRetryAt = Date.now() + delay;
          // Only surface the first failure per session to avoid spam.
          if (entry.attempts === 1) {
            toast.error(`Lost connection to ${d.name}: ${errorMessage(e)}`);
          }
        } finally {
          entry.inFlight = false;
        }
      }
    };

    const id = window.setInterval(() => void tick(), HEARTBEAT_MS);
    return () => window.clearInterval(id);
    // Intentionally re-evaluate when the device list changes so newly added
    // devices participate, and when status keys change so the next tick sees
    // fresh data. Reading via getState() inside the tick keeps the dep set
    // small without going stale.
  }, [devices, statuses, setStatus]);

  // Drop heartbeat state for devices that no longer exist.
  useEffect(() => {
    const ids = new Set(devices.map((d) => d.id));
    for (const key of Array.from(stateRef.current.keys())) {
      if (!ids.has(key)) stateRef.current.delete(key);
    }
  }, [devices]);
}
