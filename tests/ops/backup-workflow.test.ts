/**
 * Structural guard: the nightly backup tells a human when it breaks, and every
 * dump it takes is a distinct object.
 *
 * WHAT THIS DEFENDS. `.github/workflows/backup.yml` is the only off-platform
 * copy of customers' financial records. Three audit rows say the same thing
 * about it from different angles, and all three are failure-by-silence:
 *
 *   cron-014      No notification of any kind. A scheduled-workflow failure
 *                 e-mails only the last committer of the workflow file, and a
 *                 run that never HAPPENS produces nothing to check at all. The
 *                 realistic incident is: backups stop in month two, nobody
 *                 notices, and the discovery is made on the day a restore is
 *                 needed.
 *   prodready-008 GitHub disables `schedule:` workflows after 60 days of
 *                 repository inactivity, so the backup is counting down to off
 *                 with no signal. Commits reset the clock; they do not fix the
 *                 mechanism.
 *   prodready-010 The S3 key is date-only, and `aws s3 cp` overwrites. So the
 *                 likeliest sequence is the damaging one: something goes wrong,
 *                 someone clicks the manual "back it up now" button to be safe,
 *                 and that replaces the morning's pre-incident dump.
 *
 * Plus the half of prodready-009 that the restore verification does NOT cover:
 * the content gate reads stronger than it is. `grep -cE '^CREATE TABLE ' >= 12`
 * counts EVERY schema in the dump, and a Supabase dump carries the managed
 * `auth`, `storage`, `realtime` and `vault` schemas — so the count can be met
 * without a single application table present. Only `User` was checked by name.
 *
 * WHY A TEST AND NOT JUST THE WORKFLOW. There is no CI lint for workflow YAML
 * in this repo, so a syntax error in this file is discovered by the backup not
 * running — which is precisely the failure nobody is told about. Parsing the
 * file here is the lint. And an alerting step is the first thing deleted when it
 * gets noisy; these assertions make that a visible, deliberate edit.
 *
 * WHAT THIS CANNOT CHECK, stated so nobody mistakes green here for a working
 * backup: it cannot prove the S3 credentials are valid, that the bucket exists,
 * or that a dump restores. The first two are provable only by a real run; the
 * third is `.github/workflows/verify-backup-restore.yml`, which did it on
 * 2026-09-27 (run 36356799147).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const BACKUP_PATH = ".github/workflows/backup.yml";

/** The dump's own schedule. The audit below must NOT share it. */
const DUMP_CRON = "15 4 * * *";

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  if?: string;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  on?: { schedule?: { cron?: string }[]; workflow_dispatch?: unknown };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

function source(): string {
  return readFileSync(join(ROOT, BACKUP_PATH), "utf8");
}

function workflow(): Workflow {
  // The parse IS the lint. `yaml` ships its own types and resolves from the
  // repo root (hoisted via lint-staged / vite), so no new dependency is needed
  // for this to run.
  return parse(source()) as Workflow;
}

function jobs(): [string, Job][] {
  const wf = workflow();
  return Object.keys(wf.jobs ?? {}).map((name) => [name, (wf.jobs ?? {})[name]!]);
}

function stepsOf(job: Job): Step[] {
  return job.steps ?? [];
}

/** Everything a step can carry that might contain a shell command or a script. */
function stepText(step: Step): string {
  const withScript = step.with && typeof step.with.script === "string" ? step.with.script : "";
  return [step.name ?? "", step.uses ?? "", step.run ?? "", withScript].join("\n");
}

function allStepText(): string {
  const out: string[] = [];
  for (const entry of jobs()) {
    for (const step of stepsOf(entry[1])) out.push(stepText(step));
  }
  return out.join("\n");
}

/**
 * A step counts as "notifies a human" only if it leaves GitHub Actions' own UI.
 * `echo ::error::` is not a notification — nobody is looking at the log of a run
 * they do not know happened.
 */
function isOutboundAlert(step: Step): boolean {
  const text = stepText(step);
  const opensIssue = /issues\.create|issues\.createComment/.test(text);
  const postsWebhook = /curl\s+[^\n]*https?:\/\//.test(text);
  return opensIssue || postsWebhook;
}

describe("backup.yml parses (this repo has no other workflow lint)", () => {
  it("is valid YAML with at least one job", () => {
    let wf: Workflow;
    try {
      wf = workflow();
    } catch (e) {
      throw new Error(
        `${BACKUP_PATH} is not valid YAML, so GitHub will not run it and the only ` +
          `off-platform copy of customer data silently stops: ${(e as Error).message}`
      );
    }
    expect(Object.keys(wf.jobs ?? {}).length, "backup.yml declares no jobs").toBeGreaterThan(0);
  });
});

describe("cron-014 — a backup nobody is told about is a backup you do not have", () => {
  it("notifies a human outside the Actions UI when any job fails", () => {
    for (const entry of jobs()) {
      const name = entry[0];
      const failureSteps = stepsOf(entry[1]).filter((s) => /failure\(\)/.test(s.if ?? ""));
      expect(
        failureSteps.length,
        `job "${name}" has no step that runs on failure. GitHub e-mails only the last ` +
          "committer of the workflow file, so a broken nightly backup reaches nobody."
      ).toBeGreaterThan(0);
      expect(
        failureSteps.some(isOutboundAlert),
        `job "${name}" reacts to failure only inside the Actions log. A log nobody ` +
          "opens is not an alert — open an issue or post to a webhook."
      ).toBe(true);
    }
  });

  it("can open that issue, i.e. actually has permission to", () => {
    // The alert that 403s is worse than no alert: it looks wired.
    const wf = workflow();
    expect(
      wf.permissions,
      "backup.yml declares no permissions block, so it runs with whatever the repo " +
        "default is — which for a read-only default means the failure alert cannot open " +
        "an issue."
    ).toBeTruthy();
    expect(
      wf.permissions!.issues,
      "the failure alert opens a GitHub issue but the workflow is not granted issues: write"
    ).toBe("write");
    // Nothing in this workflow commits, and a token that can push is a token that
    // can trigger a production deploy from a scheduled job.
    expect(
      wf.permissions!.contents ?? "read",
      "backup.yml asks for write access to repository contents. It only reads the " +
        "database and writes to S3; a pushable token here could trigger a production " +
        "deploy from a scheduled job."
    ).toBe("read");
  });

  it("pings a dead-man's switch on success, so a MISSING run alerts too", () => {
    // The gap cron-014 is really about: `if: failure()` covers a run that
    // happened and broke. Nothing covers a run that never started — GitHub
    // drops scheduled runs under load, and disables the schedule outright after
    // 60 quiet days. Only an external "I expected a ping and got none" catches
    // that, so the workflow has to emit the ping.
    const text = allStepText();
    expect(
      /BACKUP_HEARTBEAT_URL/.test(text) || /HEARTBEAT/.test(text),
      "no heartbeat / check-in ping anywhere in backup.yml. A failed run alerts; a run " +
        "that never happens is still silent."
    ).toBe(true);

    const pingSteps: Step[] = [];
    for (const entry of jobs()) {
      for (const step of stepsOf(entry[1])) {
        if (/HEARTBEAT/.test(stepText(step))) pingSteps.push(step);
      }
    }
    expect(pingSteps.length, "the heartbeat URL is referenced but never pinged").toBeGreaterThan(0);
    expect(
      pingSteps.some((s) => /always\(\)/.test(s.if ?? "")),
      "the heartbeat only runs on the happy path. It has to run with `if: always()` so a " +
        "failed run reports the failure to the monitor instead of just going quiet."
    ).toBe(true);
  });

  it("does not fail the backup just because the heartbeat is unconfigured", () => {
    // The ping needs a secret the user has to create. Until it exists, a missing
    // secret must degrade to a warning — a backup that refuses to run because its
    // monitoring is not set up is a worse outcome than an unmonitored backup.
    const text = allStepText();
    expect(
      /::warning/.test(text),
      "nothing in backup.yml warns rather than fails. An absent BACKUP_HEARTBEAT_URL " +
        "must not take the nightly dump down with it."
    ).toBe(true);
  });
});

describe("cron-014 / prodready-008 — the dump is checked by something that is not the dump", () => {
  it("runs a freshness audit on its own schedule", () => {
    const wf = workflow();
    const crons = (wf.on?.schedule ?? []).map((s) => s.cron);
    expect(crons, "the dump's own schedule is gone").toContain(DUMP_CRON);
    expect(
      crons.filter((c) => c !== DUMP_CRON).length,
      "backup.yml has only the dump's schedule. A step inside the dump run cannot " +
        "notice that the dump run did not happen — the check has to fire independently."
    ).toBeGreaterThan(0);
  });

  it("asserts the newest object in the bucket is recent, and can run when the dump is broken", () => {
    const auditJobs = jobs().filter((entry) => {
      const text = stepsOf(entry[1]).map(stepText).join("\n");
      return /MAX_AGE_HOURS|s3 ls/.test(text) && !/pg_dump|PG_DUMP/.test(text);
    });
    expect(
      auditJobs.length,
      "no job inspects the bucket without also taking a dump. The audit must not depend " +
        "on pg_dump working, or a broken dump takes the alarm down with it."
    ).toBeGreaterThan(0);

    const text = auditJobs.map((e) => stepsOf(e[1]).map(stepText).join("\n")).join("\n");
    expect(
      /MAX_AGE_HOURS/.test(text),
      "the audit job does not compare the newest object's age against a threshold, so a " +
        "bucket that stopped receiving dumps three months ago still passes."
    ).toBe(true);
    // One missed night must trip it. The dump lands at 04:15 and the audit runs
    // the same afternoon, so the newest object is ~10h old normally and ~34h old
    // after one skipped night: the threshold has to sit between those.
    const match = /MAX_AGE_HOURS\s*=\s*(\d+)/.exec(text);
    expect(match, "MAX_AGE_HOURS is not assigned a literal number").toBeTruthy();
    const hours = Number(match![1]);
    expect(
      hours,
      `MAX_AGE_HOURS=${hours} is too tight — normal scheduler drift on GitHub would ` +
        "alert on a healthy backup, and an alarm that cries wolf gets muted."
    ).toBeGreaterThan(12);
    expect(
      hours,
      `MAX_AGE_HOURS=${hours} tolerates a completely skipped night (the newest dump is ` +
        "~34h old at audit time when one night is missed), so the one thing it exists to " +
        "catch passes."
    ).toBeLessThan(33);
  });
});

describe("prodready-008 — GitHub switches scheduled workflows off after 60 quiet days", () => {
  it("warns before the 60-day inactivity window closes", () => {
    const text = allStepText();
    expect(
      /pushed_at/.test(text),
      "nothing in backup.yml looks at how long the repository has been quiet. GitHub " +
        "disables `schedule:` workflows after 60 days with no activity, so the backup " +
        "turns itself off and the first symptom is an empty bucket."
    ).toBe(true);
    expect(
      /\b60\b/.test(text),
      "the inactivity check does not name the 60-day window it is measuring against"
    ).toBe(true);
  });
});

describe("prodready-010 — every dump is a distinct, immutable object", () => {
  /** Expand a `date -u +FMT` format string the way coreutils would. */
  function expand(fmt: string, d: Date): string {
    const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
    return fmt
      .replace(/%Y/g, String(d.getUTCFullYear()))
      .replace(/%m/g, pad(d.getUTCMonth() + 1))
      .replace(/%d/g, pad(d.getUTCDate()))
      .replace(/%H/g, pad(d.getUTCHours()))
      .replace(/%M/g, pad(d.getUTCMinutes()))
      .replace(/%S/g, pad(d.getUTCSeconds()));
  }

  it("builds a key that two runs on the same day cannot share", () => {
    // Driven rather than asserted about: pull the real format string out of the
    // workflow and expand it for two moments on the same date. A grep for "%H"
    // would pass on a format that used it somewhere harmless.
    const fmt = /date\s+-u\s+\+(\S+)/.exec(source());
    expect(
      fmt,
      "no `date -u +FORMAT` in backup.yml — cannot tell what the S3 key is built from"
    ).toBeTruthy();

    const morning = new Date(Date.UTC(2026, 8, 28, 4, 15, 0));
    const afternoon = new Date(Date.UTC(2026, 8, 28, 16, 40, 12));
    expect(
      expand(fmt![1], morning),
      "the nightly dump and a manual 'back it up before I try this' on the same day " +
        "produce the same S3 key, and `aws s3 cp` overwrites — so clicking the manual " +
        "button after something goes wrong destroys that morning's good snapshot."
    ).not.toBe(expand(fmt![1], afternoon));
  });

  it("refuses to overwrite a key that already exists", () => {
    const text = allStepText();
    expect(
      /head-object/.test(text),
      "nothing checks whether the target key is already occupied before uploading. " +
        "`aws s3 cp` replaces silently, and bucket versioning is not enabled."
    ).toBe(true);
    // The pre-flight has to abort, not just report.
    const guard = jobs()
      .map((e) => stepsOf(e[1]))
      .reduce<Step[]>((acc, steps) => acc.concat(steps), [])
      .filter((s) => /head-object/.test(stepText(s)));
    expect(
      guard.some((s) => /exit 1/.test(stepText(s))),
      "the key-collision check never exits non-zero, so an overwrite still happens"
    ).toBe(true);
  });

  it("confirms the object actually landed, with the size it should have", () => {
    // The other half of "you do not have a backup": the dump was fine, the
    // upload reported success, and nothing is in the bucket. A `cp` to a bucket
    // whose credentials lost write access is the realistic shape.
    const text = allStepText();
    expect(
      /ContentLength/.test(text),
      "backup.yml never reads the uploaded object back. A successful `aws s3 cp` is not " +
        "evidence that an object of the right size exists under nightly/."
    ).toBe(true);
  });
});

describe("prodready-009 — the content gate has to mean what it reads like", () => {
  it("counts only application tables, not Supabase's managed schemas", () => {
    // The dump is not schema-scoped, so it carries `auth`, `storage`, `realtime`
    // and `vault` alongside `public`. An unscoped `CREATE TABLE` count of 12 is
    // satisfied by those alone — the gate would pass a dump with no app tables
    // in it at all.
    const text = allStepText();
    const counts = /grep\s+-cE\s+'\^CREATE TABLE([^']*)'/.exec(text);
    expect(counts, "the CREATE TABLE count is gone from the content gate").toBeTruthy();
    expect(
      counts![1],
      "the table count still matches CREATE TABLE in any schema. Supabase's managed " +
        "schemas alone clear the threshold, so the count proves nothing about our data."
    ).toContain("public");
  });

  it("names every core table, and requires data for it, not just DDL", () => {
    // Only `User` was checked by name. A dump that lost Transaction — the table
    // holding customers' money — satisfied every gate and uploaded green.
    //
    // The list is asserted as a list rather than by grepping for each name on a
    // `CREATE TABLE` line, because the gate should iterate over one declared set
    // of tables and check both properties for each. Grepping per name would also
    // pass a workflow that checked six tables for DDL and one for data.
    const text = allStepText();
    const listed = /CORE_TABLES=["']?([A-Za-z_ ]+)["']?/.exec(text);
    expect(
      listed,
      "the content gate has no declared CORE_TABLES list, so which tables it protects " +
        "cannot be read off the file"
    ).toBeTruthy();
    const tables = listed![1].trim().split(/\s+/);
    for (const table of ["User", "Company", "Transaction", "Project", "Task", "Budget"]) {
      expect(
        tables,
        `${table} is not in the gate's core-table list. A dump that lost it uploads green.`
      ).toContain(table);
    }

    // And both properties are checked for every table in that list, inside the
    // loop over it — DDL presence and a COPY data block.
    const loop = /for t in \$CORE_TABLES[\s\S]*?\bdone\b/.exec(text);
    expect(
      loop,
      "CORE_TABLES is declared but nothing iterates over it — the list is decoration"
    ).toBeTruthy();
    expect(
      /CREATE TABLE[^\n]*\$\{?t\}?/.test(loop![0]),
      "the per-table loop does not assert CREATE TABLE for each core table"
    ).toBe(true);
    expect(
      /COPY[^\n]*\$\{?t\}?/.test(loop![0]),
      "the per-table loop does not require a COPY data block for each core table, so a " +
        "schema-only dump of any of them passes"
    ).toBe(true);
  });

  it("asserts at least one real row, not just the presence of a COPY header", () => {
    // pg_dump emits `COPY ... FROM stdin;` followed immediately by `\.` for an
    // EMPTY table, so grepping for COPY proves the statement exists and nothing
    // about the data. A dump of an empty database satisfies every check above.
    const text = allStepText();
    expect(
      /USER_ROWS|ROW_COUNT|data_rows/.test(text),
      "nothing counts rows inside a COPY block. pg_dump writes the COPY statement even " +
        "for an empty table, so the current gate cannot tell a full database from an " +
        "empty one."
    ).toBe(true);
  });
});

describe("hygiene the absence of which has already cost this repo a night", () => {
  it("serialises runs without cancelling one mid-upload", () => {
    const wf = workflow();
    expect(
      wf.concurrency,
      "no concurrency guard. Two runs at once race on the same prefix, and the manual " +
        "button makes that easy to do by hand."
    ).toBeTruthy();
    expect(
      wf.concurrency!["cancel-in-progress"],
      "cancel-in-progress would kill a dump mid-upload and leave a truncated object " +
        "behind. A late backup beats a corrupt one."
    ).toBe(false);
  });

  it("no longer claims the restore path has never been exercised", () => {
    // prodready-009 was closed on 2026-09-27 by verify-backup-restore.yml (run
    // 36356799147: 0 psql errors, 14 core tables, 19 -> 25 migrations, 29 users
    // unchanged, 0 null handles). The header used to say the opposite, and a
    // comment that contradicts reality is how the previous six of these findings
    // survived.
    const text = source();
    expect(
      /verify-backup-restore/.test(text),
      "backup.yml does not point at the workflow that proves its dumps restore. Whoever " +
        "is restoring at 3am reads this header first."
    ).toBe(true);
    expect(
      /There is deliberately no automated restore workflow/.test(text),
      "the header still declines an automated restore that now exists " +
        "(.github/workflows/verify-backup-restore.yml)."
    ).toBe(false);
  });
});
