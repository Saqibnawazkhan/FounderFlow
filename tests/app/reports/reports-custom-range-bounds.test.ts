/**
 * rep-009 — an absurd Custom range must not cost the page.
 *
 * WHAT THE FINDING SAID, AND WHAT IS ACTUALLY LEFT. As filed (2026-09-26) this was
 * a hang: `eachMonthOfInterval({ start, end })` materialised one Date per month
 * across the whole span — roughly 120,000 of them for 0001-01-01 → 9999-12-31 —
 * and `monthlyData` then re-filtered the transaction list once per bucket before
 * handing every bucket to a recharts BarChart. That code is gone: money-007
 * replaced it with `monthBuckets`, which walks UTC months behind a
 * `guard < 600` counter, so the tab no longer dies.
 *
 * THE HAZARD IT LEFT BEHIND IS WORSE IN ONE WAY AND BETTER IN ANOTHER. Better:
 * no freeze. Worse: the 600-bucket guard truncates from the START of the span, so
 * 0001-01-01 → 9999-12-31 charted the first fifty years AD — six hundred empty
 * months, none of the customer's data, no error, no explanation. A silently wrong
 * chart on the page a founder exports from is the same class of defect as
 * money-010's "Net Balance": plausible, self-consistent and not the truth.
 *
 * THREE THINGS THIS PINS.
 *
 *  1. The span is CLAMPED to `MAX_REPORT_MONTHS`, keeping the most recent months
 *     — the end the user typed as "to" — rather than the oldest. A clamp that
 *     kept the start would show year 1 AD for the same input.
 *  2. The clamp is DISCLOSED. `requestedStart` carries what was asked for, so the
 *     picker can say the range was narrowed instead of quietly redrawing.
 *  3. `monthBuckets` is a SINGLE PASS over the transactions, not one re-filter per
 *     month. With the clamp in place the old O(months x transactions) product is
 *     bounded, but /reports is handed up to 5,000 rows per type and a bounded
 *     multiple of that is still work nobody needs to do.
 *
 * Run as: npx cross-env TZ=America/Bogota vitest run tests/app/reports/reports-custom-range-bounds.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  MAX_REPORT_MONTHS,
  monthBuckets,
  reportDateBounds,
  reportWindow,
} from "@/app/(app)/reports/reports-client";
import { formatUtcMonthYear } from "@/lib/utils";
import type { Transaction } from "@/lib/types";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function win(customFrom: string, customTo: string) {
  return reportWindow({
    mode: "custom",
    now: NOW,
    customFrom,
    customTo,
    transactions: [],
  });
}

/** Whole UTC months from `start` up to (not including) `endExclusive`. */
/**
 * Calendar months the window TOUCHES — the number of buckets it should produce.
 *
 * This used to be a month-INDEX difference, and every assertion below then
 * carried a `MAX_REPORT_MONTHS + 1` tolerance to absorb the mismatch. That
 * tolerance was exactly the month the chart failed to render: the clamp measured
 * by index, the bucket loop counted touched months, and the guard cut the newest
 * one. A test whose slack is the size of the bug reports green on it. Measuring
 * the same thing the product measures is what makes the `+ 1` unnecessary — and
 * its absence is now load-bearing.
 */
function monthsTouched(w: { start: Date; endExclusive: Date }): number {
  if (w.endExclusive <= w.start) return 0;
  const idx = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  return idx(new Date(w.endExclusive.getTime() - 1)) - idx(w.start) + 1;
}

describe("the test's own timezone", () => {
  it("is west of UTC, so a local-boundary regression cannot hide here", () => {
    // Same opener as tests/app/reports/reports-period.test.ts: under TZ=UTC the
    // local and UTC month boundaries coincide and the day-edge cases below stop
    // discriminating.
    expect(new Date("2026-09-01T00:00:00.000Z").getTimezoneOffset()).toBeGreaterThan(0);
  });
});

describe("MAX_REPORT_MONTHS is a usable cap", () => {
  it("is generous enough for any real workspace and small enough to render", () => {
    expect(MAX_REPORT_MONTHS).toBeGreaterThanOrEqual(120);
    expect(MAX_REPORT_MONTHS).toBeLessThanOrEqual(240);
  });
});

describe("reportWindow clamps an absurd custom span (rep-009)", () => {
  it("narrows 0001-01-01 → 9999-12-31 to the cap", () => {
    const w = win("0001-01-01", "9999-12-31");
    expect(monthsTouched(w)).toBe(MAX_REPORT_MONTHS);
  });

  it("keeps the RECENT end, not the year-1 end", () => {
    // The whole point. Truncating from the start is what made the chart show the
    // first fifty years AD.
    const w = win("0001-01-01", "9999-12-31");
    expect(w.endExclusive.getUTCFullYear()).toBe(10000);
    expect(w.start.getUTCFullYear()).toBeGreaterThan(9980);
  });

  it("discloses the clamp by carrying the start that was asked for", () => {
    const w = win("0001-01-01", "9999-12-31");
    expect(w.requestedStart).toBeInstanceOf(Date);
    expect(w.requestedStart?.getUTCFullYear()).toBe(1);
  });

  it("leaves an ordinary range completely alone", () => {
    const w = win("2026-04-01", "2026-09-12");
    expect(w.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(w.endExclusive.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    // No clamp happened, so nothing to disclose — an always-present field would
    // make the picker announce a narrowing that never occurred.
    expect(w.requestedStart).toBeUndefined();
  });

  it("leaves a long-but-plausible range alone (8 years)", () => {
    const w = win("2018-01-01", "2026-01-01");
    expect(w.start.toISOString()).toBe("2018-01-01T00:00:00.000Z");
    expect(w.requestedStart).toBeUndefined();
  });

  it("clamps a reversed absurd range too, after un-reversing it", () => {
    // `reportWindow` forgives a reversed range rather than showing nothing, so the
    // clamp has to run on the ordered pair, not on the raw inputs.
    const w = win("9999-12-31", "0001-01-01");
    expect(monthsTouched(w)).toBe(MAX_REPORT_MONTHS);
    expect(w.requestedStart?.getUTCFullYear()).toBe(1);
  });

  it("never clamps a preset — those are generated, not typed", () => {
    for (const mode of ["3m", "6m", "1y"] as const) {
      const w = reportWindow({ mode, now: NOW, transactions: [] });
      expect(w.requestedStart).toBeUndefined();
    }
  });

  it("clamps 'all time' as well, since the earliest row sets the start", () => {
    // A transaction with a corrupt or mistyped date (year 1000) would otherwise
    // open the all-time window a millennium back.
    const w = reportWindow({
      mode: "all",
      now: NOW,
      transactions: [{ date: "1000-01-01T00:00:00.000Z" }, { date: "2026-01-01T00:00:00.000Z" }],
    });
    expect(monthsTouched(w)).toBe(MAX_REPORT_MONTHS);
    expect(w.requestedStart?.getUTCFullYear()).toBe(1000);
  });
});

describe("monthBuckets stays bounded and correct (rep-009)", () => {
  function txn(date: string, over: Partial<Transaction> = {}): Transaction {
    return {
      id: `t-${date}-${Math.random()}`,
      companyId: "c1",
      type: "expense",
      amount: 10,
      category: "Ops",
      description: "row",
      date,
      addedBy: "u1",
      addedByName: "A",
      createdAt: date,
      ...over,
    } as Transaction;
  }

  it("emits no more buckets than the cap, whatever window it is handed", () => {
    // Defence in depth: monthBuckets is also reachable with a hand-built window.
    const buckets = monthBuckets([], {
      start: new Date("0001-01-01T00:00:00.000Z"),
      endExclusive: new Date("9999-12-31T00:00:00.000Z"),
    });
    expect(buckets.length).toBeLessThanOrEqual(MAX_REPORT_MONTHS);
  });

  it("emits a bucket for EVERY month the clamped window covers", () => {
    /*
     * THE ASSERTION WHOSE ABSENCE HID THE BUG. Every bucket check in this file
     * bounded the count from above only, so a loop that stopped one month short
     * satisfied all of them — and the input each clamp case uses
     * (0001-01-01 → 9999-12-31) happens to end on a month boundary, the one shape
     * where the two measures agree. A mid-month end is the normal case and was
     * untested.
     *
     * Coverage is the property a reader cares about: the newest month is the one
     * they opened the page for, and the loop walks forward, so it is the one a
     * short count drops.
     */
    const w = win("1990-01-01", "2026-03-10");
    const buckets = monthBuckets([], w);

    expect(buckets.length, "the chart is missing months the window covers").toBe(monthsTouched(w));
    expect(
      buckets[buckets.length - 1].month,
      "the LAST bucket must be the month the window ends in — that is the one a founder came to see"
    ).toBe(formatUtcMonthYear(new Date("2026-03-01T00:00:00.000Z")));
  });

  it("does not re-scan the ledger once per month", () => {
    // The cost signal, measured rather than asserted about the source: 5,000 rows
    // over a capped window. One pass is ~5k operations; a per-bucket re-filter is
    // 5k x 120 = 600k, and the old unbounded version was 5k x 120,000. A generous
    // budget keeps this from being a flaky benchmark while still failing the
    // quadratic shape.
    const rows: Transaction[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const month = (i % 12) + 1;
      rows.push(txn(`2026-${String(month).padStart(2, "0")}-01T00:00:00.000Z`));
    }
    const w = reportWindow({
      mode: "custom",
      now: NOW,
      customFrom: "0001-01-01",
      customTo: "9999-12-31",
      transactions: [],
    });
    const started = Date.now();
    const buckets = monthBuckets(rows, w);
    expect(Date.now() - started).toBeLessThan(400);
    expect(buckets.length).toBeLessThanOrEqual(MAX_REPORT_MONTHS);
  });

  it("still files each row in its own UTC month", () => {
    const w = reportWindow({
      mode: "custom",
      now: NOW,
      customFrom: "2026-08-01",
      customTo: "2026-09-30",
      transactions: [],
    });
    const buckets = monthBuckets(
      [
        txn("2026-08-01T00:00:00.000Z", { amount: 100 }),
        txn("2026-09-01T00:00:00.000Z", { amount: 7, type: "income" }),
        txn("2026-09-30T00:00:00.000Z", { amount: 3, type: "investment" }),
      ],
      w
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0].expenses).toBe(100);
    expect(buckets[0].revenue).toBe(0);
    expect(buckets[1].revenue).toBe(7);
    expect(buckets[1].investments).toBe(3);
    expect(buckets[1].netFlow).toBe(10);
  });

  it("does not merge two months a century apart that share a label", () => {
    // "MMM yy" repeats every hundred years, so a bucket index keyed on the LABEL
    // would fold 2026-03 into 1926-03. Only reachable through a hand-built window
    // now that spans are clamped, but monthBuckets is exported and reachable.
    const buckets = monthBuckets([txn("2026-03-15T00:00:00.000Z", { amount: 50 })], {
      start: new Date("2026-01-01T00:00:00.000Z"),
      endExclusive: new Date("2026-06-01T00:00:00.000Z"),
    });
    const march = buckets.find((b) => b.expenses === 50);
    expect(march).toBeTruthy();
    expect(buckets.filter((b) => b.expenses > 0)).toHaveLength(1);
  });
});

describe("the date inputs carry absolute bounds (rep-009)", () => {
  it("offers a floor before which no ledger exists and a ceiling near now", () => {
    const { min, max } = reportDateBounds(NOW);
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(min < max).toBe(true);
    // `<input type="date">` accepts any year up to 275760 with no absolute
    // min/max, which is how a pasted or fat-fingered year reached the chart.
    expect(Number(min.slice(0, 4))).toBeGreaterThanOrEqual(2000);
    expect(Number(max.slice(0, 4))).toBeLessThanOrEqual(NOW.getUTCFullYear() + 5);
  });

  it("allows a future-dated range, because recurring rules post ahead", () => {
    const { max } = reportDateBounds(NOW);
    expect(max > "2026-09-15").toBe(true);
  });
});
