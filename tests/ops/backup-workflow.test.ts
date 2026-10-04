/**
 * Structural guard: the nightly backup tells a human when it breaks, every dump
 * it takes is a distinct object, something proves on a schedule that those dumps
 * restore, and how long they are kept is written down where a reader can see it.
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
 * Plus both halves of prodready-009, which the one proven restore did not
 * settle:
 *
 *   • The content gate read stronger than it was. `grep -cE '^CREATE TABLE '
 *     >= 12` counted EVERY schema in the dump, and an unscoped Supabase dump
 *     carries the managed `auth`, `storage`, `realtime` and `vault` schemas —
 *     so the count could be met without a single application table present.
 *     Only `User` was checked by name.
 *   • The dump itself was not `--schema`-scoped (fixed 2026-10-04). The drill
 *     restores into a VANILLA postgres:17 container, where that is harmless
 *     because nothing is there to collide with; a real recovery target is a
 *     Supabase project where every managed schema already exists. So the
 *     restorability that had been proven was proven against a target nobody
 *     would ever restore to. These tests now pin the scoping, pin a gate that
 *     refuses to upload a dump which reaches outside `public`, and pin the
 *     drill's post-restore assertion that no managed schema came along.
 *
 * And prodready-008's last two limbs: the restore drill ran only when someone
 * pressed a button (so restorability decayed silently between presses — it is
 * now weekly, with its own failure alert), and the bucket's retention lived
 * entirely in a provider console (it is now `.github/backup-bucket-lifecycle.json`,
 * with a read-only drift check in the nightly audit).
 *
 * WHY A TEST AND NOT JUST THE WORKFLOW. There is no CI lint for workflow YAML
 * in this repo, so a syntax error in either file is discovered by the backup not
 * running — which is precisely the failure nobody is told about. Parsing the
 * files here is the lint. And an alerting step is the first thing deleted when it
 * gets noisy; these assertions make that a visible, deliberate edit.
 *
 * TWO HOUSE RULES, EARNED ON 2026-10-04. Three assertions in this file were
 * GREEN against the exact defect they named, and an independent pass found all
 * three. They shared two mistakes:
 *
 *   1. ASSERT THE PROPERTY, NOT A SPELLING OF ITS ABSENCE. "The drift check
 *      cannot fail the audit" was written as `!/exit 1/` and stayed green while
 *      that step failed every night, because it died on an unguarded
 *      `VAR=$(aws …)` under the errexit GitHub supplies in `bash -e {0}` — a
 *      failure with no `exit` in it. `waysItCanFail()` below asks the question
 *      instead of enumerating answers.
 *   2. ANCHOR MULTI-LINE SHAPES TO ONE STEP. `allStepText()` /
 *      `verifyStepText()` join every step's text, so a `[\s\S]*?` run crosses
 *      step boundaries: `/MANAGED_SCHEMAS=[\s\S]*?exit 1/` paired an opening in
 *      the restore step with one of eight `exit 1`s elsewhere, and deleting the
 *      real one left the suite at 32/32. Use `stepsMatching()` /
 *      `oneStepMatching()`; keep the concatenation for single-token presence
 *      checks only.
 *
 * And the corollary for a substring test: a substring proves a MENTION. "Records
 * how long the restore took" was `/RESTORE_SECONDS/` plus
 * `/::notice title=Restore time/`, and passed on a drill with the clock reads
 * and the subtraction deleted — a step that would have died on `set -u`.
 *
 * WHAT THIS CANNOT CHECK, stated so nobody mistakes green here for a working
 * backup: it cannot prove the S3 credentials are valid, that the bucket exists,
 * that the lifecycle policy was ever applied, or that a dump restores. Those are
 * provable only by a real run. The restore half is
 * `.github/workflows/verify-backup-restore.yml`, which did it once on 2026-09-27
 * (run 36356799147) — against an UNSCOPED dump, before the change above. And
 * none of this is live until the branch carrying it reaches `main`: GitHub runs
 * `schedule:` from the default branch's copy of a workflow only.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const BACKUP_PATH = ".github/workflows/backup.yml";
const VERIFY_PATH = ".github/workflows/verify-backup-restore.yml";
const LIFECYCLE_PATH = ".github/backup-bucket-lifecycle.json";

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

/** The restore drill. Same treatment: the parse is the only lint it gets. */
function verifySource(): string {
  return readFileSync(join(ROOT, VERIFY_PATH), "utf8");
}

function workflow(): Workflow {
  // The parse IS the lint. `yaml` ships its own types and resolves from the
  // repo root (hoisted via lint-staged / vite), so no new dependency is needed
  // for this to run.
  return parse(source()) as Workflow;
}

function verifyWorkflow(): Workflow {
  return parse(verifySource()) as Workflow;
}

function jobsOf(wf: Workflow): [string, Job][] {
  return Object.keys(wf.jobs ?? {}).map((name) => [name, (wf.jobs ?? {})[name]!]);
}

function jobs(): [string, Job][] {
  return jobsOf(workflow());
}

function stepsOf(job: Job): Step[] {
  return job.steps ?? [];
}

/** Expand a `date -u +FMT` format string the way coreutils would. */
function expandDateFormat(fmt: string, d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return fmt
    .replace(/%Y/g, String(d.getUTCFullYear()))
    .replace(/%m/g, pad(d.getUTCMonth() + 1))
    .replace(/%d/g, pad(d.getUTCDate()))
    .replace(/%H/g, pad(d.getUTCHours()))
    .replace(/%M/g, pad(d.getUTCMinutes()))
    .replace(/%S/g, pad(d.getUTCSeconds()));
}

/**
 * The `pg_dump` command line, with its backslash-continuations folded into one
 * line so the flags can be read off it. Asserted about rather than grepped for:
 * a `--schema` that appears in a comment is not a `--schema` that is passed.
 */
function dumpInvocation(): string {
  const folded = source().replace(/\\\n\s*/g, " ");
  const m = /"\$PG_DUMP"[^\n]*/.exec(folded);
  if (!m) {
    throw new Error(
      `no "$PG_DUMP" invocation in ${BACKUP_PATH} — the dump step no longer runs pg_dump ` +
        "through the explicitly versioned binary, so what it dumps cannot be read off the file."
    );
  }
  return m[0];
}

/**
 * The `date -u +FMT` format string the S3 key is built from. Stops at `)` and
 * at a quote, because the real line is
 * `echo "path=founderflow-$(date -u +%Y-%m-%dT%H%M%SZ).sql.gz" >> …` and a
 * `\S+` capture swallows `).sql.gz"` into the format.
 */
function keyDateFormat(): string {
  const m = /date\s+-u\s+\+([^\s)"']+)/.exec(source());
  if (!m) {
    throw new Error(
      `no \`date -u +FORMAT\` in ${BACKUP_PATH} — cannot tell what the S3 key is built from`
    );
  }
  return m[1];
}

/** Every `--schema=X` / `--schema X` the dump actually passes. */
function dumpSchemaFlags(): string[] {
  const re = /--schema(?:=|\s+)(\S+)/g;
  const out: string[] = [];
  const invocation = dumpInvocation();
  let m: RegExpExecArray | null = re.exec(invocation);
  while (m !== null) {
    out.push(m[1].replace(/^['"]|['"]$/g, ""));
    m = re.exec(invocation);
  }
  return out;
}

/** Everything a step can carry that might contain a shell command or a script. */
function stepText(step: Step): string {
  const withScript = step.with && typeof step.with.script === "string" ? step.with.script : "";
  return [step.name ?? "", step.uses ?? "", step.run ?? "", withScript].join("\n");
}

function allStepTextOf(wf: Workflow): string {
  const out: string[] = [];
  for (const entry of jobsOf(wf)) {
    for (const step of stepsOf(entry[1])) out.push(stepText(step));
  }
  return out.join("\n");
}

function allStepText(): string {
  return allStepTextOf(workflow());
}

function verifyStepText(): string {
  return allStepTextOf(verifyWorkflow());
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

/**
 * Every step whose text matches `needle`, kept SEPARATE.
 *
 * This exists because asserting a multi-line shape against `allStepText()` is
 * unsound, and that unsoundness shipped: `/MANAGED_SCHEMAS=[\s\S]*?exit 1/`
 * over the concatenation of every step matched `MANAGED_SCHEMAS=` in one step
 * and an `exit 1` in a completely different one — there are eight `exit 1`s in
 * that file — so deleting the real `exit 1` and downgrading its `::error` to a
 * `::warning` left the suite fully green. A `[\s\S]*?` that can cross a step
 * boundary asserts nothing about either step.
 *
 * `needle` must not be a global regex: `.test` on one is stateful.
 */
function stepsMatching(wf: Workflow, needle: RegExp): Step[] {
  if (needle.global)
    throw new Error(`stepsMatching needs a non-global regex, got /${needle.source}/g`);
  const out: Step[] = [];
  for (const entry of jobsOf(wf)) {
    for (const step of stepsOf(entry[1])) if (needle.test(stepText(step))) out.push(step);
  }
  return out;
}

/** The one step matching `needle`, or a failure naming what was found instead. */
function oneStepMatching(wf: Workflow, needle: RegExp, what: string): Step {
  const found = stepsMatching(wf, needle);
  expect(
    found.length,
    `expected exactly one step ${what} (/${needle.source}/), found ${found.length}`
  ).toBe(1);
  return found[0]!;
}

/**
 * A step's `run:` script with shell comments stripped and backslash
 * continuations folded onto one line.
 *
 * The parser has already dropped the YAML comments, but a `#` comment INSIDE
 * the block scalar survives — so without this, "the step clears errexit" is
 * satisfied by a step that only talks about clearing errexit. This repo's most
 * recurrent defect is a comment that contradicts the code; an assertion a
 * comment can satisfy is the same bug wearing a test's clothes.
 */
function shellBody(step: Step): string {
  return (step.run ?? "").replace(/^[ \t]*#.*$/gm, "").replace(/\\\n[ \t]*/g, " ");
}

/**
 * The ways a `run:` step can end up with a non-zero exit, as a list of reasons
 * (empty = it cannot fail).
 *
 * GitHub invokes a `run:` block as `bash -e {0}`, so errexit arrives from the
 * SHELL INVOCATION. A step is incapable of failing only if it clears errexit,
 * or guards every command it assigns from — `VAR=$(cmd)` takes the exit status
 * of `cmd`, which is how the lifecycle-drift step died on the very
 * `NoSuchLifecycleConfiguration` it existed to report — and never exits
 * non-zero itself.
 */
function waysItCanFail(step: Step): string[] {
  const script = shellBody(step);
  const reasons: string[] = [];

  // `set +e`, `set +ex`, … — errexit explicitly cleared.
  if (!/(?:^|\n)[ \t]*set[ \t]+\+[a-zA-Z]*e/.test(script)) {
    for (const line of script.split("\n")) {
      // `VAR=$(cmd)`. `$((` is arithmetic, not a command, so it cannot fail.
      if (!/^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=\$\((?!\()/.test(line)) continue;
      if (/\|\|[ \t]*(?:true|:)[ \t]*$/.test(line)) continue;
      reasons.push(`errexit is on and this assignment is unguarded: ${line.trim()}`);
    }
  }
  for (const line of script.split("\n")) {
    // Any `exit` not immediately followed by `0` — including a bare `exit`,
    // which exits with the last command's status.
    if (/\bexit\b(?![ \t]+0\b)/.test(line)) reasons.push(`it can exit non-zero: ${line.trim()}`);
  }
  return reasons;
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
  const expand = expandDateFormat;

  it("builds a key that two runs on the same day cannot share", () => {
    // Driven rather than asserted about: pull the real format string out of the
    // workflow and expand it for two moments on the same date. A grep for "%H"
    // would pass on a format that used it somewhere harmless.
    const fmt = keyDateFormat();

    const morning = new Date(Date.UTC(2026, 8, 28, 4, 15, 0));
    const afternoon = new Date(Date.UTC(2026, 8, 28, 16, 40, 12));
    expect(
      expand(fmt, morning),
      "the nightly dump and a manual 'back it up before I try this' on the same day " +
        "produce the same S3 key, and `aws s3 cp` overwrites — so clicking the manual " +
        "button after something goes wrong destroys that morning's good snapshot."
    ).not.toBe(expand(fmt, afternoon));
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
    // When this was written the dump was not schema-scoped, so it carried
    // `auth`, `storage`, `realtime` and `vault` alongside `public`, and an
    // unscoped `CREATE TABLE` count of 12 was satisfied by those alone — the
    // gate would pass a dump with no app tables in it at all. The dump is
    // scoped now (see the describe below), which makes the `public.` qualifier
    // belt and braces rather than the only defence. Keep asserting it: the
    // scoping is one deletable token, and this is the count that would
    // otherwise go back to meaning nothing on the day it disappears.
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
    // loop over it — DDL presence and a COPY data block. Anchored to the ONE
    // step that declares the list: a `[\s\S]*?` over `allStepText()` can match
    // an opening in one step and a closing in another, which is how the
    // managed-schema assertion below came to pin nothing.
    const gateStep = oneStepMatching(workflow(), /CORE_TABLES=/, "that declares CORE_TABLES");
    const loop = /for t in \$CORE_TABLES[\s\S]*?\bdone\b/.exec(stepText(gateStep));
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

describe("prodready-009 — the dump is scoped to what this application owns", () => {
  // THE HEADLINE HALF OF prodready-009, and the one the proven restore did not
  // touch. The drill restores into a VANILLA postgres:17 container, where an
  // unscoped dump is harmless because nothing is there to collide with. A real
  // recovery target is a Supabase project, which ships `auth`, `storage`,
  // `realtime`, `vault`, `extensions`, `graphql` and `supabase_migrations`
  // already populated — so an unscoped plain-format dump piped into `psql`
  // collides with objects that exist, and the restorability that was proven was
  // proven against a target nobody would ever restore to.

  it("passes --schema to pg_dump, so the dump cannot collide with Supabase's managed schemas", () => {
    const flags = dumpSchemaFlags();
    expect(
      flags.length,
      "the pg_dump call passes no --schema filter, so it dumps every schema the role can " +
        "read. On Supabase that is `auth`, `storage`, `realtime`, `vault` and friends " +
        "alongside `public`, and `gunzip -c … | psql` into a real Supabase project then " +
        "collides with the managed objects already there. The restore drill cannot catch " +
        "this: its target is a bare postgres:17 container with none of them in it."
    ).toBeGreaterThan(0);
    expect(flags, "pg_dump is given a --schema filter that does not include `public`").toContain(
      "public"
    );
  });

  it("and the scoping still matches every schema Prisma owns", () => {
    // Driven from prisma/schema.prisma rather than hardcoded, because the
    // failure mode of scoping is losing a schema silently. If this app ever
    // adopts Prisma's multiSchema and puts a model outside `public`, the dump
    // must widen on the same day — and this is what will say so.
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const multiSchema = /@@schema\s*\(/.test(schema) || /\bschemas\s*=\s*\[/.test(schema);
    expect(
      multiSchema,
      "prisma/schema.prisma now declares models outside `public` (multiSchema), but the " +
        "dump is still scoped to a fixed schema list. Add the new schema to the --schema " +
        "flags in backup.yml, or the nightly dump silently stops covering those tables."
    ).toBe(false);
    expect(
      dumpSchemaFlags().sort(),
      "the dump's --schema list is not exactly [public]. Prisma owns only `public` here " +
        "(no @@schema, no datasource `schemas`), so anything else in the list is either a " +
        "Supabase managed schema we must not carry or a typo that drops our data."
    ).toEqual(["public"]);
  });

  it("refuses to upload a dump that reaches outside public", () => {
    // Defence in depth for the flag above: the --schema flag is one deletable
    // token. The content gate has to notice when it is gone, because the symptom
    // otherwise appears for the first time during a restore.
    // Anchored to the single step that declares the gate. Over the whole
    // workflow's step text joined together, `[\s\S]*?exit 1` will happily pair
    // `STRAY_TABLES=` here with one of the other seven `exit 1`s elsewhere in
    // the file and report a gate that does not exist.
    const step = oneStepMatching(workflow(), /STRAY_TABLES=/, "that gates on stray tables");
    const text = stepText(step);
    const gate = /STRAY_(?:TABLES|SCHEMAS)=[\s\S]*?exit 1/.exec(text);
    expect(
      gate,
      "nothing in the content gate notices an object outside `public` in the dump. Delete " +
        "the --schema flag and the nightly backup keeps uploading green while quietly " +
        "becoming unrestorable into Supabase again."
    ).toBeTruthy();
    expect(
      /grep[^\n]*public/.test(gate![0]),
      "the stray-schema gate does not compare anything against `public`, so it cannot tell " +
        "a scoped dump from an unscoped one"
    ).toBe(true);
    // Both limbs refuse the upload, and say so as an error rather than a note.
    for (const which of ["STRAY_TABLES", "STRAY_SCHEMAS"]) {
      const limb = new RegExp(
        `${which}=[\\s\\S]*?::(error|warning|notice)[^\\n]*\\n(?:[^\\n]*\\n){0,3}?\\s*exit 1`
      ).exec(text);
      expect(limb, `the ${which} gate never refuses the upload`).toBeTruthy();
      expect(
        limb![1],
        `the ${which} gate exits non-zero but reports itself as a ::${limb![1]}. The run ` +
          "summary then shows a green-looking step for a dump that cannot be restored."
      ).toBe("error");
    }
  });

  it("the restore drill proves the dump carried nothing outside public", () => {
    // The gate above runs before upload; this runs after a real restore, which
    // is the only place the property can be observed rather than inferred.
    //
    // EVERY ASSERTION BELOW IS SCOPED TO ONE STEP, and that is the whole repair
    // of this test. It used to read `verifyStepText()` — every step of the
    // workflow joined with newlines — and then ask for
    // `/MANAGED_SCHEMAS=[\s\S]*?exit 1/`. The non-greedy run crosses step
    // boundaries, so `MANAGED_SCHEMAS=` in this step paired with any of the
    // eight later `exit 1`s in the file. Proof that it pinned nothing: the
    // `::error` was downgraded to `::warning` AND the real `exit 1` deleted —
    // a drill that notices a dump it cannot restore into Supabase and passes
    // anyway — and the suite reported 32/32.
    const step = oneStepMatching(
      verifyWorkflow(),
      /MANAGED_SCHEMAS=/,
      "that checks the restored database for managed schemas"
    );
    const text = stepText(step);
    const listed = /MANAGED_SCHEMAS=["']?([a-z_ ]+)["']?/.exec(text);
    expect(
      listed,
      "the restore drill does not declare the managed schemas a Supabase-restorable dump " +
        "must NOT contain, so nothing checks the one property that scoping buys."
    ).toBeTruthy();
    const declared = listed![1].trim().split(/\s+/);
    for (const schema of ["auth", "storage", "realtime", "vault"]) {
      expect(
        declared,
        `${schema} is not in the drill's managed-schema list. It is one of the schemas a ` +
          "real Supabase target already has, so a dump carrying it is a dump that collides."
      ).toContain(schema);
    }
    expect(
      /information_schema\.schemata|pg_namespace/.test(text),
      "the managed-schema list is declared but nothing queries the restored database for " +
        "them — the list is decoration"
    ).toBe(true);
    // The finding has to STOP the drill, and it has to be reported as an
    // error. Those are two separate regressions — the tester made both at once
    // — so they are asserted as one pairing: the diagnostic that immediately
    // precedes the non-zero exit, and its severity.
    const fails = /::(error|warning|notice)[^\n]*\n(?:[^\n]*\n){0,3}?\s*exit 1/.exec(text);
    expect(
      fails,
      "the drill finds managed schemas in the restored database and does not fail. A " +
        "warning here is a green run that still cannot be restored into Supabase."
    ).toBeTruthy();
    expect(
      fails![1],
      `the managed-schema finding exits non-zero but announces itself as a ::${fails![1]}. ` +
        "GitHub renders that as a soft note on a step that nonetheless failed, and the next " +
        "reader reconciles the two by muting the step."
    ).toBe("error");
    expect(
      /\$FOUND|\$\{FOUND\}/.test(fails![0]),
      "the failure does not name the schemas it found, so the run says the dump is not " +
        "scoped without saying what came along"
    ).toBe(true);
  });

  it("the drill can actually find the objects backup.yml writes", () => {
    // Not cosmetic. backup.yml moved to a second-resolution key on 2026-09-28
    // (prodready-010) and the drill still filtered for the date-only name, so
    // its "newest dump in the bucket" selector matched nothing at all — a
    // scheduled drill built on that would have failed every week with "No dump
    // found" and told nobody anything about restorability.
    const key = `founderflow-${expandDateFormat(keyDateFormat(), new Date(Date.UTC(2026, 9, 5, 4, 15, 9)))}.sql.gz`;

    // The drill's own filter, lifted out of its shell. The ERE subset used here
    // (anchors, [0-9], {n}, groups, ?) means the same thing to grep and to
    // JavaScript, so compiling it as a RegExp tests the real expression.
    const filter = /'(\^founderflow[^']*)'/.exec(verifySource());
    expect(
      filter,
      "the drill has no `^founderflow…` object-name filter, so which dump it restores " +
        "cannot be read off the file"
    ).toBeTruthy();
    expect(
      new RegExp(filter![1]).test(key),
      `the drill's object filter /${filter![1]}/ does not match ${key}, which is the key ` +
        "backup.yml writes today. The drill would find no dump to restore and fail for a " +
        "reason that has nothing to do with restorability."
    ).toBe(true);
  });

  it("tells a credential failure apart from an empty bucket", () => {
    // The `|| true` on this pipeline was added for grep's no-match exit 1, and
    // that part is right: `pipefail` would otherwise kill the step before the
    // friendly "No dump found" could print. But it covered the whole
    // `aws | awk | grep | sort`, so a revoked key, a renamed bucket or a wrong
    // endpoint stopped aborting with the real AWS error and fell through to
    // `::error title=No dump found` — the wrong diagnosis for a weekly job
    // whose entire output is one red. Measured with a stub `aws` that returns
    // the CLI's own InvalidAccessKeyId/254: before, the step printed "No dump
    // found" and exited 1; now it exits 254 with the AWS error.
    const step = oneStepMatching(verifyWorkflow(), /aws\s+s3\s+ls/, "that lists the bucket");
    const script = shellBody(step);
    const listing = script.split("\n").filter((l) => /aws\s+s3\s+ls/.test(l));
    expect(listing.length, "expected exactly one `aws s3 ls` in the fetch step").toBe(1);
    expect(
      /\|\|\s*(?:true|:)\s*\)?\s*$/.test(listing[0]!),
      "the bucket listing is `|| true`-guarded, so a bad credential, a missing bucket or a " +
        "wrong endpoint produces an empty list instead of an error — and the step then " +
        "reports `No dump found`, which sends the next reader to look for a backup problem " +
        "that does not exist. Guard grep's no-match on its own, not the whole pipeline."
    ).toBe(false);
    // …and grep's "nothing matched" must still be forgiven, or the friendly
    // "No dump found" below is unreachable under pipefail and the drill dies
    // with no message at all.
    const filter = script.split("\n").filter((l) => /grep\s+-E\s+'\^founderflow/.test(l));
    expect(filter.length, "expected exactly one object-name filter in the fetch step").toBe(1);
    expect(
      /\|\|/.test(filter[0]!),
      "grep exits 1 when it matches nothing, and under `set -o pipefail` that kills the step " +
        "before the explicit `No dump found` error. An empty bucket would then fail with no " +
        "message at all."
    ).toBe(true);
  });

  it("accepts both of the forms its own dump_date input promises", () => {
    // The input's description and the code that reads it disagreed, and the
    // disagreement was invisible from either side alone. The description says
    // "a YYYY-MM-DD prefix (newest of that day) or a full object name"; the
    // implementation was `grep -E "^founderflow-${DUMP_DATE}"`, which PREPENDS
    // the prefix — so a full object name became `^founderflow-founderflow-…`,
    // matched nothing, and the drill failed with "No dump found", blaming the
    // bucket. That is the one operator control a human reaches for mid-incident
    // ("restore THAT snapshot, not the newest").
    //
    // Asserted in BOTH directions off the description, so the lesser fix —
    // reword the description to promise only a prefix — stays green while
    // reverting the code alone does not.
    const wf = verifyWorkflow();
    const dispatch = wf.on?.workflow_dispatch as
      | { inputs?: Record<string, { description?: string }> }
      | undefined;
    const desc = dispatch?.inputs?.dump_date?.description ?? "";
    expect(desc, "verify-backup-restore.yml has no dump_date input description").toBeTruthy();

    const step = oneStepMatching(
      verifyWorkflow(),
      /DUMP_DATE/,
      "that selects which dump to restore"
    );
    const script = shellBody(step);
    // Every line that USES the value. `${DUMP_DATE:-…}` lines are the
    // emptiness test and the error message's default, not selection.
    const uses = (script.match(/[^\n]*\$\{?DUMP_DATE\b[^\n]*/g) ?? []).filter(
      (l) => !/DUMP_DATE:-/.test(l)
    );
    expect(
      uses.length,
      "the step never uses the dump_date input to select anything"
    ).toBeGreaterThan(0);
    const prepends = uses.filter((l) => /founderflow-\$\{?DUMP_DATE/.test(l));
    const bare = uses.filter((l) => !/founderflow-\$\{?DUMP_DATE/.test(l));

    if (/full object name/i.test(desc)) {
      expect(
        bare.length,
        "the dump_date description promises a full object name, but every use of the value " +
          "prepends `founderflow-` to it — so the only form a full object name can take is " +
          `\`founderflow-founderflow-…\`, which matches nothing. Uses found: ${JSON.stringify(uses)}`
      ).toBeGreaterThan(0);
    }
    if (/prefix/i.test(desc)) {
      expect(
        prepends.length,
        "the dump_date description promises a YYYY-MM-DD prefix selects that day's newest " +
          "dump, but nothing matches the value as a prefix of the object name"
      ).toBeGreaterThan(0);
    }
  });

  it("records how long the restore took, so the RTO stops being unknown", () => {
    // "An unmeasured RTO is not an RTO" is the filing's own sentence. A number
    // in the run log is not a production-sized RTO, but it is the difference
    // between an unknown and a lower bound that trends.
    //
    // THIS TEST COULD NOT TELL A MEASUREMENT FROM A MENTION OF ONE. Both limbs
    // were substring tests — `/RESTORE_SECONDS/` and
    // `/::notice title=Restore time/` — over every step's text joined
    // together. Delete `STARTED=$(date -u +%s)` and the whole
    // `RESTORE_SECONDS=$(( … ))` computation, leaving only the notices that
    // INTERPOLATE `${RESTORE_SECONDS}`, and the suite stays green — even though
    // that step now dies on `set -u` with an unbound variable and the drill
    // never reports a time at all. So the clock reads, the subtraction between
    // them and the export are each pinned, inside ONE step.
    // Anchored on the step that DOES the restore, not on one that mentions
    // RESTORE_SECONDS: the summary step interpolates it too, and the whole
    // point here is that mentioning it is not measuring it.
    const step = oneStepMatching(verifyWorkflow(), /-f \.\/dump\.sql/, "that restores the dump");
    const script = shellBody(step);

    // (1) A start clock read, captured into a variable.
    const started = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*date\b[^)]*\+%s[^)]*\)/m.exec(script);
    expect(
      started,
      "the drill does not read a clock before the restore, so it cannot be timing it. The " +
        "one cheap fact a restore drill can produce about recovery time is how long it took."
    ).toBeTruthy();
    const startVar = started![1];

    // (2) The elapsed seconds are the DIFFERENCE between a second clock read
    // and that variable — an arithmetic expansion, not a string.
    const elapsed = new RegExp(`RESTORE_SECONDS=\\$\\(\\(([^\\n]*?)\\)\\)`).exec(script);
    expect(
      elapsed,
      "RESTORE_SECONDS is referenced but never computed as `$(( … ))`. A step that only " +
        "interpolates ${RESTORE_SECONDS} prints an empty number — or, under `set -u`, dies " +
        "on an unbound variable and reports nothing whatsoever about recovery time."
    ).toBeTruthy();
    expect(
      /date\b[^\n]*\+%s/.test(elapsed![1]),
      "RESTORE_SECONDS is computed without reading the clock again, so whatever it holds is " +
        "not a duration"
    ).toBe(true);
    expect(
      new RegExp(`\\b${startVar}\\b`).test(elapsed![1]),
      `RESTORE_SECONDS does not subtract ${startVar}, the timestamp taken before the ` +
        "restore, so it is not the restore's elapsed time"
    ).toBe(true);

    // (3) The restore itself happens BETWEEN the two reads. Otherwise the
    // number is real, trends, and measures nothing.
    const between = script.slice(
      script.indexOf(started![0]) + started![0].length,
      script.indexOf(elapsed![0])
    );
    expect(
      /\$PSQL|psql/.test(between),
      `nothing restores anything between ${startVar} and the RESTORE_SECONDS computation, so ` +
        "the number being reported as a restore time is the duration of something else"
    ).toBe(true);

    // (4) It survives the step, so later steps and the summary can use it…
    expect(
      /RESTORE_SECONDS=[^\n]*>>\s*"?\$\{?GITHUB_ENV/.test(script),
      "the measured duration is never written to $GITHUB_ENV, so it dies with the step and " +
        "nothing later in the drill can report it"
    ).toBe(true);
    // …and is surfaced where a human reads it, with the measured value in it.
    const notice = /::notice title=Restore time[^\n]*/.exec(script);
    expect(
      notice,
      "the restore duration is computed but never surfaced as a notice, so it is buried in " +
        "step output nobody scrolls to"
    ).toBeTruthy();
    expect(
      /\$\{?RESTORE_SECONDS\}?/.test(notice![0]),
      "the `Restore time` notice does not interpolate RESTORE_SECONDS, so it announces a " +
        "measurement without reporting it"
    ).toBe(true);
  });
});

describe("cron-014 — the restore drill decays unless something runs it", () => {
  // The drill existed and had run exactly once, by hand, on 2026-09-27. A
  // restore procedure proven once is proven about that day's dump, that day's
  // migrations and that day's pg_dump version; everything it asserts rots the
  // moment any of those move. `workflow_dispatch` alone means the decay is
  // silent, which is cron-014's whole shape.

  /** The hour field of a 5-field cron expression. */
  function cronHour(expr: string): number {
    const fields = expr.trim().split(/\s+/);
    expect(fields.length, `"${expr}" is not a 5-field cron expression`).toBe(5);
    const hour = Number(fields[1]);
    expect(
      Number.isFinite(hour),
      `"${expr}" does not pin an hour, so when it runs cannot be reasoned about`
    ).toBe(true);
    return hour;
  }

  function cronsOf(wf: Workflow): string[] {
    const out: string[] = [];
    const sched = wf.on?.schedule ?? [];
    for (const entry of sched) if (entry.cron) out.push(entry.cron);
    return out;
  }

  it("runs on a schedule, not only when someone remembers the button", () => {
    const crons = cronsOf(verifyWorkflow());
    expect(
      crons.length,
      "verify-backup-restore.yml has no `schedule:`, so restorability is proven only when " +
        "a human remembers to press a button. Between presses the claim decays silently — " +
        "which is the same failure-by-silence cron-014 filed about the dump itself."
    ).toBeGreaterThan(0);
  });

  it("does not land in the dump's or the freshness audit's window", () => {
    const backupHours = cronsOf(workflow()).map(cronHour);
    for (const expr of cronsOf(verifyWorkflow())) {
      const hour = cronHour(expr);
      for (const other of backupHours) {
        const gap = Math.min(Math.abs(hour - other), 24 - Math.abs(hour - other));
        expect(
          gap,
          `the drill runs at ${hour}:00 UTC and backup.yml has a job at ${other}:00 UTC. ` +
            "The drill restores the newest object in the bucket, so it has to start well " +
            "after the dump has landed — and GitHub's scheduler is best-effort, which eats " +
            "a one-hour margin on a busy morning."
        ).toBeGreaterThan(1);
      }
    }
  });

  it("tells a human when a scheduled drill fails", () => {
    // A dispatch-only workflow fails in front of the person who pressed the
    // button. A SCHEDULED one fails into an empty room, so putting it on a
    // schedule without an alert converts a manual check into a silent one.
    const wf = verifyWorkflow();
    expect(
      wf.permissions,
      "verify-backup-restore.yml declares no permissions block, so its alert runs with " +
        "whatever the repo default is — and a read-only default means the alert 403s, which " +
        "is worse than no alert because it looks wired."
    ).toBeTruthy();
    expect(
      wf.permissions!.issues,
      "the restore drill is not granted issues: write, so it cannot tell anyone it failed"
    ).toBe("write");
    expect(
      wf.permissions!.contents ?? "read",
      "the restore drill asks for write access to repository contents. It reads a dump and " +
        "writes to a throwaway container; a pushable token here could trigger a production " +
        "deploy from a scheduled job."
    ).toBe("read");

    for (const entry of jobsOf(wf)) {
      const failureSteps = stepsOf(entry[1]).filter((s) => /failure\(\)/.test(s.if ?? ""));
      expect(
        failureSteps.length,
        `job "${entry[0]}" has no step that runs on failure. On a schedule that means a ` +
          "restore drill that stopped passing says nothing at all."
      ).toBeGreaterThan(0);
      expect(
        failureSteps.some(isOutboundAlert),
        `job "${entry[0]}" reacts to failure only inside the Actions log, which nobody ` +
          "opens for a run they did not start"
      ).toBe(true);
    }
  });

  it("cannot sit on a runner forever when a restore hangs", () => {
    // Unbounded, a hung `psql -f` burns GitHub's 6-hour default — and a job
    // that is still "in progress" is a job nobody has been told about.
    const source = verifySource();
    for (const entry of jobsOf(verifyWorkflow())) {
      const job = entry[1] as Job & { "timeout-minutes"?: number };
      expect(
        job["timeout-minutes"],
        `job "${entry[0]}" in verify-backup-restore.yml has no timeout-minutes, so a hung ` +
          "restore runs for GitHub's 6-hour default before anything reports"
      ).toBeTruthy();
    }
    expect(/timeout-minutes/.test(source)).toBe(true);
  });
});

describe("prodready-008 — how long snapshots are kept is in the repo, not in someone's memory", () => {
  // The filing's last open limb: "Retention is delegated entirely to a bucket
  // lifecycle policy that lives outside the repo." Which meant nobody could
  // tell, from anything, whether old snapshots were being kept or silently
  // aged out — and a lifecycle rule is the one piece of this system that can
  // DELETE backups.

  interface LifecycleRule {
    ID?: string;
    Status?: string;
    Filter?: { Prefix?: string };
    Prefix?: string;
    Expiration?: { Days?: number; Date?: string };
  }

  function policy(): { Rules?: LifecycleRule[] } {
    return JSON.parse(readFileSync(join(ROOT, LIFECYCLE_PATH), "utf8"));
  }

  /** The product's own promise, read from the cron that enforces it. */
  function softDeleteRetentionDays(): number {
    const route = readFileSync(join(ROOT, "app/api/cron/purge-soft-deleted/route.ts"), "utf8");
    const m = /const RETENTION_DAYS\s*=\s*(\d+)/.exec(route);
    expect(m, "cannot read RETENTION_DAYS out of the purge cron").toBeTruthy();
    return Number(m![1]);
  }

  it("commits the bucket's lifecycle policy as a file", () => {
    expect(
      existsSync(join(ROOT, LIFECYCLE_PATH)),
      `${LIFECYCLE_PATH} does not exist. Retention lives only in a bucket setting nobody ` +
        "can read from here, so whether a 90-day-old snapshot still exists is unanswerable " +
        "without opening the provider's console — and a wrong lifecycle rule is the only " +
        "part of this system that deletes backups."
    ).toBe(true);
    const rules = policy().Rules ?? [];
    expect(rules.length, "the committed lifecycle policy declares no rules").toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.Status, `rule "${rule.ID}" is not Enabled, so it does nothing`).toBe("Enabled");
    }
  });

  it("scopes every rule to the nightly/ prefix", () => {
    for (const rule of policy().Rules ?? []) {
      const prefix = rule.Filter?.Prefix ?? rule.Prefix;
      expect(
        prefix,
        `rule "${rule.ID}" has no prefix, so it applies to the WHOLE bucket. An expiry rule ` +
          "with no prefix deletes anything anyone ever puts in there, which is how a " +
          "retention policy becomes a data-loss event."
      ).toBe("nightly/");
    }
  });

  it("keeps snapshots longer than the product promises recovery", () => {
    // The binding number is the soft-delete window, not a storage bill. Rows
    // tombstoned today are hard-deleted by /api/cron/purge-soft-deleted after
    // RETENTION_DAYS, so the last dump that still contains them is from the day
    // before that. If the bucket expires objects at or before the same age,
    // a recovery request that arrives at the end of the window has no snapshot
    // to recover from and CLAUDE.md's "recoverable for 90 days" is false.
    const promised = softDeleteRetentionDays();
    const rules = policy().Rules ?? [];
    const expiring = rules.filter((r) => r.Expiration && typeof r.Expiration.Days === "number");
    expect(
      expiring.length,
      "no rule expires anything, so the bucket grows forever. That is safe but it is not a " +
        "policy — say the number out loud."
    ).toBeGreaterThan(0);
    for (const rule of expiring) {
      expect(
        rule.Expiration!.Days,
        `rule "${rule.ID}" expires dumps after ${rule.Expiration!.Days} days while the ` +
          `product promises ${promised}-day recovery. A snapshot set shorter than the ` +
          "promise means the purge erases rows no backup still holds."
      ).toBeGreaterThanOrEqual(2 * promised);
    }
  });

  it("cites files that actually contain the retention figure it justifies 180 with", () => {
    // backup.yml's RETENTION section justifies 180 days as 2× the 90-day
    // soft-delete window, and names where the 90 lives so the next person can
    // check it. It named CLAUDE.md — which has never contained a `90` at all
    // (`grep -n "\b90\b" CLAUDE.md` returns nothing). A citation to the wrong
    // file is how a number drifts: the reader opens it, cannot find the figure,
    // and either gives up or edits the wrong place. The figure itself was
    // right, which is what made the pointer hard to notice.
    const promised = softDeleteRetentionDays();
    const para = /•\s*Expiration[\s\S]*?\n##\s+•/.exec(source());
    expect(
      para,
      "backup.yml's RETENTION section no longer has the bullet that explains its expiry " +
        "number, so 180 is back to being a figure with no stated reason"
    ).toBeTruthy();
    const cited = Array.from(
      new Set(para![0].match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|json|md|ya?ml)\b/g) ?? [])
    );
    expect(
      cited.length,
      `the bullet names no file as the home of the ${promised}-day figure, so the number it ` +
        "doubles cannot be checked from here"
    ).toBeGreaterThan(0);
    for (const rel of cited) {
      // A citation the paragraph itself negates ("it is NOT in X") is a
      // correction, not a claim — that is the shape this test was written for.
      const quoted = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\bnot\\b[^.]{0,60}${quoted}`, "i").test(para![0])) continue;
      expect(existsSync(join(ROOT, rel)), `backup.yml cites ${rel}, which does not exist`).toBe(
        true
      );
      expect(
        new RegExp(`\\b${promised}\\b`).test(readFileSync(join(ROOT, rel), "utf8")),
        `backup.yml says the ${promised}-day retention figure lives in ${rel}, and ${rel} ` +
          `does not contain ${promised} anywhere. The expiry in ` +
          `${LIFECYCLE_PATH} is set to twice that figure, so a reader sent to the wrong ` +
          "file cannot check the one number that decides whether a recovery request arrives " +
          "to find a snapshot or nothing."
      ).toBe(true);
    }
  });

  it("backup.yml says where the policy lives and how to apply it", () => {
    // A policy file nobody is pointed at is the same invisible setting, moved.
    const text = source();
    expect(
      text,
      "backup.yml's RETENTION section does not name the committed policy file, so the next " +
        "person to ask 'how long are these kept?' still has to guess"
    ).toContain(LIFECYCLE_PATH);
    expect(
      /put-bucket-lifecycle-configuration/.test(text),
      "backup.yml does not record the command that applies the committed policy. The file " +
        "is not self-applying — a policy in the repo that was never pushed to the bucket is " +
        "a worse lie than no file at all."
    ).toBe(true);
  });

  it("the nightly audit notices when the live bucket has drifted from it", () => {
    const text = allStepText();
    expect(
      /get-bucket-lifecycle-configuration/.test(text),
      "nothing ever reads the bucket's live lifecycle configuration, so a committed policy " +
        "that was never applied — or was applied and then changed in the console — looks " +
        "exactly like one that is in force."
    ).toBe(true);

    const driftSteps: Step[] = [];
    for (const entry of jobs()) {
      for (const step of stepsOf(entry[1])) {
        if (/get-bucket-lifecycle-configuration/.test(stepText(step))) driftSteps.push(step);
      }
    }
    expect(driftSteps.length).toBeGreaterThan(0);
    for (const step of driftSteps) {
      const body = stepText(step);
      expect(
        body,
        "the drift check does not read the committed policy, so it has nothing to compare the " +
          "live configuration against"
      ).toContain(LIFECYCLE_PATH);
      expect(
        /::warning/.test(body),
        "the drift check reports nothing a human sees in the run summary"
      ).toBe(true);
      // And it must NOT be able to fail the audit. `s3:GetLifecycleConfiguration`
      // is a bucket-level permission the upload credential may simply not have,
      // and a check that then fails every night takes the freshness alarm — the
      // one that means "there is no backup" — down with it, permanently.
      //
      // THIS ASSERTION USED TO READ `expect(/exit 1/.test(body)).toBe(false)`,
      // and it was green on a tree where this step failed EVERY NIGHT. The step
      // died on `LIVE=$(aws s3api …)` under the errexit GitHub supplies in
      // `bash -e {0}`, which is a failure containing no `exit` at all: a failed
      // `freshness` job opens the "could not find a recent dump" issue and pings
      // $BACKUP_HEARTBEAT_URL/fail, so the one alarm meaning "there is no
      // off-platform copy of customer data" became a nightly false positive
      // while this test said it could not happen. Enumerating one spelling of
      // failure misses the next one, so this asserts the property instead: by
      // what mechanism could this step exit non-zero?
      expect(
        waysItCanFail(step),
        "the lifecycle drift check can fail the freshness audit. Retention drift is not the " +
          "same severity as 'there is no recent backup', and a credential without " +
          "s3:GetLifecycleConfiguration would red the real alarm every night until it got " +
          "muted. Note that leaving `-e` out of `set` does NOT clear errexit here — GitHub " +
          "runs the block as `bash -e {0}` — so either `set +e` explicitly, or end every " +
          "`VAR=$(…)` line with `|| true`."
      ).toEqual([]);
    }
  });

  it("asks the live bucket the same question the committed file answers", () => {
    // The drift check reported FALSE REASSURANCE in three ways, all of them
    // the two sides of the comparison asking different questions. Each limb
    // below is one of them, and each is red if that mechanism is removed.
    // Measured against a real jq (jq-web) with a stub `aws`, which is how the
    // three were confirmed before this was written:
    //
    //   • a 180-day rule on the `logs/` prefix and NOTHING on nightly/ printed
    //     "::notice title=Retention as documented" — the only mechanism that
    //     answers "was the committed policy ever applied?" answering yes when
    //     it was not;
    //   • `{"Expiration":{"Date":"2026-11-01"}}` on nightly/, which erases
    //     every snapshot at once on that day, printed "Dumps are being kept
    //     forever — safe, but not what the repo says";
    //   • a `"Status":"Disabled"` rule in the committed FILE would have been
    //     read as the repo's intent, because only the live side filtered on
    //     Status.
    const step = oneStepMatching(
      workflow(),
      /get-bucket-lifecycle-configuration/,
      "that reads the bucket's lifecycle configuration"
    );
    const script = shellBody(step);

    // (1) One program, both sides. The committed file is read with a jq
    // program held in a shell variable; the live JSON must be read with the
    // SAME variable, or the two can drift apart again silently.
    const applied = /jq\s+(?:-\S+\s+)*"\$([A-Za-z_][A-Za-z0-9_]*)"\s+"\$POLICY"/.exec(script);
    expect(
      applied,
      "the committed policy is not read through a named jq program, so there is no way to " +
        "tell whether the live bucket is being asked the same question"
    ).toBeTruthy();
    const program = applied![1];
    expect(
      new RegExp(`"\\$LIVE"[^\\n]*\\|\\s*jq\\s+(?:-\\S+\\s+)*"\\$${program}"`).test(script),
      `the live lifecycle configuration is not filtered through $${program}, the same program ` +
        "the committed file is filtered through. Two programs drift: the asymmetry this " +
        'replaces was a live-side `select(.Status == "Enabled")` with no counterpart on the ' +
        "committed side, so a Disabled rule in the repo's own file read as the intent."
    ).toBe(true);

    // (2) …and that program selects on the prefix and on Status.
    const decl = new RegExp(`${program}='([\\s\\S]*?)'`).exec(script);
    expect(decl, `${program} is referenced but never assigned`).toBeTruthy();
    const rules = decl![1];
    expect(
      /startswith/.test(rules) && /nightly\//.test(rules),
      "the rule filter has no `nightly/` prefix predicate, so a lifecycle rule on any OTHER " +
        "prefix is read as this bucket's retention. A 180-day rule on `logs/` with nothing on " +
        "nightly/ then prints 'Retention as documented' about dumps no rule touches."
    ).toBe(true);
    expect(
      /Status/.test(rules) && /Enabled/.test(rules),
      "the rule filter does not require Status == Enabled, so a switched-off rule counts as " +
        "retention that is in force"
    ).toBe(true);

    // (3) An absolute Expiration.Date is read, and reported as its own thing.
    // It is not a retention window and must never be compared with one: a rule
    // expressed as a date deletes everything at once, however new.
    expect(
      /Expiration\.Date/.test(script),
      "the drift check never looks at Expiration.Date, so a live rule that erases every " +
        "snapshot in the bucket on a fixed day reads back as no expiration at all — and the " +
        "step then says dumps are being kept forever. That is an actively wrong statement " +
        "about the only component in this system that deletes backups."
    ).toBe(true);
    // The variable that ends up holding the live bucket's fixed dates. The jq
    // program is either inline on the assignment, or held in its own program
    // variable — which is how the one-program-both-sides property above is
    // achieved, so both spellings have to be accepted here.
    const dateProgram = /([A-Za-z_][A-Za-z0-9_]*)='[^']*Expiration\.Date[^']*'/.exec(script);
    const dateFilter = dateProgram
      ? `\\$\\{?${dateProgram[1]}\\}?|Expiration\\.Date`
      : "Expiration\\.Date";
    const dates = new RegExp(
      `([A-Za-z_][A-Za-z0-9_]*)=\\$\\([^\\n]*jq[^\\n]*(?:${dateFilter})[^\\n]*\\)`
    ).exec(script);
    expect(
      dates,
      "Expiration.Date is mentioned but the dates found on the live bucket are not captured " +
        "into a variable, so nothing can branch on them"
    ).toBeTruthy();
    const datesVar = dates![1];
    const warnsAboutDates = new RegExp(
      `\\[\\s+-n\\s+"\\$\\{${datesVar}:?-?\\}?"?\\s*\\][\\s\\S]{0,400}?::warning`
    ).test(script);
    expect(
      warnsAboutDates,
      `${datesVar} is captured but no \`[ -n …\` branch turns it into a ::warning, so a ` +
        "fixed-date erasure is read and then thrown away"
    ).toBe(true);
    // And the reassuring notice must be unreachable while such a rule exists.
    const notice =
      /(?:if|elif)\s+\[([^\]]*)\][^\n]*\n[^\n]*::notice title=Retention as documented/.exec(script);
    expect(
      notice,
      "the 'Retention as documented' notice is not guarded by a condition at all"
    ).toBeTruthy();
    expect(
      new RegExp(`-z[^\\n]*${datesVar}`).test(notice![1]),
      `the 'Retention as documented' notice can print while ${datesVar} is non-empty, i.e. ` +
        "while an enabled rule deletes the dumps on a fixed date. That is the false " +
        "reassurance, restored."
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

  it("no longer admits in its own header that the dump is unscoped", () => {
    // This repo's most recurrent defect is a comment that contradicts the code,
    // and this header carried the admission for prodready-009 in the present
    // tense for a week: "The dump is not `--schema`-scoped, so it still carries
    // Supabase's managed objects". The flag is there now (asserted above), so
    // the sentence has to be gone — a reader at 3am trusts the header over the
    // shell. The historical note that it USED to be unscoped is deliberately
    // phrased in the past tense and does not match this.
    const text = source();
    expect(
      /dump is not `?--schema`?-scoped/.test(text),
      "backup.yml still states that its dump is not --schema-scoped while the dump step " +
        "passes --schema=public. One of the two is lying, and the comment is the one a " +
        "human reads first."
    ).toBe(false);
  });
});
