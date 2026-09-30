/**
 * bill-020 — the webhook's plan column was decided by an ALLOW-LIST OF STATUS
 * STRINGS, and the read side was decided by the FUNDED DATE. The two disagreed,
 * and the write side won because it is the only writer.
 *
 * THE ASYMMETRY, stated exactly. `effectivePlan` (lib/billing/plan.ts) only ever
 * takes access away, and it does so for two reasons: a terminal status
 * (`expired` / `unpaid`) or a paid-through date that has passed. It does NOT
 * consult `isPaidSubscriptionStatus`. So on the READ side a `paused`
 * subscription whose date is still in the future keeps Team, exactly as
 * `cancelled` does — and `describeBillingPeriod` has a branch that renders
 * "Paused - resumes {date}" for precisely that state.
 *
 * On the WRITE side, `decideSubscriptionWrite` computed
 * `isPaidSubscriptionStatus(status) && !lapsed ? plan : "free"`. `paused` is not
 * on the allow-list, so `subscription_paused` wrote `plan: "free"` the moment it
 * landed — and `effectivePlan` never grants, so that is permanent until an
 * unpause arrives. Consequences, both of them real:
 *
 *   1. A customer who uses LemonSqueezy's own pause button — offered in the
 *      customer portal this app links to from Settings — loses unlimited seats
 *      the same minute, inside a period they have already paid for. Cancelling
 *      is treated BETTER than pausing, which is backwards: pausing is the
 *      retention outcome.
 *   2. The "Paused - resumes {date}" sentence requires `plan = "team"` AND
 *      `status = "paused"`, a combination the only writer never writes. It is
 *      shipped, unit-tested and unreachable — this repo's signature defect.
 *
 * AND THE HALF THAT IS WORSE THAN PAUSE. Any status LemonSqueezy adds later
 * takes the same path: not on the allow-list, therefore `plan: "free"`, applied
 * silently to every workspace the new status reaches. A provider changing its
 * own vocabulary should never be able to de-licence paying customers, and the
 * old code made that the DEFAULT.
 *
 * WHAT IS DELIBERATELY NOT CHANGED. `isPaidSubscriptionStatus("paused")` stays
 * FALSE — a paused subscription is genuinely not being billed, that predicate
 * means "is money moving", and tests/lib/billing/subscription-access.test.ts
 * pins it. The fix is that the write side no longer derives ENTITLEMENT from
 * that predicate alone: a status that is neither paid nor terminal now HOLDS the
 * stored plan and is reported, instead of revoking. Holding is fail-safe in both
 * directions — it cannot upgrade a free workspace either, which a plain
 * "not terminal → team" rule would have done for an unknown status with no date.
 */

import { describe, it, expect } from "vitest";
import { decideSubscriptionWrite } from "@/lib/billing/subscription-write";
import { effectivePlan, describeBillingPeriod } from "@/lib/billing/plan";
import type { StoredBillingState } from "@/lib/billing/subscription-write";

const NOW = new Date("2026-09-26T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function days(n: number): Date {
  return new Date(NOW.getTime() + n * MS_PER_DAY);
}

/** A live, paying Team workspace on subscription sub_10. */
function payingTeam(overrides: Partial<StoredBillingState> = {}): StoredBillingState {
  return {
    plan: "team",
    subscriptionStatus: "active",
    currentPeriodEnd: days(12),
    billingSubscriptionId: "sub_10",
    ...overrides,
  };
}

/** The event shape the route builds, for the SAME subscription. */
function event(status: string, periodEnd: Date | null) {
  return {
    subscriptionId: "sub_10",
    status,
    customerId: "cus_1",
    periodEnd,
    periodEndAbsent: periodEnd === null,
    variantPlan: "team" as const,
  };
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);

describe("bill-020 — pausing must not revoke a period the customer already paid for", () => {
  it("keeps the paid plan when subscription_paused lands with the period still funded", () => {
    const decision = decideSubscriptionWrite(payingTeam(), event("paused", days(12)), NOW);
    expect(decision.apply).toBe(true);
    if (!decision.apply) return;
    expect(decision.data.plan).toBe("team");
    // The status is still stored verbatim — the billing screen needs it to say
    // "Paused", and the entitlement is bounded by the date, not by the word.
    expect(decision.data.subscriptionStatus).toBe("paused");
  });

  it("treats pausing no worse than cancelling, which is the whole complaint", () => {
    const paused = decideSubscriptionWrite(payingTeam(), event("paused", days(12)), NOW);
    const cancelled = decideSubscriptionWrite(payingTeam(), event("cancelled", days(12)), NOW);
    expect(paused.apply && paused.data.plan).toBe(cancelled.apply && cancelled.data.plan);
  });

  it("makes the 'Paused - resumes' sentence reachable from what the webhook writes", () => {
    // The unreachability proof, run forwards: feed the row the webhook would
    // have written into the copy function and check which branch it lands in.
    const decision = decideSubscriptionWrite(payingTeam(), event("paused", days(12)), NOW);
    expect(decision.apply).toBe(true);
    if (!decision.apply) return;
    const stored = {
      plan: decision.data.plan,
      subscriptionStatus: decision.data.subscriptionStatus,
      currentPeriodEnd: decision.data.currentPeriodEnd ?? null,
    };
    expect(effectivePlan(stored, NOW)).toBe("team");
    expect(describeBillingPeriod(stored, fmt, NOW)?.text).toBe("Paused - resumes 2026-10-08");
  });

  it("still ends paid access once a paused subscription's funded period is over", () => {
    // Pausing buys the rest of the period, not an indefinite free licence. The
    // stingy default grace (1 day) applies, exactly as it does to any status
    // nobody has thought about.
    const decision = decideSubscriptionWrite(payingTeam(), event("paused", days(-3)), NOW);
    expect(decision.apply).toBe(true);
    if (!decision.apply) return;
    expect(decision.data.plan).toBe("free");
  });
});

describe("bill-020 — a status this build has never heard of must not de-licence anyone", () => {
  it("holds the stored paid plan for an unrecognised status inside a funded period", () => {
    const decision = decideSubscriptionWrite(payingTeam(), event("on_dunning_hold", days(12)), NOW);
    expect(decision.apply).toBe(true);
    if (!decision.apply) return;
    expect(decision.data.plan).toBe("team");
  });

  it("flags the unrecognised status so on-call finds out instead of the customer", () => {
    const decision = decideSubscriptionWrite(payingTeam(), event("on_dunning_hold", days(12)), NOW);
    expect(decision.apply).toBe(true);
    if (!decision.apply) return;
    expect(decision.unrecognisedStatus).toBe(true);
    // A status we DO know about is not noise.
    const known = decideSubscriptionWrite(payingTeam(), event("active", days(12)), NOW);
    expect(known.apply && known.unrecognisedStatus).toBe(false);
  });

  it("does not let an unrecognised status UPGRADE a free workspace either", () => {
    // The fail-safe half. "Not terminal, so team" would have granted paid
    // features off an unknown word; holding the stored plan cannot.
    const free = payingTeam({ plan: "free", subscriptionStatus: "expired" });
    // `expired` stored is terminal, so a non-terminal event for the same id is a
    // replay and is refused outright — use a workspace that simply never paid.
    const neverPaid: StoredBillingState = {
      plan: "free",
      subscriptionStatus: null,
      currentPeriodEnd: null,
      billingSubscriptionId: "sub_10",
    };
    void free;
    const decision = decideSubscriptionWrite(neverPaid, event("on_dunning_hold", days(12)), NOW);
    expect(decision.apply).toBe(true);
    if (!decision.apply) return;
    expect(decision.data.plan).toBe("free");
  });

  it("keeps expired and unpaid as revocations, whatever date they carry", () => {
    for (const status of ["expired", "unpaid"]) {
      const decision = decideSubscriptionWrite(payingTeam(), event(status, days(90)), NOW);
      expect(decision.apply, status).toBe(true);
      if (!decision.apply) continue;
      expect(decision.data.plan, status).toBe("free");
    }
  });

  it("leaves the four entitling statuses exactly as they were", () => {
    for (const status of ["active", "on_trial", "past_due", "cancelled"]) {
      const good = decideSubscriptionWrite(payingTeam(), event(status, days(12)), NOW);
      expect(good.apply && good.data.plan, status).toBe("team");
      const lapsed = decideSubscriptionWrite(payingTeam(), event(status, days(-90)), NOW);
      expect(lapsed.apply && lapsed.data.plan, `${status} lapsed`).toBe("free");
    }
  });
});
