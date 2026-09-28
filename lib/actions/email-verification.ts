"use server";

/**
 * Email-verification server actions.
 *
 *   - `getEmailVerificationStatusAction` — session-scoped; the banner in the
 *     app shell calls this once on mount to decide whether to show. Reads the
 *     live DB value, so it's never stale (unlike a JWT claim would be right
 *     after the user verifies).
 *   - `resendVerificationEmailAction` — session-scoped; the banner's Resend
 *     button. Sends to the LOGGED-IN user's own email (never an arbitrary
 *     address), so there's no enumeration surface. No-ops if already verified.
 *   - `verifyEmailAction` — token-scoped, NOT session-scoped. The
 *     verification link may be opened on a device where the user isn't logged
 *     in; the signed token is the proof. Idempotent: verifying an
 *     already-verified account just succeeds.
 */

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { gateAuthAction } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { sendVerificationEmail } from "@/lib/email/verification";
import { verifyEmailVerificationToken } from "@/lib/auth/email-verification-token";
import { VerifyEmailSchema } from "@/lib/schemas/email-verification";

import type { ActionResult } from "@/lib/actions/types";

export async function getEmailVerificationStatusAction(): Promise<
  ActionResult<{ verified: boolean; email: string }>
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  try {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user) return { success: false, error: "Account no longer exists" };
    return {
      success: true,
      data: { verified: user.emailVerifiedAt !== null, email: user.email },
    };
  } catch (e) {
    captureServerError(e, { action: "getEmailVerificationStatus", userId: session.user.id });
    return { success: false, error: "Couldn't check verification status." };
  }
}

export async function resendVerificationEmailAction(): Promise<
  ActionResult<{ dispatched: boolean; alreadyVerified: boolean }>
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  // The "we will now send a human an email" class — shared with
  // request-password-reset and request-email-change, and keyed on the signed-in
  // account as well as the address. A resend is cheap, but Gmail's daily send
  // cap is not, and the per-account dimension is what stops one person's Resend
  // button spending the whole office's budget (auth-007). It used to be the
  // single `limiters.auth` bucket that login, signup, reset and the two
  // token-redemption links also drew on.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "emailDispatch", ip, account: session.user.id });
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  try {
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true, emailVerifiedAt: true },
    });
    if (!user) return { success: false, error: "Account no longer exists" };
    if (user.emailVerifiedAt !== null) {
      return { success: true, data: { dispatched: false, alreadyVerified: true } };
    }

    const { delivered } = await sendVerificationEmail({
      userId: user.id,
      name: user.name,
      email: user.email,
    });
    return { success: true, data: { dispatched: delivered, alreadyVerified: false } };
  } catch (e) {
    captureServerError(e, { action: "resendVerificationEmail", userId: session.user.id });
    return { success: false, error: "Couldn't send the email right now. Try again shortly." };
  }
}

export async function verifyEmailAction(input: unknown): Promise<ActionResult<{ email: string }>> {
  // Redeeming a signed link: its own, deliberately loose class (30/min/address,
  // and uncounted where no proxy gives us a trustworthy address). The token is
  // an HS256 JWT, so the protection against a guessed one is cryptographic
  // rather than numeric; the cost of a refusal here is telling a customer their
  // perfectly good link is "too many requests". Until auth-007 this shared one
  // 5/min bucket with login and signup, so a burst of ordinary sign-ins behind
  // an office NAT broke a colleague's verification link.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "tokenRedeem", ip });
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = VerifyEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "This verification link is malformed." };
  }

  const verified = await verifyEmailVerificationToken(parsed.data.token);
  if (!verified.ok) {
    return {
      success: false,
      error:
        verified.reason === "expired"
          ? "This verification link has expired. Sign in and resend a fresh one."
          : "This verification link is invalid. Sign in and resend a fresh one.",
    };
  }

  try {
    const user = await db.user.findUnique({
      where: { id: verified.userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) return { success: false, error: "This account no longer exists." };

    // Idempotent — re-clicking a link (or a double-submit) just succeeds
    // without stamping a new timestamp over the original verification time.
    if (user.emailVerifiedAt === null) {
      await db.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return { success: true, data: { email: user.email } };
  } catch (e) {
    captureServerError(e, { action: "verifyEmail", userId: verified.userId });
    return { success: false, error: "Couldn't verify your email right now. Try again shortly." };
  }
}
