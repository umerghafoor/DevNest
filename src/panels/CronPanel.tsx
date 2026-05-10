import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../lib/api";

interface Props {
  deviceId: string;
}

interface CronEntry {
  schedule: string; // "* * * * *"
  command: string;
  comment: string; // inline comment after #
  raw: string; // original line
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseCrontab(text: string): CronEntry[] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("@reboot"))
    .map((line) => {
      // Strip trailing inline comment
      const commentIdx = line.indexOf(" #");
      const comment = commentIdx !== -1 ? line.slice(commentIdx + 2).trim() : "";
      const clean = commentIdx !== -1 ? line.slice(0, commentIdx).trim() : line.trim();

      // 5 schedule fields + rest is command
      const parts = clean.split(/\s+/);
      if (parts.length < 6) return null;
      const schedule = parts.slice(0, 5).join(" ");
      const command = parts.slice(5).join(" ");
      return { schedule, command, comment, raw: line };
    })
    .filter(Boolean) as CronEntry[];
}

function serializeCrontab(entries: CronEntry[]): string {
  return (
    entries
      .map((e) =>
        e.comment ? `${e.schedule} ${e.command} # ${e.comment}` : `${e.schedule} ${e.command}`,
      )
      .join("\n") + "\n"
  );
}

// ─── Human-readable schedule ──────────────────────────────────────────────────

function describeSchedule(s: string): string {
  const presets: Record<string, string> = {
    "* * * * *": "Every minute",
    "0 * * * *": "Every hour",
    "0 0 * * *": "Every day at midnight",
    "0 9 * * *": "Every day at 9 am",
    "0 0 * * 0": "Every Sunday at midnight",
    "0 0 1 * *": "1st of every month",
    "*/5 * * * *": "Every 5 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
  };
  return presets[s] ?? s;
}

const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 min", value: "*/5 * * * *" },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Every 30 min", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily 00:00", value: "0 0 * * *" },
  { label: "Daily 09:00", value: "0 9 * * *" },
  { label: "Weekly (Sun)", value: "0 0 * * 0" },
  { label: "Monthly", value: "0 0 1 * *" },
];

// ─── Entry form ───────────────────────────────────────────────────────────────

interface EntryFormProps {
  initial?: CronEntry;
  onSave: (e: CronEntry) => void;
  onCancel: () => void;
}

function EntryForm({ initial, onSave, onCancel }: EntryFormProps) {
  const [schedule, setSchedule] = useState(initial?.schedule ?? "0 * * * *");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [comment, setComment] = useState(initial?.comment ?? "");

  const valid = schedule.trim().split(/\s+/).length === 5 && command.trim();

  const submit = () => {
    if (!valid) return;
    onSave({
      schedule: schedule.trim(),
      command: command.trim(),
      comment: comment.trim(),
      raw: "",
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[480px] rounded-xl border border-(--color-border) bg-(--color-bg) p-5 shadow-2xl">
        <h3 className="mb-4 text-sm font-semibold">
          {initial ? "Edit cron job" : "New cron job"}
        </h3>

        <div className="mb-3">
          <label className="mb-1 block text-xs text-(--color-fg-muted)">Schedule</label>
          <div className="flex gap-2">
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="input flex-1 font-mono text-xs py-1.5"
              placeholder="* * * * *"
            />
            <select
              value={SCHEDULE_PRESETS.find((p) => p.value === schedule)?.value ?? ""}
              onChange={(e) => e.target.value && setSchedule(e.target.value)}
              className="input w-36 py-1.5 text-xs"
            >
              <option value="">Preset…</option>
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <p className="mt-1 text-[11px] text-(--color-fg-muted)">
            {describeSchedule(schedule)}
          </p>
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-xs text-(--color-fg-muted)">Command</label>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="input font-mono text-xs py-1.5"
            placeholder="/usr/bin/python3 /home/user/backup.py"
          />
        </div>

        <div className="mb-5">
          <label className="mb-1 block text-xs text-(--color-fg-muted)">Comment (optional)</label>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="input text-xs py-1.5"
            placeholder="Daily backup"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface-2)"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid}
            className="rounded bg-(--color-accent) px-3 py-1.5 text-xs text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function CronPanel({ deviceId }: Props) {
  const [entries, setEntries] = useState<CronEntry[]>([]);
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<CronEntry | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await invoke<{ stdout: string; exitCode: number }>(
        "run_remote_command",
        { deviceId, cmd: "crontab -l 2>/dev/null || true" },
      );
      setRawText(out.stdout);
      setEntries(parseCrontab(out.stdout));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);

  const save = async (newEntries: CronEntry[]) => {
    setSaving(true);
    setError(null);
    try {
      const content = serializeCrontab(newEntries);
      // Pipe new crontab via echo | crontab -
      const escaped = content.replace(/'/g, "'\\''");
      await invoke("run_remote_command", {
        deviceId,
        cmd: `printf '%s' '${escaped}' | crontab -`,
      });
      setEntries(newEntries);
      setRawText(content);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const addOrEdit = (updated: CronEntry) => {
    let next: CronEntry[];
    if (editTarget === "new") {
      next = [...entries, updated];
    } else {
      next = entries.map((e) => (e === editTarget ? updated : e));
    }
    setEditTarget(null);
    void save(next);
  };

  const remove = (entry: CronEntry) => {
    if (!confirm(`Delete cron job?\n${entry.schedule} ${entry.command}`)) return;
    void save(entries.filter((e) => e !== entry));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-(--color-border) px-3 py-2">
        <span className="text-xs text-(--color-fg-muted)">
          {loading ? "Loading…" : `${entries.length} job${entries.length !== 1 ? "s" : ""}`}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void load()}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-surface-2)"
          >
            Refresh
          </button>
          <button
            onClick={() => setEditTarget("new")}
            className="rounded bg-(--color-accent) px-2 py-1 text-xs text-(--color-accent-fg) hover:opacity-90"
          >
            + New job
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-(--color-error)">{error}</div>
      )}

      {saving && (
        <div className="px-4 py-1 text-xs text-(--color-warn)">Saving…</div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-auto">
        {entries.length === 0 && !loading ? (
          <div className="px-4 py-12 text-center text-xs text-(--color-fg-muted)">
            No cron jobs.{" "}
            <button
              onClick={() => setEditTarget("new")}
              className="underline hover:text-(--color-fg)"
            >
              Add one
            </button>
          </div>
        ) : (
          <table className="w-full table-fixed border-collapse text-xs">
            <colgroup>
              <col style={{ width: "180px" }} />
              <col />
              <col style={{ width: "130px" }} />
              <col style={{ width: "80px" }} />
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-(--color-border) bg-(--color-surface)">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Schedule</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Command</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-(--color-fg-muted)">Description</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={i}
                  className="group border-b border-(--color-border)/50 hover:bg-(--color-surface)"
                >
                  <td className="px-3 py-2 font-mono text-(--color-fg)">{entry.schedule}</td>
                  <td className="truncate px-3 py-2 font-mono text-(--color-fg-muted)">{entry.command}</td>
                  <td className="truncate px-3 py-2 text-(--color-fg-muted) italic">
                    {entry.comment || describeSchedule(entry.schedule)}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => setEditTarget(entry)}
                        className="rounded border border-(--color-border) px-1.5 py-0.5 text-[10px] hover:bg-(--color-surface-2)"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => remove(entry)}
                        className="rounded border border-(--color-border) px-1.5 py-0.5 text-[10px] hover:border-(--color-error) hover:text-(--color-error)"
                      >
                        ×
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Raw view footer */}
      {rawText && (
        <details className="border-t border-(--color-border)">
          <summary className="cursor-pointer px-3 py-1.5 text-xs text-(--color-fg-muted) hover:text-(--color-fg)">
            Raw crontab
          </summary>
          <pre className="max-h-40 overflow-auto bg-(--color-surface) p-3 text-[11px] font-mono text-(--color-fg-muted)">
            {rawText}
          </pre>
        </details>
      )}

      {/* Edit / new modal */}
      {editTarget !== null && (
        <EntryForm
          initial={editTarget === "new" ? undefined : editTarget}
          onSave={addOrEdit}
          onCancel={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
