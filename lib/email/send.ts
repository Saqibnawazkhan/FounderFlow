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
 *   • Either missing, and NOT a production deployment → logs the full HTML +
 *     invite URL to the server console and returns
 *     { delivered: false, devLogged: true } so callers can show a fallback
 *     toast with the URL for manual sharing.
 *   • Either missing ON A PRODUCTION DEPLOYMENT → logs that a send was
 *     DROPPED, without the body, raises a Sentry event, and returns
 *     { delivered: false, devLogged: false, error } — see
 *     `describeUnconfiguredSend` below for why the two cases differ.
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

/**
 * Is this the live production deployment?
 *
 * `VERCEL_ENV` first and `NODE_ENV` only as a fallback, because `next build`
 * sets NODE_ENV=production for PREVIEW deploys too. Keying off NODE_ENV alone
 * would raise a Sentry event for every preview deploy that has no Gmail
 * credentials — which previews legitimately do not have — and that noise is
 * precisely what gets an alert muted, taking the production signal with it.
 */
function isProductionDeployment(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === "production";
  return process.env.NODE_ENV === "production";
}

/** The message on the Sentry event and on the returned result. */
export const NO_TRANSPORT_ERROR =
  "No e-mail transport configured (GMAIL_USER / GMAIL_APP_PASSWORD unset). " +
  "The message was NOT sent and NOT logged.";

export interface UnconfiguredSend {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from: string;
  /** See isProductionDeployment(). Passed in so this stays pure and testable. */
  isProduction: boolean;
}

/**
 * Everything about the "there is no SMTP transport" branch, decided in one pure
 * place: what to log, whether to raise a Sentry event, and what to return.
 *
 * WHY THIS BRANCH IS TREATED DIFFERENTLY IN PRODUCTION (prodready-005).
 *
 * The previous version printed the whole message — `to`, `subject`, the plain
 * text and the full HTML — in every environment, and argued in a comment that
 * this is not a leak because the branch is only reached when no mail is being
 * sent to anyone at all, so the only content printed is content that had no
 * other way of reaching its recipient.
 *
 * That argument is exactly right in DEVELOPMENT, and the dev behaviour is
 * deliberately unchanged: with no Gmail credentials on a laptop, the terminal is
 * how you get the reset link to click. Hardening the body out everywhere would
 * break the only local password-reset flow there is.
 *
 * It is wrong in production, in two separate ways:
 *
 *   • The content is a live one-time credential. A reset e-mail's HTML contains
 *     the reset URL with its token; an invite's contains the invite URL. Vercel
 *     function logs are readable by every member of the Vercel team and by any
 *     configured log drain, and they are retained. "Nobody else could have read
 *     it" is true of a laptop and false of a shared log.
 *   • Nobody is reading production logs to hand-deliver a stranger's reset link,
 *     so the log serves no purpose there — while the ALERT does. This was the
 *     only failure branch in this file that reported nothing: the SMTP-rejection
 *     path below calls captureServerError, and this one, the more total failure
 *     of the two, did not.
 */
export function describeUnconfiguredSend(input: UnconfiguredSend): {
  lines: string[];
  report: boolean;
  result: SendEmailResult;
} {
  const { to, subject, html, text, from, isProduction } = input;

  if (isProduction) {
    return {
      lines: [
        "[email:no-transport] DROPPED an outbound e-mail — GMAIL_USER / GMAIL_APP_PASSWORD " +
          "are not set on this production deployment, so nothing was sent.",
        `  from=${from}`,
        `  to=${to}`,
        `  subject="${subject}"`,
        "  body withheld: it can contain a live password-reset or invite token, and this " +
          "log is readable by the whole team and by any log drain.",
      ],
      report: true,
      result: { delivered: false, devLogged: false, error: NO_TRANSPORT_ERROR },
    };
  }

  return {
    lines: [
      "[email:dev-stub] would have sent (set GMAIL_USER + GMAIL_APP_PASSWORD to enable real send)",
      `  from=${from}`,
      `  to=${to}`,
      `  subject="${subject}"`,
      `  text=${text ?? "(none — html only)"}`,
      `  html=${html}`,
    ],
    report: false,
    result: { delivered: false, devLogged: true },
  };
}

// Module-level transporter, cached across requests within one instance. Lazy
// because a worker may load this module before env vars are populated; we
// re-check on first call. Returns null — never throws — when either credential
// is missing, which is the branch sendEmail's no-transport handling covers.
//
// WHAT THE CACHE DOES NOT DO: reuse the SMTP connection. This comment used to
// claim it did ("so we don't reopen the SMTP connection on every send"), and
// that is false. There is no `pool: true` here, and a non-pooled nodemailer
// SMTPTransport builds a new SMTPConnection inside every `send()`
// (node_modules/nodemailer/lib/smtp-transport/index.js), so EVERY message pays a
// fresh TCP + TLS + AUTH handshake to smtp.gmail.com:465. What is cached is the
// transport OBJECT: option normalisation, the well-known "gmail" lookup and the
// auth setup, all of which are cheap. The connection cost is per message.
//
// Where that bites: `requestPasswordResetAction` does not await its send, and
// the ~750ms response floor is all the runway it gets, so a cold handshake can
// outlive it and the reset e-mail is then racing the instance being frozen.
//
// `pool: true` is deliberately NOT the answer, and the reasoning is per-caller
// rather than general:
//   • It would not save the reset path. That path sends ONE message per
//     invocation, so the send at risk is always the first in a fresh instance,
//     and the first send in a pool pays exactly the same TLS + AUTH handshake.
//   • It WOULD change `lib/notify/email.ts`, which fans out to every recipient
//     of a notification with `Promise.all` — several messages per invocation
//     today, each on its own connection. Pooling would cap that concurrency
//     (nodemailer's default maxConnections is 5) and reuse sockets, which may
//     well be an improvement, but it is a behaviour change to the transport
//     every e-mail path in the app shares, for a caller that did not ask for it
//     and with nothing here testing the fan-out. It also keeps an idle socket
//     open in a runtime that freezes instances.
// So it stays unpooled and the reset path's residual risk is made visible
// instead — see the RESPONSE_FLOOR_MS comment in lib/actions/password-reset.ts
// for the Sentry signal and for the two things that would actually close it
// (`after()` from next/server on Next 15, or an outbox row a cron retries).
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
    // No SMTP transport. On a laptop that is the dev stub and the body is the
    // point; on the production deployment it is a dropped e-mail that has to
    // reach Sentry and must not put a live token in a shared log. One pure
    // decision, both cases — see describeUnconfiguredSend above.
    const outcome = describeUnconfiguredSend({
      to,
      subject,
      html,
      text,
      from: FROM_DISPLAY,
      isProduction: isProductionDeployment(),
    });
    // eslint-disable-next-line no-console
    console.info(outcome.lines.join("\n"));
    if (outcome.report) {
      // Tagged `action: sendEmail:no-transport` so one Sentry alert rule can
      // fire on it. Every invite and every password reset is being dropped
      // while this is true, and password reset is the only self-service
      // recovery path in the product.
      captureServerError(new Error(NO_TRANSPORT_ERROR), {
        action: "sendEmail:no-transport",
        extra: { to, subjectPrefix: subject.slice(0, 80) },
      });
    }
    return outcome.result;
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
