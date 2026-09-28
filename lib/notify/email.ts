/**
 * Turning a notification into an email.
 *
 * Split out of fan-out.ts so that file stays about *routing* — who gets this,
 * on which channels — while this one owns the mechanics of actually sending.
 *
 * Everything here is best-effort and fire-and-forget. The durable in-app
 * Notification row is the source of truth; an email that fails, or that the
 * daily budget refuses, must never surface to the action that triggered it.
 */

import { claimEmailBudget } from "@/lib/email/quota";
import { appOrigin } from "@/lib/env";
import { EVENT_COPY, type NotifyEvent } from "@/lib/notify/events";

export type EmailRecipient = { name: string; email: string };

/**
 * Absolute base for links in email. Mail clients cannot resolve a relative
 * path, so every URL has to be fully qualified.
 *
 * Delegates to `appOrigin()` — the one decision for the public origin
 * (prodready-004) — rather than repeating `?? "http://localhost:3000"`. The
 * difference that shows up in someone's inbox: `job.link` always begins with a
 * slash (`"/tasks?taskId=123"`), so a Production origin saved as
 * `https://app.founderflow.com/` used to produce
 * `https://app.founderflow.com//tasks?taskId=123` in every notification email
 * and `…//settings` in every "manage your preferences" footer.
 *
 * Kept as a named export so it stays mockable from tests/lib/notify/fan-out.test.ts.
 */
export function linkBase(): string {
  return appOrigin();
}

export type NotificationEmailJob = {
  event: NotifyEvent;
  recipients: EmailRecipient[];
  title: string;
  message: string;
  /** App-relative deep link, e.g. "/tasks?taskId=123". */
  link?: string | null;
};

/**
 * Send one notification email per recipient, within the daily budget.
 *
 * Does not return a promise on purpose: callers are server actions in the
 * middle of a write, and SMTP round-trips have no business holding a
 * transaction open or adding latency to a user's click.
 */
export function fireNotificationEmails(job: NotificationEmailJob): void {
  if (job.recipients.length === 0) return;

  // Claim before sending. Over budget we send to as many as the budget allows
  // and silently drop the rest — those people still have the in-app row, and
  // the alternative is risking Gmail rejecting password resets too.
  const allowed = claimEmailBudget(job.recipients.length);
  if (allowed === 0) return;
  const recipients = job.recipients.slice(0, allowed);

  void (async () => {
    try {
      const [{ sendEmail }, { renderNotificationEmail }] = await Promise.all([
        import("@/lib/email/send"),
        import("@/lib/email/templates/notification"),
      ]);

      const base = linkBase();
      const copy = EVENT_COPY[job.event];
      const actionUrl = `${base}${job.link ?? "/notifications"}`;
      const preferencesUrl = `${base}/settings`;

      await Promise.all(
        recipients.map((r) => {
          const { html, text } = renderNotificationEmail({
            recipientName: r.name,
            title: job.title,
            message: job.message,
            eventLabel: copy.label,
            actionUrl,
            actionLabel: copy.actionLabel,
            preferencesUrl,
          });
          return sendEmail({ to: r.email, subject: job.title, html, text });
        })
      );
    } catch {
      // sendEmail already reports its own failures to Sentry and dev-stubs
      // when unconfigured; anything reaching here is not worth a second alarm.
    }
  })();
}
