"use server";

/**
 * Danger-zone server actions — the two irreversible operations that used to
 * be a GDPR/CCPA gap (now recoverable for 90 days via Tier 3 soft-delete).
 *
 *  1. `deleteAccountAction`  — "Delete my account"
 *  2. `deleteWorkspaceAction` — "Delete this workspace" (admin only)
 *
 * Both re-authenticate with a fresh password check inside the action even
 * though the caller already has a valid session cookie. A logged-in user
 * shouldn't be able to erase their data by accident; the password prompt
 * is the friction that makes the action deliberate.
 *
 * Soft-delete cascade:
 *   Instead of `db.company.delete()` we UPDATE a nullable `deletedAt`
 *   sentinel on Company + its child rows that carry the same column
 *   (Users, Projects, Tasks, Budgets, Transactions, Messages). Reads all filter
 *   `deletedAt: null`, so tombstoned rows disappear from the UI, the
 *   team list, mention pickers, and auth — but the physical rows stay
 *   for 90 days. `/api/cron/purge-soft-deleted` hard-deletes them after
 *   the window; nothing survives past that.
 *
 * Recovery within the window (ops, no user UI):
 *   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<id>';
 *   UPDATE "User"    SET "deletedAt" = NULL WHERE "companyId" = '<id>';
 *   -- child rows share the same tombstone timestamp, so a range filter
 *   -- reunites them:
 *   UPDATE "Transaction" SET "deletedAt" = NULL
 *     WHERE "deletedAt" BETWEEN '<t - 1s>' AND '<t + 1s>';
 */

import bcrypt from "bcryptjs";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { DeleteAccountSchema, DeleteWorkspaceSchema } from "@/lib/schemas/account";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";

import type { ActionResult } from "@/lib/actions/types";

/**
 * Delete the caller's User row.
 *
 * Since Tier 3 this is a SOFT delete — the row stays in Postgres with a
 * `deletedAt` timestamp so ops can recover within 90 days by clearing the
 * column. A nightly cron at /api/cron/purge-soft-deleted hard-purges rows
 * whose deletedAt is older than 90 days.
 *
 * Cascade semantics:
 *   - Sole-user branch (Abdul's solo-founder shape): tombstones the whole
 *     workspace so the recovery is one UPDATE per table.
 *   - Multi-user branch: only tombstones the leaving user. Their tasks +
 *     comments + activity + notifications survive so the workspace history
 *     stays intact for their teammates.
 *
 * Blocked case: sole-admin-with-teammates. Same guardrail as before —
 * promote another admin first, or delete the whole workspace.
 */
export async function deleteAccountAction(input: unknown): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = DeleteAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { password } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "Account no longer exists" };

    const ok = await bcrypt.compare(password, me.passwordHash);
    if (!ok) return { success: false, error: "Password doesn't match" };

    const companyId = me.companyId;
    const otherUsers = await db.user.count({
      where: { companyId, id: { not: me.id }, deletedAt: null },
    });
    const otherAdmins = await db.user.count({
      where: { companyId, id: { not: me.id }, role: "admin", deletedAt: null },
    });

    const now = new Date();

    // Sole-user branch: tombstone the whole workspace (same cascade as the
    // admin-triggered workspace delete). Recovery is one UPDATE per table.
    if (otherUsers === 0) {
      const rowsTouched = await softDeleteWorkspace(companyId, now);
      warnBulkMutation(rowsTouched, {
        action: "deleteAccountAction.soleUser",
        userId: me.id,
        companyId,
        // Carried into the Sentry event so whoever reads the canary can see
        // what the sweep knowingly left untombstoned, without opening this
        // file. Empty today.
        extra: { softDeleteExcluded: SOFT_DELETE_EXCLUDED },
      });
      await signOut({ redirect: false });
      return { success: true, data: undefined };
    }

    if (me.role === "admin" && otherAdmins === 0) {
      return {
        success: false,
        error:
          "You're the only admin and there are still teammates in this workspace. " +
          "Promote another teammate to admin first, or delete the workspace instead.",
      };
    }

    // Multi-user branch: only tombstone the leaving user. Teammates still
    // see who created what — Project.supervisor and Task.assignee joins
    // still resolve because the row physically exists.
    await db.user.update({
      where: { id: me.id },
      data: { deletedAt: now },
    });

    await signOut({ redirect: false });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, {
      action: "deleteAccountAction",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return {
      success: false,
      error: "Couldn't delete your account right now. Try again shortly.",
    };
  }
}

/**
 * Models that DO carry a `deletedAt` column but that this sweep deliberately
 * leaves live. Empty, and meant to stay that way.
 *
 * It is declared rather than implied so `tests/lib/db/purge-invariants.test.ts`
 * can derive the soft-deletable list from prisma/schema.prisma and check it
 * against this function. An entry here is a promise that the rows are
 * unreachable by some other means; write that reasoning next to it.
 */
const SOFT_DELETE_EXCLUDED: readonly string[] = [];

/**
 * Tombstone a company + every child row that carries a `deletedAt` sentinel
 * (Users, Projects, Tasks, Budgets, Transactions, Messages). Runs inside a
 * single Prisma $transaction so a partial failure never leaves half the
 * workspace tombstoned. Returns the total row count touched (for the
 * bulk-mutation canary).
 *
 * Message joined the soft-delete set on 2026-09-24 with the chat rollout and
 * this function did not follow it until 2026-09-25 — deleting a workspace left
 * every chat row live, with `deletedAt: null`, for the full 90-day retention
 * window. Nothing could read them (see below), so it was not an exposure; it
 * was a lie in the data. Anything that trusts the tombstone rather than the
 * session — an export, a support query, a future admin tool, the eventual GDPR
 * anonymization pass — would have walked straight past a "deleted" workspace's
 * messages.
 *
 * Channel, ChannelMember and MessageReaction are NOT tombstoned, and cannot be:
 * they have no `deletedAt` column at all. Channel's `archivedAt` is not a
 * substitute — it means "closed to new posts, history still readable", a
 * different thing, and writing it here would corrupt recovery (restoring the
 * workspace could not tell a channel archived by the sweep from one a human
 * archived last month). Leaving them live is safe for the same reason the
 * pre-existing skips below are: every chat read goes through
 * `requireScopedSession()`, and auth filters `deletedAt: null` on User, so a
 * tombstoned workspace has no session that can reach them. They die for real
 * when /api/cron/purge-soft-deleted hard-purges the Company.
 *
 * Skipped tables (no `deletedAt` column): Activity, Notification, Comment,
 * TimeEntry, InviteToken, RecurringRule, Channel, ChannelMember,
 * MessageReaction. The nightly purge deletes each of them by name when the
 * parent Company is hard-purged.
 */
async function softDeleteWorkspace(companyId: string, now: Date): Promise<number> {
  const [txn, budget, task, project, message, user, company] = await db.$transaction([
    db.transaction.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    db.budget.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    db.task.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    db.project.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    // `deletedAt: null` is doing real work here, not just skipping no-ops: a
    // message a user deleted last week must keep ITS timestamp, so restoring
    // the workspace by the sweep's timestamp brings the thread back without
    // resurrecting the one message its author took down.
    db.message.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    db.user.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    db.company.update({
      where: { id: companyId },
      data: { deletedAt: now },
    }),
  ]);
  return (
    txn.count +
    budget.count +
    task.count +
    project.count +
    message.count +
    user.count +
    (company ? 1 : 0)
  );
}

/**
 * Delete the entire workspace and everything inside it — every user, every
 * transaction, every task. Admin-only, and requires typing the workspace
 * name exactly to guard against muscle-memory clicks.
 *
 * Since Tier 3 this is a SOFT delete via `softDeleteWorkspace()` — same
 * cascade the sole-user account-delete branch takes. Recovery in ops:
 *
 *   UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<id>';
 *   UPDATE "User" SET "deletedAt" = NULL WHERE "companyId" = '<id>';
 *   -- (repeat for Transaction/Task/Budget/Project/Message — they share the
 *   -- same tombstone timestamp so a range filter reunites them, and a
 *   -- range filter is what keeps individually-deleted messages deleted)
 *
 * The nightly cron at /api/cron/purge-soft-deleted hard-deletes rows past
 * the 90-day window; nothing is recoverable after that.
 */
export async function deleteWorkspaceAction(input: unknown): Promise<ActionResult<void>> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    return { success: false, error: "Not authenticated" };
  }
  if (session.user.role !== "admin") {
    return { success: false, error: "Only an admin can delete the workspace" };
  }

  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = DeleteWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { password, workspaceName } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "Account no longer exists" };

    const ok = await bcrypt.compare(password, me.passwordHash);
    if (!ok) return { success: false, error: "Password doesn't match" };

    const company = await db.company.findUnique({
      where: { id: me.companyId },
      select: { name: true },
    });
    if (!company) {
      return { success: false, error: "Workspace no longer exists" };
    }
    // Case-sensitive on purpose. The confirmation is meant to be muscle-
    // memory friction, not a lenient guess.
    if (company.name.trim() !== workspaceName.trim()) {
      return {
        success: false,
        error: `Workspace name doesn't match. Type "${company.name}" exactly.`,
      };
    }

    const now = new Date();
    const rowsTouched = await softDeleteWorkspace(me.companyId, now);
    warnBulkMutation(rowsTouched, {
      action: "deleteWorkspaceAction",
      userId: me.id,
      companyId: me.companyId,
      extra: { workspaceName: company.name, softDeleteExcluded: SOFT_DELETE_EXCLUDED },
    });
    await signOut({ redirect: false });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, {
      action: "deleteWorkspaceAction",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return {
      success: false,
      error: "Couldn't delete the workspace right now. Try again shortly.",
    };
  }
}
