/**
 * bill-002 / bill-003 / bill-007 - "last writer wins, for ever".
 *
 * THE BUGS THESE ENCODE.
 *
 * bill-002 (replay). The webhook applied whatever it was handed, every time it
 * was handed it. There is no delivered-event ledger, and a LemonSqueezy
 * signature never expires, so one captured `active` delivery - from a proxy
 * log, an ngrok tunnel, a Sentry breadcrumb, or the dashboard's own "resend"
 * button - was a permanent free Team licence: re-POST it after
 * `subscription_expired` and the workspace flipped back to paid.
 *
 * bill-003 (out of order). Same root cause seen without an attacker. The
 * handler 500s on a transient failure *on purpose* so LemonSqueezy retries, so
 * it deliberately manufactures delayed redeliveries. A customer whose
 * `subscription_expired` 500s, who then resubscribes, gets knocked back to free
 * when the backoff finally lands the old expiry - and `billingSubscriptionId`
 * is repointed at the dead subscription, so their "Manage billing" button
 * resolves a subscription that no longer exists.
 *
 * bill-007 (absent means NULL). Every column was written on every event:
 * `currentPeriodEnd: periodEnd ? new Date(periodEnd) : null`. An event that
 * merely omits `renews_at` therefore ERASED the customer's paid-through date,
 * and the same pattern on `billingCustomerId` orphaned the workspace from its
 * subscription entirely.
 *
 * WHAT IS PINNED, AND WHAT IS NOT. A true replay guard needs a ledger of
 * delivered event ids - a new table, which this change may not create. So
 * these rules are built only from state already on the Company row, and they
 * are honest about the residual gap: replaying a delivery that is still CURRENT
 * is not detected here (it is idempotent, so it is also not harmful), and there
 * is no audit trail of what was skipped beyond the Sentry breadcrumb the route
 * raises. The DDL for the ledger is in the follow-ups.
 *
 * `now` is injected everywhere. See tests/lib/billing/subscription-access.test.ts
 * for why that matters in this repo.
 */

import { describe, expect, it } from "vitest";
import {
  decideSubscriptionWrite,
  readPeriodEnd,
  type IncomingSubscriptionEvent,
  type StoredBillingState,
} from "@/lib/billing/subscription-write";

const NOW = new Date("2026-09-26T12:00:00Z");
function days(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}

/** A Company row as the webhook reads it. Never subscribed by default. */
function stored(over: Partial<StoredBillingState> = {}): StoredBillingState {
  return {
    plan: "free",
    subscriptionStatus: null,
    currentPeriodEnd: null,
    billingSubscriptionId: null,
    ...over,
  };
}

/** A subscription event as the route has already parsed it. */
function event(over: Partial<IncomingSubscriptionEvent> = {}): IncomingSubscriptionEvent {
  return {
    subscriptionId: "sub_1",
    status: "active",
    customerId: "cus_1",
    periodEnd: days(30),
    periodEndAbsent: false,
    variantPlan: "team",
    ...over,
  };
}

describe("decideSubscriptionWrite - the happy paths still work", () => {
  it("upgrades an unbound workspace on a first activation", () => {
    const d = decideSubscriptionWrite(stored(), event(), NOW);
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.data).toEqual({
      plan: "team",
      subscriptionStatus: "active",
      billingSubscriptionId: "sub_1",
      billingCustomerId: "cus_1",
      currentPeriodEnd: days(30),
    });
  });

  it("records a cancellation while access continues, keeping the plan paid", () => {
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(9),
        billingSubscriptionId: "sub_1",
      }),
      event({ status: "cancelled", periodEnd: days(9) }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.data.plan).toBe("team");
    expect(d.data.subscriptionStatus).toBe("cancelled");
  });

  it("downgrades on expiry", () => {
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "cancelled",
        currentPeriodEnd: days(0),
        billingSubscriptionId: "sub_1",
      }),
      event({ status: "expired", periodEnd: days(0) }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.data.plan).toBe("free");
  });

  it("lets a plan change rebind the workspace to a NEW subscription id", () => {
    // LemonSqueezy mints a new subscription id on some plan changes, and those
    // events can arrive with no custom_data. This must keep working - the
    // staleness rules below must not become "never rebind".
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(10),
        billingSubscriptionId: "sub_old",
      }),
      event({ subscriptionId: "sub_new", periodEnd: days(40) }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.data.billingSubscriptionId).toBe("sub_new");
  });
});

describe("bill-002 - a replayed delivery cannot resurrect a dead subscription", () => {
  it("REFUSES a paid status for a subscription already recorded as expired", () => {
    // The captured-delivery attack: keep the bytes of the original `active`
    // event, wait for the workspace to expire, re-POST. The signature is still
    // valid and always will be.
    const d = decideSubscriptionWrite(
      stored({
        plan: "free",
        subscriptionStatus: "expired",
        currentPeriodEnd: days(-2),
        billingSubscriptionId: "sub_1",
      }),
      event({ status: "active", periodEnd: days(28) }),
      NOW
    );
    expect(d.apply).toBe(false);
    if (d.apply) return;
    expect(d.reason).toBe("replay-after-terminal");
  });

  it("REFUSES it for `unpaid` too, which is the other one-way door", () => {
    const d = decideSubscriptionWrite(
      stored({ subscriptionStatus: "unpaid", billingSubscriptionId: "sub_1" }),
      event({ status: "active" }),
      NOW
    );
    expect(d.apply).toBe(false);
  });

  it("still accepts a LATER terminal event for an expired subscription", () => {
    // `subscription_expired` arriving twice, or `unpaid` after `expired`, must
    // not be refused: neither restores access, and refusing them would leave
    // the stored status behind the truth.
    const d = decideSubscriptionWrite(
      stored({ subscriptionStatus: "expired", billingSubscriptionId: "sub_1" }),
      event({ status: "expired", periodEnd: days(-2) }),
      NOW
    );
    expect(d.apply).toBe(true);
  });

  it("is idempotent for a replay of the CURRENT delivery", () => {
    // Honest about the residual gap: without an event-id ledger a replay of a
    // still-current event is indistinguishable from the original. It is applied
    // again - and that is harmless, because it writes the same values.
    const now = stored({
      plan: "team",
      subscriptionStatus: "active",
      currentPeriodEnd: days(30),
      billingSubscriptionId: "sub_1",
    });
    const first = decideSubscriptionWrite(now, event(), NOW);
    const second = decideSubscriptionWrite(now, event(), NOW);
    expect(first).toEqual(second);
    expect(first.apply).toBe(true);
  });

  it("REFUSES to grant paid access from an event whose own period has passed", () => {
    // This is the second, date-based half of the replay guard, and it is the
    // one that does not need any stored state at all: a replayed `active`
    // carries the OLD `renews_at`, so by the time replaying it is worth
    // anything, the date it claims to be paid through is in the past.
    const d = decideSubscriptionWrite(
      stored({ plan: "free", subscriptionStatus: null, billingSubscriptionId: null }),
      event({ status: "active", periodEnd: days(-40) }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.data.plan).toBe("free");
    expect(d.lapsed).toBe(true);
  });
});

describe("bill-003 - a late redelivery cannot overwrite newer state", () => {
  it("REFUSES an expiry for a subscription the workspace is no longer bound to", () => {
    // The exact sequence from the finding. sub_10 expired, the delivery 500'd,
    // the customer resubscribed as sub_11, then the backoff landed the old
    // expiry. An `expired` for sub_10 cannot possibly be a statement about
    // sub_11, whatever order it arrives in.
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(30),
        billingSubscriptionId: "sub_11",
      }),
      event({ subscriptionId: "sub_10", status: "expired", periodEnd: days(-2) }),
      NOW
    );
    expect(d.apply).toBe(false);
    if (d.apply) return;
    expect(d.reason).toBe("superseded-subscription");
  });

  it("REFUSES a takeover that would move the paid-through date BACKWARDS", () => {
    // The non-terminal version: a stale `cancelled` for the old subscription,
    // whose ends_at predates what we already hold.
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(30),
        billingSubscriptionId: "sub_11",
      }),
      event({ subscriptionId: "sub_10", status: "cancelled", periodEnd: days(3) }),
      NOW
    );
    expect(d.apply).toBe(false);
    if (d.apply) return;
    expect(d.reason).toBe("superseded-subscription");
  });

  it("REFUSES a takeover that carries no date at all to be judged on", () => {
    // A rebinding is the one write that destroys information (the old
    // binding), so an event that gives us nothing to compare does not get to
    // do it. The route reports the skip, which is how a genuine case surfaces.
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(30),
        billingSubscriptionId: "sub_11",
      }),
      event({ subscriptionId: "sub_10", status: "active", periodEnd: null, periodEndAbsent: true }),
      NOW
    );
    expect(d.apply).toBe(false);
  });

  it("ALLOWS a new subscription once the old one is terminal", () => {
    // Resubscribing after expiry is the ordinary case and must not be blocked.
    const d = decideSubscriptionWrite(
      stored({
        plan: "free",
        subscriptionStatus: "expired",
        currentPeriodEnd: days(-2),
        billingSubscriptionId: "sub_10",
      }),
      event({ subscriptionId: "sub_11", status: "active", periodEnd: days(30) }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect(d.data.plan).toBe("team");
    expect(d.data.billingSubscriptionId).toBe("sub_11");
  });

  it("never proposes a null billingSubscriptionId", () => {
    // An unbound workspace is the most attractive forgery target there is
    // (see lib/billing/webhook-identity.ts). Whatever else a decision does,
    // it must never be the thing that unbinds a workspace.
    const cases: IncomingSubscriptionEvent[] = [
      event(),
      event({ status: "expired", periodEnd: days(-1) }),
      event({ status: "cancelled", periodEnd: days(5) }),
      event({ customerId: null }),
      event({ periodEnd: null, periodEndAbsent: true }),
    ];
    for (const e of cases) {
      const d = decideSubscriptionWrite(stored(), e, NOW);
      if (!d.apply) continue;
      expect(d.data.billingSubscriptionId, e.status).toBe(e.subscriptionId);
    }
  });
});

describe("bill-007 - absent must mean unchanged, not NULL", () => {
  it("omits currentPeriodEnd entirely when the payload carried no period keys", () => {
    // `subscription_updated` with `renews_at` and `ends_at` deleted used to
    // NULL the column, destroying the only record of what the customer paid
    // through - and the Plan section then fell back to a cheerful
    // "Unlimited members + paid features".
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(30),
        billingSubscriptionId: "sub_1",
      }),
      event({ periodEnd: null, periodEndAbsent: true }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect("currentPeriodEnd" in d.data).toBe(false);
  });

  it("omits billingCustomerId when the payload carried no customer_id", () => {
    // billingCustomerId is the last-resort anchor the identity resolver falls
    // back to. Nulling it orphans the workspace from its subscription for good:
    // every later event without custom_data becomes unresolvable, so the
    // workspace never downgrades and never updates again.
    const d = decideSubscriptionWrite(
      stored({ billingSubscriptionId: "sub_1", subscriptionStatus: "active", plan: "team" }),
      event({ customerId: null }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect("billingCustomerId" in d.data).toBe(false);
  });

  it("DOES clear currentPeriodEnd when the payload sent the keys as null", () => {
    // Present-and-null is a statement ("there is no next date"); absent is
    // silence. Conflating them in either direction is a bug, so pin both.
    const d = decideSubscriptionWrite(
      stored({
        plan: "team",
        subscriptionStatus: "active",
        currentPeriodEnd: days(30),
        billingSubscriptionId: "sub_1",
      }),
      event({ status: "expired", periodEnd: null, periodEndAbsent: false }),
      NOW
    );
    expect(d.apply).toBe(true);
    if (!d.apply) return;
    expect("currentPeriodEnd" in d.data).toBe(true);
    expect(d.data.currentPeriodEnd).toBeNull();
  });
});

describe("readPeriodEnd - where bill-007's absent-vs-null distinction is made", () => {
  it("prefers ends_at, because it is only set once a subscription is cancelled", () => {
    const r = readPeriodEnd({
      ends_at: "2026-10-05T00:00:00Z",
      renews_at: "2026-11-05T00:00:00Z",
    });
    expect(r.absent).toBe(false);
    expect(r.periodEnd?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("falls back to renews_at when ends_at is present but null", () => {
    const r = readPeriodEnd({ ends_at: null, renews_at: "2026-11-05T00:00:00Z" });
    expect(r.absent).toBe(false);
    expect(r.periodEnd?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("reports ABSENT when neither key is in the payload at all", () => {
    // The bill-007 payload: a subscription_updated with the date keys deleted.
    const r = readPeriodEnd({ status: "active" });
    expect(r.absent).toBe(true);
    expect(r.periodEnd).toBeNull();
  });

  it("reports PRESENT-and-null when both keys are there and both null", () => {
    const r = readPeriodEnd({ ends_at: null, renews_at: null });
    expect(r.absent).toBe(false);
    expect(r.periodEnd).toBeNull();
  });

  it("treats an unparseable date as absent rather than as an Invalid Date", () => {
    // `new Date("later")` is an Invalid Date. Handing one to Prisma throws, and
    // the route's catch answers 500 - so LemonSqueezy retries the same
    // unparseable payload on a backoff, for ever. Refusing to parse it means the
    // rest of the event still applies.
    const r = readPeriodEnd({ renews_at: "later" });
    expect(r.absent).toBe(true);
    expect(r.periodEnd).toBeNull();
  });

  it("ignores a non-string date value", () => {
    expect(readPeriodEnd({ renews_at: 1799999999 }).absent).toBe(true);
    expect(readPeriodEnd({ renews_at: {} }).absent).toBe(true);
  });
});

describe("the variant table decides which plan a payment buys (bill-006)", () => {
  it("grants the plan the purchased variant maps to", () => {
    const d = decideSubscriptionWrite(stored(), event({ variantPlan: "team" }), NOW);
    expect(d.apply && d.data.plan).toBe("team");
  });

  it("falls back to team when the deployment has no variant table configured", () => {
    // `variantPlan: null` means "the store/variant ids are not configured, so
    // no mapping was possible" - not "this variant grants nothing". Falling
    // back keeps an unconfigured dev deployment working; the route raises a
    // Sentry error so the gap is visible rather than assumed.
    const d = decideSubscriptionWrite(stored(), event({ variantPlan: null }), NOW);
    expect(d.apply && d.data.plan).toBe("team");
  });
});
