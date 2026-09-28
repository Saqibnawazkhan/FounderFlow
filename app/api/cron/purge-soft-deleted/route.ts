/**
 * Tier 3 nightly purge — the second half of the soft-delete recovery story.
 *
 * Hard-deletes rows whose `deletedAt` sentinel is older than the retention
 * window (default 90 days). Rows inside the window survive so ops can recover
 * a fat-fingered workspace delete by clearing the column.
 *
 * TWO scopes only — deliberately:
 *   1. Whole-workspace erasure: each overdue Company is deleted in EXPLICIT
 *      dependency order (children before parents), so it never depends on
 *      Postgres's cascade ordering and never trips a Restrict FK (Task.project
 *      → Project, Project.supervisor/createdBy → User). "Explicit" is the whole
 *      design: every workspace-scoped table is named here, including the four
 *      chat tables added 2026-09-24. See `purgeCompany` for why leaning on
 *      cascade instead was a real bug.
 *   2. Individually soft-deleted PROJECTS in still-live workspaces
 *      (deleteProjectAction soft-deletes projects with no LIVE tasks/budgets).
 *      One project at a time, its tombstoned Task and Budget rows first — see
 *      the scope-2 block for why the old single `deleteMany` was a multi-tenant
 *      outage.
 *
 * There is NO individual-user purge stage, by design. A user deactivated (X8)
 * inside a live workspace keeps their tombstone AND all their content forever —
 * their contributions "stay in the records", as the deactivate UX promises.
 * Only whole-workspace erasure (scope 1) ever removes a user's rows. (Full GDPR
 * erasure of an individual account's PII in a still-live workspace needs an
 * anonymization pass — documented follow-up.)
 *
 * DESTRUCTIVE deletion stays OFF by default (`PURGE_ENABLED` gate): the cron
 * dry-runs unless PURGE_ENABLED === "true", and that default is not up for
 * negotiation — auto-erasing customer data has to stay a deliberate decision.
 * What changed (cron-005) is what the dry run is worth: it now COUNTS, per
 * table, the rows a live run would destroy, and feeds that number to the
 * bulk-mutation canary. It used to report `companiesPurged` and nothing else,
 * so the one safety mechanism in front of an irreversible multi-tenant delete
 * could not inform the decision it exists for: "3 workspaces" reads the same
 * whether that is 40 rows or 400,000.
 *
 * ALERTING (cron-008, prodready-003). A failed stage answers 500, not 206 — 206
 * is a 2xx, which Vercel's cron view reads as a clean run, and the "alert
 * externally on a 206" half of the old comment was never built. The whole run
 * also sits inside a Sentry cron check-in, because the worst failure mode (the
 * job never fires at all) produces no response to escalate on. A missing
 * CRON_SECRET raises a Sentry event before answering 500 instead of failing in
 * silence.
 *
 * Security: CRON_SECRET, constant-time compared, fail-closed on missing env.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { withCronCheckIn } from "@/lib/cron/monitor";
import { safeEqual } from "@/lib/safe-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETENTION_DAYS = 90;

/** Must match the crontab in vercel.json, or Sentry's missed-beat alert is wrong. */
const MONITOR = { slug: "purge-soft-deleted", schedule: "15 3 * * *" } as const;

/**
 * Transaction budget for one workspace and for one project (cron-006).
 *
 * Passing NO options was the bug. `lib/db.ts` builds the PrismaClient with only
 * a `log` option — no `transactionOptions` — so Prisma's defaults applied:
 * maxWait 2000ms, timeout 5000ms. The declared `maxDuration = 60` above was
 * therefore never the operative ceiling; 5000ms was. A chat-heavy workspace
 * blew through it with P2028 "Transaction already closed", the catch below
 * recorded `company:<id>` and moved on, and the same workspace failed again the
 * next night, for ever. The workspaces most worth erasing were the only ones
 * that could not be.
 *
 * 25s leaves room inside `maxDuration = 60` for the out-of-transaction drains
 * below plus scope 2, and is deliberately under 60_000 — a transaction allowed
 * to outlive the function that opened it is a lock nobody closes.
 */
const TX_OPTIONS = { timeout: 25_000, maxWait: 5_000 };

/**
 * Batch size and per-table ceiling for the append-only tables drained OUTSIDE
 * the transaction. 25 × 2_000 = 50,000 rows per table per night; a workspace
 * with more than that finishes over several nights and is reported as
 * `companiesDeferred`, which is not a failure and must not page anyone.
 */
const DRAIN_BATCH = 2_000;
const MAX_DRAIN_BATCHES = 25;

/**
 * How many overdue rows one invocation will take on, and how long it will keep
 * starting new workspaces. Both exist because this route has a hard 60s ceiling
 * and the work is unbounded: a night that starts a fourth workspace it cannot
 * finish is worse than a night that defers it and says so in the body.
 */
const MAX_COMPANIES_PER_RUN = 10;
const MAX_PROJECTS_PER_RUN = 200;

/**
 * The latest elapsed time at which a new unit of work may be STARTED.
 *
 * DERIVED, not chosen. The check happens before a unit begins, and the unit
 * then opens a transaction that may run for `TX_OPTIONS.timeout`, so any
 * deadline later than `maxDuration - timeout` lets the work outlive the
 * function that started it — which is the half-open transaction the budget
 * exists to prevent.
 *
 * This replaces two hand-picked literals that promised a guarantee the
 * arithmetic could not deliver: 40_000 + 25_000 = 65s and 52_000 + 25_000 =
 * 77s, both against `maxDuration = 60`. Keeping the relationship in code means
 * raising the transaction timeout moves the deadline automatically instead of
 * silently invalidating a comment.
 */
const WIND_DOWN_MS = 3_000; // response assembly + the cron check-in close
const START_DEADLINE_MS = maxDuration * 1_000 - TX_OPTIONS.timeout - WIND_DOWN_MS;

/**
 * Models that carry a `deletedAt` tombstone — or a companyId — but that this
 * route deliberately does NOT name in `purgeCompany`.
 *
 * It is EMPTY, and that is the intended steady state. It exists as a
 * declared escape hatch so that `tests/lib/db/purge-invariants.test.ts` can
 * derive the coverage list from prisma/schema.prisma and still fail loudly
 * rather than being quietly edited to match whatever the route happens to do.
 * Adding an entry is allowed; adding one WITHOUT a comment here saying why the
 * rows may outlive their workspace is not. Surfaced in the response body so
 * the dry-run states what it is knowingly leaving behind.
 */
const PURGE_EXCLUDED = new Set<string>([]);

/**
 * Delete rows from one unbounded table in bounded batches, outside any
 * transaction. Returns how many rows went and whether the table was emptied.
 *
 * `exhausted: false` means the ceiling was reached, not that anything failed:
 * the caller defers the rest of that workspace to tomorrow rather than deleting
 * the parent row out from under the remaining children.
 */
async function drainInBatches(
  page: () => Promise<Array<{ id: string }>>,
  remove: (ids: string[]) => Promise<{ count: number }>
): Promise<{ rows: number; exhausted: boolean }> {
  let rows = 0;
  for (let batch = 0; batch < MAX_DRAIN_BATCHES; batch += 1) {
    const found = await page();
    if (found.length === 0) return { rows, exhausted: true };
    const removed = await remove(found.map((r) => r.id));
    rows += removed.count;
    // A page that returns rows the delete cannot remove would spin for ever
    // otherwise; the ceiling above bounds it, this makes it terminate at once.
    if (removed.count === 0) return { rows, exhausted: false };
  }
  return { rows, exhausted: false };
}

/**
 * Delete one whole workspace. Referencing rows go before referenced rows, so
 * every Restrict + Cascade FK is satisfied regardless of Postgres's own cascade
 * ordering. Rows actually removed are added to `tally` as they commit — the
 * caller reports that number even when this throws, because a partial erasure
 * that claims zero rows is how a 4,500-message delete went unnoticed.
 *
 * Returns "purged" when the workspace is gone and "deferred" when an
 * append-only table hit its per-night ceiling and the company row was
 * deliberately left in place. Throws on failure (caller records + continues).
 *
 * TWO SHAPES, ON PURPOSE (cron-006). The four append-only tables — Message,
 * MessageReaction, Activity, Notification — have no natural ceiling and are
 * drained in batches BEFORE the transaction opens. Everything else is bounded
 * by team size and work items and goes inside one transaction, so the
 * relational core of a workspace either survives intact or disappears
 * completely. The drained rows are past their retention window either way, so
 * removing them outside the transaction loses nothing recoverable.
 *
 * THE BUG THIS LIST ONCE HAD (fixed 2026-09-25). The chat rollout added
 * Channel, ChannelMember, Message and MessageReaction on 2026-09-24 and this
 * function did not learn about them. Verified against prisma/schema.prisma:
 * every chat FK into Company, User, Channel and Message is `onDelete: Cascade`
 * (Message.parent is SetNull), and the datasource has no `relationMode`
 * override, so those are real Postgres constraints. The transaction therefore
 * did NOT jam and the rows DID go away. The harm was narrower, and worth
 * naming precisely so nobody "fixes" the wrong thing:
 *
 *   1. The returned count included none of them, so a live run under-reported
 *      how much it had destroyed.
 *   2. `warnBulkMutation` (lib/safety/bulk-mutation-guard.ts) pages on-call
 *      above 100 rows. A chat-heavy workspace is mostly Message rows, so the
 *      under-count could hold a genuinely enormous purge under the threshold —
 *      the one number the canary exists to watch was the one being wrong.
 *   3. It contradicted this function's own contract. The doc above promises
 *      explicit dependency order "regardless of cascade ordering"; four tables
 *      were silently relying on exactly the cascade ordering it disclaims. The
 *      day someone flips a chat FK to Restrict — e.g. to stop a user delete
 *      taking their messages — this transaction starts failing on a table the
 *      cron has never heard of, and the error names a model that appears
 *      nowhere in this file.
 *
 * `tests/lib/db/purge-invariants.test.ts` derives the required table list from
 * the schema so the eighth soft-delete table is covered the day it lands.
 */
async function purgeCompany(
  companyId: string,
  tally: { rows: number }
): Promise<"purged" | "deferred"> {
  // Chat, innermost first: reactions before the messages they hang off.
  // MessageReaction carries no companyId of its own (see schema.prisma), so it
  // is scoped through its parent rather than by column.
  const reactions = await drainInBatches(
    () =>
      db.messageReaction.findMany({
        where: { message: { companyId } },
        take: DRAIN_BATCH,
        select: { id: true },
      }),
    (ids) => db.messageReaction.deleteMany({ where: { id: { in: ids } } })
  );
  tally.rows += reactions.rows;
  const messages = await drainInBatches(
    () => db.message.findMany({ where: { companyId }, take: DRAIN_BATCH, select: { id: true } }),
    (ids) => db.message.deleteMany({ where: { id: { in: ids } } })
  );
  tally.rows += messages.rows;
  // Activity and Notification are append-only feeds — Notification is the
  // fastest-growing table in the schema — and nothing references either, so
  // they drain in any order without touching the FK graph.
  const activities = await drainInBatches(
    () => db.activity.findMany({ where: { companyId }, take: DRAIN_BATCH, select: { id: true } }),
    (ids) => db.activity.deleteMany({ where: { id: { in: ids } } })
  );
  tally.rows += activities.rows;
  const notifications = await drainInBatches(
    () =>
      db.notification.findMany({ where: { companyId }, take: DRAIN_BATCH, select: { id: true } }),
    (ids) => db.notification.deleteMany({ where: { id: { in: ids } } })
  );
  tally.rows += notifications.rows;
  if (
    !reactions.exhausted ||
    !messages.exhausted ||
    !activities.exhausted ||
    !notifications.exhausted
  ) {
    // Ceiling reached. Leave the company row alone: deleting it now would make
    // the remaining children unreachable by the `companyId` filters above.
    return "deferred";
  }

  const txRows = await db.$transaction(async (tx) => {
    let n = 0;
    const del = async (p: Promise<{ count: number }>) => {
      n += (await p).count;
    };
    const where = { where: { companyId } };
    // ChannelMember carries no companyId of its own, which is also why it has
    // to be deleted BEFORE the channel it hangs off.
    await del(tx.channelMember.deleteMany({ where: { channel: { companyId } } }));
    await del(tx.channel.deleteMany(where));
    // Leaf rows that reference tasks/transactions/projects first.
    await del(tx.comment.deleteMany(where));
    await del(tx.timeEntry.deleteMany(where));
    await del(tx.transaction.deleteMany(where));
    await del(tx.budget.deleteMany(where));
    await del(tx.recurringRule.deleteMany(where));
    // Tasks before projects (Task.project → Project is Restrict).
    await del(tx.task.deleteMany(where));
    await del(tx.inviteToken.deleteMany(where));
    // Projects before users (Project.supervisor/createdBy → User is Restrict).
    await del(tx.project.deleteMany(where));
    // Break the Company↔owner FK before removing users.
    await tx.company.update({ where: { id: companyId }, data: { ownerId: null } });
    await del(tx.user.deleteMany(where));
    await tx.company.delete({ where: { id: companyId } });
    return n + 1; // the company row itself
  }, TX_OPTIONS);
  tally.rows += txRows;
  return "purged";
}

/**
 * The dry run's whole point (cron-005): how many rows a live `purgeCompany`
 * would destroy, per table, without destroying any of them.
 *
 * It mirrors `purgeCompany` table for table and scope for scope — the same
 * `where` shapes, so the numbers are the ones the delete would actually match.
 * `tests/lib/cron/purge-route.test.ts` asserts the two functions name the same
 * delegates, because two hand-maintained lists of table names in one file is
 * exactly the drift that lost the chat tables for a day.
 */
async function countCompanyRows(
  companyId: string
): Promise<{ total: number; byTable: Record<string, number> }> {
  const where = { where: { companyId } };
  const byTable: Record<string, number> = {};
  const add = async (model: string, p: Promise<number>) => {
    byTable[model] = await p;
  };
  await add("MessageReaction", db.messageReaction.count({ where: { message: { companyId } } }));
  await add("Message", db.message.count(where));
  await add("Activity", db.activity.count(where));
  await add("Notification", db.notification.count(where));
  await add("ChannelMember", db.channelMember.count({ where: { channel: { companyId } } }));
  await add("Channel", db.channel.count(where));
  await add("Comment", db.comment.count(where));
  await add("TimeEntry", db.timeEntry.count(where));
  await add("Transaction", db.transaction.count(where));
  await add("Budget", db.budget.count(where));
  await add("RecurringRule", db.recurringRule.count(where));
  await add("Task", db.task.count(where));
  await add("InviteToken", db.inviteToken.count(where));
  await add("Project", db.project.count(where));
  await add("User", db.user.count(where));
  byTable.Company = 1; // the workspace row itself, which db.company.delete removes

  let total = 0;
  const models = Object.keys(byTable);
  for (const model of models) total += byTable[model];
  return { total, byTable };
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed, but LOUDLY (prodready-003). This used to return in silence,
    // so a production deploy that forgot the var meant all three nightly jobs
    // 500'd every night with nothing but a Vercel log line nobody reads.
    // `scripts/vercel-build.mjs` now fails a production build without
    // CRON_SECRET; this is the belt to that brace, for the var being removed
    // after a green build.
    captureServerError(new Error("CRON_SECRET is not configured — purge-soft-deleted cannot run"), {
      action: "purgeSoftDeleted.config",
    });
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Inside the secret check on purpose: an unauthenticated probe of this URL is
  // not a run of the job, and must not close the heartbeat either way.
  return withCronCheckIn(MONITOR, () => purgeRun());
}

async function purgeRun(): Promise<NextResponse> {
  const dryRun = process.env.PURGE_ENABLED !== "true";
  const startedAt = Date.now();
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const overdue = { deletedAt: { not: null, lt: cutoff } };

  const failed: Array<{ stage: string; error: string }> = [];
  const result = {
    companiesPurged: 0,
    /** Workspaces this run deliberately left for the next one. Not a failure. */
    companiesDeferred: 0,
    workspaceRowsDeleted: 0,
    /** Dry-run only: what a live run would destroy. 0 on a live run. */
    workspaceRowsWouldDelete: 0,
    /** Dry-run only: the same figure per table, so the number is auditable. */
    workspaceRowsByTable: {} as Record<string, number>,
    orphanProjectsPurged: 0,
    /** Projects this run deliberately left for the next one. Not a failure. */
    orphanProjectsDeferred: 0,
    orphanProjectRowsDeleted: 0,
    orphanProjectRowsWouldDelete: 0,
  };

  // 1. Whole-workspace erasure, one company at a time in dependency order.
  try {
    const overdueCompanies = await db.company.findMany({
      where: overdue,
      select: { id: true },
      take: MAX_COMPANIES_PER_RUN,
    });
    if (dryRun) {
      result.companiesPurged = overdueCompanies.length;
      for (const c of overdueCompanies) {
        // The dry run needs the same deadline as the live loop. It opens no
        // transaction, but 10 workspaces x 16 sequential counts is not free and
        // this is the branch that runs EVERY night, PURGE_ENABLED being off by
        // design. Overrunning turns the nightly heartbeat into a false alarm.
        if (Date.now() - startedAt > START_DEADLINE_MS) {
          result.companiesDeferred += 1;
          continue;
        }
        const counted = await countCompanyRows(c.id);
        result.workspaceRowsWouldDelete += counted.total;
        const models = Object.keys(counted.byTable);
        for (const model of models) {
          result.workspaceRowsByTable[model] =
            (result.workspaceRowsByTable[model] ?? 0) + counted.byTable[model];
        }
      }
      // The canary now gets a real number BEFORE the first irreversible run —
      // which is the only run where it could ever have prevented anything.
      warnBulkMutation(result.workspaceRowsWouldDelete, {
        action: "purgeSoftDeleted.workspaces.dryRun",
        extra: {
          companies: overdueCompanies.length,
          retentionDays: RETENTION_DAYS,
          byTable: result.workspaceRowsByTable,
        },
      });
    } else {
      for (const c of overdueCompanies) {
        if (Date.now() - startedAt > START_DEADLINE_MS) {
          // Out of budget for this invocation. Starting a workspace we cannot
          // finish inside maxDuration is how a half-open transaction happens.
          result.companiesDeferred += 1;
          continue;
        }
        const tally = { rows: 0 };
        try {
          const outcome = await purgeCompany(c.id, tally);
          if (outcome === "deferred") result.companiesDeferred += 1;
          else result.companiesPurged += 1;
        } catch (e) {
          // One stuck workspace shouldn't block the rest.
          const msg = e instanceof Error ? e.message : "Unknown purge error";
          failed.push({ stage: `company:${c.id}`, error: msg });
          captureServerError(e, {
            action: "purgeSoftDeleted.company",
            extra: { companyId: c.id, cutoff: cutoff.toISOString(), rowsDeleted: tally.rows },
          });
        } finally {
          // Rows that already committed are reported whether the workspace
          // finished or not. A partial erasure claiming 0 rows is invisible.
          result.workspaceRowsDeleted += tally.rows;
        }
      }
      warnBulkMutation(result.workspaceRowsDeleted, {
        action: "purgeSoftDeleted.workspaces",
        extra: { companies: result.companiesPurged, retentionDays: RETENTION_DAYS },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown purge error";
    failed.push({ stage: "companies", error: msg });
    captureServerError(e, { action: "purgeSoftDeleted.companies", extra: { dryRun } });
  }

  // 2. Individually soft-deleted projects in STILL-LIVE workspaces.
  //    Company-tombstoned projects were already handled by scope 1, so this is
  //    scoped to live companies.
  //
  //    ONE PROJECT AT A TIME, CHILDREN FIRST (cron-002). This used to be a
  //    single `db.project.deleteMany({ where: projectWhere })`. Two facts made
  //    that a multi-tenant outage: `deleteProjectAction` decides a project is
  //    empty by counting only `deletedAt: null` tasks and budgets, so a project
  //    whose every task was soft-deleted FIRST passes the emptiness check and
  //    gets tombstoned while those rows physically remain; and Task.project /
  //    Budget.project are `onDelete: Restrict`. So one such project raised a
  //    foreign-key violation for the WHOLE statement: orphanProjectsPurged
  //    stayed 0, the stage failed, and no overdue project in ANY workspace was
  //    ever purged again, every night, because of one customer's data shape.
  //    Per-project now, with its tombstoned children removed in dependency
  //    order inside the same transaction — and anything that still refuses is
  //    one named failure that the others survive.
  try {
    const projectWhere = { ...overdue, company: { deletedAt: null } };
    const overdueProjects = await db.project.findMany({
      where: projectWhere,
      select: { id: true },
      take: MAX_PROJECTS_PER_RUN,
    });
    if (dryRun) {
      result.orphanProjectsPurged = overdueProjects.length;
      for (const p of overdueProjects) {
        if (Date.now() - startedAt > START_DEADLINE_MS) {
          result.orphanProjectsDeferred += 1;
          continue;
        }
        const [tasks, budgets, comments] = await Promise.all([
          db.task.count({ where: { projectId: p.id } }),
          db.budget.count({ where: { projectId: p.id } }),
          // Counted although nothing deletes them directly: Comment.task is
          // onDelete: Cascade, so Postgres removes them and reports no count.
          // Leaving them out makes the dry run understate what a live run
          // destroys, and the canary below thresholds on this number.
          db.comment.count({ where: { task: { projectId: p.id } } }),
        ]);
        result.orphanProjectRowsWouldDelete += tasks + budgets + comments + 1;
      }
      warnBulkMutation(result.orphanProjectRowsWouldDelete, {
        action: "purgeSoftDeleted.orphanProjects.dryRun",
        extra: { projects: overdueProjects.length, retentionDays: RETENTION_DAYS },
      });
    } else {
      for (const p of overdueProjects) {
        if (Date.now() - startedAt > START_DEADLINE_MS) {
          // Same reason as the company loop: the rest are still overdue
          // tomorrow, and `orphanProjectsDeferred` says how many.
          result.orphanProjectsDeferred += 1;
          continue;
        }
        try {
          const rows = await db.$transaction(async (tx) => {
            let n = 0;
            // Unconditional, not `deletedAt: { not: null }`: the project row is
            // going, so every row holding its Restrict FK has to go with it.
            // TimeEntry.task is SetNull, so it never jams.
            // TimeEntry/Transaction/Activity/Notification/RecurringRule point at
            // Project with SetNull and are deliberately kept: they are live
            // workspace data that merely loses its project tag.
            //
            // Comment.task is onDelete: Cascade, so Postgres deletes these rows
            // and reports no count for them. Count them BEFORE the tasks go, or
            // the tally under-states what was destroyed and the canary below
            // thresholds on the wrong number — the same under-count this file's
            // own header calls the real harm of the missing chat tables.
            n += await tx.comment.count({ where: { task: { projectId: p.id } } });
            n += (await tx.task.deleteMany({ where: { projectId: p.id } })).count;
            n += (await tx.budget.deleteMany({ where: { projectId: p.id } })).count;
            await tx.project.delete({ where: { id: p.id } });
            return n + 1; // the project row itself
          }, TX_OPTIONS);
          result.orphanProjectRowsDeleted += rows;
          result.orphanProjectsPurged += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Unknown purge error";
          failed.push({ stage: `orphanProject:${p.id}`, error: msg });
          captureServerError(e, {
            action: "purgeSoftDeleted.orphanProject",
            extra: { projectId: p.id, cutoff: cutoff.toISOString() },
          });
        }
      }
      warnBulkMutation(result.orphanProjectRowsDeleted, {
        action: "purgeSoftDeleted.orphanProjects",
        extra: { projects: result.orphanProjectsPurged, retentionDays: RETENTION_DAYS },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown purge error";
    failed.push({ stage: "orphanProjects", error: msg });
    captureServerError(e, { action: "purgeSoftDeleted.orphanProjects", extra: { dryRun } });
  }

  // 500, not 206 (cron-008). 206 is a 2xx: Vercel's cron view read a
  // permanently-failing stage as a successful invocation, and the "alert
  // externally on a partial drop" half was never built. A 5xx restores
  // Vercel's own escalation, and `withCronCheckIn` turns it into a Sentry
  // monitor error as well.
  const status = failed.length > 0 ? 500 : 200;
  return NextResponse.json(
    {
      ok: failed.length === 0,
      dryRun,
      ranAt: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
      // In dry-run, `companiesPurged` / `orphanProjectsPurged` are "would
      // purge" counts and the row figures live in `workspaceRowsWouldDelete`
      // (+ `workspaceRowsByTable`) and `orphanProjectRowsWouldDelete`. On a
      // live run it is the other way round.
      result,
      // Every count above is ONE PAGE of overdue rows, not the whole backlog:
      // this route has a hard 60s ceiling. Stated explicitly so nobody reads
      // "200 projects" as "200 projects exist". The dry run walks exactly the
      // page the next live run would take, which is what makes the two
      // comparable.
      limits: {
        companiesPerRun: MAX_COMPANIES_PER_RUN,
        projectsPerRun: MAX_PROJECTS_PER_RUN,
      },
      // What the sweep deliberately leaves behind. Empty is the healthy
      // answer; a non-empty array here is the thing to read before trusting
      // "the workspace is gone".
      excludedModels: Array.from(PURGE_EXCLUDED),
      failures: failed,
      durationMs: Date.now() - startedAt,
    },
    { status }
  );
}
