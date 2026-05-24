"use server";

/**
 * Team / user server actions. Writes are admin-only (closes audit flaw #8 for
 * team management); reads are scoped to session.user.companyId.
 *
 * Invariants enforced server-side:
 *   - Only admins can invite, remove, or change roles.
 *   - You can't remove yourself (use the regular sign-out flow).
 *   - You can't demote yourself (avoid accidental lock-out).
 *   - A company must always have at least one admin (refuse the last-admin
 *     removal or demotion).
 *   - Invited users always land in the same company as the inviter.
 *   - Invited users start with the requested role from the InviteUserSchema
 *     (cofounder | member). Minting another admin requires a follow-up
 *     updateUserRoleAction, which itself logs an activity.
 */

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { InviteUserSchema, UpdateRoleSchema } from "@/lib/schemas/user";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import type { User } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

/** Strip the passwordHash before returning to the client. */
function toClient(u: {
  id: string;
  name: string;
  email: string;
  role: string;
  avatar: string | null;
  companyId: string;
  createdAt: Date;
}): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    password: "", // legacy field; never populated server-side
    role: u.role as User["role"],
    avatar: u.avatar ?? undefined,
    companyId: u.companyId,
    createdAt: u.createdAt.toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reads                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function listCompanyUsersAction(): Promise<ActionResult<User[]>> {
  const session = await auth();
  if (!session?.user?.companyId) return { success: false, error: "Not authenticated" };

  const rows = await db.user.findMany({
    where: { companyId: session.user.companyId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  return { success: true, data: rows.map(toClient) };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Writes — every one requires admin role                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.id || !session?.user?.companyId) {
    return { ok: false, error: "Not authenticated" } as const;
  }
  if (session.user.role !== "admin") {
    return { ok: false, error: "Only admins can change the team" } as const;
  }
  return {
    ok: true,
    userId: session.user.id,
    companyId: session.user.companyId,
  } as const;
}

export async function inviteUserAction(input: unknown): Promise<ActionResult<User>> {
  const gate = await requireAdmin();
  if (!gate.ok) return { success: false, error: gate.error };

  const rl = limiters.write.consume(gate.userId);
  if (!rl.allowed) return { success: false, error: rl.error ?? "Too many requests" };

  const parsed = InviteUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid invite",
    };
  }
  const { name, email, password, role } = parsed.data;
  const { userId: actorId, companyId } = gate;

  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return {
        success: false,
        error: "An account with this email already exists",
      };
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const actor = await db.user.findUnique({ where: { id: actorId } });
    if (!actor) return { success: false, error: "User no longer exists" };

    const created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name, email, passwordHash, role, companyId },
      });
      await tx.activity.create({
        data: {
          companyId,
          type: "user_joined",
          message: `${actor.name} added ${name} as ${
            role === "cofounder" ? "Co-Founder" : "Team Member"
          }`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({ kind: "user", invitedUser: name, role }),
        },
      });
      // Welcome notification for the new user themselves.
      await tx.notification.create({
        data: {
          userId: user.id,
          companyId,
          title: "Welcome to FounderFlow",
          message: `${actor.name} invited you to the workspace. Get started by exploring the dashboard.`,
          type: "info",
          link: "/dashboard",
        },
      });
      return user;
    });

    revalidatePath("/team");
    revalidatePath("/activities");
    revalidatePath("/notifications");

    return { success: true, data: toClient(created) };
  } catch (e) {
    captureServerError(e, { action: "inviteUserAction" });
    return {
      success: false,
      error: "Couldn't invite right now. Try again in a moment.",
    };
  }
}

export async function updateUserRoleAction(input: unknown): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return { success: false, error: gate.error };

  const parsed = UpdateRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid role change" };
  }
  const { userId, role } = parsed.data;
  const { userId: actorId, companyId } = gate;

  try {
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) return { success: false, error: "User not found" };
    if (target.companyId !== companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (target.role === role) {
      // No-op — return success so the UI can still refresh.
      return { success: true, data: undefined };
    }

    // Don't let an admin demote themselves out of admin if they're the last one.
    if (target.id === actorId && role !== "admin") {
      const adminCount = await db.user.count({
        where: { companyId, role: "admin" },
      });
      if (adminCount <= 1) {
        return {
          success: false,
          error: "You're the only admin. Promote someone else first, then change your role.",
        };
      }
    }

    const actor = await db.user.findUnique({ where: { id: actorId } });
    if (!actor) return { success: false, error: "User no longer exists" };

    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { role } });
      await tx.activity.create({
        data: {
          companyId,
          type: "user_role_changed",
          message: `${actor.name} changed ${target.name}'s role to ${role}`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({
            kind: "user",
            invitedUser: target.name,
            role,
            previousRole: target.role,
          }),
        },
      });
      // Tell the target unless they're the actor.
      if (target.id !== actorId) {
        await tx.notification.create({
          data: {
            userId: target.id,
            companyId,
            title: "Your role changed",
            message: `${actor.name} updated your role to ${role}`,
            type: "info",
            link: "/team",
          },
        });
      }
    });

    revalidatePath("/team");
    revalidatePath("/activities");
    revalidatePath("/notifications");

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateUserRoleAction" });
    return { success: false, error: "Couldn't change role right now." };
  }
}

export async function removeUserAction(userId: string): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return { success: false, error: gate.error };
  const { userId: actorId, companyId } = gate;

  if (userId === actorId) {
    return {
      success: false,
      error: "Use the Sign-out button to leave the workspace yourself.",
    };
  }

  try {
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) return { success: false, error: "User not found" };
    if (target.companyId !== companyId) {
      return { success: false, error: "Not authorized" };
    }

    // Don't let the last admin be removed (the company would be ownerless).
    if (target.role === "admin") {
      const adminCount = await db.user.count({
        where: { companyId, role: "admin" },
      });
      if (adminCount <= 1) {
        return {
          success: false,
          error: "You can't remove the last admin. Promote someone else first.",
        };
      }
    }

    const actor = await db.user.findUnique({ where: { id: actorId } });
    if (!actor) return { success: false, error: "User no longer exists" };

    // Note: Prisma schema cascades on User deletion, so the target user's
    // transactions, tasks, activities, and notifications all go with them.
    // The UI surfaces a destructive ConfirmDialog before this fires.
    await db.$transaction(async (tx) => {
      await tx.user.delete({ where: { id: userId } });
      // Re-point company ownership if we just deleted the owner.
      const company = await tx.company.findUnique({ where: { id: companyId } });
      if (company?.ownerId === userId) {
        await tx.company.update({
          where: { id: companyId },
          data: { ownerId: actorId },
        });
      }
      await tx.activity.create({
        data: {
          companyId,
          type: "user_removed",
          message: `${actor.name} removed ${target.name} from the team`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({
            kind: "user",
            invitedUser: target.name,
            role: target.role,
          }),
        },
      });
    });

    revalidatePath("/team");
    revalidatePath("/activities");
    revalidatePath("/notifications");

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "removeUserAction" });
    return { success: false, error: "Couldn't remove right now." };
  }
}
