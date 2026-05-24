import { describe, it, expect } from "vitest";
import { alreadyFiredToday, isRuleDueOn, materialize } from "@/lib/recurring/materialize";
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
    amount: 100,
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
    const rules = [
      rule({ id: "due", dayOfMonth: 15 }),
      rule({ id: "not-due", dayOfMonth: 20 }),
      rule({ id: "paused", dayOfMonth: 15, active: false }),
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
          amount: 50_000,
          category: "Founder Investment",
          description: "Saqib's monthly top-up",
          addedBy: "user-saqib",
          addedByName: "Saqib Nawaz",
          dayOfMonth: 15,
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
      date: today,
    });
  });

  it("is idempotent — running the materializer twice in the same day fires once", () => {
    const today = new Date(Date.UTC(2026, 2, 15));
    const r = rule({ dayOfMonth: 15 });

    const first = materialize([r], today);
    expect(first).toHaveLength(1);

    // Simulate the cron stamping lastMaterializedAt after the first run.
    r.lastMaterializedAt = today;
    const second = materialize([r], today);
    expect(second).toHaveLength(0);
  });
});
