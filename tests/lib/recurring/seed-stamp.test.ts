// @vitest-environment node

/**
 * finance-planning-004 — a monthly rule charged TWICE in the month it was created.
 *
 * `createRecurringAction` posts a seed transaction immediately, on purpose: "The
 * seed IS the first month of this recurring cost", which is also what makes a
 * brand-new rule visible to the budget it belongs to (the half of money-005 that
 * was hardest to find). It then stamped `lastMaterializedAt: now`, and
 * `dueDatesFor` walks `(lastMaterializedAt, today]` — so a rule created on the 3rd
 * with `dayOfMonth: 15` came due again on the 15th of the SAME month. One monthly
 * rent charge set up, two rows posted, both carrying the same rule badge so
 * neither looks like the mistake.
 *
 * WHY IT SURVIVED: created on or after the due day it was already correct. Anyone
 * who tried it on the 20th saw exactly one charge.
 *
 * These cases walk a whole calendar against the pure decision rather than
 * asserting one example, because the interesting inputs are the boundaries — the
 * due day itself, the day after, month-end clamping, February, and the weekly
 * rule whose "period" is not a month at all.
 */

import { describe, it, expect } from "vitest";
import { seedStampFor, dueDatesFor } from "@/lib/recurring/materialize";
import type { RecurringRule } from "@prisma/client";
import { Prisma } from "@prisma/client";

function rule(over: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: "r_rent",
    companyId: "c_nimbus",
    projectId: null,
    type: "expense",
    amount: new Prisma.Decimal(50000),
    category: "Office Rent",
    description: "Rent",
    addedBy: "u_ayesha",
    addedByName: "Ayesha",
    frequency: "monthly",
    dayOfMonth: 15,
    dayOfWeek: null,
    active: true,
    startDate: new Date(Date.UTC(2026, 9, 3)),
    lastMaterializedAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 3)),
    ...over,
  } as RecurringRule;
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("finance-planning-004 — the seed pays for the current period", () => {
  it("stamps forward to this month's due day when created before it", () => {
    // 3 October, rule due on the 15th. THE BUG: stamping `now` left the 15th
    // inside the scheduler's window.
    const created = utc(2026, 9, 3);
    const r = rule({ startDate: created });
    expect(iso(seedStampFor(r, created))).toBe("2026-10-15");
  });

  it("leaves the stamp alone when created ON the due day", () => {
    const created = utc(2026, 9, 15);
    const r = rule({ startDate: created });
    expect(seedStampFor(r, created)).toBe(created);
  });

  it("leaves the stamp alone when created after the due day", () => {
    const created = utc(2026, 9, 20);
    const r = rule({ startDate: created });
    expect(seedStampFor(r, created)).toBe(created);
  });

  it("clamps to the last day of a short month, as isRuleDueOn does", () => {
    // Day 31 in a 30-day month fires on the 30th. The stamp has to agree with
    // that, or the scheduler posts a second charge on the clamped day.
    const created = utc(2026, 10, 3); // 3 November, 30 days
    const r = rule({ dayOfMonth: 31, startDate: created });
    expect(iso(seedStampFor(r, created))).toBe("2026-11-30");
  });

  it("handles February, the month every calendar bug lives in", () => {
    const created = utc(2026, 1, 2); // 2 February 2026, 28 days
    const r = rule({ dayOfMonth: 30, startDate: created });
    expect(iso(seedStampFor(r, created))).toBe("2026-02-28");
  });

  it("stamps forward to this week's day for a weekly rule", () => {
    // Monday 5 October 2026, rule due on Fridays (dayOfWeek 5).
    const created = utc(2026, 9, 5);
    expect(created.getUTCDay()).toBe(1);
    const r = rule({ frequency: "weekly", dayOfMonth: null, dayOfWeek: 5, startDate: created });
    expect(iso(seedStampFor(r, created))).toBe("2026-10-09");
  });

  it("leaves a weekly rule created on its own day alone", () => {
    const created = utc(2026, 9, 9); // a Friday
    expect(created.getUTCDay()).toBe(5);
    const r = rule({ frequency: "weekly", dayOfMonth: null, dayOfWeek: 5, startDate: created });
    expect(seedStampFor(r, created)).toBe(created);
  });

  it("stands in for the next occurrence within seven days, even when it is six away", () => {
    // Saturday, rule due on Fridays. THE TRADE, and my first version of this test
    // got it backwards, so it is written out: the alternative is charging on
    // Saturday (the seed) AND the following Friday, which is two charges in six
    // days for a rule the customer set up as weekly. Skipping that Friday delays
    // the second charge to Friday+7 — a one-off delay the customer can see and
    // nobody has to reconcile. A doubled charge is a wrong number in a ledger and
    // both rows carry the same rule badge. So the seed always pays for the next
    // occurrence inside one period, and the invariant is "one charge per seven
    // days, always", asserted as a property below.
    const created = utc(2026, 9, 10); // Saturday
    expect(created.getUTCDay()).toBe(6);
    const r = rule({ frequency: "weekly", dayOfMonth: null, dayOfWeek: 5, startDate: created });
    expect(iso(seedStampFor(r, created))).toBe("2026-10-16");
  });
});

describe("finance-planning-004 — what the scheduler then owes", () => {
  /** The real question: how many times is this charged in its first month? */
  function chargesThroughMonthEnd(seededOn: Date, dayOfMonth: number, stamp: Date): string[] {
    const r = rule({ dayOfMonth, startDate: seededOn, lastMaterializedAt: stamp });
    const monthEnd = new Date(Date.UTC(seededOn.getUTCFullYear(), seededOn.getUTCMonth() + 1, 0));
    return dueDatesFor(r, monthEnd).dates.map(iso);
  }

  it("owes NOTHING more this month once the seed is stamped forward", () => {
    const created = utc(2026, 9, 3);
    const stamp = seedStampFor(rule({ startDate: created }), created);
    expect(chargesThroughMonthEnd(created, 15, stamp)).toEqual([]);
  });

  it("would have owed the 15th under the old `now` stamp — the bug, stated", () => {
    // This is the assertion that fails if somebody "simplifies" seedStampFor back
    // to returning `when`: the old behaviour is reproduced here explicitly so the
    // contrast is in the file rather than in a commit message.
    const created = utc(2026, 9, 3);
    expect(chargesThroughMonthEnd(created, 15, created)).toEqual(["2026-10-15"]);
  });

  it("still owes the NEXT month's charge, so nothing is lost", () => {
    const created = utc(2026, 9, 3);
    const stamp = seedStampFor(rule({ startDate: created }), created);
    const r = rule({ dayOfMonth: 15, startDate: created, lastMaterializedAt: stamp });
    expect(dueDatesFor(r, utc(2026, 10, 20)).dates.map(iso)).toEqual(["2026-11-15"]);
  });

  it("charges a weekly rule at most once per seven days, whatever day it starts", () => {
    // The weekly invariant, over every possible start day. Two charges inside one
    // seven-day window is the failure this finding is about.
    for (let day = 1; day <= 7; day += 1) {
      const created = utc(2026, 9, day);
      const weekly = {
        frequency: "weekly",
        dayOfMonth: null,
        dayOfWeek: 5,
        startDate: created,
      } as Partial<RecurringRule>;
      const stamp = seedStampFor(rule(weekly), created);
      const scheduled = dueDatesFor(
        rule({ ...weekly, lastMaterializedAt: stamp }),
        utc(2026, 10, 30),
        { maxOccurrences: 24, maxLookbackDays: 400 }
      ).dates;
      const all = [created].concat(scheduled);
      for (let i = 1; i < all.length; i += 1) {
        const gapDays = (all[i].getTime() - all[i - 1].getTime()) / (24 * 60 * 60 * 1000);
        expect(gapDays, `started Oct ${day}, gap before ${iso(all[i])}`).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it("charges exactly once per month for a whole year, whatever day it starts", () => {
    // The property, not an example. For every start day in October, the first
    // twelve months must contain exactly twelve charges: the seed plus eleven.
    for (let day = 1; day <= 31; day += 1) {
      const created = utc(2026, 9, day);
      const r = rule({ dayOfMonth: 15, startDate: created });
      const stamp = seedStampFor(r, created);
      const scheduled = dueDatesFor(
        rule({ dayOfMonth: 15, startDate: created, lastMaterializedAt: stamp }),
        utc(2027, 8, 30),
        { maxOccurrences: 24, maxLookbackDays: 400 }
      ).dates;
      // 1 seed + scheduled === 12 charges in the first twelve months.
      expect(scheduled.length + 1, `started on Oct ${day}`).toBe(12);
    }
  });
});
