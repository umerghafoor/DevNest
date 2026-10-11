/**
 * Crontab helpers: a lossless line model (so saving never drops comments,
 * env vars or @macros), schedule parsing, next-run computation and
 * plain-English descriptions.
 */

// ─── Crontab line model ──────────────────────────────────────────────────────

export interface CronJob {
  kind: "job";
  /** Five fields, or an @macro like "@daily" / "@reboot". */
  schedule: string;
  command: string;
  /** Inline comment after " #". */
  comment: string;
  /** Commented out with a leading "# " — kept in the file, not run. */
  disabled: boolean;
}

/** Any other line (comment, blank, VAR=value…), preserved verbatim. */
export interface CronOther {
  kind: "other";
  raw: string;
}

export type CronLine = CronJob | CronOther;

const MACROS = new Set([
  "@reboot",
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
]);

const FIELD_RE = /^[\d*,\-/A-Za-z]+$/;

function parseJob(text: string, disabled: boolean): CronJob | null {
  const commentIdx = text.indexOf(" #");
  const comment = commentIdx !== -1 ? text.slice(commentIdx + 2).trim() : "";
  const clean = (commentIdx !== -1 ? text.slice(0, commentIdx) : text).trim();
  const parts = clean.split(/\s+/);

  if (MACROS.has(parts[0]?.toLowerCase())) {
    if (parts.length < 2) return null;
    return {
      kind: "job",
      schedule: parts[0].toLowerCase(),
      command: parts.slice(1).join(" "),
      comment,
      disabled,
    };
  }
  if (parts.length < 6) return null;
  const fields = parts.slice(0, 5);
  if (!fields.every((f) => FIELD_RE.test(f))) return null;
  // A disabled line must really look like a schedule, not prose.
  if (disabled && !parseSchedule(fields.join(" "))) return null;
  return {
    kind: "job",
    schedule: fields.join(" "),
    command: parts.slice(5).join(" "),
    comment,
    disabled,
  };
}

export function parseCrontab(text: string): CronLine[] {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return [];
  return lines.map((raw): CronLine => {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) return { kind: "other", raw };
    if (t.startsWith("#")) {
      const job = parseJob(t.replace(/^#\s*/, ""), true);
      return job ?? { kind: "other", raw };
    }
    // VAR=value lines (MAILTO, PATH, SHELL…)
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) return { kind: "other", raw };
    return parseJob(t, false) ?? { kind: "other", raw };
  });
}

export function serializeCrontab(lines: CronLine[]): string {
  const out = lines.map((l) => {
    if (l.kind === "other") return l.raw;
    const body = l.comment
      ? `${l.schedule} ${l.command} # ${l.comment}`
      : `${l.schedule} ${l.command}`;
    return l.disabled ? `# ${body}` : body;
  });
  return out.join("\n") + "\n";
}

// ─── Schedule parsing ────────────────────────────────────────────────────────

export interface Schedule {
  minutes: number[];
  hours: number[];
  /** Days of month 1–31. */
  dom: number[];
  /** Months 1–12. */
  months: number[];
  /** Days of week 0–6 (Sunday = 0). */
  dow: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MACRO_SCHEDULES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[],
): number[] | null {
  const values = new Set<number>();
  const toNum = (s: string) => {
    const lower = s.toLowerCase();
    const named = names?.indexOf(lower) ?? -1;
    if (named !== -1) return named + (names === MONTH_NAMES ? 1 : 0);
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = toNum(a);
      hi = toNum(b);
    } else {
      lo = toNum(range);
      // "5/15" means 5, 20, 35, 50
      hi = stepStr === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    // Day of week allows 7 as an alias for Sunday (folded to 0 below).
    if (lo < min || hi > (names === DOW_NAMES ? 7 : max) || lo > hi)
      return null;
    for (let v = lo; v <= hi; v += step)
      values.add(names === DOW_NAMES ? v % 7 : v);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseSchedule(schedule: string): Schedule | null {
  const expr = MACRO_SCHEDULES[schedule] ?? schedule;
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minutes = parseField(f[0], 0, 59);
  const hours = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const months = parseField(f[3], 1, 12, MONTH_NAMES);
  const dow = parseField(f[4], 0, 6, DOW_NAMES);
  if (!minutes || !hours || !dom || !months || !dow) return null;
  return {
    minutes,
    hours,
    dom,
    months,
    dow,
    domRestricted: f[2] !== "*",
    dowRestricted: f[4] !== "*",
  };
}

function dayMatches(s: Schedule, d: Date): boolean {
  if (!s.months.includes(d.getMonth() + 1)) return false;
  const domOk = s.dom.includes(d.getDate());
  const dowOk = s.dow.includes(d.getDay());
  // Cron rule: if both day fields are restricted, either may match.
  if (s.domRestricted && s.dowRestricted) return domOk || dowOk;
  if (s.domRestricted) return domOk;
  if (s.dowRestricted) return dowOk;
  return true;
}

/** Next `count` run times strictly after `from` (searches up to ~1 year). */
export function nextRuns(schedule: string, from: Date, count = 1): Date[] {
  const s = parseSchedule(schedule);
  if (!s) return [];
  const out: Date[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 400 && out.length < count; i++) {
    if (dayMatches(s, day)) {
      for (const h of s.hours) {
        for (const m of s.minutes) {
          const t = new Date(day);
          t.setHours(h, m, 0, 0);
          if (t > from) {
            out.push(t);
            if (out.length >= count) return out;
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** Average runs per day over the next four weeks. */
export function runsPerDay(schedule: string, from: Date): number | null {
  const s = parseSchedule(schedule);
  if (!s) return null;
  const perDay = s.hours.length * s.minutes.length;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  let total = 0;
  for (let i = 0; i < 28; i++) {
    if (dayMatches(s, day)) total += perDay;
    day.setDate(day.getDate() + 1);
  }
  return total / 28;
}

// ─── Descriptions ────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const DOW_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Plain-English summary of a schedule, falling back to the raw expression. */
export function describeSchedule(schedule: string): string {
  if (schedule === "@reboot") return "At boot";
  const expr = MACRO_SCHEDULES[schedule] ?? schedule;
  const f = expr.trim().split(/\s+/);
  const s = parseSchedule(expr);
  if (!s || f.length !== 5) return schedule;
  const [min, hour, dom, mon, dow] = f;

  const everyN = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];
  const single = (vals: number[]) => (vals.length === 1 ? vals[0] : null);

  let when: string;
  if (min === "*" && hour === "*") when = "Every minute";
  else if (everyN(min) && hour === "*") when = `Every ${everyN(min)} minutes`;
  else if (single(s.minutes) !== null && hour === "*")
    when =
      s.minutes[0] === 0 ? "Every hour" : `Hourly at :${pad(s.minutes[0])}`;
  else if (single(s.minutes) !== null && everyN(hour))
    when = `Every ${everyN(hour)} hours at :${pad(s.minutes[0])}`;
  else if (single(s.minutes) !== null && s.hours.length <= 4)
    when = `At ${s.hours.map((h) => `${pad(h)}:${pad(s.minutes[0])}`).join(", ")}`;
  else return schedule;

  if (dom === "*" && mon === "*" && dow === "*") {
    return when.startsWith("At ") ? `${when} daily` : when;
  }
  if (dom === "*" && mon === "*") {
    if (dow === "1-5") return `${when} on weekdays`;
    if (dow === "0,6" || dow === "6,0") return `${when} on weekends`;
    return `${when} on ${s.dow.map((d) => DOW_LABELS[d].slice(0, 3)).join(", ")}`;
  }
  if (dow === "*" && mon === "*" && s.dom.length <= 3) {
    const ord = (n: number) =>
      n +
      (n % 10 === 1 && n !== 11
        ? "st"
        : n % 10 === 2 && n !== 12
          ? "nd"
          : n % 10 === 3 && n !== 13
            ? "rd"
            : "th");
    return `${when} on the ${s.dom.map(ord).join(", ")} of each month`;
  }
  return schedule;
}

// ─── Cron execution log ──────────────────────────────────────────────────────

export interface CronLogEvent {
  at: Date;
  text: string;
}

/** One execution of a job, assembled from the cron daemon's log lines. */
export interface CronRunRecord {
  at: Date;
  pid: string;
  user: string;
  command: string;
  /** Every log line cron wrote for this run (session, output, errors…). */
  events: CronLogEvent[];
  endedAt?: Date;
  exitStatus?: number;
}

/**
 * Shell snippet that prints recent cron daemon log lines: the journal when
 * it has them, otherwise syslog / the cron log file.
 */
export const CRON_LOG_CMD = `out=$(journalctl -o short-iso --no-pager -n 5000 _COMM=cron _COMM=crond 2>/dev/null)
if [ -n "$out" ]; then printf '%s\\n' "$out"; else grep -h -E '(CRON|crond|cron)\\[[0-9]+\\]' /var/log/syslog /var/log/cron 2>/dev/null | tail -n 5000; fi`;

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

export function parseLogTime(line: string, now: Date): Date | null {
  const iso =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?/.exec(
      line,
    );
  if (iso) {
    const tz = iso[2]?.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") ?? "";
    const d = new Date(iso[1] + tz);
    return isNaN(d.getTime()) ? null : d;
  }
  const sys = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (sys) {
    const idx = MONTHS.indexOf(sys[1]);
    if (idx < 0 || idx % 3) return null;
    // Classic syslog has no year: assume this year unless that's in the future.
    const d = new Date(
      now.getFullYear(),
      idx / 3,
      Number(sys[2]),
      Number(sys[3]),
      Number(sys[4]),
      Number(sys[5]),
    );
    if (d.getTime() > now.getTime() + 86_400_000)
      d.setFullYear(d.getFullYear() - 1);
    return d;
  }
  return null;
}

/**
 * Turn cron daemon log lines into runs. Lines are tied together by the cron
 * child's PID: "session opened" → "(user) CMD (…)" → output / errors →
 * "session closed". Returned oldest first.
 */
export function parseCronLog(text: string, now: Date): CronRunRecord[] {
  const runs: CronRunRecord[] = [];
  const openByPid = new Map<string, CronRunRecord>();
  // Lines that arrive before their CMD line (e.g. "session opened").
  const pending = new Map<string, CronLogEvent[]>();

  for (const line of text.split("\n")) {
    const m = /\b(?:CRON|crond|cron)\[(\d+)\]:\s?(.*)$/.exec(line);
    if (!m) continue;
    const at = parseLogTime(line, now);
    if (!at) continue;
    const [, pid, msg] = m;
    const event = { at, text: msg.trim() };

    const cmd = /^\((\S+)\) CMD \((.*)\)\s*$/.exec(event.text);
    if (cmd) {
      const run: CronRunRecord = {
        at,
        pid,
        user: cmd[1],
        command: cmd[2].trim(),
        events: [...(pending.get(pid) ?? []), event],
      };
      pending.delete(pid);
      runs.push(run);
      openByPid.set(pid, run);
      continue;
    }

    const run = openByPid.get(pid);
    if (!run) {
      const list = pending.get(pid) ?? [];
      list.push(event);
      pending.set(pid, list);
      continue;
    }
    run.events.push(event);
    const exit = /exit status (\d+)/i.exec(event.text);
    if (exit) run.exitStatus = Number(exit[1]);
    if (/session closed|CMDEND/i.test(event.text)) {
      run.endedAt = at;
      openByPid.delete(pid);
    }
  }
  return runs;
}

const normCmd = (s: string) => s.replace(/\s+/g, " ").trim();

/** Runs whose logged command matches this job's command. */
export function runsForJob(
  job: CronJob,
  runs: CronRunRecord[],
): CronRunRecord[] {
  const c = normCmd(job.command);
  return runs.filter((r) => {
    const rc = normCmd(r.command);
    return rc === c || rc.includes(c) || c.includes(rc);
  });
}
