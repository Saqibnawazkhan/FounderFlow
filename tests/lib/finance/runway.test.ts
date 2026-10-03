/**
 * Burn, runway, and the "vs avg" pace comparison (money-017).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * The dashboard computed `monthlyBurn = burnWindowExpense(…) / BURN_WINDOW_MONTHS`
 * — a constant 3 — and `lib/actions/chat.ts` mirrored it as `last3MoExpenses / 3`
 * for the runway card. The rolling window is a genuine three months wide, so the
 * divisor is right for a workspace that has existed for three months and WRONG
 * for every workspace younger than that: a one-month-old workspace that spent
 * 100,000 reported a burn of 33,333 and therefore about THREE TIMES its real
 * runway. Overstating runway for the youngest, most cash-fragile workspaces is
 * the wrong direction to be wrong in — runway is the number a founder makes
 * hiring and fundraising decisions on.
 *
 * The same arithmetic produced the second half of the bug: `burnDeltaPct`
 * compared MONTH-TO-DATE spend against a WHOLE-month average, so on the 3rd of
 * the month a workspace spending exactly its normal amount read "-90% vs avg".
 * A comparison that is structurally negative for three weeks out of four is not
 * a signal, it is noise with a minus sign.
 *
 * ── THE CONTRACT ───────────────────────────────────────────────────────────
 * Burn is the window's spend over the months the ledger ACTUALLY covers, capped
 * at the window and floored at one month, and a month-to-date figure is compared
 * against the same FRACTION of an average month that has elapsed.
 *
 * Pro-rating alone was not enough, and the first fix shipped without the rest of
 * it (R2-money-017-pace): the floor means a workspace with under a month of
 * ledger has a "average" that is its own month-to-date total, and pro-rating a
 * total against itself yields `(1 / elapsed - 1) * 100` — +107% on the 15th,
 * +933% on the 3rd — for every workspace in that population alike. So the second
 * half of the contract is that the comparison is WITHHELD until a full month of
 * ledger stands behind the average, and shown from then on.
 *
 * TZ: the suite pins America/Bogota. It matters here — `NOW` below is UTC
 * midnight on the 15th, which is the 14th in Bogota, so every day-of-month
 * figure proves it reads the UTC calendar (the one `Transaction.date` is stored
 * in — lib/date-range.ts, money-007) and not the viewer's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BURN_WINDOW_MONTHS,
  averageMonthlyBurn,
  burnMonthsCovered,
  burnPaceComparable,
  burnPaceDeltaPct,
  burnWindowStart,
  monthElapsedFraction,
  runwayMonths,
} from "@/lib/finance/runway";

/** UTC midnight on the 15th of a 31-day month. */
const NOW = new Date("2026-10-15T00:00:00.000Z");
/** The same clock, early in the month: the "-90% vs avg" case. */
const THIRD = new Date("2026-10-03T00:00:00.000Z");

describe("the test's own timezone", () => {
  it("is west of UTC, or the UTC-day cases below prove nothing", () => {
    expect(NOW.getTimezoneOffset()).toBe(300);
    // Locally this instant is the 14th. Every assertion below expects the 15th.
    expect(NOW.getDate()).toBe(14);
    expect(NOW.getUTCDate()).toBe(15);
  });
});

describe("burnWindowStart", () => {
  it("is a rolling three months back, pinned to UTC midnight", () => {
    expect(burnWindowStart(NOW).toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(BURN_WINDOW_MONTHS).toBe(3);
  });
});

describe("burnMonthsCovered", () => {
  it("covers the whole window for a ledger older than it", () => {
    expect(burnMonthsCovered("2025-01-01T00:00:00.000Z", NOW)).toBe(3);
  });

  it("covers the whole window for a ledger starting exactly at its edge", () => {
    expect(burnMonthsCovered(burnWindowStart(NOW), NOW)).toBe(3);
  });

  it("divides by two for two months of history, not by three", () => {
    expect(burnMonthsCovered("2026-08-15T00:00:00.000Z", NOW)).toBe(2);
  });

  it("divides by one for one month of history", () => {
    expect(burnMonthsCovered("2026-09-15T00:00:00.000Z", NOW)).toBe(1);
  });

  it("carries the fraction of a part-month of history", () => {
    // 2026-08-30 → one whole month to Sep 30 (clamped into the short month, the
    // way utcMonthsAgo clamps), then 15 of the following 30 days.
    expect(burnMonthsCovered("2026-08-30T00:00:00.000Z", NOW)).toBeCloseTo(1.5, 10);
  });

  it("never divides by less than one month", () => {
    // Five days old. Extrapolating a five-day sample to a month would print a
    // burn six times the money that has actually left the account.
    expect(burnMonthsCovered("2026-10-10T00:00:00.000Z", NOW)).toBe(1);
    // A first row dated in the future (someone logging a scheduled payment) is
    // negative history; it must not produce a negative or zero divisor.
    expect(burnMonthsCovered("2026-12-01T00:00:00.000Z", NOW)).toBe(1);
  });

  it("falls back to the whole window when the ledger start is unknown", () => {
    expect(burnMonthsCovered(null, NOW)).toBe(3);
    expect(burnMonthsCovered(undefined, NOW)).toBe(3);
    expect(burnMonthsCovered("not a date", NOW)).toBe(3);
  });
});

describe("averageMonthlyBurn", () => {
  it("reports a one-month-old workspace's whole spend as one month of burn", () => {
    // THE HEADLINE CASE. 100,000 spent, one month of history. The old
    // divide-by-3 reported 33,333.
    expect(averageMonthlyBurn(100_000, "2026-09-15T00:00:00.000Z", NOW)).toBe(100_000);
  });

  it("averages over two months when that is all the history there is", () => {
    expect(averageMonthlyBurn(100_000, "2026-08-15T00:00:00.000Z", NOW)).toBe(50_000);
  });

  it("still averages over three months for a workspace older than the window", () => {
    expect(averageMonthlyBurn(300_000, "2025-01-01T00:00:00.000Z", NOW)).toBe(100_000);
  });

  it("is zero on a ledger with no spend, not a divide-by-zero", () => {
    expect(averageMonthlyBurn(0, "2026-09-15T00:00:00.000Z", NOW)).toBe(0);
    expect(averageMonthlyBurn(0, null, NOW)).toBe(0);
  });
});

describe("runwayMonths", () => {
  it("does not overstate a young workspace's runway by three times", () => {
    const burn = averageMonthlyBurn(100_000, "2026-09-15T00:00:00.000Z", NOW);
    // 400,000 in the bank, 100,000 a month going out: four months, not twelve.
    expect(runwayMonths(400_000, burn)).toBe(4);
  });

  it("is null — 'no burn recorded' — when nothing has been spent", () => {
    expect(runwayMonths(400_000, 0)).toBeNull();
  });
});

describe("monthElapsedFraction", () => {
  it("counts the UTC day of the month, including today", () => {
    expect(monthElapsedFraction(NOW)).toBeCloseTo(15 / 31, 12);
    expect(monthElapsedFraction(THIRD)).toBeCloseTo(3 / 31, 12);
  });

  it("is a whole month on the last day of the month", () => {
    expect(monthElapsedFraction(new Date("2026-10-31T00:00:00.000Z"))).toBe(1);
    // February, so the denominator is the real month length and not 31.
    expect(monthElapsedFraction(new Date("2027-02-28T00:00:00.000Z"))).toBe(1);
    expect(monthElapsedFraction(new Date("2027-02-14T00:00:00.000Z"))).toBeCloseTo(14 / 28, 12);
  });
});

describe("burnPaceDeltaPct", () => {
  const BURN = 100_000;
  /** Years of history, so these cases are about the pro-rating alone. A ledger
   *  younger than a month has no pace to compare against at all — the describe
   *  below. */
  const OLD = "2025-01-01T00:00:00.000Z";

  it("reads 0% for a workspace spending exactly at its average pace", () => {
    expect(burnPaceDeltaPct(BURN * (15 / 31), BURN, OLD, NOW)).toBe(0);
  });

  it("reads 0% on the 3rd of the month, where the old figure read -90%", () => {
    // THE SECOND HALF OF money-017: the un-pro-rated comparison made a
    // perfectly normal workspace look like it had stopped spending.
    expect(burnPaceDeltaPct(BURN * (3 / 31), BURN, OLD, THIRD)).toBe(0);
  });

  it("reads +100% for a workspace spending at twice its average pace", () => {
    expect(burnPaceDeltaPct(2 * BURN * (15 / 31), BURN, OLD, NOW)).toBe(100);
  });

  it("reads a real underspend as negative", () => {
    // Half the usual pace, a fortnight in.
    expect(burnPaceDeltaPct(0.5 * BURN * (15 / 31), BURN, OLD, NOW)).toBe(-50);
  });

  it("compares against the whole month on the last day of the month", () => {
    const endOfMonth = new Date("2026-10-31T00:00:00.000Z");
    expect(burnPaceDeltaPct(BURN, BURN, OLD, endOfMonth)).toBe(0);
    expect(burnPaceDeltaPct(BURN * 1.1, BURN, OLD, endOfMonth)).toBe(10);
  });

  it("is null when there is no average to compare against", () => {
    expect(burnPaceDeltaPct(5_000, 0, OLD, NOW)).toBeNull();
  });

  it("normalises -0, which would print as '+-0%'", () => {
    // A 0.1% drift under the pace rounds to -0, which passes `>= 0` and so takes
    // the product's explicit "+" branch while Intl renders the value as "-0%".
    const delta = burnPaceDeltaPct(BURN * (15 / 31) * 0.999, BURN, OLD, NOW);
    expect(delta).toBe(0);
    expect(Object.is(delta, -0)).toBe(false);
  });
});

/**
 * UNDER A MONTH OF LEDGER, THERE IS NO PACE TO COMPARE AGAINST.
 *
 * `burnMonthsCovered` floors the divisor at one month, so for a workspace whose
 * every row is inside the current month the "average" IS the month-to-date
 * total. Pro-rating a total against itself leaves
 * `(1 / monthElapsedFraction - 1) * 100` — the same figure for every workspace in
 * that population no matter what it has spent, large and positive early in the
 * month. money-017 existed to stop a young workspace being told something
 * misleading about its burn; a +933% that is pure arithmetic is the same defect
 * with a different sign. The card has an honest "no comparison" state (`null` →
 * "spent this month"), so it is used.
 */
describe("burnPaceDeltaPct on a ledger younger than one month", () => {
  /** Every row this workspace has is inside the current month: NOW is the 15th. */
  const STARTED_THIS_MONTH = "2026-10-01T00:00:00.000Z";

  it("says nothing for a workspace whose whole ledger is inside this month", () => {
    const spend = 40_000;
    // The self-reference, spelled out: the "average" and the month-to-date total
    // are the same number, so the comparison read +107% — and would read +107%
    // for every workspace in this population, whatever it had spent.
    expect(averageMonthlyBurn(spend, STARTED_THIS_MONTH, NOW)).toBe(spend);
    expect(burnPaceDeltaPct(spend, spend, STARTED_THIS_MONTH, NOW)).toBeNull();
    expect(burnPaceComparable(STARTED_THIS_MONTH, NOW)).toBe(false);
  });

  it("does not read wildly positive early in the month", () => {
    // On the 3rd the artefact was +933%, for 5,000 of spend and for 5 million
    // alike.
    for (const spend of [5_000, 5_000_000]) {
      const avg = averageMonthlyBurn(spend, STARTED_THIS_MONTH, THIRD);
      expect(burnPaceDeltaPct(spend, avg, STARTED_THIS_MONTH, THIRD)).toBeNull();
    }
  });

  it("says nothing for three weeks of ledger, where the divisor was floored", () => {
    // 2026-09-20 → 2026-10-15 is 0.84 months, clamped up to one. The clamp is the
    // bias: a truthful divisor would give a bigger average and a smaller delta,
    // so a steady spender read +19% here.
    const threeWeeks = "2026-09-20T00:00:00.000Z";
    expect(burnMonthsCovered(threeWeeks, NOW)).toBe(1);
    const avg = averageMonthlyBurn(26_000, threeWeeks, NOW);
    expect(burnPaceDeltaPct(15_000, avg, threeWeeks, NOW)).toBeNull();
  });

  it("still compares once a full month of ledger stands behind the average", () => {
    // Exactly one month: the divisor is truthful, and half of the average's
    // numerator is money from outside the month-to-date window, so the figure
    // carries information again. This is the boundary — it must not suppress
    // everything.
    const oneMonth = "2026-09-15T00:00:00.000Z";
    expect(burnPaceComparable(oneMonth, NOW)).toBe(true);
    expect(burnPaceDeltaPct(100_000 * (15 / 31), 100_000, oneMonth, NOW)).toBe(0);
    expect(burnPaceDeltaPct(2 * 100_000 * (15 / 31), 100_000, oneMonth, NOW)).toBe(100);
  });

  it("says nothing when the ledger start is unknown or unparseable", () => {
    // Unlike burn and runway, which must render something and so fall back to the
    // whole window, this figure has an honest absent state. A start that cannot be
    // shown to be a month old cannot justify the claim. (`null` from the server
    // means an empty ledger — getLedgerStart's `_min(date)` — which has no average
    // to compare against either way.)
    expect(burnPaceDeltaPct(5_000, 5_000, null, NOW)).toBeNull();
    expect(burnPaceDeltaPct(5_000, 5_000, undefined, NOW)).toBeNull();
    expect(burnPaceDeltaPct(5_000, 5_000, "not a date", NOW)).toBeNull();
  });

  it("says nothing for a ledger whose first row is in the future", () => {
    // Someone logging a scheduled payment: negative history, which the divisor
    // clamps to one month, so the same artefact.
    expect(burnPaceComparable("2026-12-01T00:00:00.000Z", NOW)).toBe(false);
    expect(burnPaceDeltaPct(5_000, 5_000, "2026-12-01T00:00:00.000Z", NOW)).toBeNull();
  });
});

/* ──────────────── the half that lives in the two call sites ─────────────── */

/**
 * ONE copy of the arithmetic, or this fixes half a product.
 *
 * /dashboard's Balance card and the chat runway card quote the same word —
 * "runway" — about the same workspace on the same afternoon. They had two
 * independent copies of the formula, kept in step by a comment asking the next
 * reader to keep them in step (the TODO at lib/actions/chat.ts). A fix applied
 * to one of them is worse than no fix: a customer reading both surfaces cannot
 * tell which number to believe.
 */
describe("both runway surfaces use this module", () => {
  const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  /** Booleans, not `expect(code).toContain(…)`: a failing match on a 1,200-line
   *  source prints the whole file into the runner's output. */
  const has = (code: string, needle: string | RegExp) =>
    typeof needle === "string" ? code.indexOf(needle) !== -1 : needle.test(code);

  it("/dashboard takes burn, runway and the pace delta from lib/finance/runway", () => {
    const code = source("app", "(app)", "dashboard", "dashboard-client.tsx");
    expect(has(code, "@/lib/finance/runway"), "no import of the shared module").toBe(true);
    expect(has(code, "averageMonthlyBurn"), "burn is still computed locally").toBe(true);
    expect(has(code, "burnPaceDeltaPct"), "the pace delta is still computed locally").toBe(true);
    // The defect, spelled exactly as it shipped.
    expect(
      has(code, /\/\s*BURN_WINDOW_MONTHS/),
      "still divides the window spend by the constant window length"
    ).toBe(false);
  });

  it("the chat runway card takes them from the same module", () => {
    const code = source("lib", "actions", "chat.ts");
    expect(has(code, "@/lib/finance/runway"), "no import of the shared module").toBe(true);
    expect(has(code, "averageMonthlyBurn"), "burn is still computed locally").toBe(true);
    expect(has(code, /last3MoExpenses\s*\/\s*3/), "still divides by a literal 3").toBe(false);
  });
});
