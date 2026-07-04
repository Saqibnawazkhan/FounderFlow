"use server";

/**
 * Change-email server actions (audit S3).
 *
 *   - `requestEmailChangeAction(newEmail)` — session-scoped. Validates the
 *     new address isn't taken, then emails a confirmation link TO THE NEW
 *     ADDRESS. The email is NOT changed yet — only clicking the link (which
 *     proves the user controls the destination inbox) applies it. Sending to
 *     the new address is the whole point: it verifies ownership before the
 *     swap, so a typo can't lock the user out of their account.
 *   - `confirmEmailChangeAction(token)` — token-scoped (works logged-out on
 *     any device). Swaps the email + marks it verified. Idempotent-ish: a
 *     second click after the swap fails the not-taken check gracefully.
 */

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { sendEmail } from "@/lib/email/send";
import { signEmailChangeToken, verifyEmailChangeToken } from "@/lib/auth/email-change-token";
import { RequestEmailChangeSchema, ConfirmEmailChangeSchema } from "@/lib/schemas/email-change";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

function linkBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function requestEmailChangeAction(
  input: unknown
): Promise<ActionResult<{ dispatched: boolean; newEmail: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Not authenticated" };

  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = RequestEmailChangeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid email" };
  }
  const { newEmail } = parsed.data;

  try {
    const me = await db.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, name: true, email: true },
    });
    if (!me) return { success: false, error: "Account no longer exists" };
    if (newEmail === me.email) {
      return { success: false, error: "That's already your email." };
    }
    const collision = await db.user.findUnique({ where: { email: newEmail } });
    if (collision) {
      return { success: false, error: "An account with this email already exists." };
    }

    const token = await signEmailChangeToken(me.id, newEmail);
    const url = `${linkBase()}/verify-email-change?token=${encodeURIComponent(token)}`;
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
        <h2 style="margin:0 0 12px 0;">Confirm your new email</h2>
        <p>Hi ${me.name},</p>
        <p>A request was made to change your FounderFlow login email to this address. Click below to confirm the change. The link expires in 1 hour.</p>
        <p style="margin:24px 0;">
          <a href="${url}" style="background:#b6f425;color:#0a0a0a;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;">
            Confirm new email
          </a>
        </p>
        <p style="color:#666;font-size:12px;word-break:break-all;">${url}</p>
        <p style="color:#666;font-size:12px;">If you didn't request this, ignore this email — your current address stays in place.</p>
      </div>
    `;
    const text = `Confirm your new FounderFlow email: ${url}\n\nThe link expires in 1 hour. If you didn't request this, ignore it.`;

    const result = await sendEmail({
      to: newEmail,
      subject: "Confirm your new FounderFlow email",
      html,
      text,
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
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
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
    const user = await db.user.findUnique({
      where: { id: verified.userId },
      select: { id: true, email: true },
    });
    if (!user) return { success: false, error: "This account no longer exists." };
    if (user.email === verified.newEmail) {
      // Already applied (double click) — treat as success.
      return { success: true, data: { email: user.email } };
    }
    // Re-check the target isn't taken in the window since the link was sent.
    const collision = await db.user.findUnique({ where: { email: verified.newEmail } });
    if (collision && collision.id !== user.id) {
      return { success: false, error: "That email is now in use by another account." };
    }

    await db.user.update({
      where: { id: user.id },
      // The clicked link proves the new address, so it lands verified.
      data: { email: verified.newEmail, emailVerifiedAt: new Date() },
    });
    return { success: true, data: { email: verified.newEmail } };
  } catch (e) {
    captureServerError(e, { action: "confirmEmailChange", userId: verified.userId });
    return { success: false, error: "Couldn't change your email right now. Try again shortly." };
  }
}
