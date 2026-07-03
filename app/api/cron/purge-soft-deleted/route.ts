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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETENTION_DAYS = 90;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  async function purgeStage(stage: keyof typeof purged, run: () => Promise<{ count: number }>) {
    try {
      const { count } = await run();
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
        extra: { stage, cutoff: cutoff.toISOString() },
      });
    }
  }

  // 1. Companies cascade to everything within, so they go first.
  await purgeStage("companies", () =>
    db.company.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } })
  );
  // 2. Orphaned rows whose parent workspace is still live but the row itself
  //    was individually tombstoned (e.g. a member left the team 91 days ago).
  await purgeStage("users", () =>
    db.user.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } })
  );
  await purgeStage("projects", () =>
    db.project.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } })
  );
  await purgeStage("tasks", () =>
    db.task.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } })
  );
  await purgeStage("budgets", () =>
    db.budget.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } })
  );
  await purgeStage("transactions", () =>
    db.transaction.deleteMany({ where: { deletedAt: { not: null, lt: cutoff } } })
  );

  const status = failed.length > 0 ? 206 : 200;
  return NextResponse.json(
    {
      ok: failed.length === 0,
      ranAt: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
      purged,
      failures: failed,
      durationMs: Date.now() - startedAt,
    },
    { status }
  );
}
