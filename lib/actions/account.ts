"use server";

/**
 * Danger-zone server actions — the two irreversible operations that used to
 * be a GDPR/CCPA gap.
 *
 *  1. `deleteAccountAction`  — "Delete my account"
 *  2. `deleteWorkspaceAction` — "Delete this workspace" (admin only)
 *
 * Both re-authenticate with a fresh password check inside the action even
 * though the caller already has a valid session cookie. A logged-in user
 * shouldn't be able to erase their data by accident; the password prompt
 * is the friction that makes the action deliberate.
 *
 * Cascade reliance:
 *   The Prisma schema is already thoroughly wired for `onDelete: Cascade`
 *   from Company → most owned rows and from User → most user-owned rows.
 *   The two hand-managed edges are Project.supervisor / Project.creator,
 *   which are marked non-null with no cascade — a naive `db.user.delete`
 *   would foreign-key-error if the leaver supervises or created any project.
 *   `deleteAccountAction` reassigns those FKs to the company owner first
 *   (so the projects survive) before removing the user row.
 */

import bcrypt from "bcryptjs";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { DeleteAccountSchema, DeleteWorkspaceSchema } from "@/lib/schemas/account";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

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
 * Tombstone a company + every child row that carries a `deletedAt` sentinel
 * (Users, Projects, Tasks, Budgets, Transactions). Runs inside a single
 * Prisma $transaction so a partial failure never leaves half the workspace
 * tombstoned. Returns the total row count touched (for the bulk-mutation
 * canary).
 *
 * Skipped tables: Activity, Notification, Comment, TimeEntry, InviteToken,
 * RecurringRule. They don't carry `deletedAt` (yet) — the nightly purge
 * still catches their orphans when the parent Company is hard-purged, via
 * the existing `onDelete: Cascade` chain.
 */
async function softDeleteWorkspace(companyId: string, now: Date): Promise<number> {
  const [txn, budget, task, project, user, company] = await db.$transaction([
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
    db.user.updateMany({
      where: { companyId, deletedAt: null },
      data: { deletedAt: now },
    }),
    db.company.update({
      where: { id: companyId },
      data: { deletedAt: now },
    }),
  ]);
  return txn.count + budget.count + task.count + project.count + user.count + (company ? 1 : 0);
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
 *   -- (repeat for Transaction/Task/Budget/Project — they share the
 *   -- same tombstone timestamp so a range filter reunites them)
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
      extra: { workspaceName: company.name },
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
