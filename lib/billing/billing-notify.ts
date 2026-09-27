/**
 * Telling the workspace admins that something happened to their money. (bill-018)
 *
 * The copy and the decision about tone/link live in the pure
 * lib/billing/billing-alerts.ts; this is the I/O half - the split that keeps the
 * judgement unit-testable, same as webhook-identity / billing-forgery.
 *
 * WHY `event: "team_change"` AND NOT A BILLING EVENT. Notification writes are
 * only legal through `notifyUsers`, and tests/lib/notify/fan-out-sites.test.ts
 * enforces that plus "every notifyUsers call site names a known event" and "every
 * declared event is actually raised somewhere". A `billing_alert` event would
 * therefore have to be added to `NOTIFY_EVENTS` and `DEFAULT_CHANNELS` in
 * lib/notify/events.ts and lib/notify/preferences.ts - files this change does not
 * own - so it borrows the closest existing switch instead.
 *
 * `team_change` is labelled "Account and team changes / Your role changes, or
 * your access is restored", and its defaults are in-app + email + push, which is
 * exactly the reach a declined card needs. It is still a fudge: an admin who mutes
 * role-change pings would also mute "your card was declined", which nobody would
 * choose. Adding a dedicated `billing_alert` row to the preferences matrix is
 * tracked as a follow-up; when it lands, the only change here is the literal.
 *
 * Recipients are ADMINS only, and that is the point of the finding: the workspace
 * admin and the card-holder need not be the same person, because LemonSqueezy's
 * checkout lets the buyer type any email. Before this, the admin's only warning
 * was mail sent to whatever address the buyer chose.
 *
 * Never throws. A webhook that 500s because a notification failed is worse than a
 * missing notification: LemonSqueezy retries the delivery, and the billing write
 * has already committed by the time we get here.
 */

import { db } from "@/lib/db";
import { notifyUsers } from "@/lib/notify/fan-out";
import { billingAlertCopy, type BillingAlertKind } from "@/lib/billing/billing-alerts";
import { captureServerError } from "@/lib/sentry-server";
import { formatDate } from "@/lib/utils";

export interface BillingAdminAlert {
  companyId: string;
  kind: BillingAlertKind;
  /** When paid access stops (or stopped). Usually `Company.currentPeriodEnd`. */
  accessEndsAt?: Date | null;
}

/**
 * Fan a billing alert out to every live admin of the workspace.
 *
 * Returns how many in-app rows were written, so the caller can log what actually
 * happened rather than assume - a workspace whose only admin has muted the
 * channel is notified zero times, and that is worth being able to see.
 */
export async function notifyWorkspaceAdmins(
  alert: BillingAdminAlert
): Promise<{ notified: number }> {
  try {
    // `deletedAt: null` on both: a tombstoned workspace is inside its Tier 3
    // recovery window and ops treat it as gone, and a tombstoned admin must not
    // keep receiving mail from a workspace they were removed from (the same rule
    // the fan-out applies to email addresses).
    const company = await db.company.findFirst({
      where: { id: alert.companyId, deletedAt: null },
      select: {
        name: true,
        users: { where: { role: "admin", deletedAt: null }, select: { id: true } },
      },
    });
    if (!company || company.users.length === 0) return { notified: 0 };

    const copy = billingAlertCopy(alert.kind, {
      workspaceName: company.name,
      accessEndsAt: alert.accessEndsAt ?? null,
      formatDate,
    });

    // `event:` stays the FIRST property and a string literal: the structural
    // guard in tests/lib/notify/fan-out-sites.test.ts matches on exactly that
    // shape, and a computed event name would slip past it.
    return await notifyUsers({
      event: "team_change",
      userIds: company.users.map((u) => u.id),
      companyId: alert.companyId,
      title: copy.title,
      message: copy.message,
      // "system", not "finance": this is about the subscription behind the
      // workspace, not a transaction inside it, and the /notifications finance
      // filter is for workspace money.
      category: "system",
      tone: copy.tone,
      link: copy.link,
    });
  } catch (e) {
    captureServerError(e, {
      action: "notifyWorkspaceAdmins",
      companyId: alert.companyId,
      extra: { kind: alert.kind },
    });
    return { notified: 0 };
  }
}

/**
 * Which lifecycle events are worth an alert, and which are routine.
 *
 * `subscription_payment_success` is deliberately absent: it fires on every
 * successful renewal, and a monthly "we charged your card" notification is how
 * people mute a product. The receipt LemonSqueezy emails is the right channel for
 * that. Only the exceptions reach a human here.
 */
export function billingAlertForEvent(eventName: string): BillingAlertKind | null {
  switch (eventName) {
    case "subscription_payment_failed":
      return "payment_failed";
    case "subscription_payment_recovered":
      return "payment_recovered";
    case "subscription_cancelled":
      return "cancelled";
    case "subscription_expired":
      return "expired";
    default:
      return null;
  }
}
