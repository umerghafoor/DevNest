import { useEffect, useState } from "react";

interface BrowserInfo {
  platform: string;
  userAgent: string;
  language: string;
  online: boolean;
  cores: number;
  memoryGb: number | null;
  screen: string;
  timezone: string;
  appUptime: string;
}

function formatUptime(ms: number) {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function readInfo(startedAt: number): BrowserInfo {
  const navAny = navigator as typeof navigator & { deviceMemory?: number };
  return {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    cores: navigator.hardwareConcurrency,
    memoryGb:
      typeof navAny.deviceMemory === "number" ? navAny.deviceMemory : null,
    screen: `${window.screen.width}×${window.screen.height} @ ${window.devicePixelRatio}x`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    appUptime: formatUptime(Date.now() - startedAt),
  };
}

export function SysInfoPanel() {
  const [startedAt] = useState(() => Date.now());
  const [info, setInfo] = useState<BrowserInfo>(() => readInfo(startedAt));

  useEffect(() => {
    const t = setInterval(() => setInfo(readInfo(startedAt)), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  const rows: [string, string][] = [
    ["Platform", info.platform],
    ["Language", info.language],
    ["Timezone", info.timezone],
    ["CPU cores", String(info.cores)],
    ["Memory", info.memoryGb ? `~${info.memoryGb} GB` : "unknown"],
    ["Screen", info.screen],
    ["Network", info.online ? "online" : "offline"],
    ["App uptime", info.appUptime],
    ["User agent", info.userAgent],
  ];

  return (
    <div className="fade-up h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl">
        <h2 className="mb-1 text-sm font-semibold">System information</h2>
        <p className="mb-4 text-xs text-(--color-fg-muted)">
          Browser-side info. For deeper host metrics, use the Metrics panel.
        </p>
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
                {v}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
