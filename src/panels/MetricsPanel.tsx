import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { MetricsSnapshot } from "../lib/api";

interface Props {
  deviceId: string;
}

const HISTORY = 60;

export function MetricsPanel({ deviceId }: Props) {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cpuHistory = useRef<number[]>([]);
  const memHistory = useRef<number[]>([]);
  const [tick, setTick] = useState(0);

  const poll = useCallback(async () => {
    try {
      const s = await api.metricsSnapshot(deviceId);
      cpuHistory.current.push(s.cpuPercent);
      if (cpuHistory.current.length > HISTORY) cpuHistory.current.shift();
      const memPct = s.memTotalMb ? (s.memUsedMb / s.memTotalMb) * 100 : 0;
      memHistory.current.push(memPct);
      if (memHistory.current.length > HISTORY) memHistory.current.shift();
      setSnap(s);
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(String(e));
    }
  }, [deviceId]);

  useEffect(() => {
    cpuHistory.current = [];
    memHistory.current = [];
    void poll();
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [poll]);

  if (error && !snap) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-(--color-error)">
        Could not read metrics: {error}
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-(--color-fg-muted)">
        Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="grid grid-cols-2 gap-4">
        <Card title="CPU" value={`${snap.cpuPercent.toFixed(1)}%`}>
          <Sparkline data={cpuHistory.current} max={100} key={`cpu-${tick}`} />
        </Card>
        <Card
          title="Memory"
          value={`${snap.memUsedMb} / ${snap.memTotalMb} MiB`}
          sub={
            snap.memTotalMb
              ? `${((snap.memUsedMb / snap.memTotalMb) * 100).toFixed(1)}%`
              : undefined
          }
        >
          <Sparkline data={memHistory.current} max={100} key={`mem-${tick}`} />
        </Card>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase text-(--color-fg-muted)">
          Disks
        </h3>
        <div className="space-y-2">
          {snap.disks.map((d) => (
            <div
              key={d.mount}
              className="rounded border border-(--color-border) bg-(--color-surface) p-3 text-xs"
            >
              <div className="flex justify-between">
                <span className="font-mono">{d.mount}</span>
                <span className="text-(--color-fg-muted)">
                  {d.used} / {d.total}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-(--color-surface-2)">
                <div
                  className={`h-full ${d.usePercent > 90 ? "bg-(--color-error)" : d.usePercent > 75 ? "bg-(--color-warn)" : "bg-(--color-accent)"}`}
                  style={{ width: `${Math.min(d.usePercent, 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  value,
  sub,
  children,
}: {
  title: string;
  value: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded border border-(--color-border) bg-(--color-surface) p-4">
      <div className="text-xs uppercase text-(--color-fg-muted)">{title}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-(--color-fg-muted)">{sub}</div>}
      <div className="mt-3 h-12">{children}</div>
    </div>
  );
}

function Sparkline({ data, max }: { data: number[]; max: number }) {
  if (data.length < 2) {
    return (
      <div className="flex h-full items-center text-xs text-(--color-fg-muted)">
        Collecting…
      </div>
    );
  }
  const w = 200;
  const h = 40;
  const stepX = w / (HISTORY - 1);
  const points = data
    .map((v, i) => {
      const x = (i + (HISTORY - data.length)) * stepX;
      const y = h - (Math.min(v, max) / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="h-full w-full"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
