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
import { captureServerError } from "@/lib/sentry-server";

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
    // Dev / unconfigured-prod fallback. Log the whole message, not just its
    // envelope: the only reason anyone reads this line is to recover the
    // thing that did NOT get sent — an invite URL, a password-reset link, a
    // task's deadline — and none of that lives in `to=` + `subject=`. The
    // header above has promised "the full HTML + invite URL" since this file
    // was written; until now it printed neither.
    //
    // This is NOT a production log leak, and please don't "harden" the body
    // back out on that reasoning. getTransporter() returns null on exactly
    // one condition: GMAIL_USER or GMAIL_APP_PASSWORD is unset, i.e. no mail
    // is being sent to anyone at all. A configured deployment never reaches
    // this branch, so the only content ever printed here is content that had
    // no other way of reaching its recipient.
    // eslint-disable-next-line no-console
    console.info(
      [
        "[email:dev-stub] would have sent (set GMAIL_USER + GMAIL_APP_PASSWORD to enable real send)",
        `  from=${FROM_DISPLAY}`,
        `  to=${to}`,
        `  subject="${subject}"`,
        `  text=${text ?? "(none — html only)"}`,
        `  html=${html}`,
      ].join("\n")
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
    // Surface to Sentry too — without this, a stuck SMTP credential or
    // a Gmail quota-rejection (550) is only visible in console output the
    // admin doesn't read. captureServerError tags by `action: sendEmail`
    // so a single alert can wire on this.
    captureServerError(e, {
      action: "sendEmail",
      // Redact subject content to a length so a noisy email body doesn't
      // bloat the Sentry event; recipient + reason are what triage needs.
      extra: { to, subjectPrefix: subject.slice(0, 80), reason: msg },
    });
    return { delivered: false, devLogged: false, error: msg };
  }
}
