import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

interface Props {
  deviceId: string;
}

interface Process {
  pid: string;
  user: string;
  cpu: string;
  mem: string;
  command: string;
}

type SortKey = "cpu" | "mem" | "pid";

// Parse `ps -eo pid,user,%cpu,%mem,comm --no-headers` output
function parsePs(output: string): Process[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Fields: PID USER %CPU %MEM COMMAND (COMMAND may have spaces)
      const parts = line.split(/\s+/);
      return {
        pid: parts[0] ?? "",
        user: parts[1] ?? "",
        cpu: parts[2] ?? "0",
        mem: parts[3] ?? "0",
        command: parts.slice(4).join(" "),
      };
    })
    .filter((p) => p.pid !== "");
}

const SIGNALS = ["SIGTERM", "SIGKILL", "SIGHUP", "SIGINT", "SIGUSR1", "SIGUSR2"];

export function ProcessPanel({ deviceId }: Props) {
  const [procs, setProcs] = useState<Process[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("cpu");
  const [filter, setFilter] = useState("");
  const [killTarget, setKillTarget] = useState<Process | null>(null);
  const [killSignal, setKillSignal] = useState("SIGTERM");
  const [killing, setKilling] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch = useCallback(async () => {
    try {
      const out = await invoke<{ stdout: string; exitCode: number }>(
        "run_remote_command",
        {
          deviceId,
          cmd: "ps -eo pid,user,%cpu,%mem,comm --no-headers --sort=-%cpu 2>/dev/null | head -100",
        },
      );
      setProcs(parsePs(out.stdout));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [deviceId]);

  const startPolling = useCallback(async () => {
    setLoading(true);
    await fetch();
    setLoading(false);
    intervalRef.current = setInterval(() => void fetch(), 3000);
  }, [fetch]);

  useEffect(() => {
    void startPolling();
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, [startPolling]);

  const killProcess = async () => {
    if (!killTarget) return;
    setKilling(true);
    try {
      const sigNum = SIGNALS.indexOf(killSignal) >= 0 ? killSignal : "SIGTERM";
      await invoke("run_remote_command", {
        deviceId,
        cmd: `kill -${sigNum} ${killTarget.pid}`,
      });
      setKillTarget(null);
      await fetch();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setKilling(false);
    }
  };

  const sorted = [...procs]
    .filter(
      (p) =>
        !filter ||
        p.command.toLowerCase().includes(filter.toLowerCase()) ||
        p.user.toLowerCase().includes(filter.toLowerCase()) ||
        p.pid.includes(filter),
    )
    .sort((a, b) => {
      if (sortBy === "pid") return Number(a.pid) - Number(b.pid);
      if (sortBy === "mem") return Number(b.mem) - Number(a.mem);
      return Number(b.cpu) - Number(a.cpu);
    });

  const SortHeader = ({
    col,
    label,
    className = "",
  }: {
    col: SortKey;
    label: string;
    className?: string;
  }) => (
    <th
      className={`cursor-pointer select-none px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted) hover:text-(--color-fg) ${className}`}
      onClick={() => setSortBy(col)}
    >
      {label}
      {sortBy === col && <span className="ml-1 opacity-60">↓</span>}
    </th>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, user, PID…"
          className="input h-7 w-56 py-1 text-xs"
        />
        <span className="ml-auto text-xs text-(--color-fg-muted)">
          {loading ? "Loading…" : `${sorted.length} processes · refreshes every 3s`}
        </span>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-(--color-error)">{error}</div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col style={{ width: "70px" }} />
            <col style={{ width: "100px" }} />
            <col style={{ width: "70px" }} />
            <col style={{ width: "70px" }} />
            <col />
            <col style={{ width: "60px" }} />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-(--color-border) bg-(--color-surface)">
            <tr>
              <SortHeader col="pid" label="PID" />
              <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">
                User
              </th>
              <SortHeader col="cpu" label="CPU %" />
              <SortHeader col="mem" label="MEM %" />
              <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">
                Command
              </th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const cpuNum = Number(p.cpu);
              const memNum = Number(p.mem);
              return (
                <tr
                  key={p.pid}
                  className="group border-b border-(--color-border)/50 hover:bg-(--color-surface)"
                >
                  <td className="px-3 py-1.5 font-mono text-(--color-fg-muted)">
                    {p.pid}
                  </td>
                  <td className="truncate px-3 py-1.5 text-(--color-fg-muted)">
                    {p.user}
                  </td>
                  <td
                    className={`px-3 py-1.5 font-mono tabular-nums ${cpuNum > 50 ? "text-(--color-error)" : cpuNum > 20 ? "text-(--color-warn)" : "text-(--color-fg)"}`}
                  >
                    {p.cpu}
                  </td>
                  <td
                    className={`px-3 py-1.5 font-mono tabular-nums ${memNum > 20 ? "text-(--color-warn)" : "text-(--color-fg)"}`}
                  >
                    {p.mem}
                  </td>
                  <td className="truncate px-3 py-1.5 font-mono text-(--color-fg)">
                    {p.command}
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => setKillTarget(p)}
                      className="rounded border border-(--color-border) px-2 py-0.5 text-[10px] text-(--color-fg-muted) opacity-0 transition-opacity hover:border-(--color-error) hover:text-(--color-error) group-hover:opacity-100"
                    >
                      Kill
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && !loading && !error && (
          <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">
            No processes found.
          </div>
        )}
      </div>

      {/* Kill confirmation modal */}
      {killTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-xl border border-(--color-border) bg-(--color-bg) p-5 shadow-2xl">
            <h3 className="mb-1 text-sm font-semibold">Kill process?</h3>
            <p className="mb-4 text-xs text-(--color-fg-muted)">
              <span className="font-mono text-(--color-fg)">{killTarget.command}</span>{" "}
              (PID {killTarget.pid})
            </p>
            <div className="mb-4">
              <label className="mb-1 block text-xs text-(--color-fg-muted)">
                Signal
              </label>
              <select
                value={killSignal}
                onChange={(e) => setKillSignal(e.target.value)}
                className="input text-xs py-1.5"
              >
                {SIGNALS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setKillTarget(null)}
                className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface-2)"
              >
                Cancel
              </button>
              <button
                onClick={() => void killProcess()}
                disabled={killing}
                className="rounded bg-(--color-error) px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
              >
                {killing ? "Killing…" : `Send ${killSignal}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
