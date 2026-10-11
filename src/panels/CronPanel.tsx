import { useCallback, useEffect, useMemo, useState } from "react";
import { errorMessage, invokeWithSudo, type CommandOutput } from "../lib/api";
import {
  CRON_LOG_CMD,
  describeSchedule,
  nextRuns,
  parseCronLog,
  parseCrontab,
  parseSchedule,
  runsPerDay,
  runsForJob,
  serializeCrontab,
  type CronJob,
  type CronLine,
  type CronRunRecord,
} from "../lib/cron";
import { List, Pause, Pencil, Play, Plus, X } from "lucide-react";
import { BTN_GROUP, TOOL_BTN } from "../lib/ui";
import { useElementSize } from "../lib/use-element-size";
import { Modal } from "../components/Modal";
import { confirm } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";

interface Props {
  deviceId: string;
}

type CmdOut = { stdout: string; exitCode: number };

// ─── Formatting ──────────────────────────────────────────────────────────────

function relTime(d: Date, now: Date): string {
  const s = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(s);
  const v =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86_400
          ? `${Math.floor(abs / 3600)}h ${Math.round((abs % 3600) / 60)}m`
          : `${Math.round(abs / 86_400)}d`;
  return s >= 0 ? `in ${v}` : `${v} ago`;
}

function fmtRunsPerDay(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1) return `${Math.round(n).toLocaleString()}/day`;
  if (n * 7 >= 1) return `${Math.round(n * 7)}/week`;
  return `${Math.max(1, Math.round(n * 28))}/month`;
}

const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 min", value: "*/5 * * * *" },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Every 30 min", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily 00:00", value: "0 0 * * *" },
  { label: "Daily 09:00", value: "0 9 * * *" },
  { label: "Weekdays 09:00", value: "0 9 * * 1-5" },
  { label: "Weekly (Sun)", value: "0 0 * * 0" },
  { label: "Monthly", value: "0 0 1 * *" },
  { label: "At boot", value: "@reboot" },
];

// ─── Entry form ──────────────────────────────────────────────────────────────

function EntryForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CronJob;
  onSave: (job: CronJob) => void;
  onCancel: () => void;
}) {
  const [schedule, setSchedule] = useState(initial?.schedule ?? "0 * * * *");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [comment, setComment] = useState(initial?.comment ?? "");

  const sched = schedule.trim();
  const validSchedule = sched === "@reboot" || !!parseSchedule(sched);
  const valid = validSchedule && !!command.trim();
  const upcoming = validSchedule ? nextRuns(sched, new Date(), 3) : [];

  const submit = () => {
    if (!valid) return;
    onSave({
      kind: "job",
      schedule: sched,
      command: command.trim(),
      comment: comment.trim(),
      disabled: initial?.disabled ?? false,
    });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title={initial ? "Edit cron job" : "New cron job"}
      footer={
        <>
          <button
            onClick={onCancel}
            className="rounded border border-(--color-border) px-3 py-1.5 text-xs hover:bg-(--color-surface-2)"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid}
            className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg) hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <div>
          <label className="mb-1 block text-(--color-fg-muted)">Schedule</label>
          <div className="flex gap-2">
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              className="input flex-1 font-mono"
              placeholder="* * * * *"
              autoFocus
            />
            <select
              value={
                SCHEDULE_PRESETS.find((p) => p.value === sched)?.value ?? ""
              }
              onChange={(e) => e.target.value && setSchedule(e.target.value)}
              className="input w-40"
            >
              <option value="">Preset…</option>
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <p
            className={`mt-1 ${validSchedule ? "text-(--color-fg-muted)" : "text-(--color-error)"}`}
          >
            {validSchedule
              ? describeSchedule(sched)
              : "Invalid schedule — use 5 fields (min hour day month weekday) or @reboot"}
          </p>
          {upcoming.length > 0 && (
            <p className="mt-0.5 text-(--color-fg-muted)">
              Next:{" "}
              {upcoming
                .map((d) =>
                  d.toLocaleString(undefined, {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                  }),
                )
                .join(" · ")}
            </p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-(--color-fg-muted)">Command</label>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="input font-mono"
            placeholder="/usr/bin/python3 /home/user/backup.py"
          />
        </div>
        <div>
          <label className="mb-1 block text-(--color-fg-muted)">
            Comment (optional)
          </label>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            className="input"
            placeholder="Daily backup"
          />
        </div>
      </div>
    </Modal>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export function CronPanel({ deviceId }: Props) {
  const [lines, setLines] = useState<CronLine[]>([]);
  const [rawText, setRawText] = useState("");
  const [user, setUser] = useState("");
  const [runs, setRuns] = useState<CronRunRecord[] | null>(null);
  const [logTarget, setLogTarget] = useState<CronJob | "all" | null>(null);
  const [manual, setManual] = useState<ManualRun | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<CronJob | "new" | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Adapt to the pane: short panes fold the stat tiles into one line, narrow
  // ones drop secondary columns and use icon buttons.
  const [measureRef, size] = useElementSize();
  const short = size.h > 0 && size.h < 320;
  const narrow = size.w > 0 && size.w < 720;
  const tiny = size.w > 0 && size.w < 480;
  // Not enough height for list + log side by side: show the log on its own.
  const logFullscreen = !!logTarget && size.h > 0 && size.h < 460;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await invokeWithSudo<CmdOut>("run_remote_command", {
        deviceId,
        cmd: 'echo "##USER##$(id -un)"; crontab -l 2>/dev/null || true',
      });
      const [first, ...rest] = out.stdout.split("\n");
      const text = rest.join("\n");
      setUser(first.replace("##USER##", "").trim());
      setRawText(text);
      setLines(parseCrontab(text));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
    // Execution history is best-effort: logs may be missing or unreadable.
    try {
      const out = await invokeWithSudo<CmdOut>("run_remote_command", {
        deviceId,
        cmd: CRON_LOG_CMD,
      });
      setRuns(parseCronLog(out.stdout, new Date()));
    } catch {
      setRuns([]);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep countdowns fresh.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  const jobs = useMemo(
    () => lines.filter((l): l is CronJob => l.kind === "job"),
    [lines],
  );

  const save = async (next: CronLine[]) => {
    setSaving(true);
    setError(null);
    try {
      const content = serializeCrontab(next);
      const escaped = content.replace(/'/g, "'\\''");
      await invokeWithSudo("run_remote_command", {
        deviceId,
        cmd: `printf '%s' '${escaped}' | crontab -`,
      });
      setLines(next);
      setRawText(content);
    } catch (e) {
      setError(errorMessage(e));
      toast.error(`Saving crontab failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const addOrEdit = (updated: CronJob) => {
    const next =
      editTarget === "new"
        ? [...lines, updated]
        : lines.map((l) => (l === editTarget ? updated : l));
    setEditTarget(null);
    void save(next);
  };

  const runNow = async (job: CronJob) => {
    setRunningNow(true);
    const startedAt = new Date();
    try {
      const out = await invokeWithSudo<CommandOutput>("run_remote_command", {
        deviceId,
        cmd: job.command,
      });
      setManual({
        job,
        startedAt,
        ms: Date.now() - startedAt.getTime(),
        out,
        error: null,
      });
    } catch (e) {
      setManual({
        job,
        startedAt,
        ms: Date.now() - startedAt.getTime(),
        out: null,
        error: errorMessage(e),
      });
    } finally {
      setRunningNow(false);
    }
  };

  const toggle = (job: CronJob) =>
    void save(
      lines.map((l) => (l === job ? { ...job, disabled: !job.disabled } : l)),
    );

  const remove = async (job: CronJob) => {
    const ok = await confirm(`${job.schedule} ${job.command}`, {
      title: "Delete cron job?",
      destructive: true,
    });
    if (ok) void save(lines.filter((l) => l !== job));
  };

  // ── Stats ──
  const rows = useMemo(
    () =>
      jobs.map((job) => {
        const next = job.disabled ? undefined : nextRuns(job.schedule, now)[0];
        const jobRuns = runs ? runsForJob(job, runs) : [];
        const last = jobRuns.reduce<Date | undefined>(
          (a, r) => (!a || r.at > a ? r.at : a),
          undefined,
        );
        const dayAgo = now.getTime() - 86_400_000;
        return {
          job,
          next,
          last,
          runs24h: jobRuns.filter((r) => r.at.getTime() >= dayAgo).length,
          perDay: job.disabled ? null : runsPerDay(job.schedule, now),
        };
      }),
    [jobs, runs, now],
  );

  const active = rows.filter((r) => !r.job.disabled);
  const soonest = active
    .filter((r) => r.next)
    .sort((a, b) => a.next!.getTime() - b.next!.getTime())[0];
  const totalPerDay = active.reduce((a, r) => a + (r.perDay ?? 0), 0);
  const ran24h = runs
    ? runs.filter((r) => r.at.getTime() >= now.getTime() - 86_400_000).length
    : null;

  const plannedLabel =
    totalPerDay >= 1
      ? `${Math.round(totalPerDay).toLocaleString()}/day`
      : fmtRunsPerDay(totalPerDay || null);

  return (
    <div
      ref={measureRef}
      className="fade-up flex h-full flex-col overflow-hidden"
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-(--color-border) px-2 py-1 text-xs">
        {short ? (
          <span
            className="min-w-0 truncate text-(--color-fg-muted)"
            title={`crontab of ${user || "?"}`}
          >
            <b className="font-semibold text-(--color-fg)">{active.length}</b>{" "}
            job{active.length === 1 ? "" : "s"}
            {soonest?.next && (
              <>
                {" · next "}
                <span className="text-(--color-fg)">
                  {soonest.job.comment || shortCommand(soonest.job.command)}
                </span>{" "}
                {relTime(soonest.next, now)}
              </>
            )}
            {!tiny && (
              <>
                {" · "}
                {plannedLabel}
                {ran24h != null && runs?.length ? ` · ${ran24h} ran (24h)` : ""}
              </>
            )}
          </span>
        ) : (
          <span className="text-(--color-fg-muted)">
            crontab
            {user && (
              <>
                {" · "}
                <span className="font-mono text-(--color-fg)">{user}</span>
              </>
            )}
          </span>
        )}
        {saving && <span className="text-(--color-warn)">Saving…</span>}
        <div className={`${BTN_GROUP} ml-auto`}>
          <button
            onClick={() => setLogTarget(logTarget === "all" ? null : "all")}
            className={`${TOOL_BTN} ${logTarget === "all" ? "text-(--color-accent)" : ""}`}
            title="All runs from the cron log"
          >
            {tiny ? <List size={13} /> : "Activity"}
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className={TOOL_BTN}
            title="Reload"
          >
            {loading ? "…" : "↻"}
          </button>
          <button
            onClick={() => setEditTarget("new")}
            className={`${TOOL_BTN} text-(--color-accent)`}
          >
            {tiny ? <Plus size={13} /> : "+ New job"}
          </button>
        </div>
      </div>

      {/* Stats */}
      {!short && !logFullscreen && (
        <div className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2 border-b border-(--color-border) p-2">
          <Stat
            label="Jobs"
            value={String(active.length)}
            sub={
              jobs.length - active.length
                ? `${jobs.length - active.length} disabled`
                : "all enabled"
            }
          />
          <Stat
            label="Next run"
            value={soonest?.next ? relTime(soonest.next, now) : "—"}
            sub={
              soonest
                ? soonest.job.comment || shortCommand(soonest.job.command)
                : "nothing scheduled"
            }
          />
          <Stat label="Planned" value={plannedLabel} sub="from schedules" />
          <Stat
            label="Ran (24h)"
            value={ran24h == null ? "…" : String(ran24h)}
            sub={
              runs == null
                ? "reading cron log"
                : runs.length
                  ? "from cron log"
                  : "no cron log access"
            }
          />
        </div>
      )}

      {error && (
        <div className="px-3 py-1 text-xs text-(--color-error)">{error}</div>
      )}

      {/* Jobs */}
      <div
        className={`min-h-0 flex-1 overflow-auto ${logFullscreen ? "hidden" : ""}`}
      >
        {jobs.length === 0 && !loading ? (
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
          <ul>
            <li className="sticky top-0 z-10 flex h-6 items-center gap-2 border-b border-(--color-border) bg-(--color-bg) px-3 text-[11px] text-(--color-fg-muted)">
              <span className="w-2 shrink-0" />
              <span className="flex min-w-0 flex-1 gap-2">
                <span className="w-24 shrink-0">Schedule</span>
                {!narrow && <span className="w-40 shrink-0">Description</span>}
                <span className="min-w-0 flex-1">Command</span>
              </span>
              <span className="w-20 shrink-0 text-right">Next</span>
              {!tiny && (
                <span className="w-20 shrink-0 text-right">Last run</span>
              )}
              {!narrow && (
                <span className="w-20 shrink-0 text-right">Planned</span>
              )}
              {/* invisible copy keeps the header aligned with the buttons */}
              <JobActions invisible icons={narrow} disabled={false} />
            </li>
            {rows.map(({ job, next, last, runs24h, perDay }, i) => (
              <li
                key={i}
                className={`group flex h-8 items-center gap-2 border-b border-(--color-border) px-3 text-xs hover:bg-(--color-surface) ${job.disabled ? "opacity-55" : ""} ${logTarget === job ? "bg-(--color-surface)" : ""}`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${job.disabled ? "bg-(--color-offline)" : "bg-(--color-online)"}`}
                  title={job.disabled ? "Disabled (commented out)" : "Enabled"}
                />
                <button
                  onClick={() => setEditTarget(job)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={`${job.schedule} ${job.command}${job.comment ? `\n# ${job.comment}` : ""}\nClick to edit`}
                >
                  <span className="w-24 shrink-0 truncate font-mono">
                    {job.schedule}
                  </span>
                  {!narrow && (
                    <span className="w-40 shrink-0 truncate text-(--color-fg-muted)">
                      {job.comment || describeSchedule(job.schedule)}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-(--color-fg-muted)">
                    {job.command}
                  </span>
                </button>
                <span
                  className="w-20 shrink-0 text-right tabular-nums"
                  title={next?.toLocaleString() ?? "Not scheduled"}
                >
                  {next ? relTime(next, now) : "—"}
                </span>
                {!tiny && (
                  <span
                    className="w-20 shrink-0 text-right tabular-nums text-(--color-fg-muted)"
                    title={
                      last
                        ? `Last run ${last.toLocaleString()} · ${runs24h} run(s) in the last 24h`
                        : "No runs found in the cron log"
                    }
                  >
                    {last ? relTime(last, now) : "—"}
                  </span>
                )}
                {!narrow && (
                  <span
                    className="w-20 shrink-0 text-right tabular-nums text-(--color-fg-muted)"
                    title="Planned runs"
                  >
                    {fmtRunsPerDay(perDay)}
                  </span>
                )}
                <JobActions
                  icons={narrow}
                  disabled={job.disabled}
                  logsActive={logTarget === job}
                  onLogs={() => setLogTarget(logTarget === job ? null : job)}
                  onEdit={() => setEditTarget(job)}
                  onToggle={() => toggle(job)}
                  onDelete={() => void remove(job)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {logTarget && (
        <RunLogPane
          full={logFullscreen}
          deviceId={deviceId}
          target={logTarget}
          runs={runs}
          manual={manual}
          runningNow={runningNow}
          now={now}
          onRunNow={
            logTarget === "all" ? undefined : () => void runNow(logTarget)
          }
          onAddRedirect={
            logTarget === "all"
              ? undefined
              : () => {
                  const updated = {
                    ...logTarget,
                    command: withOutputFile(logTarget),
                  };
                  setLogTarget(updated);
                  void save(lines.map((l) => (l === logTarget ? updated : l)));
                }
          }
          onClose={() => setLogTarget(null)}
        />
      )}

      {/* Raw view footer */}
      {rawText && !short && !logFullscreen && (
        <details className="shrink-0 border-t border-(--color-border)">
          <summary className="cursor-pointer px-3 py-1 text-xs text-(--color-fg-muted) hover:text-(--color-fg)">
            Raw crontab
          </summary>
          <pre className="max-h-40 overflow-auto bg-(--color-surface) p-3 font-mono text-[11px] text-(--color-fg-muted)">
            {rawText}
          </pre>
        </details>
      )}

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

/** Per-job buttons; `icons` swaps labels for symbols in narrow panes. */
function JobActions({
  icons,
  disabled,
  logsActive,
  invisible,
  onLogs,
  onEdit,
  onToggle,
  onDelete,
}: {
  icons: boolean;
  disabled: boolean;
  logsActive?: boolean;
  /** Render as an invisible spacer (header alignment). */
  invisible?: boolean;
  onLogs?: () => void;
  onEdit?: () => void;
  onToggle?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={`${BTN_GROUP} shrink-0 ${invisible ? "invisible bg-transparent" : ""}`}
      aria-hidden={invisible}
    >
      <button
        onClick={onLogs}
        className={`${TOOL_BTN} ${logsActive ? "text-(--color-accent)" : ""}`}
        title="Run history and output"
        tabIndex={invisible ? -1 : undefined}
      >
        {icons ? <List size={13} /> : "Logs"}
      </button>
      <button
        onClick={onEdit}
        className={TOOL_BTN}
        title="Edit"
        tabIndex={invisible ? -1 : undefined}
      >
        {icons ? <Pencil size={12} /> : "Edit"}
      </button>
      <button
        onClick={onToggle}
        className={`${TOOL_BTN} ${icons ? "" : "min-w-14"}`}
        title={disabled ? "Enable" : "Disable"}
        tabIndex={invisible ? -1 : undefined}
      >
        {icons ? (
          disabled ? (
            <Play size={12} />
          ) : (
            <Pause size={12} />
          )
        ) : disabled ? (
          "Enable"
        ) : (
          "Disable"
        )}
      </button>
      <button
        onClick={onDelete}
        className={`${TOOL_BTN} hover:text-(--color-error)`}
        title="Delete"
        tabIndex={invisible ? -1 : undefined}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-(--color-surface) px-3 py-1.5">
      <div className="text-[11px] text-(--color-fg-muted)">{label}</div>
      <div className="truncate text-base font-semibold tabular-nums leading-tight">
        {value}
      </div>
      {sub && (
        <div
          className="truncate text-[11px] text-(--color-fg-muted)"
          title={sub}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/** Last path segment plus args, e.g. "/usr/bin/backup.sh --x" → "backup.sh --x". */
function shortCommand(cmd: string): string {
  const [bin, ...args] = cmd.split(/\s+/);
  return [bin.split("/").pop(), ...args].join(" ");
}

// ─── Run log pane ────────────────────────────────────────────────────────────

interface ManualRun {
  job: CronJob;
  startedAt: Date;
  ms: number;
  out: CommandOutput | null;
  error: string | null;
}

/** First file the command's output is redirected to (ignores /dev/null). */
function outputFile(command: string): string | null {
  for (const m of command.matchAll(
    /(?:^|\s)(?:\d|&)?>>?\s*("?)([^\s"&;|]+)\1/g,
  )) {
    if (m[2] !== "/dev/null" && !m[2].startsWith("&")) return m[2];
  }
  return null;
}

/** Command with stdout+stderr appended to a per-job file in $HOME. */
function withOutputFile(job: CronJob): string {
  const name =
    (job.comment || job.command.split(/\s+/)[0].split("/").pop() || "job")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "job";
  return `${job.command} >> "$HOME/cron-${name}.log" 2>&1`;
}

function RunLogPane({
  full,
  deviceId,
  target,
  runs,
  manual,
  runningNow,
  now,
  onRunNow,
  onAddRedirect,
  onClose,
}: {
  /** Take the whole panel (short panes) instead of the lower part. */
  full?: boolean;
  deviceId: string;
  target: CronJob | "all";
  runs: CronRunRecord[] | null;
  manual: ManualRun | null;
  runningNow: boolean;
  now: Date;
  onRunNow?: () => void;
  onAddRedirect?: () => void;
  onClose: () => void;
}) {
  const job = target === "all" ? null : target;

  // The job's own output, when its command redirects to a file.
  const file = job ? outputFile(job.command) : null;
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const loadFile = useCallback(async () => {
    if (!file) return;
    setFileError(null);
    try {
      const out = await invokeWithSudo<CommandOutput>("run_remote_command", {
        deviceId,
        // Unquoted on purpose so $HOME / ~ in the path expand like in cron.
        cmd: `tail -n 200 ${file} 2>&1`,
      });
      setFileText(out.stdout);
    } catch (e) {
      setFileError(errorMessage(e));
    }
  }, [deviceId, file]);
  useEffect(() => {
    setFileText(null);
    void loadFile();
  }, [loadFile]);
  const list = useMemo(() => {
    if (!runs) return [];
    const mine = job ? runsForJob(job, runs) : runs;
    return [...mine]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 100);
  }, [runs, job]);
  const showManual = manual && job && manual.job === job;
  const discarding =
    !!job &&
    !file &&
    list.some((r) =>
      r.events.some((e) => /discarding output|No MTA installed/i.test(e.text)),
    );

  return (
    <div
      className={`flex flex-col ${full ? "min-h-0 flex-1" : "h-[45%] min-h-40 shrink-0 border-t border-(--color-border)"}`}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs">
        <span className="font-semibold">
          {job ? "Run log" : "Cron activity"}
        </span>
        <span className="min-w-0 truncate font-mono text-(--color-fg-muted)">
          {job ? job.command : "all jobs"}
        </span>
        <span className="shrink-0 text-(--color-fg-muted)">
          · {list.length} run{list.length === 1 ? "" : "s"}
        </span>
        <div className={`${BTN_GROUP} ml-auto shrink-0`}>
          {onRunNow && (
            <button
              onClick={onRunNow}
              disabled={runningNow}
              className={`${TOOL_BTN} text-(--color-accent)`}
              title="Run the command now and show its output (not via cron, so cron's environment may differ)"
            >
              {runningNow ? "Running…" : "▶ Run now"}
            </button>
          )}
          <button onClick={onClose} className={TOOL_BTN} title="Close">
            {full ? "← Back" : "✕"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-xs">
        {discarding && (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-(--color-warn)/10 px-2 py-1.5 font-sans text-(--color-warn)">
            <span>
              Cron is discarding this job&apos;s output (no mail server
              installed), so what it printed isn&apos;t kept anywhere.
            </span>
            {onAddRedirect && (
              <button
                onClick={onAddRedirect}
                className="rounded bg-(--color-warn)/20 px-2 py-0.5 hover:bg-(--color-warn)/30"
                title='Append >> "$HOME/cron-<name>.log" 2>&1 to the command'
              >
                Save output to a log file
              </button>
            )}
          </div>
        )}

        {file && (
          <div className="mb-2 rounded-md bg-(--color-surface) p-2">
            <div className="mb-1 flex items-center gap-2 font-sans">
              <span className="font-semibold">Output file</span>
              <span className="min-w-0 truncate font-mono text-(--color-fg-muted)">
                {file}
              </span>
              <button
                onClick={() => void loadFile()}
                className={`${TOOL_BTN} ml-auto`}
                title="Reload"
              >
                ↻
              </button>
            </div>
            {fileError ? (
              <div className="text-(--color-error)">{fileError}</div>
            ) : fileText == null ? (
              <div className="text-(--color-fg-muted)">Loading…</div>
            ) : fileText.trim() ? (
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap">
                {fileText}
              </pre>
            ) : (
              <div className="text-(--color-fg-muted)">
                (empty — the job hasn&apos;t written anything yet)
              </div>
            )}
          </div>
        )}

        {showManual && (
          <div className="mb-2 rounded-md bg-(--color-surface) p-2">
            <div className="mb-1 flex items-center gap-2 font-sans">
              <span className="font-semibold">Manual run</span>
              <span className="text-(--color-fg-muted)">
                {manual.startedAt.toLocaleTimeString()} ·{" "}
                {(manual.ms / 1000).toFixed(1)}s
              </span>
              {manual.out && <ExitBadge status={manual.out.exitCode} />}
            </div>
            {manual.error && (
              <pre className="whitespace-pre-wrap text-(--color-error)">
                {manual.error}
              </pre>
            )}
            {manual.out && (
              <>
                {manual.out.stdout && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
                    {manual.out.stdout}
                  </pre>
                )}
                {manual.out.stderr && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-(--color-error)">
                    {manual.out.stderr}
                  </pre>
                )}
                {!manual.out.stdout && !manual.out.stderr && (
                  <div className="text-(--color-fg-muted)">(no output)</div>
                )}
              </>
            )}
          </div>
        )}

        {runs == null ? (
          <div className="py-4 text-center font-sans text-(--color-fg-muted)">
            Reading cron log…
          </div>
        ) : list.length === 0 ? (
          <div className="py-4 text-center font-sans text-(--color-fg-muted)">
            {runs.length === 0
              ? "No cron log available on this device (journal / syslog unreadable or empty)."
              : "No runs of this job in the cron log yet."}
          </div>
        ) : (
          list.map((r, i) => (
            <div
              key={`${r.pid}-${r.at.getTime()}-${i}`}
              className="border-b border-(--color-border) py-1.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 font-sans">
                <span className="tabular-nums">
                  {r.at.toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span className="text-(--color-fg-muted)">
                  {relTime(r.at, now)}
                </span>
                <span className="text-(--color-fg-muted)">
                  · {r.user} · pid {r.pid}
                </span>
                {r.endedAt && (
                  <span className="text-(--color-fg-muted)">
                    · took{" "}
                    {Math.max(
                      0,
                      Math.round((r.endedAt.getTime() - r.at.getTime()) / 1000),
                    )}
                    s
                  </span>
                )}
                {r.exitStatus != null ? (
                  <ExitBadge status={r.exitStatus} />
                ) : !r.endedAt ? (
                  <span className="text-(--color-warn)">
                    running / no end logged
                  </span>
                ) : null}
                {!job && (
                  <span className="min-w-0 truncate font-mono text-(--color-fg-muted)">
                    {r.command}
                  </span>
                )}
              </div>
              {r.events
                .filter((e) => !/ CMD \(/.test(` ${e.text}`))
                .map((e, j) => (
                  <div
                    key={j}
                    className={`whitespace-pre-wrap pl-3 ${
                      /error|fail|exit status [1-9]/i.test(e.text)
                        ? "text-(--color-error)"
                        : /pam_unix|session (opened|closed)/.test(e.text)
                          ? "text-(--color-fg-muted)/70"
                          : ""
                    }`}
                  >
                    {e.text}
                  </div>
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ExitBadge({ status }: { status: number }) {
  return (
    <span
      className={`rounded px-1.5 text-[11px] ${
        status === 0
          ? "bg-(--color-online)/15 text-(--color-online)"
          : "bg-(--color-error)/15 text-(--color-error)"
      }`}
    >
      exit {status}
    </span>
  );
}
