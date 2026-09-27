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
 *      "Explicit" is the whole design: every workspace-scoped table is named
 *      here, including the four chat tables added 2026-09-24. See
 *      `purgeCompany` for why leaning on cascade instead was a real bug.
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
 * Delete one whole workspace in dependency order within a single transaction.
 * Referencing rows go before referenced rows, so every Restrict + Cascade FK
 * is satisfied regardless of Postgres's own cascade ordering. Returns the
 * number of rows removed. Throws on failure (caller records + continues).
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
 *   1. The returned `n` counted none of them, so a live run under-reported
 *      how much it had destroyed. (The DRY-RUN path never calls this function
 *      at all — it reports `companiesPurged` only — so the dry run was not the
 *      victim here; the live run's `workspaceRowsDeleted` was.)
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
async function purgeCompany(companyId: string): Promise<number> {
  return db.$transaction(async (tx) => {
    let n = 0;
    const del = async (p: Promise<{ count: number }>) => {
      n += (await p).count;
    };
    const where = { where: { companyId } };
    // Chat, innermost first: reactions → messages → memberships → channels.
    // ChannelMember and MessageReaction carry no companyId of their own (see
    // schema.prisma), so they are scoped through their parent rather than by
    // column — which is also why they have to be deleted BEFORE that parent.
    await del(tx.messageReaction.deleteMany({ where: { message: { companyId } } }));
    await del(tx.message.deleteMany(where));
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
      // PURGE_ENABLED=true. Note `workspaceRowsDeleted` is 0 in dry-run by
      // construction — purgeCompany isn't called — so it is a live-run figure.
      result,
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
