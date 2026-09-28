/**
 * Shared "send the verification email" helper. Used by both signupAction
 * (auto-send on account creation) and resendVerificationEmailAction (the
 * banner's Resend button), so the email template + link construction live
 * in exactly one place.
 *
 * Delivery is best-effort: sendEmail() logs the link to the server console
 * when SMTP isn't configured (local dev / partial prod), so verification is
 * testable without real delivery. Returns whether it actually dispatched so
 * the caller can toast honestly.
 */

import { appOrigin } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { signEmailVerificationToken } from "@/lib/auth/email-verification-token";

export async function sendVerificationEmail(input: {
  userId: string;
  name: string;
  email: string;
}): Promise<{ delivered: boolean }> {
  const token = await signEmailVerificationToken(input.userId);
  // `appOrigin()` is the single decision for the public origin (prodready-004).
  // This file used to keep its own `?? "http://localhost:3000"`, which meant a
  // Production origin stored with a trailing slash produced
  // `https://app.founderflow.com//verify-email?token=…` — a doubled slash in a
  // path is the kind of URL that works in one mail client and 404s in the next,
  // and the account then stays unverified with no error anywhere.
  const url = `${appOrigin()}/verify-email?token=${encodeURIComponent(token)}`;

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
      <h2 style="margin:0 0 12px 0;">Confirm your email</h2>
      <p>Hi ${input.name},</p>
      <p>Welcome to FounderFlow! Confirm this email address so you can recover your account and receive important workspace notifications. The link expires in 7 days.</p>
      <p style="margin:24px 0;">
        <a href="${url}" style="background:#10B981;color:#1F2933;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;">
          Confirm email
        </a>
      </p>
      <p style="color:#666;font-size:12px;">If the button doesn't work, paste this URL into your browser:</p>
      <p style="color:#666;font-size:12px;word-break:break-all;">${url}</p>
      <p style="color:#666;font-size:12px;">If you didn't create a FounderFlow account, you can ignore this email.</p>
    </div>
  `;
  const text = `Confirm your FounderFlow email: ${url}\n\nThe link expires in 7 days. If you didn't create an account, ignore this email.`;

  const result = await sendEmail({
    to: input.email,
    subject: "Confirm your FounderFlow email",
    html,
    text,
  });
  return { delivered: result.delivered };
}
