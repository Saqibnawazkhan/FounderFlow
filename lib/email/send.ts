/**
 * Email sender — single entry point for every transactional email.
 *
 * Provider: Gmail SMTP via Nodemailer. Uses your personal Gmail with an
 * App Password (Google requires this over the regular account password).
 * Free, ~500 emails/day, no domain verification needed — perfect for a
 * small-team app like FounderFlow where the invite volume is single digits.
 *
 * Behavior:
 *   • GMAIL_USER + GMAIL_APP_PASSWORD set → real send
 *   • Either missing → logs the full HTML + invite URL to the server
 *     console and returns { delivered: false, devLogged: true } so callers
 *     can show a fallback toast with the URL for manual sharing.
 *
 * Setup (one time per Google account):
 *   1. Enable 2-Step Verification at https://myaccount.google.com/security
 *   2. Visit https://myaccount.google.com/apppasswords and create an App
 *      Password for "Mail" — Google shows a 16-char string once
 *   3. GMAIL_USER = your@gmail.com, GMAIL_APP_PASSWORD = that 16-char string
 *      (paste WITHOUT the spaces Google shows for readability)
 *   4. Add both to Vercel env vars + redeploy
 *
 * Quota: ~500 outbound emails/day on a free Gmail account. Workspace
 * accounts get ~2000/day. Hitting the limit returns a 550 error which
 * we log via [email:gmail-rejected].
 */

import nodemailer from "nodemailer";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  delivered: boolean;
  devLogged: boolean;
  error?: string;
}

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FROM_DISPLAY =
  process.env.EMAIL_FROM ?? (GMAIL_USER ? `FounderFlow <${GMAIL_USER}>` : "FounderFlow");

// Module-level transporter — cached across requests so we don't reopen the
// SMTP connection on every send. Lazy because Node 14+ workers may load
// this module before env vars are populated; we re-check on first call.
let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  return transporter;
}

export async function sendEmail({
  to,
  subject,
  html,
  text,
}: SendEmailInput): Promise<SendEmailResult> {
  const t = getTransporter();
  if (!t) {
    // Dev / unconfigured prod fallback. Log everything so the admin can
    // copy the invite link out of the toast or function logs.
    // eslint-disable-next-line no-console
    console.info(
      `[email:dev-stub] would have sent to=${to} subject="${subject}" (set GMAIL_USER + GMAIL_APP_PASSWORD to enable real send)`
    );
    return { delivered: false, devLogged: true };
  }

  try {
    await t.sendMail({
      from: FROM_DISPLAY,
      to,
      subject,
      html,
      text,
    });
    return { delivered: true, devLogged: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown email error";
    // eslint-disable-next-line no-console
    console.error(
      `[email:gmail-rejected] to=${to} from=${FROM_DISPLAY} subject="${subject}" reason="${msg}"`
    );
    return { delivered: false, devLogged: false, error: msg };
  }
}
