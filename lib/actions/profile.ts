"use server";

/**
 * /settings profile + password mutations.
 *
 * Every action here is scoped to the signed-in user — there's no "edit another
 * user's profile" path (admin team management lives in /team via
 * lib/actions/team.ts). The session.user.id is the only ID we trust.
 *
 *   updateProfileAction({ name })
 *     • Updates the display name. NAME ONLY.
 *
 *       This entry used to read "updates display name and login email" and
 *       "rejects duplicate emails … we check up front", and both halves had
 *       stopped being true: `UpdateProfileSchema` accepts nothing but `name`
 *       (lib/schemas/profile.ts:12), and there is no email read or write left
 *       anywhere in this file. A login email now moves only through
 *       lib/actions/email-change.ts, which proves control of the destination
 *       inbox first (audit S3) — so a duplicate-email check here would be a
 *       check on a path that no longer exists.
 *
 *   changePasswordAction({ currentPassword, newPassword, confirmPassword })
 *     • Re-verifies the current password with bcrypt before writing.
 *     • Hashes the new one at work factor 12 (matches signup).
 *     • Rate-limited as a current-password ORACLE, not as a write: 5 per user
 *       per 10 minutes, on the same bucket as delete-account (auth-014). See
 *       the comment on the gate itself.
 *     • Bumps `sessionVersion`, which signs out every session for this
 *       user — including the current device. The modal redirects to
 *       /login afterwards.
 *     • Mails the address on file (acct-005) AND writes a `password_changed`
 *       Activity row (sec-020) — the alert and the durable record.
 *
 *   getMyHandleAction() / updateHandleAction({ handle })
 *     • Read + write of User.handle, the @mention address (FaultsAudit T16).
 *     • Unique PER COMPANY, never globally; the race is answered by the
 *       index, not by the pre-check.
 */

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ChangePasswordSchema,
  UpdateHandleSchema,
  UpdateProfileSchema,
} from "@/lib/schemas/profile";
import { gateAuthAction, limiters, rateLimiter } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import { sendSecurityNotice } from "@/lib/email/templates/security-notice";
import { tryWriteSecurityActivity } from "@/lib/activity/security-log";

import type { ActionResult } from "@/lib/actions/types";

/**
 * acct-006 note: this action deliberately returns no payload.
 *
 * The staleness it used to cause is fixed at the source — `lib/auth.ts`'s jwt
 * callback now re-reads `name`/`email` from the live row in the lookup it
 * already performs — so the authority for the new name is the session, not this
 * return value. The caller's job is simply to make the session refetch
 * (`useSession().update()`), which re-runs that callback. Handing the name back
 * as well would create a second, competing source of truth for the value that
 * had two of them in the first place.
 */
export async function updateProfileAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // Write tier, 60/min/user, and that IS the right tier here — unlike its
  // sibling below, this action asks for no credential and so verifies nothing
  // an attacker could be probing for. Saving a display name is an ordinary
  // write and belongs in the ordinary write budget.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = UpdateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid profile" };
  }
  const { name } = parsed.data;

  try {
    // Name only — email changes route through the verified change flow
    // (lib/actions/email-change.ts) so they can't skip inbox ownership.
    await db.user.update({
      where: { id: session.user.id },
      data: { name },
    });

    revalidatePath("/settings");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateProfileAction" });
    return { success: false, error: "Couldn't update your profile right now." };
  }
}

export async function changePasswordAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // auth-014. This gate used to be `limiters.write` — 60 per minute — under a
  // comment that said "Auth-tier limiter — same envelope as login/signup". It
  // was not: login's envelope is 5/min, and the real rate here was 3,600
  // current-password guesses an hour, with a fresh budget per victim because
  // the key is the user id.
  //
  // It matters because `ChangePasswordSchema` requires `currentPassword` and
  // this action says whether it was right, so the endpoint is an ORACLE for the
  // one secret a borrowed session does not already have — the thing needed to
  // then move the login email, close the workspace, or reuse the credential
  // elsewhere.
  //
  // `passwordConfirm` is 5 per user per 10 minutes and shares its bucket with
  // `destructive` (delete-account / delete-workspace), so five guesses is five
  // in total rather than five per endpoint. It has no address dimension on
  // purpose: a password change is routine, and an office-NAT bucket would let
  // colleagues' typos refuse each other. Both decisions are argued in full at
  // the `passwordConfirm` case in lib/rate-limit.ts — and the locked-out owner's
  // remedy stays open, because /forgot-password runs on a different budget.
  const gate = gateAuthAction({ kind: "passwordConfirm", userId: session.user.id });
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ChangePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid password" };
  }
  const { currentPassword, newPassword } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "User no longer exists" };

    const ok = await bcrypt.compare(currentPassword, me.passwordHash);
    if (!ok) return { success: false, error: "Current password is incorrect" };

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.user.update({
      where: { id: me.id },
      // Bump sessionVersion in the same UPDATE as the hash (mirrors
      // resetPasswordAction) so every other live session for this user is
      // force-signed-out on its next request. A changed password must not
      // leave a session the user thought they'd just locked out.
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });

    // acct-005. The address on file learns its credential moved, BEFORE the
    // cookie is cleared — this is the owner's only out-of-band signal that
    // somebody with a borrowed session has just locked them out, and the one
    // place it can be sent is the moment we still know which address was on the
    // row. `sendSecurityNotice` never throws and never spends notification
    // budget; see lib/email/templates/security-notice.ts for both reasons. The
    // notice carries the /forgot-password remedy and never the new password.
    await sendSecurityNotice({
      kind: "password-changed",
      to: me.email,
      recipientName: me.name,
      accountEmail: me.email,
    });

    // sec-020. The durable half of the same signal. The notice above is an ALERT
    // — one inbox, once, and deleting the message deletes the evidence; this is
    // the row that outlives it, on the surface the workspace's admins already
    // read. It sits beside the notice rather than after `signOut()` only to keep
    // the two halves together: every field it needs comes from `me`, which is
    // already in hand, so it does not depend on the session still existing.
    //
    // Never allowed to fail the change: the UPDATE has landed, and reporting
    // failure would leave the user trying the old password for ever. Same
    // posture as `sendSecurityNotice`; see lib/activity/security-log.ts.
    await tryWriteSecurityActivity({
      companyId: me.companyId,
      userId: me.id,
      userName: me.name,
      type: "password_changed",
      message: `${me.name} changed their password`,
    });

    // The bump also invalidates THIS session — its JWT still carries the old
    // version, so lib/auth.ts's jwt callback returns null from here on. Clear
    // the cookie now, inside the request that's still authenticated, rather
    // than leaving the client to discover it on a later request that
    // middleware would bounce to /login mid-navigation. The caller shows a
    // "sign in again" toast and redirects.
    try {
      await signOut({ redirect: false });
    } catch (e) {
      // Cookie write failed — the password change already landed and the
      // version bump means the stale JWT is rejected on its next use, so the
      // user is still effectively signed out. Report success, record the blip.
      captureServerError(e, { action: "changePasswordAction:signOut" });
    }

    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "changePasswordAction" });
    return { success: false, error: "Couldn't change your password right now." };
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Handle (@mention address)                                               */
/* ─────────────────────────────────────────────────────────────────────── */

/**
 * The handle-change budget: three per hour, per user.
 *
 * WHY A BUDGET AT ALL. A handle is an ADDRESS other people type. Churning it
 * rewrites how a person is reached: every `@ali` already sitting in a comment
 * or a chat message is matched at render time against the CURRENT handle
 * (tokenizeForRender in lib/comments/mentions.ts), so a handle that moves
 * forty times an hour leaves a trail of mentions that resolve to nobody, and
 * then to somebody else. Three is the number that costs an honest user
 * nothing — claim it, see the preview, fix the typo — and makes churn tedious.
 *
 * WHAT IT HONESTLY DOES NOT FIX. The impersonation half of the threat is a
 * DIFFERENT actor: Alice renames `@ali` to `@ali-k`, and Mallory — who has
 * spent no budget at all — claims the freed `@ali` and starts receiving
 * mentions meant for Alice. No per-user limit on the person renaming can stop
 * that. The fix is a reservation: park a vacated handle against its former
 * owner for a grace window so nobody else can take it. That needs a durable
 * record (a `handleChangedAt` column, or a small reservations table), i.e. a
 * migration this change is not allowed to write — it is in the follow-ups, and
 * this limiter is a speed bump in the meantime, not a guarantee.
 *
 * SEPARATE FROM `limiters.write`, for the reason the `read` bucket is separate
 * from it (see lib/rate-limit.ts): a rejection that lands on a different
 * action from the one that caused it is the worst class of bug this file can
 * cause. Someone renaming themselves must not lose the ability to save a task,
 * and someone importing sixty transactions must not be told their handle is
 * rate-limited.
 *
 * DECLARED HERE, NOT IN THE SHARED `limiters` TABLE, only because
 * lib/rate-limit.ts belongs to another agent in this wave. `rateLimiter()`
 * anchors its buckets on globalThis by name, so this is behaviourally
 * identical to sitting in that table — move it there when the file is free.
 * In-memory either way: it resets on process restart and is not shared across
 * regions, which is fine for a speed bump and is not a quota.
 */
const handleLimiter = rateLimiter("handle", { limit: 3, windowMs: 60 * 60_000 });

/**
 * The caller's own handle, for the settings field to show before it is edited.
 *
 * WHY A SERVER ACTION AND NOT A QUERY PROP. /settings gets its user through
 * `getCurrentUser()` and the client `User` type in lib/types.ts, and neither
 * carries `handle` yet; both files belong to another agent this wave. Reading
 * it here is what lets the field show a real value instead of an empty box — a
 * handle nobody can see is a column, not a feature. Fold this into
 * `getCurrentUser` and delete it once `User` carries the field: one read per
 * page beats two.
 *
 * Self-scoped, like everything else in this file — the session's own id is the
 * only one it will read, so there is no way to ask it about a teammate.
 */
export async function getMyHandleAction(): Promise<ActionResult<{ handle: string | null }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // Read budget, not the write one — this fires on every /settings mount.
  const gate = limiters.read.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  try {
    const me = await db.user.findFirst({
      where: { id: session.user.id, deletedAt: null },
      select: { handle: true },
    });
    if (!me) return { success: false, error: "User no longer exists" };
    return { success: true, data: { handle: me.handle } };
  } catch (e) {
    captureServerError(e, { action: "getMyHandleAction" });
    return { success: false, error: "Couldn't load your handle right now." };
  }
}

/**
 * Claim or change the caller's @mention handle.
 *
 * Self-scoped: there is no "rename a teammate" path, not even for an admin, so
 * the signed-in id is the only one written and there is no authz predicate to
 * consult beyond being signed in (same shape as
 * updateNotificationPreferenceAction). The one access decision that IS real
 * here is the SCOPE of the uniqueness check below.
 */
export async function updateHandleAction(
  input: unknown
): Promise<ActionResult<{ handle: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const gate = handleLimiter.consume(session.user.id);
  if (!gate.allowed) {
    return {
      success: false,
      error: gate.error ?? "You have changed your handle a few times just now. Try again shortly.",
    };
  }

  const parsed = UpdateHandleSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid handle" };
  }
  const { handle } = parsed.data;

  try {
    const me = await db.user.findFirst({
      where: { id: session.user.id, deletedAt: null },
      select: { id: true, companyId: true, handle: true },
    });
    if (!me) return { success: false, error: "User no longer exists" };

    // No-op: saving the value already stored is success, not a collision with
    // yourself. Cheap, and it keeps a double-submit from reporting "that
    // handle is taken" about the caller's own row.
    if (me.handle === handle) return { success: true, data: { handle } };

    // Uniqueness, scoped to THIS WORKSPACE and nothing wider.
    //
    // Handles are per-company by design (`@@unique([companyId, handle])`) for
    // the same reason two companies may each hold a #general: a mention only
    // ever resolves inside a workspace. A global check would be wrong twice
    // over — it would refuse a handle that is free here, and it would leak the
    // existence of a handle in a company the caller cannot see, turning this
    // field into an oracle for enumerating another tenant's roster.
    //
    // NOT filtered by `deletedAt: null`, and that exception to the house rule
    // is load-bearing. The unique INDEX counts tombstoned rows — the backfill
    // gave them handles deliberately so that restoring a soft-deleted teammate
    // (CLAUDE.md, Tier 3) cannot fail on a slot somebody took while they were
    // gone. Filtering them out here would report "available" and then eat a
    // P2002 one line later. This reads index occupancy, not people, which is
    // also why the error below names nobody.
    const taken = await db.user.findFirst({
      where: { companyId: me.companyId, handle },
      select: { id: true },
    });
    if (taken) return { success: false, error: "That handle is taken." };

    // One statement, so no `$transaction`: a single UPDATE is already atomic,
    // and an interactive transaction would buy a round trip and a second
    // connection without buying an invariant. The check above is advisory —
    // between it and this write, someone else can commit the same handle. That
    // race is arbitrated by the unique index (caught below), not by isolation
    // level; READ COMMITTED would not have seen the other transaction either.
    await db.user.update({ where: { id: me.id }, data: { handle } });

    // /team is the roster; /settings is this page's own copy of the value.
    // Deliberately not revalidating every page that loads getCompanyUsers —
    // those render names, and a stale mention-autocomplete entry costs a
    // keystroke, while blanket revalidation costs every one of them a rebuild.
    revalidatePath("/settings");
    revalidatePath("/team");
    return { success: true, data: { handle } };
  } catch (e) {
    // P2002 on User_companyId_handle_key: two people claiming one handle in
    // the same instant is an ordinary race, not an incident. The index doing
    // its job is the correct outcome; the loser gets the same sentence the
    // pre-check gives, and nothing goes to Sentry.
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002") {
      return { success: false, error: "That handle is taken." };
    }
    captureServerError(e, { action: "updateHandleAction" });
    return { success: false, error: "Couldn't save your handle right now." };
  }
}
