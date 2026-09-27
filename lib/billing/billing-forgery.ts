/**
 * Alerting for everything the LemonSqueezy webhook must never do QUIETLY.
 *
 * It started as one thing - applying a payment to a workspace the payer does not
 * own - and the P1 audit added three more, all of which had exactly the same
 * shape: the route made a decision with real money behind it and returned
 * `{ received: true }` with no log line, no Sentry event and no row. Every helper
 * here exists because the alternative was silence.
 *
 * Separate from lib/billing/webhook-identity.ts so that module stays pure and
 * I/O-free (and therefore trivially unit-testable). Shaped like
 * lib/safety/bulk-mutation-guard.ts: a dedicated module whose only job is to
 * tag one `boundary` consistently, so a single Sentry alert rule can page
 * on-call on it.
 *
 * FOUR BOUNDARIES, deliberately distinct, alongside `server-action`,
 * `bulk-mutation`, `app-route` and `global`. They are split by what an operator
 * should DO about them, which is the only useful way to split an alert:
 *
 *   billing-forgery       error   PAGE. Never expected. A takeover attempt
 *                                 against a paying workspace, or a checkout link
 *                                 being driven by hand.
 *   billing-unplaced      error   PAGE. A real payment we could not attach to
 *                                 any workspace (bill-008). Money in, nothing
 *                                 delivered. Only a human can fix it.
 *   billing-stale-event   warning WATCH. A delivery we refused as a replay or as
 *                                 out-of-order (bill-002/003). Expected
 *                                 occasionally - LemonSqueezy retries - but a
 *                                 cluster means something is genuinely wrong.
 *   billing-out-of-scope  warning WATCH. Test-mode, another store, or a product
 *                                 that buys no plan here (bill-006). Ordinary
 *                                 noise one at a time; on a live deployment a
 *                                 run of them means the store is misconfigured.
 *
 * captureException vs captureMessage is chosen by that same table, not by taste:
 * the two PAGE boundaries are error-level issues that should group and alert, the
 * two WATCH boundaries are warnings to skim.
 *
 * None of these ever throws. The caller has already decided what HTTP status to
 * answer, and a misbehaving Sentry client must not turn that into a 500 - which
 * for a forged or unplaceable event would make LemonSqueezy retry it for ever.
 */

import * as Sentry from "@sentry/nextjs";
import { captureServerError } from "@/lib/sentry-server";

export interface BillingForgeryContext {
  /** LemonSqueezy event name, e.g. subscription_created. */
  eventName: string;
  /** The rejection reason from `decideWebhookCompany`. */
  reason: string;
  /** The workspace id the BUYER claimed via checkout custom data. Untrusted. */
  claimedCompanyId: string | null;
  /** Provider-assigned ids, safe to record. */
  subscriptionId: string | null;
  customerId: string | null;
}

/**
 * Report a webhook whose payload tried to bind a subscription to a workspace it
 * has no claim on. Never throws - the caller has already decided to answer 400,
 * and a misbehaving Sentry client must not turn that into a 500 (which would
 * make LemonSqueezy retry a forged event indefinitely).
 */
export function captureBillingForgery(ctx: BillingForgeryContext): void {
  try {
    Sentry.captureException(
      new Error(`Billing webhook identity rejected (${ctx.reason}): ${ctx.eventName}`),
      {
        level: "error",
        tags: {
          boundary: "billing-forgery",
          action: "lemonSqueezyWebhook",
          reason: ctx.reason,
          // The CLAIMED id, not a verified one - tagged so triage can see at a
          // glance which workspace was being aimed at, and check whether it is
          // a real paying customer who needs telling.
          ...(ctx.claimedCompanyId ? { claimedCompanyId: ctx.claimedCompanyId } : {}),
        },
        extra: {
          eventName: ctx.eventName,
          reason: ctx.reason,
          claimedCompanyId: ctx.claimedCompanyId,
          subscriptionId: ctx.subscriptionId,
          customerId: ctx.customerId,
        },
      }
    );
  } catch (err) {
    // Same defensive fallback as warnBulkMutation: fall through to the local
    // capture helper, which no-ops without SENTRY_DSN and still console.errors
    // so the event survives in the Vercel function log.
    captureServerError(err, { action: "captureBillingForgery" });
  }
}

/** Shared shape for the three non-forgery reports. */
export interface BillingEventContext {
  eventName: string;
  /** Why we did not apply it. A machine-ish slug, tagged for grouping. */
  reason: string;
  /** Provider-assigned ids, safe to record. */
  subscriptionId: string | null;
  customerId: string | null;
  /** The workspace, once one has been resolved. */
  companyId?: string | null;
  extra?: Record<string, unknown>;
}

/**
 * A subscription event we could not attach to any workspace. bill-008.
 *
 * THE BUG THIS CLOSES. The route was `if (companyId) { ...update... }` with no
 * else, then `return NextResponse.json({ received: true })`. Three ways to land
 * there - no custom_data and an unknown customer id, a custom_data company_id
 * naming a workspace that no longer exists, or a workspace whose
 * billingCustomerId had been nulled by bill-007 - and all three answered HTTP
 * 200. LemonSqueezy marks a 200 delivered and never retries, so the event was
 * simply gone: the customer's card was charged, their workspace stayed on "Solo
 * (Free)" capped at 2 members, and support had literally nothing to look at.
 * `captureServerError` was only reachable from the catch block, so none of it was
 * logged. The same silence hid lost DOWNGRADES, which is the other half of
 * bill-004's revenue leak.
 *
 * Error level and its own boundary because this is the one class here that
 * always means somebody has paid for something they did not get.
 */
export function reportUnplaceableBillingEvent(ctx: BillingEventContext): void {
  try {
    Sentry.captureException(
      new Error(`Billing event could not be placed (${ctx.reason}): ${ctx.eventName}`),
      {
        level: "error",
        tags: {
          boundary: "billing-unplaced",
          action: "lemonSqueezyWebhook",
          reason: ctx.reason,
          ...(ctx.companyId ? { companyId: ctx.companyId } : {}),
        },
        extra: {
          eventName: ctx.eventName,
          reason: ctx.reason,
          subscriptionId: ctx.subscriptionId,
          customerId: ctx.customerId,
          companyId: ctx.companyId ?? null,
          ...ctx.extra,
        },
      }
    );
  } catch (err) {
    captureServerError(err, { action: "reportUnplaceableBillingEvent" });
  }
}

/**
 * A delivery we deliberately did not apply: a replay of a dead subscription, or
 * an out-of-order redelivery that would have overwritten newer state.
 * bill-002 / bill-003.
 *
 * Warning, not error, and that is a considered choice. LemonSqueezy's own retry
 * behaviour produces these legitimately - the route answers 500 on transient
 * failures ON PURPOSE so it retries - so paging on one would train on-call to
 * ignore the boundary. What matters is the SHAPE: a cluster against one
 * subscription means a delivery is stuck in a retry loop, and a
 * `replay-after-terminal` on a subscription nobody is retrying means somebody is
 * re-POSTing captured bytes.
 *
 * Until the delivered-event ledger exists (a new table; see the follow-ups) this
 * breadcrumb IS the audit trail for skipped writes. Which is precisely why it is
 * unconditional rather than sampled.
 */
export function reportSkippedBillingWrite(ctx: BillingEventContext): void {
  try {
    Sentry.captureMessage(`Billing write skipped (${ctx.reason}): ${ctx.eventName}`, {
      level: "warning",
      tags: {
        boundary: "billing-stale-event",
        action: "lemonSqueezyWebhook",
        reason: ctx.reason,
        ...(ctx.companyId ? { companyId: ctx.companyId } : {}),
      },
      extra: {
        eventName: ctx.eventName,
        reason: ctx.reason,
        subscriptionId: ctx.subscriptionId,
        customerId: ctx.customerId,
        companyId: ctx.companyId ?? null,
        ...ctx.extra,
      },
    });
  } catch (err) {
    captureServerError(err, { action: "reportSkippedBillingWrite" });
  }
}

/**
 * An event that is not about anything we sell: test mode on a live deployment,
 * another store, or a product/variant that buys no plan here. bill-006.
 *
 * Worth recording even though we are right to ignore it. One at a time this is
 * noise; a run of `test-mode` on a live deployment means the store was left in
 * test mode after go-live (which used to mint free Team workspaces), and a run of
 * `foreign-variant` means a new product shipped without a plan mapping - so the
 * customers buying it are being refused.
 */
export function reportOutOfScopeBillingEvent(ctx: BillingEventContext): void {
  try {
    Sentry.captureMessage(`Billing event out of scope (${ctx.reason}): ${ctx.eventName}`, {
      level: "warning",
      tags: {
        boundary: "billing-out-of-scope",
        action: "lemonSqueezyWebhook",
        reason: ctx.reason,
      },
      extra: {
        eventName: ctx.eventName,
        reason: ctx.reason,
        subscriptionId: ctx.subscriptionId,
        customerId: ctx.customerId,
        ...ctx.extra,
      },
    });
  } catch (err) {
    captureServerError(err, { action: "reportOutOfScopeBillingEvent" });
  }
}
