/**
 * The security-notice email — acct-005.
 *
 * WHAT IT IS FOR. Three things could happen to a FounderFlow account in total
 * silence, as far as the owner's inbox was concerned: the password could be
 * changed, the account could be deleted, and the whole workspace could be
 * deleted. Each of those is the last step of an account takeover done at an
 * unlocked laptop, and each of them is also something a customer simply wants a
 * receipt for. The only channel that still belongs to the REAL owner after such
 * a change is the address that was on file WHEN it happened — so that is who
 * these go to, and they say what to do if it was not them.
 *
 * (The fourth case, moving the login email, was already covered: see
 * `warnOldAddress` in lib/actions/email-change.ts, which has warned the old
 * address on both request and completion since the acct-004 / auth-005 wave.)
 *
 * THE QUOTA DECISION, STATED ONCE, HERE. These messages do NOT call
 * `claimEmailBudget` (lib/email/quota.ts) and must not be made to.
 *
 *   • That budget is a circuit breaker against a NOTIFICATION LOOP. Its single
 *     caller is lib/notify/email.ts, and its own docstring says the headroom it
 *     leaves under Gmail's ~500/day cap is reserved "for transactional mail:
 *     verification, password reset, email change, invites". A security notice
 *     is that class, not notification noise.
 *   • It degrades by SILENTLY DROPPING recipients. Dropping a takeover alert is
 *     precisely the silence acct-005 is about, and it would drop it on the
 *     busiest day — the one where something is looping.
 *   • The volume is already bounded, and by the right thing: a human action
 *     behind `gateAuthAction({ kind: "destructive" })` (5 per user / 10 min) or
 *     `limiters.write`, plus MAX_NOTICE_RECIPIENTS below for the one fan-out.
 *
 * tests/lib/actions/account-security-notices.test.ts asserts the budget is
 * untouched, so this decision fails the suite rather than quietly eroding.
 *
 * HOUSE STYLE: inlined styles, no images, no remote resources — every email
 * client treats <style> differently and inline survives Gmail / Outlook / Apple
 * Mail. Same constraints and the same card structure as templates/invite.ts and
 * templates/notification.ts.
 */

import { appOrigin } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { captureServerError } from "@/lib/sentry-server";

/**
 * The soft-delete retention window, in days, as told to the customer.
 *
 * MIRRORED, NOT IMPORTED. The authority is `RETENTION_DAYS` in
 * app/api/cron/purge-soft-deleted/route.ts, and importing a route module into a
 * server action would drag the whole cron handler into the action's bundle.
 * tests/lib/actions/account-security-notices.test.ts parses that file and fails
 * if the two numbers drift — because the number in this email is a PROMISE, and
 * a promise of 90 days over a cron that purges at 30 is the worst possible
 * drift: the customer waits out a deadline that already passed.
 */
export const SECURITY_NOTICE_RETENTION_DAYS = 90;

/**
 * The most people one teardown will email.
 *
 * A workspace delete is the only notice here that fans out, and it is the only
 * place a single click can ask for an unbounded number of sends. A cap is the
 * right shape rather than a shared daily budget (see the header): it is per
 * event, it cannot be exhausted by unrelated traffic, and going over it is
 * reported rather than silently swallowed. 100 is far above any real FounderFlow
 * workspace — the free plan allows two members — and far below Gmail's cap.
 */
const MAX_NOTICE_RECIPIENTS = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SecurityNoticeKind = "password-changed" | "account-deleted" | "workspace-deleted";

export interface SecurityNoticeInput {
  kind: SecurityNoticeKind;
  /** Who is being written to — greeting only. */
  recipientName: string;
  /** The login address the change happened to. Shown so the reader knows which account. */
  accountEmail: string;
  /** Canonical origin. Always `appOrigin()` — never hand-built (prodready-004). */
  origin?: string;
  /** Workspace name, for the workspace-deleted notice. */
  workspaceName?: string;
  /** When the tombstone was written, for the delete notices. */
  deletedAt?: Date;
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The last day the 90-day window still covers a deletion made at `deletedAt`. */
function recoverableUntil(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + SECURITY_NOTICE_RETENTION_DAYS * DAY_MS);
}

/**
 * A date a human can act on, pinned to UTC.
 *
 * UTC, not the server's zone, because the server's zone is Vercel's and means
 * nothing to the reader — and because a deadline that renders differently on two
 * instances is a deadline nobody can quote back at us.
 */
function humanDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface Copy {
  subject: string;
  eyebrow: string;
  headline: string;
  /** Paragraphs, in order. Plain text — escaped on the way into the HTML. */
  body: string[];
  /** The "this wasn't me" instruction. Rendered emphasised, in the danger colour. */
  remedy: string;
  /** Optional call to action. Omitted where the reader can no longer sign in. */
  action?: { url: string; label: string };
}

function copyFor(input: SecurityNoticeInput): Copy {
  const origin = input.origin ?? appOrigin();
  const when = input.deletedAt ?? new Date();
  const deadline = humanDate(recoverableUntil(when));
  const workspace = input.workspaceName ?? "your workspace";

  if (input.kind === "password-changed") {
    return {
      subject: "Your FounderFlow password was changed",
      eyebrow: "Security alert",
      headline: "Your password was changed",
      body: [
        `The password for your FounderFlow account (${input.accountEmail}) was just changed, ` +
          `and every device signed in to it has been signed out.`,
        `If you made this change, there is nothing to do — sign back in with the new password.`,
      ],
      // Actionable, not "contact us": someone who did not set this password
      // cannot sign in, so reset is the only door they still have. It is also
      // the control that revokes any pending login-email change (see
      // lib/actions/email-change.ts), which is the next step of a takeover.
      remedy:
        `If this wasn't you, reset your password immediately at ${origin}/forgot-password — ` +
        `whoever changed it can sign in to your account until you do. Then reply to this email ` +
        `and we'll help you secure the account.`,
      action: { url: `${origin}/forgot-password`, label: "Reset your password" },
    };
  }

  if (input.kind === "account-deleted") {
    return {
      subject: "Your FounderFlow account was deleted",
      eyebrow: "Account deleted",
      headline: "Your account was deleted",
      body: [
        `Your FounderFlow account (${input.accountEmail}) was deleted on ${humanDate(when)}. ` +
          `You have been signed out and can no longer sign in.`,
        `Nothing is erased straight away: your account is recoverable for ` +
          `${SECURITY_NOTICE_RETENTION_DAYS} days, until ${deadline}. After that it is ` +
          `permanently deleted and cannot be brought back.`,
      ],
      remedy:
        `If you didn't do this, reply to this email before ${deadline} and we will restore the ` +
        `account. Reply by the same date if you did mean to delete it but have changed your mind.`,
    };
  }

  return {
    subject: `"${workspace}" was deleted on FounderFlow`,
    eyebrow: "Workspace deleted",
    headline: `"${workspace}" was deleted`,
    body: [
      `The FounderFlow workspace "${workspace}" was deleted on ${humanDate(when)}, along with ` +
        `every project, task, budget and transaction in it. Everyone in it has been signed out, ` +
        `including your account (${input.accountEmail}).`,
      `Nothing is erased straight away: the whole workspace is recoverable for ` +
        `${SECURITY_NOTICE_RETENTION_DAYS} days, until ${deadline}. After that it is permanently ` +
        `deleted and cannot be brought back.`,
    ],
    remedy:
      `If you didn't expect this, reply to this email before ${deadline} and we will restore the ` +
      `workspace exactly as it was.`,
  };
}

/** The copy for one notice, rendered into a subject and both bodies. */
function buildSecurityNotice(input: SecurityNoticeInput): RenderedEmail {
  const c = copyFor(input);
  const name = escapeHtml(input.recipientName);

  const paragraphs = c.body
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#CBD5E1;">${escapeHtml(p)}</p>`
    )
    .join("\n              ");

  const button = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
                <tr>
                  <td>
                    <a href="${c.action.url}" style="display:inline-block;background:#10B981;color:#1F2933;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:9999px;">${escapeHtml(c.action.label)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#9CAFC3;">Or paste this link in your browser:</p>
              <p style="margin:0 0 24px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:12px;line-height:1.5;color:#CBD5E1;word-break:break-all;">${c.action.url}</p>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#1F2933;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;color:#FFFFFF;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1F2933;padding:48px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#2A3642;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:40px 32px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#9CAFC3;">${escapeHtml(c.eyebrow)}</p>
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">${escapeHtml(c.headline)}</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#CBD5E1;">Hey ${name},</p>
              ${paragraphs}
              ${button}
              <hr style="border:0;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;" />
              <p style="margin:0;font-size:13px;line-height:1.55;color:#FCA5A5;"><strong>${escapeHtml(c.remedy)}</strong></p>
              <p style="margin:16px 0 0;font-size:12px;line-height:1.55;color:#9CAFC3;">You're getting this because it is a change to your account's security. There is no way to switch these off.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${c.headline}

Hey ${input.recipientName},

${c.body.join("\n\n")}
${c.action ? `\n${c.action.label}: ${c.action.url}\n` : ""}
${c.remedy}

—
You're getting this because it is a change to your account's security.
There is no way to switch these off.`;

  return { subject: c.subject, html, text };
}

/**
 * Send one security notice. NEVER THROWS, and never spends notification budget.
 *
 * WHY THE SWALLOW IS LOAD-BEARING. Every caller is past the point of no return:
 * the password is already rewritten, the workspace is already tombstoned. If a
 * mailer fault propagated, the action's outer catch would return "Couldn't
 * change your password right now" about a change that HAS landed, and the user
 * would keep trying the old password forever. `sendEmail` already reports rather
 * than throws, but `nodemailer.createTransport` on a bad credential does not, so
 * the guarantee has to be made here rather than assumed.
 *
 * Awaited by callers rather than fire-and-forget: a serverless runtime may kill
 * a floating promise the moment the response is returned, and a security notice
 * dropped on the way out is the exact silence acct-005 is about. The cost is one
 * SMTP round trip on an action the user already expects to be slow.
 */
export async function sendSecurityNotice(
  input: SecurityNoticeInput & { to: string }
): Promise<void> {
  try {
    const { subject, html, text } = buildSecurityNotice(input);
    await sendEmail({ to: input.to, subject, html, text });
  } catch (e) {
    captureServerError(e, {
      action: "sendSecurityNotice",
      extra: { kind: input.kind, to: input.to },
    });
  }
}

/**
 * Send the same notice to several people — the workspace teardown fan-out.
 *
 * NEVER THROWS EITHER, and the guarantee has to be restated here rather than
 * inherited: this function does work of its own (dedupe, cap) BEFORE it reaches
 * `sendSecurityNotice`, and every caller is past the point of no return with a
 * whole workspace already tombstoned. A fault while assembling the recipient
 * list must not turn a completed delete into "Couldn't delete the workspace
 * right now", which is an error message about something that already happened.
 *
 * Capped at MAX_NOTICE_RECIPIENTS, and going over is REPORTED: a workspace that
 * large means either a customer we did not know we had or a bug, and both are
 * worth a Sentry event. Recipients are deduplicated by address because the
 * acting admin appears in the member list too.
 */
export async function sendSecurityNotices(
  recipients: Array<{ name: string; email: string }>,
  input: Omit<SecurityNoticeInput, "recipientName" | "accountEmail">
): Promise<void> {
  try {
    const seen: Record<string, true> = {};
    const unique: Array<{ name: string; email: string }> = [];
    for (const r of recipients ?? []) {
      if (!r || !r.email) continue;
      const key = r.email.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      unique.push(r);
    }

    if (unique.length > MAX_NOTICE_RECIPIENTS) {
      captureServerError(
        new Error(`Security notice fan-out capped at ${MAX_NOTICE_RECIPIENTS} recipients`),
        {
          action: "sendSecurityNotices:capped",
          extra: { kind: input.kind, requested: unique.length },
        }
      );
    }

    const batch = unique.slice(0, MAX_NOTICE_RECIPIENTS);
    await Promise.all(
      batch.map((r) =>
        sendSecurityNotice({
          ...input,
          to: r.email,
          recipientName: r.name,
          accountEmail: r.email,
        })
      )
    );
  } catch (e) {
    captureServerError(e, { action: "sendSecurityNotices", extra: { kind: input.kind } });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
