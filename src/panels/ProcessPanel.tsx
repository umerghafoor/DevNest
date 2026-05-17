import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";
import { toast } from "../components/Toast";
import { SkeletonTable } from "../components/Skeleton";
import { usePaneSettings } from "../store/pane-settings-store";
import {
  useResizableColumns,
  ResizableTh,
  type ColumnSpec,
} from "../components/ResizableColumns";

interface Props {
  deviceId: string;
  paneId?: string;
}

const PROC_COLUMNS: ColumnSpec[] = [
  { id: "pid", defaultWidth: 80, minWidth: 50 },
  { id: "user", defaultWidth: 110, minWidth: 60 },
  { id: "cpu", defaultWidth: 80, minWidth: 50 },
  { id: "mem", defaultWidth: 80, minWidth: 50 },
  { id: "command", defaultWidth: 400, minWidth: 100 },
  { id: "actions", defaultWidth: 64, minWidth: 48 },
];

interface Process {
  pid: string;
  user: string;
  cpu: string;
  mem: string;
  command: string;
}

type SortKey = "pid" | "user" | "cpu" | "mem" | "command";
type SortDir = "asc" | "desc";

interface ProcessSettings {
  filter: string;
  sortKey: SortKey;
  sortDir: SortDir;
}

const DEFAULT_PROC_SETTINGS: ProcessSettings = {
  filter: "",
  sortKey: "cpu",
  sortDir: "desc",
};

function parsePs(output: string): Process[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
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

const SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "SIGINT",
  "SIGUSR1",
  "SIGUSR2",
];

export function ProcessPanel({ deviceId, paneId }: Props) {
  const [procs, setProcs] = useState<Process[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, updateSettings] = usePaneSettings<ProcessSettings>(
    paneId,
    DEFAULT_PROC_SETTINGS,
  );
  const { filter, sortKey: sortBy, sortDir } = settings;
  const setFilter = (v: string) => updateSettings({ filter: v });
  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      updateSettings({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    } else {
      // Numeric columns default to descending (largest first); text ascending.
      const numericDefault: SortDir =
        key === "cpu" || key === "mem" || key === "pid" ? "desc" : "asc";
      updateSettings({ sortKey: key, sortDir: numericDefault });
    }
  };
  const [killTarget, setKillTarget] = useState<Process | null>(null);
  const [killSignal, setKillSignal] = useState("SIGTERM");
  const [killing, setKilling] = useState(false);
  const [killDialogVisible, setKillDialogVisible] = useState(false);
  const { widthFor, ResizeHandle } = useResizableColumns(PROC_COLUMNS, paneId);
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

  // Animate kill dialog in
  useEffect(() => {
    if (killTarget) {
      const frame = requestAnimationFrame(() => setKillDialogVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setKillDialogVisible(false);
  }, [killTarget]);

  const closeKillDialog = () => {
    setKillDialogVisible(false);
    setTimeout(() => setKillTarget(null), 200);
  };

  const killProcess = async () => {
    if (!killTarget) return;
    setKilling(true);
    try {
      const sigNum = SIGNALS.indexOf(killSignal) >= 0 ? killSignal : "SIGTERM";
      await invoke("run_remote_command", {
        deviceId,
        cmd: `kill -${sigNum} ${killTarget.pid}`,
      });
      toast.success(`Sent ${killSignal} to PID ${killTarget.pid}`);
      closeKillDialog();
      await fetch();
    } catch (e) {
      toast.error(`Kill failed: ${errorMessage(e)}`);
      setError(errorMessage(e));
    } finally {
      setKilling(false);
    }
  };

  const sorted = useMemo(() => {
    const filtered = procs.filter(
      (p) =>
        !filter ||
        p.command.toLowerCase().includes(filter.toLowerCase()) ||
        p.user.toLowerCase().includes(filter.toLowerCase()) ||
        p.pid.includes(filter),
    );
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: Process, b: Process) => {
      switch (sortBy) {
        case "pid":
          return (Number(a.pid) - Number(b.pid)) * dir;
        case "cpu":
          return (Number(a.cpu) - Number(b.cpu)) * dir;
        case "mem":
          return (Number(a.mem) - Number(b.mem)) * dir;
        case "user":
          return a.user.localeCompare(b.user) * dir;
        case "command":
          return a.command.localeCompare(b.command) * dir;
      }
    };
    return [...filtered].sort(cmp);
  }, [procs, filter, sortBy, sortDir]);

  const SortHeader = ({
    col,
    label,
  }: {
    col: SortKey;
    label: string;
  }) => {
    const active = sortBy === col;
    return (
      <ResizableTh
        columnId={col}
        ResizeHandle={ResizeHandle}
        onClick={() => toggleSort(col)}
        className={active ? "text-(--color-fg)" : ""}
      >
        {label}
        <span className="ml-1 text-[9px]">
          {active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </ResizableTh>
    );
  };

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
          {loading
            ? "Loading…"
            : `${sorted.length} processes · refreshes every 3s`}
        </span>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-(--color-error) fade-up">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <SkeletonTable rows={8} cols={6} />
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="table-fixed border-collapse text-xs" style={{ minWidth: "100%" }}>
            <colgroup>
              <col style={{ width: widthFor("pid") }} />
              <col style={{ width: widthFor("user") }} />
              <col style={{ width: widthFor("cpu") }} />
              <col style={{ width: widthFor("mem") }} />
              <col style={{ width: widthFor("command") }} />
              <col style={{ width: widthFor("actions") }} />
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-(--color-border) bg-(--color-surface)">
              <tr>
                <SortHeader col="pid" label="PID" />
                <SortHeader col="user" label="User" />
                <SortHeader col="cpu" label="CPU %" />
                <SortHeader col="mem" label="MEM %" />
                <SortHeader col="command" label="Command" />
                <th className="relative px-3 py-2">
                  <ResizeHandle columnId="actions" />
                </th>
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
                      className={`px-3 py-1.5 font-mono tabular-nums transition-colors ${cpuNum > 50 ? "text-(--color-error)" : cpuNum > 20 ? "text-(--color-warn)" : "text-(--color-fg)"}`}
                    >
                      {p.cpu}
                    </td>
                    <td
                      className={`px-3 py-1.5 font-mono tabular-nums transition-colors ${memNum > 20 ? "text-(--color-warn)" : "text-(--color-fg)"}`}
                    >
                      {p.mem}
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono text-(--color-fg)">
                      {p.command}
                    </td>
                    <td className="px-2 py-1.5">
                      <button
                        onClick={() => setKillTarget(p)}
                        className="rounded border border-(--color-border) px-2 py-0.5 text-[10px] text-(--color-fg-muted)
                          opacity-0 transition-all hover:border-(--color-error) hover:text-(--color-error) group-hover:opacity-100"
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
            <div className="px-4 py-8 text-center text-xs text-(--color-fg-muted) fade-up">
              No processes found.
            </div>
          )}
        </div>
      )}

      {/* Kill confirmation modal — animated */}
      {killTarget && (
        <div
          className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-200
            ${killDialogVisible ? "bg-black/40" : "bg-black/0"}`}
          onClick={closeKillDialog}
        >
          <div
            className={`w-80 rounded-xl border border-(--color-border) bg-(--color-bg) p-5 shadow-2xl
              transition-all duration-200 ease-out
              ${killDialogVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-semibold">Kill process?</h3>
            <p className="mb-4 text-xs text-(--color-fg-muted)">
              <span className="font-mono text-(--color-fg)">
                {killTarget.command}
              </span>{" "}
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
                onClick={closeKillDialog}
                className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface-2) transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void killProcess()}
                disabled={killing}
                className="rounded bg-(--color-error) px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
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
