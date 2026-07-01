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
 * Rate limit: reuses the existing `limiters.auth` bucket — 5 requests per
 * IP per minute. Same bucket as signup + login so the raw brute-force
 * attempts across all three routes share the same allowance.
 */

import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { limiters } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { captureServerError } from "@/lib/sentry-server";
import { sendEmail } from "@/lib/email/send";
import { signPasswordResetToken, verifyPasswordResetToken } from "@/lib/auth/password-reset-token";
import { RequestPasswordResetSchema, ResetPasswordSchema } from "@/lib/schemas/password-reset";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

function resetLinkBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export async function requestPasswordResetAction(
  input: unknown
): Promise<ActionResult<{ dispatched: boolean }>> {
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  const parsed = RequestPasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid email" };
  }
  const { email } = parsed.data;

  try {
    const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true } });
    // Anti-enumeration: same success path whether the account exists or not.
    // The email only fires when it does.
    if (!user) {
      return { success: true, data: { dispatched: false } };
    }

    const token = await signPasswordResetToken(user.id);
    const url = `${resetLinkBase()}/reset-password?token=${encodeURIComponent(token)}`;

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
        <h2 style="margin:0 0 12px 0;">Reset your FounderFlow password</h2>
        <p>Hi ${user.name},</p>
        <p>We received a request to reset the password for the account associated with this email address. Click the button below to choose a new password. The link expires in 15 minutes.</p>
        <p style="margin:24px 0;">
          <a href="${url}" style="background:#b6f425;color:#0a0a0a;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;">
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
  const ip = await getClientIp();
  const gate = limiters.auth.consume(ip);
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
    const user = await db.user.findUnique({
      where: { id: verified.userId },
      select: { id: true, email: true },
    });
    if (!user) {
      return { success: false, error: "This account no longer exists." };
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    return { success: true, data: { email: user.email } };
  } catch (e) {
    captureServerError(e, { action: "resetPasswordAction" });
    return { success: false, error: "Couldn't reset your password right now. Try again shortly." };
  }
}
