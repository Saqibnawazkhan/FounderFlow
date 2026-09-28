"use server";

/**
 * Password-reset server actions.
 *
 * Enumeration posture: `requestPasswordResetAction` returns success even when
 * no account matches the email. That prevents an attacker from probing which
 * addresses are registered by watching for a different error path. The email
 * is only actually sent when a matching user exists.
 *
 * Delivery posture: `sendEmail()` returns `{ delivered, devLogged }`. When
 * SMTP isn't configured (local dev, or a partial prod deploy), the reset
 * link is logged to the server console. The client toast is identical
 * either way so the enumeration guarantee holds.
 *
 * Rate limit: the two halves of this flow are in DIFFERENT risk classes and no
 * longer share a bucket with login or signup (auth-007). Requesting a link is
 * `emailDispatch` — 10 per client address / 10 min and 5 per submitted address
 * / 15 min, because the cost is somebody's inbox and our capped Gmail quota.
 * Redeeming one is `tokenRedeem` — 30 per address / minute, loose because the
 * token is unforgeable and a false refusal lands on a locked-out customer. Both
 * used to be one 5-per-minute IP bucket shared with eight other actions, so a
 * few ordinary sign-ins behind an office NAT meant no reset email at all — and,
 * because this endpoint is enumeration-safe, no explanation either.
 *
 * Tombstones (auth-006): a soft-deleted user is NOT a resettable account.
 * `authorize()` filters `deletedAt: null`, so a tombstoned row can never sign
 * in; both lookups below therefore filter it too. Until 2026-09-28 they did
 * not, and the reset ran to completion on a deleted account — it rewrote the
 * password hash, advanced `sessionVersion`, and returned success, so the app
 * told a locked-out customer their new password was set and then still refused
 * it. Two harms, both closed here: the false success, and the WRITE to a row
 * inside the retention window CLAUDE.md promises is restorable with a single
 * `UPDATE … SET "deletedAt" = NULL`.
 *
 * Both reads are `findFirst`, not `findUnique`, for a reason that is easy to
 * undo by accident: Prisma's `findUnique` accepts only unique fields in
 * `where`, so it CANNOT carry `deletedAt: null`. Changing either back to
 * `findUnique` silently reopens the hole.
 *
 * Note what does NOT change: `requestPasswordResetAction` still returns the
 * same `{ dispatched: false }` envelope for a tombstone that it returns for an
 * address that was never registered. The anti-enumeration posture above is
 * deliberate, and a distinct "that account was deleted" response would turn
 * this endpoint into an oracle for it. Only `resetPasswordAction` — which is
 * reached solely by someone already holding a valid signed token for that
 * user — says so out loud.
 */

import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { gateAuthAction } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { appOrigin } from "@/lib/env";
import { captureServerError } from "@/lib/sentry-server";
import { sendEmail } from "@/lib/email/send";
import {
  passwordVersion,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from "@/lib/auth/password-reset-token";
import { RequestPasswordResetSchema, ResetPasswordSchema } from "@/lib/schemas/password-reset";

import type { ActionResult } from "@/lib/actions/types";

/**
 * The origin every link in this file is concatenated onto.
 *
 * `appOrigin` (lib/env.ts) is the ONE decision — prodready-004. This used to be
 * its own `process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"`, one of
 * seven such copies, and one of the six that did NOT strip a trailing slash: an
 * origin pasted out of a browser address bar (`https://app.founderflow.com/`)
 * produced `https://app.founderflow.com//reset-password?token=…`, a URL that
 * works in one mail client and 404s in the next, in front of someone who cannot
 * sign in. `appOrigin` also trims whitespace, which `.replace(/\/$/, "")`
 * silently fails to handle when a pasted value ends in a space.
 *
 * The raw value is passed EXPLICITLY rather than relying on the default
 * argument, so the read stays at call time exactly as it is today. The default
 * argument would snapshot `env.NEXT_PUBLIC_APP_URL` at module load instead.
 */
function resetLinkBase(): string {
  return appOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

export async function requestPasswordResetAction(
  input: unknown
): Promise<ActionResult<{ dispatched: boolean }>> {
  const parsed = RequestPasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid email" };
  }
  const { email } = parsed.data;

  // The "we will now send a human an email" class (auth-007): 10 per client
  // address per 10 minutes, AND 5 per target address per 15 minutes. Below the
  // parse because the per-account key IS the submitted address — `safeParse` is
  // pure and touches no database, so an unparseable flood still costs nothing.
  //
  // Keyed on the SUBMITTED address, never on the looked-up user, so the
  // allowance is identical whether the account exists, never existed or is
  // tombstoned. Keying the found user would make the number of requests this
  // endpoint accepts an oracle for "is this address registered", which is the
  // exact posture the header above exists to protect.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "emailDispatch", ip, account: email });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  try {
    const user = await db.user.findFirst({
      // `deletedAt: null` is why this is findFirst — findUnique cannot express it.
      where: { email, deletedAt: null },
      select: { id: true, name: true, passwordHash: true },
    });
    // Anti-enumeration: same success path whether the account exists, never
    // existed, or has been tombstoned. The email only fires when it is live.
    if (!user) {
      return { success: true, data: { dispatched: false } };
    }

    // Bind the token to the current password hash so a successful reset (which
    // rewrites the hash) makes this and any other outstanding link single-use.
    const token = await signPasswordResetToken(user.id, passwordVersion(user.passwordHash));
    const url = `${resetLinkBase()}/reset-password?token=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
        <h2 style="margin:0 0 12px 0;">Reset your FounderFlow password</h2>
        <p>Hi ${user.name},</p>
        <p>We received a request to reset the password for the account associated with this email address. Click the button below to choose a new password. The link expires in 15 minutes.</p>
        <p style="margin:24px 0;">
          <a href="${url}" style="background:#10B981;color:#1F2933;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;">
            Reset password
          </a>
        </p>
        <p style="color:#666;font-size:12px;">If the button doesn't work, paste this URL into your browser:</p>
        <p style="color:#666;font-size:12px;word-break:break-all;">${url}</p>
        <p style="color:#666;font-size:12px;">If you didn't ask to reset your password, ignore this email — your account stays as-is.</p>
      </div>
    `;
    const text = `Reset your FounderFlow password: ${url}\n\nThe link expires in 15 minutes. If you didn't ask to reset, ignore this email.`;

    const result = await sendEmail({
      to: email,
      subject: "Reset your FounderFlow password",
      html,
      text,
    });

    return { success: true, data: { dispatched: result.delivered } };
  } catch (e) {
    captureServerError(e, { action: "requestPasswordResetAction" });
    // Still return success to preserve enumeration posture; we shouldn't
    // reveal a Prisma / SMTP failure to a probing client. The captureServerError
    // above surfaces the real cause to the admin.
    return { success: true, data: { dispatched: false } };
  }
}

export async function resetPasswordAction(
  input: unknown
): Promise<ActionResult<{ email: string }>> {
  // Redeeming a signed link — its own loose class, and deliberately NOT the
  // bucket the request half above uses. A reset token is an HS256 JWT bound to
  // the current password hash, so the defence against a guessed one is
  // cryptographic; the numeric limit here is a courtesy valve against a hot
  // loop, and the cost of a false refusal is telling a locked-out customer that
  // their single-use link is "too many requests" (auth-007).
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "tokenRedeem", ip });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid password" };
  }
  const { token, password } = parsed.data;

  const verified = await verifyPasswordResetToken(token);
  if (!verified.ok) {
    return {
      success: false,
      error:
        verified.reason === "expired"
          ? "This reset link has expired. Request a new one."
          : "This reset link is invalid. Request a new one.",
    };
  }

  try {
    const user = await db.user.findFirst({
      // Same tombstone filter as `authorize()`, in the SAME query as the read,
      // so there is no window in which the row is fetched and then written
      // before anyone checks whether it still exists. findUnique cannot carry
      // this filter; do not change it back.
      where: { id: verified.userId, deletedAt: null },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) {
      // Covers both "never existed" and "deleted". A holder of a valid signed
      // token for this id is the account owner, so naming it leaks nothing and
      // replaces a success envelope that was a lie.
      return { success: false, error: "This account no longer exists." };
    }
    // Single-use enforcement: the token's pv must still match the live hash.
    // Once a reset lands, the hash (and pv) change, so a replayed or stale
    // link — including one issued before an earlier reset — is rejected here.
    if (verified.pv !== passwordVersion(user.passwordHash)) {
      return {
        success: false,
        error: "This reset link has already been used. Request a new one.",
      };
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await db.user.update({
      where: { id: user.id },
      // Bump sessionVersion so any other live session (incl. a hijacked one
      // that prompted the reset) is force-signed-out on its next request.
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    return { success: true, data: { email: user.email } };
  } catch (e) {
    captureServerError(e, { action: "resetPasswordAction" });
    return { success: false, error: "Couldn't reset your password right now. Try again shortly." };
  }
}
