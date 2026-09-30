"use server";

/**
 * Change-email server actions (audit S3; hardened for acct-004 / auth-004 /
 * auth-005 / sec-010, and message-honest for acct-016).
 *
 *   - `requestEmailChangeAction({ newEmail, password })` — session-scoped AND
 *     password-scoped. Re-verifies the current password with bcrypt, validates
 *     the new address isn't taken — naming a tombstoned holder as such rather
 *     than claiming a live account has it (acct-016) — then emails a
 *     confirmation link TO THE NEW ADDRESS and a plain heads-up TO THE CURRENT
 *     ONE. The email is NOT changed
 *     yet — only clicking the link (which proves the user controls the
 *     destination inbox) applies it. Sending the link to the new address is the
 *     whole point: it verifies ownership before the swap, so a typo can't lock
 *     the user out of their account.
 *   - `confirmEmailChangeAction(token)` — token-scoped (works logged-out on any
 *     device, which is why it takes no session). Swaps the email, marks it
 *     verified and bumps `sessionVersion` in ONE update, then tells the old
 *     address the move has landed. Single-use: a spent or superseded link is
 *     refused, it is not quietly re-applied.
 *
 * WHY THE EXTRA CEREMONY. Moving the login address is the last step of an
 * account takeover, not a profile edit: once the row holds attacker@x, the
 * ordinary /forgot-password flow delivers to the attacker's inbox and the real
 * owner's password no longer reaches any address they control. The shipped flow
 * made that step free — a session cookie was the entire credential, nothing was
 * ever sent to the address being replaced, the confirmation link survived the
 * password change that is the documented remedy, and confirming left every
 * other live session alone. Four audit rows, one chain. So:
 *
 *   1. RE-AUTHENTICATE (sec-010, auth-005). The current password is required
 *      and bcrypt-checked before a token is minted, the same bar
 *      `changePasswordAction` (lib/actions/profile.ts) and
 *      `deleteAccountAction` (lib/actions/account.ts) already set. A minute at
 *      an unlocked tab is no longer enough. (2FA is out of scope by product
 *      decision; the password is the re-auth factor this product has.)
 *   2. TELL THE OLD ADDRESS (auth-005, sec-010), twice: when a change is
 *      requested, and again when it lands. This is the owner's only signal, and
 *      the request-time notice is the one that matters — it arrives while the
 *      change can still be stopped, and it says how (change your password;
 *      that both signs every device out and revokes the pending link). The
 *      notice deliberately does NOT contain the confirmation link: the link is
 *      a credential for the NEW inbox, and mailing it to the old one would make
 *      the warning a second way to complete the change.
 *   3. BIND THE TOKEN TO THE ACCOUNT (acct-004, auth-004). See
 *      lib/auth/email-change-token.ts — `bv` is a digest of
 *      {sessionVersion, email, passwordHash} at mint time, recomputed here from
 *      the live row. A password change, a reset, a logout-everywhere, a later
 *      email change, or this link's own first use all move it, so all of them
 *      revoke the pending change for free.
 *   4. REVOKE OTHER SESSIONS (auth-005, sec-010). The confirm writes
 *      `sessionVersion: { increment: 1 }` in the SAME update as the new email,
 *      exactly as lib/actions/password-reset.ts:153 does with the new hash, so
 *      the two cannot land apart. A hijacked session does not survive the
 *      change it was used to make.
 *
 * `confirmEmailChangeAction` still calls no `auth()`, on purpose: the link is
 * followed from a mail client that carries no session cookie, possibly on
 * another device. The token IS the credential, which is why it is now bound and
 * IP-rate-limited (and why it is listed, with that reason, in
 * tests/lib/actions/action-auth-gates.test.ts's PRE_AUTH_ENDPOINTS).
 */

import bcrypt from "bcryptjs";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gateAuthAction } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { appOrigin } from "@/lib/env";
import { captureServerError } from "@/lib/sentry-server";
import { escapeHtml } from "@/lib/email/html";
import { sendEmail } from "@/lib/email/send";
import {
  emailChangeBinding,
  signEmailChangeToken,
  verifyEmailChangeToken,
} from "@/lib/auth/email-change-token";
import { RequestEmailChangeSchema, ConfirmEmailChangeSchema } from "@/lib/schemas/email-change";

import type { ActionResult } from "@/lib/actions/types";

/**
 * The request contract, with the re-auth factor added here rather than in
 * `lib/schemas/email-change.ts`.
 *
 * WHY HERE. A `"use server"` module may only export async functions (see
 * tests/lib/actions/use-server-exports.test.ts), so a schema cannot be shared
 * from this file — and the shared schema's own file is owned by another agent in
 * this wave. Extending it locally means the SERVER is correct today, with no
 * edit to a file this change does not own, and stays correct if `password` is
 * later folded into the shared schema (an `.extend()` simply overrides). The
 * client-side modal needs the field added to its form either way; until it is,
 * a change request is refused with the message below, which is the fail-closed
 * direction.
 */
const RequestEmailChangeWithPasswordSchema = RequestEmailChangeSchema.extend({
  password: z.string().min(1, "Enter your current password to change your login email."),
});

/**
 * The origin the confirm link and both warning links are concatenated onto.
 *
 * `appOrigin` (lib/env.ts) is the one decision — prodready-004. This was one of
 * six copies of `process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"`
 * that did not strip a trailing slash, so an origin pasted out of an address
 * bar emitted `https://app.founderflow.com//verify-email-change?token=…`. That
 * matters twice over here: the confirm link is the only thing that completes
 * the change, and `${linkBase()}/forgot-password` is what the OWNER is told to
 * open when the request was not theirs.
 *
 * The raw value is passed explicitly so the read stays at call time, as it is
 * today, rather than a module-load snapshot of the validated `env`.
 */
function linkBase(): string {
  return appOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

/**
 * The heads-up to the address being replaced. Never carries the confirmation
 * link (see point 2 in the header) — it carries the one control that actually
 * stops the change, which is a password change, because that bumps
 * `sessionVersion` and so invalidates both every session and the pending link.
 */
async function warnOldAddress(args: {
  oldEmail: string;
  newEmail: string;
  name: string;
  applied: boolean;
}): Promise<void> {
  const { oldEmail, newEmail, name, applied } = args;
  const settingsUrl = `${linkBase()}/settings`;

  const subject = applied
    ? "Your FounderFlow login email was changed"
    : "Someone asked to change your FounderFlow login email";

  const headline = applied
    ? `Your FounderFlow login email has been changed from ${oldEmail} to ${newEmail}. Sign in with the new address from now on.`
    : `A request was made to change your FounderFlow login email from ${oldEmail} to ${newEmail}. Nothing has changed yet — it only takes effect if the confirmation link sent to ${newEmail} is opened.`;

  const remedy = applied
    ? `If this wasn't you, reset your password immediately at ${linkBase()}/forgot-password and contact support — whoever made this change now controls password resets for this account.`
    : `If this wasn't you, change your password now at ${settingsUrl}. That signs out every device AND cancels this pending request.`;

  // The text/plain alternative is NOT escaped, deliberately: a human reads it as
  // typed, and `&amp;` in front of a customer's own name is its own defect. Only
  // the HTML body goes through `escapeHtml` (auth-016). `headline` and `remedy`
  // are escaped whole rather than per-value because both are prose assembled
  // above out of two addresses and a URL — escaping at the seam is what gets
  // forgotten when a third sentence is added to them later.
  const text = `Hi ${name},\n\n${headline}\n\n${remedy}\n`;
  const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
        <h2 style="margin:0 0 12px 0;">${applied ? "Your login email was changed" : "Your login email is being changed"}</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>${escapeHtml(headline)}</p>
        <p style="color:#B42318;"><strong>${escapeHtml(remedy)}</strong></p>
      </div>
    `;

  // acct-005 posture: the warning must never be able to fail the thing it is
  // warning about. `sendEmail` reports delivery rather than throwing, but
  // `nodemailer.createTransport` on a malformed credential does not — and on the
  // confirm path the address has ALREADY been rewritten by the time this runs,
  // so a propagated throw would hand the user "Couldn't change your email right
  // now" about a change that landed. Same guarantee as `sendSecurityNotice` in
  // lib/email/templates/security-notice.ts.
  try {
    await sendEmail({ to: oldEmail, subject, html, text });
  } catch (e) {
    captureServerError(e, { action: "warnOldAddress", extra: { applied } });
  }
}

export async function requestEmailChangeAction(
  input: unknown
): Promise<ActionResult<{ dispatched: boolean; newEmail: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // The "we will now send a human an email" class, keyed on the signed-in
  // account as well as the client address (auth-007). Two emails go out per
  // call — the confirmation and the warning to the old address — so the
  // per-account dimension is what protects both inboxes and our send quota,
  // and it means an office behind one NAT cannot spend each other's budget.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "emailDispatch", ip, account: session.user.id });
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = RequestEmailChangeWithPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid email" };
  }
  const { newEmail, password } = parsed.data;

  try {
    const me = await db.user.findFirst({
      // `deletedAt: null`: a tombstoned account must not be able to move its
      // login address, or a soft-deleted workspace could be re-pointed during
      // the retention window and then recovered under someone else's inbox.
      where: { id: session.user.id, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        sessionVersion: true,
      },
    });
    if (!me) return { success: false, error: "Account no longer exists" };

    // Re-auth FIRST, before any existence check below, so this endpoint cannot
    // be used as an "is this address registered?" oracle by someone who only
    // has the session.
    const reauthenticated = await bcrypt.compare(password, me.passwordHash);
    if (!reauthenticated) return { success: false, error: "Current password is incorrect" };

    if (newEmail === me.email) {
      return { success: false, error: "That's already your email." };
    }
    // WHO HOLDS THE TARGET ADDRESS, and honestly which kind of holder it is
    // (acct-016). `findFirst` + an explicit `select` of the tombstone, the
    // same construction lib/actions/auth.ts:216-234 already uses on signup for
    // acct-001 / auth-006.
    //
    // AND DELIBERATELY NOT `where: { email: newEmail, deletedAt: null }`. That
    // is the one-line version of this finding and it is worse than the bug:
    // `User.email` carries a PLAIN global unique index
    // (prisma/migrations/20260523212052_init/migration.sql:92 — no partial
    // predicate) and a soft-deleted row keeps its address, so the lookup would
    // miss the row, the UPDATE on the confirm path would fail with P2002, and
    // the catch-all would answer "Couldn't change your email right now" — the
    // same refusal wearing a server error. The block is also correct on its
    // own terms: a deactivated teammate's address must stay reserved or
    // `reactivateUserAction` (lib/actions/team.ts:521) could not restore them.
    // Genuinely releasing an address for reuse needs a `priorEmail` column on
    // the delete path, and belongs there, not here.
    const collision = await db.user.findFirst({
      where: { email: newEmail },
      select: { id: true, deletedAt: true },
    });
    if (collision?.deletedAt) {
      // No date in this message, for the reason auth.ts:221 gives: the
      // tombstone ages out only when the purge cron runs for real, and
      // `PURGE_ENABLED` is off by default by documented decision (CLAUDE.md),
      // so "wait until <date>" would be a promise this product does not keep.
      //
      // The extra bit this tells the caller over the old message is "deleted,
      // not live", and only after bcrypt has already accepted their current
      // password above — so it is not an oracle anyone can reach without the
      // account's own credentials.
      return {
        success: false,
        error:
          "That email belongs to a FounderFlow account that was deleted. " +
          "Contact support to restore it, or use a different address.",
      };
    }
    if (collision) {
      return { success: false, error: "An account with this email already exists." };
    }

    const token = await signEmailChangeToken(me.id, newEmail, emailChangeBinding(me));
    const url = `${linkBase()}/verify-email-change?token=${encodeURIComponent(token)}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
        <h2 style="margin:0 0 12px 0;">Confirm your new email</h2>
        <p>Hi ${escapeHtml(me.name)},</p>
        <p>A request was made to change your FounderFlow login email to this address. Click below to confirm the change. The link expires in 1 hour.</p>
        <p style="margin:24px 0;">
          <a href="${url}" style="background:#10B981;color:#1F2933;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;">
            Confirm new email
          </a>
        </p>
        <p style="color:#666;font-size:12px;word-break:break-all;">${url}</p>
        <p style="color:#666;font-size:12px;">If you didn't request this, ignore this email — your current address stays in place. The link also stops working if the account's password is changed.</p>
      </div>
    `;
    const text = `Confirm your new FounderFlow email: ${url}\n\nThe link expires in 1 hour. If you didn't request this, ignore it.`;

    const result = await sendEmail({
      to: newEmail,
      subject: "Confirm your new FounderFlow email",
      html,
      text,
    });

    // The owner's signal. Sent after the confirmation mail and never allowed to
    // fail the request: `sendEmail` reports delivery rather than throwing, and a
    // bounced warning must not leave the user unable to change their address.
    await warnOldAddress({
      oldEmail: me.email,
      newEmail,
      name: me.name,
      applied: false,
    });

    return { success: true, data: { dispatched: result.delivered, newEmail } };
  } catch (e) {
    captureServerError(e, { action: "requestEmailChange", userId: session.user.id });
    return { success: false, error: "Couldn't start the email change right now. Try again." };
  }
}

export async function confirmEmailChangeAction(
  input: unknown
): Promise<ActionResult<{ email: string }>> {
  // Redeeming a signed link, followed from a mail client that carries no
  // session cookie: its own loose class, 30 per address per minute, and
  // uncounted where no proxy gives us a trustworthy address. It shared one
  // 5/min bucket with login and signup until auth-007, which meant a few
  // ordinary sign-ins from the same office could refuse this link outright.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "tokenRedeem", ip });
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ConfirmEmailChangeSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "This link is malformed." };

  const verified = await verifyEmailChangeToken(parsed.data.token);
  if (!verified.ok) {
    return {
      success: false,
      error:
        verified.reason === "expired"
          ? "This confirmation link has expired. Request the change again."
          : "This confirmation link is invalid. Request the change again.",
    };
  }

  try {
    const user = await db.user.findFirst({
      // `deletedAt: null` — the old lookup had no such filter, so a
      // confirmation link could still rewrite the login address of an account
      // inside its soft-delete retention window (acct-004).
      where: { id: verified.userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        sessionVersion: true,
      },
    });
    if (!user) return { success: false, error: "This account no longer exists." };

    // THE REVOCATION CHECK. `bv` was computed from {sessionVersion, email,
    // passwordHash} when the link was minted; if the live row no longer digests
    // to the same value, something has happened that must cancel this change —
    // a password change or reset, a logout-everywhere, a later email change, or
    // this very link's own first use.
    //
    // Two separate messages because the two cases mean different things to the
    // person reading them: "already used" is reassuring (the change went
    // through), "no longer valid" is a revocation they need to act on.
    if (verified.bv !== emailChangeBinding(user)) {
      if (user.email === verified.newEmail) {
        return {
          success: false,
          error: `This confirmation link has already been used — your login email is already ${user.email}.`,
        };
      }
      return {
        success: false,
        error:
          "This confirmation link is no longer valid: the account changed after it was sent " +
          "(a password change, a sign-out of all devices, or a later email change). " +
          "Request the change again.",
      };
    }

    // Re-check the target isn't taken in the window since the link was sent —
    // and say which kind of holder took it (acct-016). Unfiltered by
    // `deletedAt` on purpose; see the long note on the request path above. Here
    // the reason is sharper still, because the UPDATE is one statement away: a
    // filtered lookup would hand a P2002 to the catch below and answer
    // "Couldn't change your email right now. Try again shortly." about a
    // permanent refusal.
    const collision = await db.user.findFirst({
      where: { email: verified.newEmail },
      select: { id: true, deletedAt: true },
    });
    if (collision && collision.id !== user.id) {
      if (collision.deletedAt) {
        return {
          success: false,
          error:
            "That email now belongs to a FounderFlow account that was deleted. " +
            "Contact support to restore it, or request the change again with a different address.",
        };
      }
      return { success: false, error: "That email is now in use by another account." };
    }

    const previousEmail = user.email;
    await db.user.update({
      where: { id: user.id },
      data: {
        // The clicked link proves the new address, so it lands verified.
        email: verified.newEmail,
        emailVerifiedAt: new Date(),
        // ONE UPDATE, both facts. Moving the login address is a credential
        // change: every other live session — including the borrowed one that
        // may have started this — has to die, and it must not be possible for
        // the new address to land while the bump does not. Same construction as
        // lib/actions/password-reset.ts:153 and lib/actions/profile.ts.
        //
        // This also revokes THIS link (its `bv` is now stale), which is what
        // makes it single-use, and it revokes any OTHER outstanding link for
        // the account, which is what stops an earlier address being restored.
        sessionVersion: { increment: 1 },
      },
    });

    await warnOldAddress({
      oldEmail: previousEmail,
      newEmail: verified.newEmail,
      name: user.name,
      applied: true,
    });

    return { success: true, data: { email: verified.newEmail } };
  } catch (e) {
    captureServerError(e, { action: "confirmEmailChange", userId: verified.userId });
    return { success: false, error: "Couldn't change your email right now. Try again shortly." };
  }
}
