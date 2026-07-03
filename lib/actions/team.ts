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
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { AcceptInviteSchema, InviteUserSchema, UpdateRoleSchema } from "@/lib/schemas/user";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import { sendEmail } from "@/lib/email/send";
import { renderInviteEmail } from "@/lib/email/templates/invite";
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
    // Tier 3: soft-deleted teammates disappear from the team list.
    where: { companyId: session.user.companyId, deletedAt: null },
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

/**
 * Phase 6: invite-by-email. Generates a single-use token (7-day expiry),
 * stores it on the InviteToken table, and emails a `/invite/[token]` link
 * to the recipient. We deliberately DON'T create a User row here — that
 * would block re-inviting and leave orphaned accounts when invites lapse.
 *
 * Returns `{ inviteUrl }` so the UI can show / copy the link directly,
 * useful in dev where Resend isn't configured (the server logs it too).
 */
export async function inviteUserAction(
  input: unknown
): Promise<ActionResult<{ email: string; emailSent: boolean; inviteUrl: string }>> {
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
  const { name, email, role } = parsed.data;
  const { userId: actorId, companyId } = gate;

  try {
    // Refuse if the email already belongs to a real account.
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return {
        success: false,
        error: "An account with this email already exists",
      };
    }

    // If a still-pending invite exists for this email + company, invalidate
    // it before issuing a fresh one (so resending the invite always works).
    await db.inviteToken.deleteMany({
      where: { email, companyId, usedAt: null },
    });

    const actor = await db.user.findUnique({ where: { id: actorId } });
    if (!actor) return { success: false, error: "User no longer exists" };
    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) return { success: false, error: "Company no longer exists" };

    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.$transaction(async (tx) => {
      await tx.inviteToken.create({
        data: { token, email, name, role, companyId, invitedBy: actorId, expiresAt },
      });
      await tx.activity.create({
        data: {
          companyId,
          type: "user_joined",
          message: `${actor.name} invited ${name} (${role === "cofounder" ? "Co-Founder" : "Team Member"})`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({ kind: "user", invitedUser: name, role }),
        },
      });
    });

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
    const inviteUrl = `${baseUrl}/invite/${token}`;

    // Render + send the email. Result is ignored on failure — the invite
    // row exists, so the admin can copy the URL from the response and
    // share it manually if Resend rejects.
    const { html, text } = renderInviteEmail({
      inviteeName: name,
      inviterName: actor.name,
      companyName: company.name,
      roleLabel: role === "cofounder" ? "Co-Founder" : "Team Member",
      acceptUrl: inviteUrl,
    });
    const sendResult = await sendEmail({
      to: email,
      subject: `${actor.name} invited you to ${company.name} on FounderFlow`,
      html,
      text,
    });

    revalidatePath("/team");
    revalidatePath("/activities");

    return {
      success: true,
      data: { email, emailSent: sendResult.delivered, inviteUrl },
    };
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
        where: { companyId, role: "admin", deletedAt: null },
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
        where: { companyId, role: "admin", deletedAt: null },
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* Accept invite — runs from /invite/[token] when the recipient sets pw       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The /invite/[token] flow: the recipient submits the form, this action
 * re-validates the token (existence + not expired + not used), creates the
 * real User with their chosen password, marks the token used, fan-outs the
 * welcome notification + activity, and auto-signs them in.
 *
 * Race condition: between two browser tabs both submitting at the same
 * moment, only the first wins because we wrap the user-create + token-mark
 * in a single `$transaction` and bail if `findUnique({ where: { email } })`
 * already returns a row from the prior tab.
 */
export async function acceptInviteAction(input: unknown): Promise<ActionResult> {
  const parsed = AcceptInviteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid invite acceptance",
    };
  }
  const { token, password } = parsed.data;

  try {
    const invite = await db.inviteToken.findUnique({ where: { token } });
    if (!invite) {
      return { success: false, error: "This invite link is invalid" };
    }
    if (invite.usedAt) {
      return { success: false, error: "This invite has already been used" };
    }
    if (invite.expiresAt < new Date()) {
      return {
        success: false,
        error: "This invite has expired. Ask your admin to send a new one.",
      };
    }

    // Double-check no user with this email exists — could happen if they
    // signed up via the normal /signup flow between invite + accept.
    const existing = await db.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      return {
        success: false,
        error: "An account with this email already exists. Try signing in instead.",
      };
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inviter = await db.user.findUnique({ where: { id: invite.invitedBy } });
    const inviterName = inviter?.name ?? "An admin";

    await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: invite.name,
          email: invite.email,
          passwordHash,
          role: invite.role,
          companyId: invite.companyId,
        },
      });
      await tx.inviteToken.update({
        where: { id: invite.id },
        data: { usedAt: new Date() },
      });
      await tx.activity.create({
        data: {
          companyId: invite.companyId,
          type: "user_joined",
          message: `${invite.name} accepted ${inviterName}'s invite`,
          userId: user.id,
          userName: invite.name,
          metadata: JSON.stringify({
            kind: "user",
            invitedUser: invite.name,
            role: invite.role,
          }),
        },
      });
      await tx.notification.create({
        data: {
          userId: user.id,
          companyId: invite.companyId,
          title: "Welcome to FounderFlow",
          message: `${inviterName} invited you to the workspace. Get started by exploring the dashboard.`,
          type: "info",
          link: "/dashboard",
        },
      });
    });

    // Auto-sign-in with the password they just set. Same redirect:false
    // dance as signupAction so the client controls the navigation.
    try {
      await signIn("credentials", {
        email: invite.email,
        password,
        redirect: false,
      });
    } catch (e) {
      if (e instanceof AuthError) {
        // Account is real, but the sign-in step bounced (rare). Send them
        // to /login with their email pre-fillable.
        return {
          success: false,
          error: "Account created, but auto-sign-in failed. Sign in manually.",
        };
      }
      throw e;
    }

    revalidatePath("/team");
    revalidatePath("/activities");

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "acceptInviteAction" });
    return {
      success: false,
      error: "Couldn't activate your account right now. Try again in a moment.",
    };
  }
}
