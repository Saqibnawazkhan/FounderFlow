/**
 * Tier 3 nightly purge — the second half of the soft-delete recovery story.
 *
 * Hard-deletes rows whose `deletedAt` sentinel is older than the retention
 * window (default 90 days). Rows inside the window survive so ops can recover
 * a fat-fingered workspace delete by clearing the column.
 *
 * TWO scopes only — deliberately:
 *   1. Whole-workspace erasure: each overdue Company is deleted in EXPLICIT
 *      dependency order inside a transaction (children before parents), so it
 *      never depends on Postgres's cascade ordering and never trips a Restrict
 *      FK (Task.project → Project, Project.supervisor/createdBy → User).
 *   2. Individually soft-deleted PROJECTS in still-live workspaces
 *      (deleteProjectAction soft-deletes empty projects). Safe: an empty
 *      project has no children and its inbound refs are SetNull.
 *
 * There is NO individual-user purge stage, by design. A user deactivated (X8)
 * inside a live workspace keeps their tombstone AND all their content forever —
 * their contributions "stay in the records", as the deactivate UX promises.
 * Only whole-workspace erasure (scope 1) ever removes a user's rows. (Full GDPR
 * erasure of an individual account's PII in a still-live workspace needs an
 * anonymization pass — documented follow-up.)
 *
 * DESTRUCTIVE deletion stays OFF by default (`PURGE_ENABLED` gate): the cron
 * dry-runs (counts, deletes nothing) unless PURGE_ENABLED === "true". With the
 * ordered-deletion fix above, flipping it on is now safe — it's kept opt-in so
 * that auto-erasing customer data remains a deliberate decision.
 *
 * Security: CRON_SECRET, constant-time compared, fail-closed on missing env.
 * Bulk-mutation canary fires if a run deletes more than the threshold.
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

/**
 * Delete one whole workspace in dependency order within a single transaction.
 * Referencing rows go before referenced rows, so every Restrict + Cascade FK
 * is satisfied regardless of Postgres's own cascade ordering. Returns the
 * number of rows removed. Throws on failure (caller records + continues).
 */
async function purgeCompany(companyId: string): Promise<number> {
  return db.$transaction(async (tx) => {
    let n = 0;
    const del = async (p: Promise<{ count: number }>) => {
      n += (await p).count;
    };
    const where = { where: { companyId } };
    // Leaf rows that reference tasks/transactions/projects first.
    await del(tx.comment.deleteMany(where));
    await del(tx.timeEntry.deleteMany(where));
    await del(tx.transaction.deleteMany(where));
    await del(tx.budget.deleteMany(where));
    await del(tx.recurringRule.deleteMany(where));
    // Tasks before projects (Task.project → Project is Restrict).
    await del(tx.task.deleteMany(where));
    await del(tx.activity.deleteMany(where));
    await del(tx.notification.deleteMany(where));
    await del(tx.inviteToken.deleteMany(where));
    // Projects before users (Project.supervisor/createdBy → User is Restrict).
    await del(tx.project.deleteMany(where));
    // Break the Company↔owner FK before removing users.
    await tx.company.update({ where: { id: companyId }, data: { ownerId: null } });
    await del(tx.user.deleteMany(where));
    await tx.company.delete({ where: { id: companyId } });
    n += 1; // the company row itself
    return n;
  });
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = process.env.PURGE_ENABLED !== "true";
  const startedAt = Date.now();
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const overdue = { deletedAt: { not: null, lt: cutoff } };

  const failed: Array<{ stage: string; error: string }> = [];
  const result = {
    companiesPurged: 0,
    workspaceRowsDeleted: 0,
    orphanProjectsPurged: 0,
  };

  // 1. Whole-workspace erasure, one company at a time in dependency order.
  try {
    const overdueCompanies = await db.company.findMany({ where: overdue, select: { id: true } });
    if (dryRun) {
      result.companiesPurged = overdueCompanies.length;
    } else {
      for (const c of overdueCompanies) {
        try {
          result.workspaceRowsDeleted += await purgeCompany(c.id);
          result.companiesPurged += 1;
        } catch (e) {
          // One stuck workspace shouldn't block the rest.
          const msg = e instanceof Error ? e.message : "Unknown purge error";
          failed.push({ stage: `company:${c.id}`, error: msg });
          captureServerError(e, {
            action: "purgeSoftDeleted.company",
            extra: { companyId: c.id, cutoff: cutoff.toISOString() },
          });
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

  // 2. Individually soft-deleted (empty) projects in STILL-LIVE workspaces.
  //    Safe to hard-delete; no cascade harm. Company-tombstoned projects were
  //    already handled by scope 1, so scope this to live companies.
  try {
    const projectWhere = { ...overdue, company: { deletedAt: null } };
    if (dryRun) {
      result.orphanProjectsPurged = await db.project.count({ where: projectWhere });
    } else {
      const { count } = await db.project.deleteMany({ where: projectWhere });
      result.orphanProjectsPurged = count;
      warnBulkMutation(count, {
        action: "purgeSoftDeleted.orphanProjects",
        extra: { retentionDays: RETENTION_DAYS },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown purge error";
    failed.push({ stage: "orphanProjects", error: msg });
    captureServerError(e, { action: "purgeSoftDeleted.orphanProjects", extra: { dryRun } });
  }

  const status = failed.length > 0 ? 206 : 200;
  return NextResponse.json(
    {
      ok: failed.length === 0,
      dryRun,
      ranAt: now.toISOString(),
      cutoff: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
      // In dry-run these are "would purge" counts; deletion only runs when
      // PURGE_ENABLED=true.
      result,
      failures: failed,
      durationMs: Date.now() - startedAt,
    },
    { status }
  );
}
