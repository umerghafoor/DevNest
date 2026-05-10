import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

interface Props {
  deviceId: string;
}

interface ListeningPort {
  proto: string;
  localAddr: string;
  port: string;
  process: string;
}

// Parse `ss -tlnp` output
// Netid  State   Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
function parseSs(output: string): ListeningPort[] {
  const lines = output.split("\n").slice(1); // skip header
  const results: ListeningPort[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // columns: Netid State Recv-Q Send-Q Local:Port Peer:Port [Process]
    const cols = trimmed.split(/\s+/);
    if (cols.length < 5) continue;

    const proto = cols[0]; // tcp / tcp6 / udp
    const localFull = cols[4] ?? ""; // e.g. 0.0.0.0:22 or [::]:80
    const portMatch = localFull.match(/:(\d+)$/);
    if (!portMatch) continue;

    const port = portMatch[1];
    const localAddr = localFull.slice(0, localFull.lastIndexOf(":"));

    // Process column looks like: users:(("sshd",pid=1234,fd=3))
    const procCol = cols.slice(6).join(" ");
    const procMatch = procCol.match(/"([^"]+)"/);
    const process = procMatch ? procMatch[1] : "";

    results.push({ proto, localAddr, port, process });
  }

  return results.sort((a, b) => Number(a.port) - Number(b.port));
}

// Parse simple nmap/portgrep-style lines like: "631/tcp  open  ipp"
function parseSimple(output: string): ListeningPort[] {
  const results: ListeningPort[] = [];
  const regex = /(\d+)\/(tcp|udp)\s+open\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(output)) !== null) {
    const port = m[1];
    const proto = m[2];
    const service = m[3];
    results.push({ proto, localAddr: "0.0.0.0", port, process: service });
  }
  return results.sort((a, b) => Number(a.port) - Number(b.port));
}

// Well-known ports that are expected — anything outside this list is highlighted
const COMMON_PORTS = new Set([
  "22", "80", "443", "3306", "5432", "6379", "8080", "8443", "27017",
]);

export function PortsPanel({ deviceId }: Props) {
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch = useCallback(async () => {
    try {
      // Try ss first; fall back to netstat
      const out = await invoke<{ stdout: string; exitCode: number }>(
        "run_remote_command",
        {
          deviceId,
          cmd: "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null",
        },
      );
      const parsed = parseSs(out.stdout);
      if (parsed.length > 0) {
        setPorts(parsed);
      } else {
        const alt = parseSimple(out.stdout);
        setPorts(alt);
      }
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [deviceId]);

  useEffect(() => {
    setLoading(true);
    void fetch().finally(() => setLoading(false));
    intervalRef.current = setInterval(() => void fetch(), 10_000);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [fetch]);

  const displayed = ports.filter(
    (p) =>
      !filter ||
      p.port.includes(filter) ||
      p.process.toLowerCase().includes(filter.toLowerCase()) ||
      p.localAddr.includes(filter),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by port, process, address…"
          className="input h-7 w-56 py-1 text-xs"
        />
        <button
          onClick={() => void fetch()}
          className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
        >
          Refresh
        </button>
        <span className="ml-auto text-xs text-(--color-fg-muted)">
          {loading ? "Loading…" : `${displayed.length} listening ports`}
        </span>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-(--color-error)">{error}</div>
      )}

      <div className="flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col style={{ width: "60px" }} />
            <col style={{ width: "80px" }} />
            <col style={{ width: "180px" }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-(--color-border) bg-(--color-surface)">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Port</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Proto</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Address</th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Process</th>
            </tr>
          </thead>
          <tbody>
            {displayed.map((p, i) => {
              const unexpected = !COMMON_PORTS.has(p.port);
              return (
                <tr
                  key={i}
                  className="border-b border-(--color-border)/50 hover:bg-(--color-surface)"
                >
                  <td className={`px-3 py-1.5 font-mono font-semibold tabular-nums ${unexpected ? "text-(--color-warn)" : "text-(--color-fg)"}`}>
                    {p.port}
                    {unexpected && (
                      <span className="ml-1.5 rounded bg-(--color-warn)/15 px-1 py-px text-[9px] font-normal uppercase text-(--color-warn)">
                        unusual
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-(--color-fg-muted)">{p.proto}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-(--color-fg-muted)">{p.localAddr}</td>
                  <td className="truncate px-3 py-1.5 font-mono text-(--color-fg)">{p.process || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {displayed.length === 0 && !loading && !error && (
          <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
            No listening ports found.
          </div>
        )}
      </div>
    </div>
  );
}
