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
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { sendVerificationEmail } from "@/lib/email/verification";
import { verifyEmailVerificationToken } from "@/lib/auth/email-verification-token";
import { VerifyEmailSchema } from "@/lib/schemas/email-verification";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

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

  // Same auth bucket as login/signup/reset — a resend is cheap but we don't
  // want a script hammering Gmail's quota.
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
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
  // Rate-limited by IP even though it's token-gated — a scripted brute over
  // the token space shares the auth bucket with everything else.
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
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
