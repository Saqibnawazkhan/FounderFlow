/**
 * Tier 3 nightly purge — the second half of the soft-delete recovery story.
 *
 * Every night, hard-delete rows whose `deletedAt` sentinel is older than
 * the retention window (default: 90 days). Rows inside the window survive
 * so ops can recover a fat-fingered workspace delete by clearing the column.
 *
 * Order of operations:
 *   1. Purge past-window Companies first. Their `onDelete: Cascade`
 *      children (transactions, tasks, budgets, projects, users, activities,
 *      notifications, comments, timeEntries, recurring rules, invite tokens)
 *      all disappear in the same statement, so the counts below don't
 *      double-count child rows.
 *   2. Purge remaining orphaned tombstones per table — mostly the
 *      "individual user left the team" case where only the User row
 *      carried deletedAt.
 *
 * Security: same CRON_SECRET pattern as /api/cron/materialize-recurring.
 * A missing env var fails closed (500) so the endpoint isn't exposed by
 * accident.
 *
 * Bulk-mutation canary: after every stage, if the count is over
 * `BULK_MUTATION_THRESHOLD` we fire a Sentry warning so on-call sees a
 * sudden spike (e.g. a bug wiped 10,000 rows overnight) without waiting
 * for a customer to notice.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { safeEqual } from "@/lib/safe-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETENTION_DAYS = 90;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // DESTRUCTIVE hard-delete is OFF by default. This cron only deletes rows
  // when PURGE_ENABLED === "true"; otherwise it runs a DRY RUN that COUNTS
  // what would be purged and deletes nothing. Two reasons this is opt-in:
  //   1. Auto-erasing customer data must be a deliberate, explicit decision.
  //   2. Known FK-cascade bug: the "users" stage below hard-deletes a
  //      soft-deleted User, and Transaction/Task/Comment/Budget/RecurringRule/
  //      TimeEntry all declare onDelete: Cascade on their user FK — so purging
  //      a member who was deactivated (X8) inside a STILL-LIVE workspace would
  //      cascade away their expenses/tasks/comments, contradicting X8's
  //      "their contributions stay in the records" promise. Users who created
  //      or supervise a live project instead trip the Project Restrict FK and
  //      abort the whole stage.
  //   DO NOT set PURGE_ENABLED=true in production until those user-authored
  //   FKs are moved to SetNull (the denormalized *Name columns already keep
  //   the history) and supervisor/creator reassignment is implemented.
  //   Tracked in FaultsAudit.md. The dry-run output still surfaces the backlog
  //   so ops can see retention working without any deletion.
  const dryRun = process.env.PURGE_ENABLED !== "true";
  const startedAt = Date.now();
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const failed: Array<{ stage: string; error: string }> = [];
  const purged: Record<string, number> = {
    companies: 0,
    users: 0,
    projects: 0,
    tasks: 0,
    budgets: 0,
    transactions: 0,
  };

  type PurgeDelegate = {
    count: (args: { where: unknown }) => Promise<number>;
    deleteMany: (args: { where: unknown }) => Promise<{ count: number }>;
  };
  const overdue = { deletedAt: { not: null, lt: cutoff } };

  async function purgeStage(stage: keyof typeof purged, model: PurgeDelegate) {
    try {
      if (dryRun) {
        // Count only — surfaces the retention backlog without deleting.
        purged[stage] = await model.count({ where: overdue });
        return;
      }
      const { count } = await model.deleteMany({ where: overdue });
      purged[stage] = count;
      warnBulkMutation(count, {
        action: `purgeSoftDeleted.${stage}`,
        extra: { cutoff: cutoff.toISOString(), retentionDays: RETENTION_DAYS },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown purge error";
      failed.push({ stage, error: msg });
      captureServerError(e, {
        action: "purgeSoftDeleted",
        extra: { stage, cutoff: cutoff.toISOString(), dryRun },
      });
    }
  }

  // Companies cascade to everything within, so they go first; the remaining
  // stages catch rows individually tombstoned inside a still-live workspace.
  await purgeStage("companies", db.company as unknown as PurgeDelegate);
  await purgeStage("users", db.user as unknown as PurgeDelegate);
  await purgeStage("projects", db.project as unknown as PurgeDelegate);
  await purgeStage("tasks", db.task as unknown as PurgeDelegate);
  await purgeStage("budgets", db.budget as unknown as PurgeDelegate);
  await purgeStage("transactions", db.transaction as unknown as PurgeDelegate);

  const status = failed.length > 0 ? 206 : 200;
  return NextResponse.json(
    {
      ok: failed.length === 0,
      dryRun,
      ranAt: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
      // In dry-run these are "would purge" counts; deletion only happens when
      // PURGE_ENABLED=true.
      purged,
      failures: failed,
      durationMs: Date.now() - startedAt,
    },
    { status }
  );
}
