import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type SystemInfo } from "../lib/api";
import { useAppStore } from "../store/app-store";
import { SkeletonCard } from "../components/Skeleton";

interface Props {
  deviceId: string;
}

function formatUptime(totalSec: number) {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
}

function formatBytes(bytes: number) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function SysInfoPanel({ deviceId }: Props) {
  const device = useAppStore((s) => s.devices.find((d) => d.id === deviceId));
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.systemInfo(deviceId);
      setInfo(next);
      setFetchedAt(Date.now());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    setInfo(null);
    void load();
  }, [load]);

  // Uptime is fetched once; tick it forward locally instead of re-polling.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const uptime =
    info?.uptimeSeconds != null
      ? info.uptimeSeconds + Math.max(0, Math.floor((now - fetchedAt) / 1000))
      : null;

  const rows: [string, string][] = info
    ? [
        ["Hostname", info.hostname],
        ["User", info.user],
        ["OS", info.distro || info.os],
        ["Kernel", [info.os, info.kernel].filter(Boolean).join(" ")],
        ["Architecture", info.architecture],
        ["CPU", info.cpuModel],
        ["CPU cores", info.cores != null ? String(info.cores) : ""],
        [
          "Memory",
          info.memoryBytes != null ? formatBytes(info.memoryBytes) : "",
        ],
        ["Timezone", info.timezone],
        ["Uptime", uptime != null ? formatUptime(uptime) : ""],
        ["Shell", info.shell],
      ]
    : [];

  return (
    <div className="fade-up h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">System information</h2>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="rounded border border-(--color-border) px-2 py-0.5 text-xs hover:bg-(--color-surface-2) disabled:opacity-40"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <p className="mb-4 text-xs text-(--color-fg-muted)">
          {device ? `${device.name} · ${device.host}` : deviceId}. For live
          usage, use the Metrics panel.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-(--color-error) px-4 py-2 text-xs text-(--color-error)">
            {error}
          </div>
        )}

        {!info && !error && <SkeletonCard />}

        {info && (
          <div className="overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface)">
            {rows.map(([k, v]) => (
              <div
                key={k}
                className="flex gap-3 border-b border-(--color-border) px-4 py-2 last:border-b-0"
              >
                <div className="w-32 shrink-0 text-xs text-(--color-fg-muted)">
                  {k}
                </div>
                <div className="min-w-0 break-all font-mono text-xs text-(--color-fg)">
                  {v || "unknown"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
