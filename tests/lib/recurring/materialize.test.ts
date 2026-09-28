import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  MAX_CATCHUP_LOOKBACK_DAYS,
  MAX_CATCHUP_OCCURRENCES,
  alreadyFiredToday,
  dueDatesFor,
  isRuleDueOn,
  materialize,
  planRecurring,
} from "@/lib/recurring/materialize";
import type { RecurringRule } from "@prisma/client";

// Helper: build a RecurringRule with sane defaults so each test only sets
// the fields under test. startDate is one week in the past so the rule
// has had time to "begin" before the test clock.
function rule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  const week = 7 * 24 * 60 * 60 * 1000;
  return {
    id: "rule-1",
    companyId: "co-1",
    type: "expense",
    // Prisma.Decimal after the Float→Decimal migration (FaultsAudit.md P0-4).
    amount: new Prisma.Decimal(100),
    category: "Office Rent",
    description: "test",
    addedBy: "user-1",
    addedByName: "Test User",
    frequency: "monthly",
    dayOfMonth: 15,
    dayOfWeek: null,
    active: true,
    startDate: new Date(Date.UTC(2026, 0, 1)),
    lastMaterializedAt: null,
    createdAt: new Date(Date.now() - week),
    // money-005: a rule may now be attributed to a project, which is what lets
    // recurring spend reach a budget cap. Null is the company-wide default.
    projectId: null,
    ...overrides,
  };
}

describe("isRuleDueOn — monthly", () => {
  it("fires on the exact day-of-month", () => {
    expect(isRuleDueOn(rule({ dayOfMonth: 15 }), new Date(Date.UTC(2026, 2, 15)))).toBe(true);
    expect(isRuleDueOn(rule({ dayOfMonth: 1 }), new Date(Date.UTC(2026, 2, 1)))).toBe(true);
  });

  it("does not fire on other days", () => {
    expect(isRuleDueOn(rule({ dayOfMonth: 15 }), new Date(Date.UTC(2026, 2, 14)))).toBe(false);
    expect(isRuleDueOn(rule({ dayOfMonth: 15 }), new Date(Date.UTC(2026, 2, 16)))).toBe(false);
  });

  it("clamps dayOfMonth=31 to Feb 28 in a non-leap year", () => {
    // 2026 is not a leap year — Feb has 28 days
    expect(isRuleDueOn(rule({ dayOfMonth: 31 }), new Date(Date.UTC(2026, 1, 28)))).toBe(true);
    expect(isRuleDueOn(rule({ dayOfMonth: 31 }), new Date(Date.UTC(2026, 1, 27)))).toBe(false);
  });

  it("clamps dayOfMonth=31 to Feb 29 in a leap year", () => {
    // 2028 is a leap year
    expect(isRuleDueOn(rule({ dayOfMonth: 31 }), new Date(Date.UTC(2028, 1, 29)))).toBe(true);
    expect(isRuleDueOn(rule({ dayOfMonth: 31 }), new Date(Date.UTC(2028, 1, 28)))).toBe(false);
  });

  it("clamps dayOfMonth=31 to Apr 30 (April has 30 days)", () => {
    expect(isRuleDueOn(rule({ dayOfMonth: 31 }), new Date(Date.UTC(2026, 3, 30)))).toBe(true);
  });

  it("dayOfMonth=15 in Feb fires on the 15th (no clamping needed)", () => {
    expect(isRuleDueOn(rule({ dayOfMonth: 15 }), new Date(Date.UTC(2026, 1, 15)))).toBe(true);
    // Doesn't double-fire on the 28th just because 15 < 28
    expect(isRuleDueOn(rule({ dayOfMonth: 15 }), new Date(Date.UTC(2026, 1, 28)))).toBe(false);
  });
});

describe("isRuleDueOn — weekly", () => {
  it("fires on the matching day-of-week", () => {
    // 2026-03-16 is a Monday (dayOfWeek=1)
    const r = rule({ frequency: "weekly", dayOfMonth: null, dayOfWeek: 1 });
    expect(isRuleDueOn(r, new Date(Date.UTC(2026, 2, 16)))).toBe(true);
  });

  it("does not fire on other days of the week", () => {
    const r = rule({ frequency: "weekly", dayOfMonth: null, dayOfWeek: 1 });
    expect(isRuleDueOn(r, new Date(Date.UTC(2026, 2, 17)))).toBe(false); // Tuesday
  });
});

describe("isRuleDueOn — gating", () => {
  it("paused rules never fire", () => {
    expect(
      isRuleDueOn(rule({ active: false, dayOfMonth: 15 }), new Date(Date.UTC(2026, 2, 15)))
    ).toBe(false);
  });

  it("future-dated startDate prevents firing", () => {
    const r = rule({ startDate: new Date(Date.UTC(2026, 5, 1)), dayOfMonth: 15 });
    expect(isRuleDueOn(r, new Date(Date.UTC(2026, 2, 15)))).toBe(false);
    // But on/after startDate, fires normally
    expect(isRuleDueOn(r, new Date(Date.UTC(2026, 6, 15)))).toBe(true);
  });

  it("monthly rule with null dayOfMonth never fires", () => {
    expect(isRuleDueOn(rule({ dayOfMonth: null }), new Date(Date.UTC(2026, 2, 15)))).toBe(false);
  });

  it("weekly rule with null dayOfWeek never fires", () => {
    expect(
      isRuleDueOn(
        rule({ frequency: "weekly", dayOfMonth: null, dayOfWeek: null }),
        new Date(Date.UTC(2026, 2, 16))
      )
    ).toBe(false);
  });

  it("unknown frequency never fires", () => {
    expect(
      isRuleDueOn(rule({ frequency: "yearly" as never }), new Date(Date.UTC(2026, 2, 15)))
    ).toBe(false);
  });
});

describe("alreadyFiredToday", () => {
  it("returns false if never materialized", () => {
    expect(alreadyFiredToday(rule({ lastMaterializedAt: null }), new Date())).toBe(false);
  });

  it("returns true if lastMaterializedAt is in the same UTC day as `when`", () => {
    const day = new Date(Date.UTC(2026, 2, 15, 23, 59, 59));
    const earlierSameDay = new Date(Date.UTC(2026, 2, 15, 0, 0, 5));
    expect(alreadyFiredToday(rule({ lastMaterializedAt: earlierSameDay }), day)).toBe(true);
  });

  it("returns false if lastMaterializedAt is the previous day", () => {
    const day = new Date(Date.UTC(2026, 2, 15));
    const yesterday = new Date(Date.UTC(2026, 2, 14, 23, 59, 59));
    expect(alreadyFiredToday(rule({ lastMaterializedAt: yesterday }), day)).toBe(false);
  });
});

describe("materialize", () => {
  it("returns transactions for due, unfired, active rules only", () => {
    const today = new Date(Date.UTC(2026, 2, 15));
    // Every rule is caught up to yesterday, so this test is about SELECTION
    // only — the catch-up walk has its own describe block below. (Before
    // catch-up landed these rules carried lastMaterializedAt: null, which now
    // legitimately means "nothing has ever fired, reconcile from startDate"
    // and would emit January's and February's occurrences too.)
    const caught = new Date(Date.UTC(2026, 2, 14));
    const rules = [
      rule({ id: "due", dayOfMonth: 15, lastMaterializedAt: caught }),
      rule({ id: "not-due", dayOfMonth: 20, lastMaterializedAt: caught }),
      rule({ id: "paused", dayOfMonth: 15, active: false, lastMaterializedAt: caught }),
      rule({ id: "already-fired", dayOfMonth: 15, lastMaterializedAt: today }),
    ];
    const out = materialize(rules, today);
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("due");
  });

  it("maps every field from rule to MaterializedTransaction", () => {
    const today = new Date(Date.UTC(2026, 2, 15));
    const out = materialize(
      [
        rule({
          id: "r1",
          companyId: "co-x",
          type: "investment",
          amount: new Prisma.Decimal(50_000),
          category: "Founder Investment",
          description: "Saqib's monthly top-up",
          addedBy: "user-saqib",
          addedByName: "Saqib Nawaz",
          dayOfMonth: 15,
          lastMaterializedAt: new Date(Date.UTC(2026, 2, 14)),
        }),
      ],
      today
    );
    expect(out[0]).toEqual({
      ruleId: "r1",
      companyId: "co-x",
      type: "investment",
      amount: 50_000,
      category: "Founder Investment",
      description: "Saqib's monthly top-up",
      addedBy: "user-saqib",
      addedByName: "Saqib Nawaz",
      projectId: null,
      date: today,
    });
  });

  it("is idempotent — running the materializer twice in the same day fires once", () => {
    const today = new Date(Date.UTC(2026, 2, 15));
    const r = rule({ dayOfMonth: 15, lastMaterializedAt: new Date(Date.UTC(2026, 2, 14)) });

    const first = materialize([r], today);
    expect(first).toHaveLength(1);

    // Simulate the cron stamping lastMaterializedAt after the first run.
    r.lastMaterializedAt = today;
    const second = materialize([r], today);
    expect(second).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * cron-004 / money-005 — the materializer as a RECONCILER, not a same-day
 * trigger.
 *
 * The contract these assert, in the user's terms: "if the nightly job misses
 * its run, the recurring expense still appears, dated the day it was due."
 * Vercel cron does not retry, so a single 500 used to skip a customer's rent
 * for that month permanently, with no row anywhere to notice.
 * ──────────────────────────────────────────────────────────────────────── */

describe("dueDatesFor — catch-up after a missed run (cron-004)", () => {
  it("emits the missed occurrence when the job runs a day late", () => {
    // Rule fires on the 15th. The job did not run on the 15th; it runs on the
    // 16th. The 15th's expense must still appear.
    const r = rule({ dayOfMonth: 15, lastMaterializedAt: new Date(Date.UTC(2026, 1, 15)) });
    const { dates } = dueDatesFor(r, new Date(Date.UTC(2026, 2, 16, 0, 5)));
    expect(dates.map((d) => d.toISOString())).toEqual([
      new Date(Date.UTC(2026, 2, 15)).toISOString(),
    ]);
  });

  it("emits one occurrence per missed month, oldest first", () => {
    // Last fired 2026-01-15; it is now 2026-04-20. Feb, Mar and Apr are owed.
    const r = rule({ dayOfMonth: 15, lastMaterializedAt: new Date(Date.UTC(2026, 0, 15)) });
    const { dates } = dueDatesFor(r, new Date(Date.UTC(2026, 3, 20)));
    expect(dates.map((d) => d.toISOString())).toEqual([
      new Date(Date.UTC(2026, 1, 15)).toISOString(),
      new Date(Date.UTC(2026, 2, 15)).toISOString(),
      new Date(Date.UTC(2026, 3, 15)).toISOString(),
    ]);
  });

  it("dates each occurrence on the day it was DUE, not the day the job ran", () => {
    // This is the money half of cron-004: a June rent posted with a July date
    // leaves June's books wrong forever, which is what /reports and runway read.
    const r = rule({ dayOfMonth: 1, lastMaterializedAt: new Date(Date.UTC(2026, 4, 1)) });
    const out = materialize([r], new Date(Date.UTC(2026, 6, 9, 3, 15)));
    expect(out.map((m) => m.date.toISOString())).toEqual([
      new Date(Date.UTC(2026, 5, 1)).toISOString(),
      new Date(Date.UTC(2026, 6, 1)).toISOString(),
    ]);
  });

  it("does not re-emit an occurrence already materialized (same-day rerun)", () => {
    const r = rule({ dayOfMonth: 15, lastMaterializedAt: new Date(Date.UTC(2026, 2, 15, 0, 5)) });
    expect(dueDatesFor(r, new Date(Date.UTC(2026, 2, 15, 23, 59))).dates).toEqual([]);
  });

  it("walks weekly rules too", () => {
    // 2026-03-16 is a Monday. Last fired Monday 2026-02-23 → 3 Mondays owed.
    const r = rule({
      frequency: "weekly",
      dayOfMonth: null,
      dayOfWeek: 1,
      lastMaterializedAt: new Date(Date.UTC(2026, 1, 23)),
    });
    const { dates } = dueDatesFor(r, new Date(Date.UTC(2026, 2, 16)));
    expect(dates.map((d) => d.toISOString())).toEqual([
      new Date(Date.UTC(2026, 2, 2)).toISOString(),
      new Date(Date.UTC(2026, 2, 9)).toISOString(),
      new Date(Date.UTC(2026, 2, 16)).toISOString(),
    ]);
  });

  it("caps a run and defers the rest instead of silently dropping them", () => {
    // Weekly rule untouched for a year: 52-ish occurrences owed. A single run
    // must not mint a year of history in one go, and must say how many it left.
    const r = rule({
      frequency: "weekly",
      dayOfMonth: null,
      dayOfWeek: 1,
      startDate: new Date(Date.UTC(2025, 2, 17)),
      lastMaterializedAt: new Date(Date.UTC(2025, 2, 17)),
    });
    const { dates, deferred } = dueDatesFor(r, new Date(Date.UTC(2026, 2, 16)));
    expect(dates).toHaveLength(MAX_CATCHUP_OCCURRENCES);
    expect(deferred).toBeGreaterThan(0);
    // Oldest first, so the deferred tail is picked up by the next run.
    expect(dates[0].getTime()).toBeLessThan(dates[dates.length - 1].getTime());
  });

  it("never walks further back than the lookback window, and says when it truncated", () => {
    const r = rule({
      dayOfMonth: 1,
      startDate: new Date(Date.UTC(2020, 0, 1)),
      lastMaterializedAt: null,
    });
    const res = dueDatesFor(r, new Date(Date.UTC(2026, 2, 16)));
    expect(res.truncatedLookback).toBe(true);
    const floor = Date.UTC(2026, 2, 16) - MAX_CATCHUP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    for (const d of res.dates) expect(d.getTime()).toBeGreaterThanOrEqual(floor);
  });

  it("still refuses to backfill before the rule's own startDate", () => {
    const r = rule({ dayOfMonth: 15, startDate: new Date(Date.UTC(2026, 2, 20)) });
    expect(
      dueDatesFor(r, new Date(Date.UTC(2026, 3, 16))).dates.map((d) => d.toISOString())
    ).toEqual([new Date(Date.UTC(2026, 3, 15)).toISOString()]);
  });

  it("a paused rule catches up on nothing", () => {
    const r = rule({ active: false, lastMaterializedAt: new Date(Date.UTC(2026, 0, 15)) });
    expect(dueDatesFor(r, new Date(Date.UTC(2026, 3, 20))).dates).toEqual([]);
  });
});

describe("planRecurring — per-rule plans the cron can claim (cron-003)", () => {
  it("hands back the lastMaterializedAt it read, so the writer can claim the rule", () => {
    const token = new Date(Date.UTC(2026, 1, 15));
    const plans = planRecurring(
      [rule({ dayOfMonth: 15, lastMaterializedAt: token })],
      new Date(Date.UTC(2026, 2, 15))
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].claimToken).toBe(token);
    expect(plans[0].occurrences).toHaveLength(1);
  });

  it("omits rules with nothing owed rather than emitting an empty plan", () => {
    const plans = planRecurring(
      [rule({ dayOfMonth: 15, lastMaterializedAt: new Date(Date.UTC(2026, 2, 15)) })],
      new Date(Date.UTC(2026, 2, 15))
    );
    expect(plans).toEqual([]);
  });
});

describe("money-005 — a recurring rule's project reaches the transaction", () => {
  it("carries the rule's projectId onto every materialized transaction", () => {
    const out = materialize(
      [
        rule({
          dayOfMonth: 15,
          projectId: "proj-nimbus",
          lastMaterializedAt: new Date(Date.UTC(2026, 2, 14)),
        }),
      ],
      new Date(Date.UTC(2026, 2, 15))
    );
    expect(out).toHaveLength(1);
    expect(out[0].projectId).toBe("proj-nimbus");
  });

  it("leaves projectId null for a company-wide rule", () => {
    const out = materialize(
      [rule({ dayOfMonth: 15, lastMaterializedAt: new Date(Date.UTC(2026, 2, 14)) })],
      new Date(Date.UTC(2026, 2, 15))
    );
    expect(out[0].projectId).toBeNull();
  });
});
