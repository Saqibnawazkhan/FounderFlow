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

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

/**
 * Delete the caller's User row.
 *
 * Special case: if the caller is the SOLE user of their company (whether or
 * not they're the admin), we cascade to a workspace delete because there's
 * nothing left worth preserving after they leave.
 *
 * Blocked cases (returns error, no writes):
 *   - Caller is admin AND another admin exists → they can leave, delete
 *     just their user
 *   - Caller is admin AND is the sole admin AND other members exist →
 *     refuse; ask them to promote another admin first, or use
 *     `deleteWorkspaceAction` to wipe the whole workspace
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
      where: { companyId, id: { not: me.id } },
    });
    const otherAdmins = await db.user.count({
      where: { companyId, id: { not: me.id }, role: "admin" },
    });

    // Sole-user branch: cascade to workspace delete. This is what happens
    // when Abdul (single-admin solo-founder shape) hits "Delete my account".
    if (otherUsers === 0) {
      await db.company.delete({ where: { id: companyId } });
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

    // Non-sole path: reassign the FKs that would otherwise block delete,
    // then remove the user. The company owner picks up orphaned projects
    // (they're always still around — Company.ownerId is only null during
    // signup transactions, never in steady state).
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { ownerId: true },
    });
    const fallbackUserId = company?.ownerId && company.ownerId !== me.id ? company.ownerId : null;

    await db.$transaction(async (tx) => {
      if (fallbackUserId) {
        await tx.project.updateMany({
          where: { supervisorId: me.id },
          data: { supervisorId: fallbackUserId },
        });
        await tx.project.updateMany({
          where: { createdBy: me.id },
          data: { createdBy: fallbackUserId },
        });
      }
      await tx.user.delete({ where: { id: me.id } });
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
 * Delete the entire workspace and everything inside it — every user, every
 * transaction, every task. Admin-only, and requires typing the workspace
 * name exactly to guard against muscle-memory clicks.
 *
 * Cascade goes:
 *   Company → users (onDelete: Cascade)
 *     → each user's transactions / tasks / activities / etc. cascade in turn
 *   Company → transactions / tasks / activities / budgets / … direct cascades
 *
 * Net result: one `db.company.delete` erases the whole workspace.
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

    await db.company.delete({ where: { id: me.companyId } });
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
