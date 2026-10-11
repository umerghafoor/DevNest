import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  nextRuns,
  parseCronLog,
  parseCrontab,
  runsForJob,
  parseSchedule,
  runsPerDay,
  serializeCrontab,
  type CronJob,
} from "./cron";

const SAMPLE = `# m h dom mon dow command
MAILTO=admin@example.com
PATH=/usr/local/bin:/usr/bin:/bin

*/5 * * * * /usr/bin/backup.sh # every five
@reboot /home/beetle/start.sh
# 0 3 * * * /usr/bin/disabled-job.sh
# This is just a note about the jobs below
30 9 * * 1-5 python3 report.py
`;

describe("parseCrontab / serializeCrontab", () => {
  it("round-trips a crontab without losing comments, env vars or macros", () => {
    expect(serializeCrontab(parseCrontab(SAMPLE))).toBe(SAMPLE);
  });

  it("recognises jobs, @macros and commented-out (disabled) jobs", () => {
    const jobs = parseCrontab(SAMPLE).filter(
      (l): l is CronJob => l.kind === "job",
    );
    expect(jobs.map((j) => [j.schedule, j.disabled])).toEqual([
      ["*/5 * * * *", false],
      ["@reboot", false],
      ["0 3 * * *", true],
      ["30 9 * * 1-5", false],
    ]);
    expect(jobs[0].comment).toBe("every five");
  });

  it("toggling disabled only changes that line", () => {
    const lines = parseCrontab(SAMPLE);
    const job = lines.find(
      (l): l is CronJob => l.kind === "job" && l.schedule === "30 9 * * 1-5",
    )!;
    job.disabled = true;
    const out = serializeCrontab(lines);
    expect(out).toContain("# 30 9 * * 1-5 python3 report.py");
    expect(out).toContain("MAILTO=admin@example.com");
    expect(out).toContain("# This is just a note about the jobs below");
  });

  it("treats an empty crontab as no lines", () => {
    expect(parseCrontab("")).toEqual([]);
  });
});

describe("schedules", () => {
  it("parses ranges, steps, lists and names", () => {
    const s = parseSchedule("5/20 9-17/4 1,15 jan-mar mon-fri")!;
    expect(s.minutes).toEqual([5, 25, 45]);
    expect(s.hours).toEqual([9, 13, 17]);
    expect(s.dom).toEqual([1, 15]);
    expect(s.months).toEqual([1, 2, 3]);
    expect(s.dow).toEqual([1, 2, 3, 4, 5]);
    expect(parseSchedule("0 0 * * 7")!.dow).toEqual([0]);
    expect(parseSchedule("61 * * * *")).toBeNull();
  });

  it("computes the next run", () => {
    const from = new Date(2026, 9, 11, 13, 41, 30); // Sun 11 Oct 2026
    expect(nextRuns("*/5 * * * *", from)[0]).toEqual(
      new Date(2026, 9, 11, 13, 45),
    );
    // Weekdays only: Sunday → Monday 09:30
    expect(nextRuns("30 9 * * 1-5", from)[0]).toEqual(
      new Date(2026, 9, 12, 9, 30),
    );
    expect(nextRuns("@reboot", from)).toEqual([]);
  });

  it("estimates runs per day", () => {
    const from = new Date(2026, 9, 11);
    expect(runsPerDay("*/5 * * * *", from)).toBe(288);
    expect(runsPerDay("@daily", from)).toBe(1);
    expect(runsPerDay("0 9 * * 1-5", from)).toBeCloseTo(20 / 28);
  });

  it("describes common schedules", () => {
    expect(describeSchedule("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeSchedule("0 * * * *")).toBe("Every hour");
    expect(describeSchedule("30 9 * * 1-5")).toBe("At 09:30 on weekdays");
    expect(describeSchedule("@daily")).toBe("At 00:00 daily");
    expect(describeSchedule("@reboot")).toBe("At boot");
    expect(describeSchedule("0 0 1 * *")).toBe(
      "At 00:00 on the 1st of each month",
    );
  });
});

describe("parseCronLog", () => {
  const now = new Date("2026-10-11T14:00:00Z");

  it("groups a run's lines by pid and picks up end time and exit status", () => {
    const log = [
      "2026-10-11T13:00:01+0000 beetle-eye CRON[4321]: pam_unix(cron:session): session opened for user beetle(uid=1000) by (uid=0)",
      "2026-10-11T13:00:01+0000 beetle-eye CRON[4321]: (beetle) CMD (/home/beetle/backup.sh --full)",
      "2026-10-11T13:00:01+0000 beetle-eye CRON[4999]: (root) CMD (run-parts /etc/cron.hourly)",
      "2026-10-11T13:00:09+0000 beetle-eye CRON[4321]: (CRON) error (grandchild #4322 failed with exit status 2)",
      "2026-10-11T13:00:09+0000 beetle-eye CRON[4321]: pam_unix(cron:session): session closed for user beetle",
      "2026-10-11T13:05:00+0000 beetle-eye systemd[1]: unrelated line",
    ].join("\n");
    const runs = parseCronLog(log, now);
    expect(runs).toHaveLength(2);
    const [backup, hourly] = runs;
    expect(backup.user).toBe("beetle");
    expect(backup.command).toBe("/home/beetle/backup.sh --full");
    expect(backup.events).toHaveLength(4);
    expect(backup.exitStatus).toBe(2);
    expect(backup.endedAt).toEqual(new Date("2026-10-11T13:00:09Z"));
    expect(hourly.endedAt).toBeUndefined();

    const job = parseCrontab("0 * * * * /home/beetle/backup.sh --full\n")[0];
    expect(runsForJob(job as CronJob, runs)).toEqual([backup]);
  });

  it("reads classic syslog timestamps", () => {
    const runs = parseCronLog(
      "Oct 11 13:41:01 beetle-eye CRON[77]: (root) CMD (/usr/bin/true)",
      now,
    );
    expect(runs[0].at.getMonth()).toBe(9);
    expect(runs[0].at.getDate()).toBe(11);
    expect(runs[0].at.getFullYear()).toBe(2026);
  });
});
