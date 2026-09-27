/**
 * bill-004 / bill-005 - "paid until someone remembers to switch it off".
 *
 * THE BUGS THESE ENCODE.
 *
 * bill-004. `Company.plan` was written by exactly one thing (the LemonSqueezy
 * webhook) and read by the member-limit gate, and NOTHING anywhere compared
 * `currentPeriodEnd` to today. `PAID_STATUSES` contained "cancelled" and
 * "past_due", so both mapped to plan="team" with no upper bound. Lose the one
 * `subscription_expired` delivery - a silent 200 on an unresolvable event
 * (bill-008), an endpoint that was down, a 500 retry that ran out - and the
 * workspace keeps Team for ever, free, with no in-app way to correct it
 * because `plan` has no other writer.
 *
 * bill-005. The same collapsed column was rendered as `Renews {date}` for
 * every status. `currentPeriodEnd` is `ends_at ?? renews_at`, and `ends_at` is
 * set precisely WHEN THE SUBSCRIPTION HAS BEEN CANCELLED - so the cancelled
 * case, the one where the date means "access stops", was the one case
 * guaranteed to be labelled "you will be charged again".
 *
 * THE RULE THESE TESTS PIN. Paid access is a function of (plan, status, date,
 * now) - never of `plan` alone. `effectivePlan` is that function, and the copy
 * on the billing screen comes from `describeBillingPeriod` so the sentence and
 * the entitlement can never disagree.
 *
 * `now` is INJECTED into every case, never defaulted. A date test that reads
 * the wall clock passes for the wrong reason six months later, and this repo
 * has already shipped tests made vacuous by an unpinned clock (which is why
 * the suite runs under `TZ=America/Bogota`). Every instant here is explicit
 * UTC, so the pinned zone cannot change an outcome either.
 */

import { describe, expect, it } from "vitest";
import {
  ACCESS_GRACE_DAYS,
  accessGraceDays,
  describeBillingPeriod,
  effectivePlan,
  FREE_MEMBER_LIMIT,
  isPaidSubscriptionStatus,
  isTerminalSubscriptionStatus,
  memberLimitForCompany,
  memberLimitForPlan,
  paidAccessEndsAt,
} from "@/lib/billing/plan";

const NOW = new Date("2026-09-26T12:00:00Z");
/** Days before/after NOW, as an instant. */
function days(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}
/** ISO-8601, the way a date reaches the browser through getBillingSummary. */
function iso(d: Date): string {
  return d.toISOString();
}

describe("subscription status vocabulary", () => {
  it("treats the four entitling statuses as paid and nothing else", () => {
    for (const s of ["active", "on_trial", "past_due", "cancelled"]) {
      expect(isPaidSubscriptionStatus(s), s).toBe(true);
    }
    for (const s of ["expired", "unpaid", "paused", "", "ACTIVE", null, undefined]) {
      expect(isPaidSubscriptionStatus(s), String(s)).toBe(false);
    }
  });

  it("treats expired and unpaid as terminal - a subscription cannot come back from either", () => {
    // LemonSqueezy mints a NEW subscription when someone resubscribes after
    // expiry, so "expired" on a given subscription id is final. "unpaid" is
    // dunning-exhausted and goes the same way. This is what makes a replayed
    // `active` for that same id refusable (bill-002).
    expect(isTerminalSubscriptionStatus("expired")).toBe(true);
    expect(isTerminalSubscriptionStatus("unpaid")).toBe(true);
    expect(isTerminalSubscriptionStatus("cancelled")).toBe(false);
    expect(isTerminalSubscriptionStatus("past_due")).toBe(false);
    expect(isTerminalSubscriptionStatus(null)).toBe(false);
  });

  it("gives past_due the longest grace and cancelled almost none", () => {
    // The asymmetry is the point. `past_due` means LemonSqueezy is still
    // retrying the card, so revoking on the day the period ends would cut off
    // a customer who is about to pay. `cancelled` carries an exact `ends_at`,
    // so its only slack is for clock/timezone skew.
    expect(accessGraceDays("past_due")).toBeGreaterThan(accessGraceDays("active"));
    expect(accessGraceDays("active")).toBeGreaterThan(accessGraceDays("cancelled"));
    expect(ACCESS_GRACE_DAYS.past_due).toBe(14);
    // An unknown status gets the stingy default, not the generous one.
    expect(accessGraceDays("something_new")).toBe(accessGraceDays("cancelled"));
  });
});

describe("effectivePlan - bill-004", () => {
  it("keeps a live subscription on Team", () => {
    expect(
      effectivePlan({ plan: "team", subscriptionStatus: "active", currentPeriodEnd: days(20) }, NOW)
    ).toBe("team");
  });

  it("keeps a cancelled subscription on Team until its access date", () => {
    // Paid through the end of the month, cancelled mid-month: they keep what
    // they bought. This is the case lib/billing/plan.ts's header warns about.
    expect(
      effectivePlan(
        { plan: "team", subscriptionStatus: "cancelled", currentPeriodEnd: days(9) },
        NOW
      )
    ).toBe("team");
  });

  it("DROPS a cancelled subscription to free once the access date has passed", () => {
    // THE BUG: 45 days past `ends_at` and `plan` still said "team", for ever.
    expect(
      effectivePlan(
        { plan: "team", subscriptionStatus: "cancelled", currentPeriodEnd: days(-45) },
        NOW
      )
    ).toBe("free");
  });

  it("DROPS a long-unpaid card to free once the dunning window is over", () => {
    // 60 days past_due is not a payment problem any more, it is a non-customer.
    expect(
      effectivePlan(
        { plan: "team", subscriptionStatus: "past_due", currentPeriodEnd: days(-60) },
        NOW
      )
    ).toBe("free");
  });

  it("does NOT drop a card that only just failed - that is the grace window", () => {
    expect(
      effectivePlan(
        { plan: "team", subscriptionStatus: "past_due", currentPeriodEnd: days(-3) },
        NOW
      )
    ).toBe("team");
  });

  it("does NOT drop an active subscription whose renewal webhook is a few hours late", () => {
    // Renewal charges and their webhooks are not simultaneous. Revoking the
    // instant `renews_at` passes would flip a paying customer to free for the
    // gap - a self-inflicted outage, and the exact over-correction this test
    // exists to prevent.
    expect(
      effectivePlan({ plan: "team", subscriptionStatus: "active", currentPeriodEnd: days(-1) }, NOW)
    ).toBe("team");
  });

  it("ignores the date entirely for a terminal status", () => {
    // An expired subscription is free even if some stale `renews_at` is still
    // in the future, because `expired` cannot be recovered from.
    expect(
      effectivePlan(
        { plan: "team", subscriptionStatus: "expired", currentPeriodEnd: days(30) },
        NOW
      )
    ).toBe("free");
  });

  it("leaves a Team workspace with no period end alone", () => {
    // Seeded / hand-granted workspaces have no billing dates at all. There is
    // nothing to compare to, so the only safe reading is "still paid" - the
    // alternative silently de-licenses the demo workspace and anyone the
    // operator comped.
    expect(
      effectivePlan({ plan: "team", subscriptionStatus: null, currentPeriodEnd: null }, NOW)
    ).toBe("team");
  });

  it("never upgrades: a free workspace stays free whatever the dates say", () => {
    expect(
      effectivePlan({ plan: "free", subscriptionStatus: "active", currentPeriodEnd: days(30) }, NOW)
    ).toBe("free");
  });

  it("accepts an ISO string, because that is what reaches the client", () => {
    // getBillingSummary serialises currentPeriodEnd with toISOString().
    expect(
      effectivePlan(
        { plan: "team", subscriptionStatus: "cancelled", currentPeriodEnd: iso(days(-45)) },
        NOW
      )
    ).toBe("free");
  });

  it("treats an unparseable stored date as no date rather than as 1970", () => {
    // `new Date("nonsense")` is an Invalid Date whose getTime() is NaN, and
    // every comparison against NaN is false - so a naive `< now` check would
    // quietly KEEP access. Refuse to guess: fall back to unbounded.
    expect(
      paidAccessEndsAt({ plan: "team", subscriptionStatus: "active", currentPeriodEnd: "nope" })
    ).toBeNull();
  });
});

describe("memberLimitForCompany - the gate bill-004 actually leaks through", () => {
  it("caps a lapsed Team workspace at the free member limit", () => {
    expect(
      memberLimitForCompany(
        { plan: "team", subscriptionStatus: "cancelled", currentPeriodEnd: days(-45) },
        NOW
      )
    ).toBe(FREE_MEMBER_LIMIT);
  });

  it("leaves a live Team workspace uncapped", () => {
    expect(
      memberLimitForCompany(
        { plan: "team", subscriptionStatus: "active", currentPeriodEnd: days(20) },
        NOW
      )
    ).toBe(Infinity);
  });

  it("agrees with the plan-only helper whenever there is no date to check", () => {
    // memberLimitForPlan stays - plenty of callers only have a plan string -
    // but it must not disagree with the time-aware one on the unbounded case.
    expect(
      memberLimitForCompany({ plan: "team", subscriptionStatus: null, currentPeriodEnd: null }, NOW)
    ).toBe(memberLimitForPlan("team"));
  });
});

describe("describeBillingPeriod - bill-005", () => {
  /** Stand-in for lib/utils formatDate, so this module stays DOM-free. */
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  it("says Renews only for a subscription that will actually renew", () => {
    const notice = describeBillingPeriod(
      { plan: "team", subscriptionStatus: "active", currentPeriodEnd: days(20) },
      fmt,
      NOW
    );
    expect(notice?.text).toBe("Renews 2026-10-16");
    expect(notice?.tone).toBe("neutral");
  });

  it("NEVER says Renews for a cancelled subscription - it says when access ends", () => {
    // THE BUG, in one assertion. `ends_at` is set only on cancellation, so
    // "Renews <ends_at>" is a false statement about money on the one screen
    // where a customer looks for the truth about money.
    const future = describeBillingPeriod(
      { plan: "team", subscriptionStatus: "cancelled", currentPeriodEnd: days(9) },
      fmt,
      NOW
    );
    expect(future?.text).not.toMatch(/renews/i);
    expect(future?.text).toBe("Cancelled - access ends 2026-10-05");
    expect(future?.tone).toBe("warning");

    const past = describeBillingPeriod(
      { plan: "team", subscriptionStatus: "cancelled", currentPeriodEnd: days(-45) },
      fmt,
      NOW
    );
    expect(past?.text).not.toMatch(/renews/i);
    expect(past?.text).toBe("Subscription ended 2026-08-12 - upgrade to restore Team features");
    expect(past?.tone).toBe("danger");
  });

  it("tells a past-due customer their card failed, with the deadline", () => {
    const notice = describeBillingPeriod(
      { plan: "team", subscriptionStatus: "past_due", currentPeriodEnd: days(-3) },
      fmt,
      NOW
    );
    expect(notice?.text).toMatch(/payment failed/i);
    expect(notice?.needsAction).toBe(true);
    expect(notice?.tone).toBe("danger");
    expect(notice?.text).not.toMatch(/renews/i);
  });

  it("says paused, not renews, while a subscription is paused", () => {
    const notice = describeBillingPeriod(
      { plan: "team", subscriptionStatus: "paused", currentPeriodEnd: days(12) },
      fmt,
      NOW
    );
    expect(notice?.text).toBe("Paused - resumes 2026-10-08");
    expect(notice?.text).not.toMatch(/renews/i);
  });

  it("falls back to the feature line when a Team workspace has no dates", () => {
    const notice = describeBillingPeriod(
      { plan: "team", subscriptionStatus: null, currentPeriodEnd: null },
      fmt,
      NOW
    );
    expect(notice?.text).toBe("Unlimited members + paid features");
  });

  it("returns null for a workspace that has never subscribed", () => {
    // The upgrade pitch on the free plan is marketing copy that belongs in the
    // settings component with FREE_MEMBER_LIMIT, not in a billing module.
    // Returning null says "you own this sentence" rather than inventing one.
    expect(
      describeBillingPeriod(
        { plan: "free", subscriptionStatus: null, currentPeriodEnd: null },
        fmt,
        NOW
      )
    ).toBeNull();
  });

  it("does not say Renews for ANY status - the property, not nine examples", () => {
    // Belt and braces over the switch: whatever statuses LemonSqueezy grows,
    // only the two that genuinely renew may use that word.
    const renewing = ["active", "on_trial"];
    const statuses = [
      "active",
      "on_trial",
      "past_due",
      "cancelled",
      "paused",
      "unpaid",
      "expired",
      "something_new",
    ];
    for (const status of statuses) {
      for (const end of [days(9), days(-45)]) {
        const notice = describeBillingPeriod(
          { plan: "team", subscriptionStatus: status, currentPeriodEnd: end },
          fmt,
          NOW
        );
        const saysRenews = /renews/i.test(notice?.text ?? "");
        expect(
          saysRenews,
          `status=${status} end=${iso(end)} -> ${JSON.stringify(notice?.text)}`
        ).toBe(renewing.indexOf(status) !== -1 && end.getTime() > NOW.getTime());
      }
    }
  });
});
