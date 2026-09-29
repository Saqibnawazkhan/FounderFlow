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
import { DEFAULT_APPEARANCE, writeAppearanceCookies } from "@/lib/appearance/cookies";
import { AcceptInviteSchema, InviteUserSchema, UpdateRoleSchema } from "@/lib/schemas/user";
import { gateAuthAction, limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { appOrigin } from "@/lib/env";
import { captureServerError } from "@/lib/sentry-server";
import { sendEmail } from "@/lib/email/send";
import { renderInviteEmail } from "@/lib/email/templates/invite";
import { memberLimitForCompany, memberLimitForPlan, PLAN_LABELS } from "@/lib/billing/plan";
import { joinDefaultChannels } from "@/lib/chat/bootstrap";
import { deriveHandle, isHandleConflict, uniqueHandle } from "@/lib/user/handle";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

function roleLabel(role: string): string {
  return role === "cofounder" ? "Co-Founder" : "Team Member";
}

/**
 * Render + send the invite email for a token. Shared by inviteUserAction
 * (fresh invite) and resendInviteAction (re-send an existing pending one).
 * Never throws on a delivery failure — returns `emailSent: false` so the
 * caller can surface the copyable URL as a fallback.
 */
async function deliverInviteEmail(params: {
  email: string;
  inviteeName: string;
  inviterName: string;
  companyName: string;
  role: string;
  token: string;
}): Promise<{ emailSent: boolean; inviteUrl: string }> {
  // `appOrigin` (lib/env.ts) is the one decision for the public origin —
  // prodready-004. This site already stripped ONE trailing slash, so the
  // ordinary pasted-from-an-address-bar case was already right here; what
  // changes is the two it got wrong. A value with trailing WHITESPACE
  // (" https://app.founderflow.com/ ", a paste into Vercel's env UI) did not
  // match /\/$/ at all, so the href in the invite e-mail began with a space and
  // carried " /" in the middle; and a doubled trailing slash lost only one of
  // the two. `appOrigin` trims first, then strips every trailing slash.
  const baseUrl = appOrigin(process.env.NEXT_PUBLIC_APP_URL);
  const inviteUrl = `${baseUrl}/invite/${params.token}`;
  const { html, text } = renderInviteEmail({
    inviteeName: params.inviteeName,
    inviterName: params.inviterName,
    companyName: params.companyName,
    roleLabel: roleLabel(params.role),
    acceptUrl: inviteUrl,
  });
  const sendResult = await sendEmail({
    to: params.email,
    subject: `${params.inviterName} invited you to ${params.companyName} on FounderFlow`,
    html,
    text,
  });
  return { emailSent: sendResult.delivered, inviteUrl };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reads                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

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
 * useful in dev where SMTP isn't configured (the server logs it too).
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
    // WHO HOLDS THE ADDRESS, and honestly which kind of holder (acct-016). This
    // answered "An account with this email already exists" for a DEACTIVATED
    // teammate too — a sentence about a live account, and a dead end: the admin
    // could not invite the address, and nothing told them why or what to do.
    // Deactivating Bob and re-inviting him is an ordinary thing to try.
    //
    // DELIBERATELY NOT `where: { email, deletedAt: null }`, the one-line version
    // of this fix: `User.email` carries a plain global unique index
    // (prisma/migrations/20260523212052_init/migration.sql:92) and a soft-deleted
    // row keeps its address, so the lookup would miss the row and the invite
    // would fail later for a reason nobody could read. The reservation is also
    // correct on its own terms — `reactivateUserAction` below could not restore
    // anyone if the address were free to re-take. `findUnique` rather than
    // email-change.ts's `findFirst` only because `email` is unique; the
    // load-bearing part is the absent filter and the tombstone in the `select`.
    const existing = await db.user.findUnique({
      where: { email },
      select: { id: true, deletedAt: true, companyId: true },
    });
    if (existing?.deletedAt) {
      // TWO MESSAGES, because the admin can act on exactly one of these cases.
      // In their own workspace the Team page already has a Deactivated section
      // with a Reactivate button wired to `reactivateUserAction`, so the message
      // names a control that exists. In someone else's workspace that action
      // refuses the target (`target.companyId !== companyId`), so pointing there
      // would be a second false instruction.
      //
      // No date in either, for the reason lib/actions/auth.ts:221 gives: the
      // tombstone ages out only when the purge cron runs for real, and
      // `PURGE_ENABLED` is off by documented decision (CLAUDE.md).
      if (existing.companyId === companyId) {
        return {
          success: false,
          error:
            "That teammate is deactivated, not gone — their address stays reserved while " +
            "the account exists. Reactivate them in the Deactivated list on the Team page " +
            "instead of re-inviting them.",
        };
      }
      return {
        success: false,
        error:
          "That email belongs to a FounderFlow account that was deleted. " +
          "Contact support to restore it, or invite a different address.",
      };
    }
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

    // Free-plan member cap (pricing: "up to 2 co-founders"). Count active
    // members + still-pending invites so you can't queue past the limit. The
    // current email's pending invite was just deleted above, so a resend never
    // counts itself. Team plan is unlimited.
    const limit = memberLimitForPlan(company.plan);
    if (Number.isFinite(limit)) {
      const [activeMembers, pendingInvites] = await Promise.all([
        db.user.count({ where: { companyId, deletedAt: null } }),
        db.inviteToken.count({ where: { companyId, usedAt: null } }),
      ]);
      if (activeMembers + pendingInvites >= limit) {
        return {
          success: false,
          error: `Your ${PLAN_LABELS.free} plan is limited to ${limit} members. Upgrade to ${PLAN_LABELS.team} in Settings for unlimited co-founders.`,
        };
      }
    }

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
          message: `${actor.name} invited ${name} (${roleLabel(role)})`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({ kind: "user", invitedUser: name, role }),
        },
      });
    });

    // Render + send the email. A delivery failure is non-fatal — the invite
    // row exists, so the admin can copy the URL from the response and
    // share it manually if the SMTP send is rejected.
    const { emailSent, inviteUrl } = await deliverInviteEmail({
      email,
      inviteeName: name,
      inviterName: actor.name,
      companyName: company.name,
      role,
      token,
    });

    revalidatePath("/team");
    revalidatePath("/activities");

    return {
      success: true,
      data: { email, emailSent, inviteUrl },
    };
  } catch (e) {
    captureServerError(e, { action: "inviteUserAction" });
    return {
      success: false,
      error: "Couldn't invite right now. Try again in a moment.",
    };
  }
}

/**
 * Re-send a pending invite (X7). Rotates the token + pushes the 7-day
 * expiry out again, then re-delivers the email. Rotating the token means an
 * older forwarded link stops working — the freshest link is the only valid
 * one, which is the safer default.
 */
export async function resendInviteAction(
  inviteId: string
): Promise<ActionResult<{ email: string; emailSent: boolean; inviteUrl: string }>> {
  const gate = await requireAdmin();
  if (!gate.ok) return { success: false, error: gate.error };

  const rl = limiters.write.consume(gate.userId);
  if (!rl.allowed) return { success: false, error: rl.error ?? "Too many requests" };

  try {
    const invite = await db.inviteToken.findUnique({ where: { id: inviteId } });
    if (!invite || invite.companyId !== gate.companyId) {
      return { success: false, error: "Invite not found" };
    }
    if (invite.usedAt) {
      return { success: false, error: "That invite has already been accepted" };
    }

    const actor = await db.user.findUnique({ where: { id: gate.userId } });
    if (!actor) return { success: false, error: "User no longer exists" };
    const company = await db.company.findUnique({ where: { id: gate.companyId } });
    if (!company) return { success: false, error: "Company no longer exists" };

    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.inviteToken.update({
      where: { id: invite.id },
      data: { token, expiresAt },
    });

    const { emailSent, inviteUrl } = await deliverInviteEmail({
      email: invite.email,
      inviteeName: invite.name,
      inviterName: actor.name,
      companyName: company.name,
      role: invite.role,
      token,
    });

    revalidatePath("/team");

    return { success: true, data: { email: invite.email, emailSent, inviteUrl } };
  } catch (e) {
    captureServerError(e, { action: "resendInviteAction" });
    return { success: false, error: "Couldn't resend right now. Try again in a moment." };
  }
}

/**
 * Revoke a pending invite (X7). Hard-deletes the token so its link stops
 * working immediately. Safe to hard-delete — no user account exists yet.
 */
export async function revokeInviteAction(inviteId: string): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return { success: false, error: gate.error };

  try {
    const invite = await db.inviteToken.findUnique({ where: { id: inviteId } });
    if (!invite || invite.companyId !== gate.companyId) {
      return { success: false, error: "Invite not found" };
    }
    if (invite.usedAt) {
      return { success: false, error: "That invite has already been accepted" };
    }
    await db.inviteToken.delete({ where: { id: invite.id } });

    revalidatePath("/team");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "revokeInviteAction" });
    return { success: false, error: "Couldn't revoke right now." };
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
      // sessionVersion BUMPED IN THE SAME UPDATE AS THE ROLE, for the reason
      // lib/actions/password-reset.ts:153 gives for bumping inline with the new
      // hash: the two cannot be allowed to land apart.
      //
      // Without it, changing a role changed nothing the target could feel.
      // Middleware decides finance access from `auth.user?.role`, and the Edge
      // jwt callback (auth.config.ts) does no database read — that claim is
      // whatever was baked into the signed cookie at sign-in. The Node callback
      // refreshes `token.role` per request, but an RSC cannot write the cookie
      // back, so the cookie only moves when something re-mints it. A demoted
      // co-founder therefore kept loading /expenses and /dashboard — the full
      // company ledger — for the token's lifetime (30 days by default), and
      // could hold the stale claim indefinitely by blocking the one
      // /api/auth/session request that would have refreshed it. A promoted
      // teammate had the mirror-image problem: still locked out, with no
      // in-product way to fix it. Findings sec-002 / auth-003.
      //
      // The bump makes the version in their token stale, so lib/auth.ts's jwt
      // callback returns null on their very next request and they re-auth into
      // a token carrying the new role. A privilege change forcing a clean
      // re-auth is the correct posture anyway.
      await tx.user.update({
        where: { id: userId },
        data: { role, sessionVersion: { increment: 1 } },
      });
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
      await notifyUsers({
        event: "team_change",
        userIds: [target.id],
        exclude: actorId, // don't tell someone they changed their own role
        companyId,
        title: "Your role changed",
        message: `${actor.name} updated your role to ${role}`,
        category: "team",
        link: "/team",
        tx,
      });
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
    if (!target || target.deletedAt) return { success: false, error: "User not found" };
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

    // Tier 3 soft-delete (X8): stamp deletedAt instead of hard-deleting. The
    // user loses access immediately (auth + queries filter deletedAt: null)
    // but their transactions, tasks, and activities stay in the records —
    // exactly what the confirm dialog promises — and an admin can restore
    // them with reactivateUserAction until the 90-day purge cron fires.
    const deletedAt = new Date();
    await db.$transaction(async (tx) => {
      // The tombstone AND a version bump. lib/auth.ts's jwt callback already
      // kills a session whose user row carries a deletedAt, so this is the
      // second, independent reason that token stops working — cheap insurance
      // against a future refactor that relaxes one of the two checks.
      //
      // reactivateUserAction deliberately does NOT bump. The cookies minted
      // before this deactivation are already behind by one version, so leaving
      // the counter where it is keeps them dead while a restored account signs
      // in cleanly; bumping again on the way back in would only revoke tokens
      // that no longer exist.
      await tx.user.update({
        where: { id: userId },
        data: { deletedAt, sessionVersion: { increment: 1 } },
      });
      // Re-point company ownership away from the deactivated owner so a
      // tombstoned row never remains the workspace owner.
      const company = await tx.company.findUnique({ where: { id: companyId } });
      if (company?.ownerId === userId) {
        await tx.company.update({
          where: { id: companyId },
          data: { ownerId: actorId },
        });
      }
      // Invalidate any still-pending invites addressed to them — a stale
      // link shouldn't re-create the account they were just removed from.
      await tx.inviteToken.deleteMany({
        where: { email: target.email, companyId, usedAt: null },
      });
      // De-register their devices (data-integrity-004 / acct-008). The
      // /team confirm dialog and the purge cron's header both describe
      // deactivation as "loses access, keeps their history" — a phone that
      // keeps buzzing with "New expense — 2,500,000" is not that. Three things
      // used to compose into the leak: nothing pruned PushSubscription (it has
      // no tombstone of its own), the purge cron deliberately has no
      // individual-user stage so the rows lived forever, and recipient lists
      // upstream forgot the filter. `sendPushToUsers` now filters
      // `user: { deletedAt: null }` at the delivery boundary; this is the other
      // half — the registration is REMOVED, not merely skipped, so it cannot
      // come back through a caller that forgets.
      //
      // Reactivation does not restore them, and should not: the browser mints a
      // fresh subscription on the next visit, and a resurrected endpoint is one
      // nobody consented to twice.
      await tx.pushSubscription.deleteMany({ where: { userId } });
      await tx.activity.create({
        data: {
          companyId,
          type: "user_removed",
          message: `${actor.name} deactivated ${target.name}`,
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
    return { success: false, error: "Couldn't deactivate right now." };
  }
}

/**
 * Restore a soft-deleted teammate (X8). Clears the deletedAt sentinel so
 * they can sign in again and reappear on the roster with their prior role.
 * Admin-only. No-op-safe if they're already active.
 */
export async function reactivateUserAction(userId: string): Promise<ActionResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return { success: false, error: gate.error };
  const { userId: actorId, companyId } = gate;

  try {
    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) return { success: false, error: "User not found" };
    if (target.companyId !== companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (!target.deletedAt) {
      // Already active — return success so the UI can refresh cleanly.
      return { success: true, data: undefined };
    }

    const actor = await db.user.findUnique({ where: { id: actorId } });
    if (!actor) return { success: false, error: "User no longer exists" };

    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { deletedAt: null } });
      await tx.activity.create({
        data: {
          companyId,
          type: "user_joined",
          message: `${actor.name} reactivated ${target.name}`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({
            kind: "user",
            invitedUser: target.name,
            role: target.role,
          }),
        },
      });
      await notifyUsers({
        event: "team_change",
        userIds: [target.id],
        companyId,
        title: "Your access was restored",
        message: `${actor.name} reactivated your account. Welcome back.`,
        category: "team",
        link: "/dashboard",
        tx,
      });
    });

    revalidatePath("/team");
    revalidatePath("/activities");
    revalidatePath("/notifications");

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "reactivateUserAction" });
    return { success: false, error: "Couldn't reactivate right now." };
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Accept invite — runs from /invite/[token] when the recipient sets pw       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * How many times the acceptance is attempted when the handle unique index
 * rejects it. Three, not thirty: the only way to lose twice is for two people
 * to accept invites into the same workspace in the same instant with addresses
 * that derive the same base, and past that the honest answer is a retryable
 * error rather than a loop holding a transaction open. The index, not this
 * number, is the guarantee — see `uniqueHandle` in lib/user/handle.ts.
 */
const HANDLE_WRITE_ATTEMPTS = 3;

/**
 * Thrown inside the acceptance transaction when the workspace has no seat left
 * (bill-013), so the write rolls back and the invitee gets the real reason
 * instead of the catch-all "couldn't activate your account right now".
 *
 * A class rather than a flag because the check has to run INSIDE the transaction
 * — the roster it counts and the row it would create must share one snapshot, or
 * two simultaneous acceptances both read "one seat left" and both take it.
 */
class SeatLimitReached extends Error {}

/**
 * The /invite/[token] flow: the recipient submits the form, this action
 * re-validates the token (existence + not expired + not used), creates the
 * real User with their chosen password and their @mention handle, marks the
 * token used, fan-outs the welcome notification + activity, and auto-signs
 * them in.
 *
 * Race condition: between two browser tabs both submitting at the same
 * moment, only the first wins because we wrap the user-create + token-mark
 * in a single `$transaction` and bail if `findUnique({ where: { email } })`
 * already returns a row from the prior tab.
 *
 * The OTHER race is between two different invitees whose emails derive the
 * same handle. That one is not a "bail" — both acceptances are legitimate and
 * both must succeed — so it is a bounded retry around the transaction instead;
 * the loop below argues the shape.
 */
export async function acceptInviteAction(input: unknown): Promise<ActionResult> {
  // auth-008. A COURTESY VALVE, AND NOT AN ANTI-GUESSING ONE. The token is two
  // UUIDv4s with the dashes stripped (~244 bits, see inviteUserAction above), so
  // nothing about the attempt RATE makes guessing it feasible and this is not a
  // brute-force fix. What it closes is that this was the only pre-auth endpoint
  // in the codebase that metered nothing at all: /invite/* is public in
  // auth.config.ts and middleware wires only NextAuth, so an anonymous caller
  // could drive one indexed `inviteToken.findUnique` per POST, indefinitely,
  // with no session. The other three redeem endpoints (verify-email,
  // confirm-email-change, reset-password) have used this exact class since
  // auth-007; 30 per address per minute costs a real invitee — who submits once
  // — nothing, and a refusal here would land on somebody holding a good link.
  //
  // THIS IS ONE OF THE SURFACE'S TWO HALVES, AND NOT THE ONE AN ATTACKER WOULD
  // PICK. The paragraph above framed the POST as the exposure; the GET of
  // /invite/[token] runs the same unique read with no server-action encoding at
  // all, and for a while it was metered by nothing while this line was metered.
  // It is now gated in app/invite/[token]/page.tsx on its own bucket
  // (`invitePageIp`, 15/min/address) — deliberately NOT this one, so that a
  // flood of page renders can never refuse the submit of somebody who already
  // has the form open. Both halves, or neither is worth much.
  //
  // BEFORE THE PARSE, deliberately, matching password-reset.ts:171: the class
  // carries no identity (there is no verified account yet), so there is nothing
  // in the body it needs, and putting it first means a malformed body cannot
  // reach the database either.
  //
  // FAILS OPEN WHERE NO ADDRESS IS TRUSTWORTHY — lib/rate-limit.ts returns
  // "allowed, uncounted" when `isTrustedIpKey` rejects the key, because pooling
  // every visitor into one bucket would let one attacker refuse everybody's
  // invite. Off Vercel and without TRUSTED_PROXY_HEADER set, this gate is
  // therefore a no-op by design, not by accident.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "tokenRedeem", ip });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  const parsed = AcceptInviteSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid invite acceptance",
    };
  }
  const { token, password } = parsed.data;

  try {
    // The workspace's tombstone is read THROUGH THE RELATION, in the same round
    // trip as the token — not as a follow-up query somebody can forget to add
    // to the next code path that claims an invite.
    const invite = await db.inviteToken.findUnique({
      where: { token },
      include: {
        company: {
          select: {
            deletedAt: true,
            // bill-013: the three columns `memberLimitForCompany` needs. Selected
            // here, in the same round trip, for the same reason `deletedAt` is —
            // the seat cap is a property of the workspace at ACCEPTANCE time, not
            // at the time the invite was written.
            plan: true,
            subscriptionStatus: true,
            currentPeriodEnd: true,
          },
        },
      },
    });
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
    // AN INVITE OUTLIVES THE WORKSPACE IT WAS SENT FOR. softDeleteWorkspace
    // (lib/actions/account.ts) tombstones Transaction, Budget, Task, Project,
    // Message, User and Company and never touches InviteToken — although
    // removeUserAction three functions up deletes a removed user's pending
    // invites for exactly this reason. Invites live 7 days, so the window is
    // wide. Accepting one used to mint a LIVE User inside a dead company:
    // getCurrentCompany throws "Company not found" on some pages while others
    // render, so the product looks broken in a way nobody can explain — and
    // every row they then create is live data inside a company the purge cron
    // hard-deletes after the retention window, so their work vanishes with no
    // tombstone of its own. Finding data-integrity-003.
    //
    // Refused here rather than only at the source, because this is the check
    // that cannot be bypassed by a delete path that forgets to clean up: the
    // tokens should ALSO be burnt inside softDeleteWorkspace's transaction.
    if (invite.company.deletedAt) {
      return {
        success: false,
        error: "This workspace is no longer active. Ask whoever invited you for a new invite.",
      };
    }

    // Double-check no user with this email exists — could happen if they
    // signed up via the normal /signup flow between invite + accept.
    //
    // AND SAY WHICH KIND OF HOLDER IT IS (acct-016). This branch answered "an
    // account with this email already exists — try signing in instead" for a
    // DEACTIVATED account as well, and that is the worst version of the finding
    // on this surface: signing in is the one thing that cannot work, because
    // `authorize()` filters `deletedAt: null` (lib/auth.ts:202). An admin
    // deactivates Bob and re-invites the same address; Bob sets a password, is
    // told to sign in, and the sign-in answers "Invalid email or password"
    // (lib/actions/auth.ts:437). Three closed doors, not one of them naming the
    // reason.
    //
    // Unfiltered by `deletedAt` on purpose — see the long note in
    // `inviteUserAction` above; the address is reserved while the tombstone
    // exists, and a filtered lookup would only move the refusal to the
    // `user.create` below as a P2002 the catch-all reports as a server error.
    const existing = await db.user.findUnique({
      where: { email: invite.email },
      select: { id: true, deletedAt: true },
    });
    if (existing?.deletedAt) {
      // No route for the invitee to fix this themselves, so the message sends
      // them to the person who CAN: an admin of that workspace has the
      // Reactivate control, and re-inviting the address never will work.
      return {
        success: false,
        error:
          "This email belongs to a FounderFlow account that was deactivated. Ask whoever " +
          "invited you to restore it — a fresh invite to the same address cannot replace it.",
      };
    }
    if (existing) {
      return {
        success: false,
        error: "An account with this email already exists. Try signing in instead.",
      };
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const inviter = await db.user.findUnique({ where: { id: invite.invitedBy } });
    const inviterName = inviter?.name ?? "An admin";

    // The invitee's @mention address, derived from the same email local-part
    // the backfill used. Written here because nothing else ever would: the
    // add_user_handle migration healed the rows that existed when it ran and a
    // row that commits without a handle stays NULL forever — and NULLS
    // DISTINCT means the unique index never complains, so the new teammate is
    // simply unmentionable in their own workspace with nothing saying why.
    // That is FaultsAudit T16 reintroduced for every invitee from now on.
    const handleBase = deriveHandle(invite.email);

    // Candidates this request has already watched the index reject. Fed back
    // into `uniqueHandle` on the next attempt, because the taken-set re-read
    // alone is not enough to make progress: the winner of the race may still
    // be uncommitted when we look, so the same candidate would come back and
    // we would lose the same way three times.
    const lostRaces: string[] = [];

    // WHY THE RETRY WRAPS THE WHOLE TRANSACTION, not just the insert. Under
    // Postgres a failed statement ABORTS its transaction, so catching P2002
    // inside the `$transaction` callback and trying the next candidate there
    // raises 25P02 instead — the aftershock, not the collision.
    // `lib/chat/bootstrap.ts` documents the same trap for its post-race
    // re-read. So the unit of retry is the attempt, and everything the
    // acceptance writes rolls back with it: no half-burnt token, no duplicate
    // activity row, no second #general membership.
    //
    // BOUNDED, and small. Each extra attempt buys a vanishing slice of
    // probability — it takes two people accepting invites into the same
    // workspace in the same instant with email local-parts that clean to the
    // same base — and the honest answer past that is to fail and let them
    // retry, not to sit in a loop holding a transaction open.
    //
    // The bcrypt hash is computed ABOVE the loop on purpose: it is the
    // expensive part of this action and it does not change between attempts.
    for (let attempt = 1; attempt <= HANDLE_WRITE_ATTEMPTS; attempt++) {
      // Reassigned inside the transaction so the catch below knows which
      // candidate lost; the initial value only matters if the transaction dies
      // before it is picked, in which case the error is not a handle conflict
      // and the value goes unread.
      let attempted = handleBase;

      try {
        await db.$transaction(async (tx) => {
          // bill-013. THE SEAT CAP, RE-ASKED AT ACCEPTANCE. `plan` gated exactly
          // one thing in this codebase — `inviteUserAction` above — so a token
          // issued while the workspace was on Team still minted a member after the
          // plan lapsed. That made one paid month buy permanent seats: subscribe,
          // invite twenty people, cancel, and nothing anywhere revoked, suspended
          // or even reported the overage while the billing screen went on claiming
          // "Up to 2 members".
          //
          // `memberLimitForCompany`, not `memberLimitForPlan`: entitlement is
          // (plan, status, paid-through date), so a workspace whose `plan` column
          // still says "team" because a `subscription_expired` delivery was lost
          // is capped here anyway (bill-004).
          //
          // Counted INSIDE the transaction — see SeatLimitReached — and it counts
          // members only. Other pending invites are deliberately not counted: they
          // may never be accepted, and `inviteUserAction` already refuses to queue
          // past the limit at issue time.
          const limit = memberLimitForCompany(invite.company);
          if (Number.isFinite(limit)) {
            const activeMembers = await tx.user.count({
              where: { companyId: invite.companyId, deletedAt: null },
            });
            if (activeMembers >= limit) {
              throw new SeatLimitReached(
                `This workspace is on the ${PLAN_LABELS.free} plan, which is limited to ` +
                  `${limit} members, and it is already full. Ask an admin to upgrade to ` +
                  `${PLAN_LABELS.team} and send the invite again.`
              );
            }
          }

          // INSIDE the transaction, so the roster we de-duplicate against and
          // the row we write share one snapshot.
          //
          // DELIBERATELY NOT FILTERED BY `deletedAt: null`, which is the one
          // place this query departs from the house rule that every scoped
          // read filters it. A tombstoned teammate still occupies their slot
          // in `@@unique([companyId, handle])` — the backfill says so in as
          // many words, and it backfilled soft-deleted rows for this reason.
          // Handing their handle to a live invitee would collide the moment
          // ops ran the soft-delete restore documented in CLAUDE.md, and would
          // quietly re-point every historical @mention of that person at
          // somebody else in the meantime.
          const roster = await tx.user.findMany({
            where: { companyId: invite.companyId, handle: { not: null } },
            select: { handle: true },
          });
          const taken: string[] = [...lostRaces];
          // `for...of` over the array, and `if (row.handle)` rather than a
          // non-null assertion: `handle` is nullable in the client type even
          // though the `not: null` filter means it cannot be null here.
          for (const row of roster) {
            if (row.handle) taken.push(row.handle);
          }
          attempted = uniqueHandle(handleBase, taken);

          const user = await tx.user.create({
            data: {
              name: invite.name,
              email: invite.email,
              handle: attempted,
              passwordHash,
              role: invite.role,
              companyId: invite.companyId,
            },
          });
          await tx.inviteToken.update({
            where: { id: invite.id },
            data: { usedAt: new Date() },
          });
          // Put them in the workspace's default channels (#general, and only
          // #general — lib/chat/bootstrap.ts argues the restraint).
          //
          // This was missing entirely: `createChannelAction` is the ONLY other
          // place in the codebase that writes a ChannelMember, and
          // `markChannelReadAction` refuses to auto-join on open by design, so an
          // invitee had no runtime path into any channel, ever. A public channel
          // is still readable and postable without membership — the visible
          // symptom is subtler than an empty chat: no unread badges (only a
          // membership row carries the `lastReadAt` watermark the rail counts
          // against) and an absence from #general's member list and count.
          //
          // IN the transaction. The question worth asking is whether a chat row
          // should be allowed to void an acceptance that burns a single-use
          // token, and the answer is that it cannot: `usedAt` is set by THIS
          // transaction, so a rollback un-burns it and the invitee's link still
          // works on retry. Beyond that, `joinDefaultChannels` returns 0 rather
          // than throwing for every ordinary "nothing to do" — no channel yet,
          // already a member — which leaves the database being unreachable as the
          // only realistic failure, and `user.create` above has already taken the
          // transaction down in that case.
          await joinDefaultChannels(tx, invite.companyId, user.id);
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
          // The one thing a retried attempt does not fully undo: `notifyUsers`
          // writes its Notification row through `tx` (rolled back with
          // everything else) but fires push OUTSIDE it, deliberately
          // fire-and-forget. Harmless here — the account being created by this
          // very transaction owns no PushSubscription row yet, so there is no
          // device for a duplicate welcome to reach.
          await notifyUsers({
            event: "team_change",
            userIds: [user.id],
            companyId: invite.companyId,
            title: "Welcome to FounderFlow",
            message: `${inviterName} invited you to the workspace. Get started by exploring the dashboard.`,
            category: "team",
            link: "/dashboard",
            tx,
          });
        });

        // Committed. The only other way out of this loop is a throw, so
        // nothing below can run on an acceptance that never landed.
        break;
      } catch (e) {
        // The seat cap is a final, explainable refusal, not a retryable race:
        // returning here (rather than rethrowing into the catch-all below) is what
        // gets the invitee the actual reason instead of "try again in a moment".
        if (e instanceof SeatLimitReached) {
          return { success: false, error: e.message };
        }
        // `isHandleConflict`, never a bare P2002 check: `User.email` is unique
        // too, and the duplicate-email race — someone completing /signup with
        // this address between the pre-check above and this insert — must keep
        // reaching the catch-all's message rather than being retried three
        // times under different handles to the same end.
        if (isHandleConflict(e) && attempt < HANDLE_WRITE_ATTEMPTS) {
          lostRaces.push(attempted);
          continue;
        }
        throw e;
      }
    }

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

    // i18n-002: this is an invited teammate's FIRST session, on a device that
    // has never seen the app - the same case as signupAction. Without this the
    // pre-paint script in app/layout.tsx reads no cookie and their first
    // authenticated paint is en/ltr regardless of the row. The row was just
    // created and does not set theme/locale, so it holds the schema defaults.
    await writeAppearanceCookies(DEFAULT_APPEARANCE);

    revalidatePath("/team");
    revalidatePath("/activities");
    // The rail renders a per-channel member COUNT, and #general just gained
    // one. Cheap, and it keeps the teammates already looking at /chat from
    // showing a stale roster until something else happens to invalidate it.
    revalidatePath("/chat");

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "acceptInviteAction" });
    return {
      success: false,
      error: "Couldn't activate your account right now. Try again in a moment.",
    };
  }
}
