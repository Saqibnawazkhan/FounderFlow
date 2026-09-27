/**
 * What we say to a workspace admin when their billing changes. (bill-018)
 *
 * THE TRAP THIS EXISTS TO AVOID. `SUB_EVENTS` held the seven `subscription_*`
 * lifecycle events and nothing else, so `subscription_payment_failed`,
 * `_payment_success` and `_payment_recovered` fell straight through to
 * `return NextResponse.json({ received: true })`. This app has a full
 * notification fan-out with a per-event preferences matrix
 * (lib/notify/fan-out.ts) and billing used none of it — a grep for
 * notify/Notification under lib/billing, lib/lemonsqueezy and the webhook route
 * returned nothing at all.
 *
 * So when a customer's card was declined, the only warning anybody got was
 * whatever email LemonSqueezy sent to the CARD-HOLDER's address — which need not
 * be the workspace admin, because checkout lets the buyer type any email. Then
 * the subscription expired, the workspace silently dropped to free, and nothing
 * explained why invites had stopped working. Involuntary churn is the largest
 * recoverable revenue loss in a subscription business, and this made it
 * invisible.
 *
 * WHY THE COPY IS A SEPARATE, PURE MODULE. Same split as
 * webhook-identity / billing-forgery: `lib/billing/billing-notify.ts` touches
 * Prisma and the fan-out, so importing it into a test instantiates a Prisma
 * client. Everything a test needs to assert lives here instead.
 *
 * `formatDate` is injected rather than imported, for the same reason as in
 * lib/billing/plan.ts: `lib/utils` reaches for the DOM, and this module has to
 * stay safe wherever the webhook runs.
 */

import { FREE_MEMBER_LIMIT } from "@/lib/billing/plan";
import type { NotifyTone } from "@/lib/notify/events";

/** The billing moments worth interrupting an admin for. */
export const BILLING_ALERT_KINDS = [
  "payment_failed",
  "payment_recovered",
  "cancelled",
  "expired",
] as const;

export type BillingAlertKind = (typeof BILLING_ALERT_KINDS)[number];

export interface BillingAlertCopy {
  title: string;
  message: string;
  tone: NotifyTone;
  /**
   * In-app path, never an external URL. `Notification.link` is fed to the app
   * router and to web push, and `/settings` is where the "Manage billing" button
   * that opens the real LemonSqueezy portal lives. The payload does carry
   * `attributes.urls.update_payment_method`, which would be one click shorter —
   * but there is nowhere to persist it (no column) and pushing an off-site
   * absolute URL through the in-app link is a separate decision; see the
   * follow-ups.
   */
  link: string;
}

export interface BillingAlertOptions {
  /** The workspace name, when the caller has it. Copy must read without it. */
  workspaceName?: string | null;
  /** When paid access stops (or stopped). Copy must read without it. */
  accessEndsAt?: Date | null;
  formatDate: (date: Date) => string;
}

export function billingAlertCopy(
  kind: BillingAlertKind,
  opts: BillingAlertOptions
): BillingAlertCopy {
  // One admin can own several workspaces, so "your subscription" is useless to
  // them — name the workspace whenever we know it. The fallback has to be a
  // noun phrase that reads in the middle of a sentence, because the webhook does
  // not always have the name.
  const ws = opts.workspaceName ? opts.workspaceName : "your workspace";
  const when = opts.accessEndsAt ? opts.formatDate(opts.accessEndsAt) : null;

  switch (kind) {
    case "payment_failed":
      return {
        title: "Payment failed",
        message: when
          ? `We couldn't charge the card on file for ${ws}. Update it by ${when} to keep Team features.`
          : `We couldn't charge the card on file for ${ws}. Update it to keep Team features.`,
        tone: "danger",
        link: "/settings?billing=past_due",
      };

    case "payment_recovered":
      return {
        title: "Payment went through",
        message: `The card on file for ${ws} was charged successfully. Team features stay on.`,
        tone: "success",
        link: "/settings",
      };

    case "cancelled":
      // Deliberately never the word "renew" in any form. Saying it here is
      // bill-005 wearing a different hat: the date on a cancellation is when
      // access STOPS, and calling it a renewal is a false statement about money.
      return {
        title: "Subscription cancelled",
        message: when
          ? `Team features for ${ws} stay on until ${when}. After that it drops to the free plan, capped at ${FREE_MEMBER_LIMIT} members.`
          : `Team features for ${ws} stay on until the end of the current period, then it drops to the free plan, capped at ${FREE_MEMBER_LIMIT} members.`,
        tone: "warning",
        link: "/settings",
      };

    case "expired":
      // This is the sentence that answers bill-013's other half: the team page
      // starts refusing invites and nothing anywhere says why.
      return {
        title: "Subscription ended",
        message: when
          ? `Team features are off for ${ws} as of ${when} - it's back on the free plan, capped at ${FREE_MEMBER_LIMIT} members. Upgrade any time to restore them.`
          : `Team features are off for ${ws} - it's back on the free plan, capped at ${FREE_MEMBER_LIMIT} members. Upgrade any time to restore them.`,
        tone: "warning",
        link: "/settings",
      };
  }
}
