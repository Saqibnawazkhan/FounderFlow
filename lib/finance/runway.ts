/**
 * Burn, runway, and the month-to-date pace comparison. ONE copy, for both
 * surfaces that quote them (money-017).
 *
 * ── WHY THIS MODULE EXISTS AT ALL ──────────────────────────────────────────
 * /dashboard's Balance card and the chat runway card
 * (`postRunwayCardAction` → components/chat/runway-card.tsx) both say the word
 * "runway" about the same workspace on the same afternoon. Until this file they
 * each had their own copy of the formula, kept in step by a comment asking the
 * next reader to keep them in step — the TODO(finance) that used to sit on
 * `runwayFigures` in lib/actions/chat.ts and that this module discharges. A
 * customer who reads both surfaces and sees two numbers has no way to tell which
 * one is lying, which is worse than one number that is wrong in a known way.
 *
 * Pure, so both a client component and a server action can import it, and so the
 * arithmetic is testable without rendering React or touching a database —
 * tests/lib/finance/runway.test.ts, whose last block asserts that both call
 * sites actually use this module, because a shared helper adopted by one of two
 * callers is exactly the drift it was written to prevent.
 *
 * ── WHAT WAS WRONG (money-017) ─────────────────────────────────────────────
 * Both copies divided the burn window's spend by a CONSTANT 3:
 *
 *     monthlyBurn = burnWindowExpense(…) / BURN_WINDOW_MONTHS   // dashboard
 *     monthlyBurn = last3MoExpenses / 3                         // runway card
 *
 * The window itself is a genuine three months wide (see `burnWindowStart`), so
 * the divisor is correct for a workspace that has existed for three months, and
 * wrong for every workspace younger than that — it averages the money over
 * months in which the company did not yet exist. A one-month-old workspace that
 * spent 100,000 reported a burn of 33,333 and therefore about THREE TIMES its
 * real runway. That is the wrong direction to be wrong in: the youngest
 * workspaces are the most cash-fragile, and runway is the number a founder makes
 * hiring and fundraising decisions on.
 *
 * The same constant produced the second half: the dashboard compared
 * MONTH-TO-DATE spend against a WHOLE-month average, so on the 3rd of the month
 * a workspace spending its perfectly normal amount read "-90% vs avg", and one
 * spending at twice its normal pace read "-3%". A comparison that is
 * structurally negative for three weeks out of four is noise with a minus sign.
 *
 * ── AND WHAT THE FIRST FIX LEFT (R2-money-017-pace) ────────────────────────
 * Pro-rating alone was not enough for the population money-017 was about. Under
 * a month of ledger the divisor below is CLAMPED to one month, so the "average"
 * is really a total — and for a workspace whose every row is inside the current
 * month that total is the month-to-date figure itself. The pace comparison then
 * returned `(1 / elapsed - 1) * 100` for everyone in that population regardless
 * of how much they had spent: +107% on the 15th, +933% on the 3rd. A young
 * workspace was told something new and equally meaningless. `burnPaceComparable`
 * now withholds the figure until there is a month of ledger behind the average;
 * burn and runway still print, because they have to.
 *
 * ── WHAT IS DELIBERATELY *NOT* CHANGED ─────────────────────────────────────
 * The window stays ROLLING and keeps the part-month we are in. A calendar window
 * ("the last N complete months") would exclude the current month's spend
 * entirely, which for a workspace in its first month means a burn of 0 and an
 * INFINITE runway — the same error as before, larger. lib/date-range.ts
 * `utcMonthsAgo` carries the rest of that reasoning.
 */

import { startOfUtcMonth, utcMonthsAgo } from "@/lib/date-range";

/**
 * Months in the rolling burn window.
 *
 * THE one copy of this number. `app/(app)/dashboard/windows.ts` re-exports it
 * for the RSC boundary (a `"use client"` module cannot hand a Server Component a
 * value — see that file), so the window the spend is summed over and the cap on
 * the divisor below cannot drift apart.
 */
export const BURN_WINDOW_MONTHS = 3;

/**
 * The lower bound of the burn window: UTC midnight, three calendar months back.
 *
 * Rolling rather than `startOfUtcMonth(now, -2)`, and UTC rather than date-fns
 * `subMonths` (which works in the runtime's local calendar while
 * `Transaction.date` is a date-only value stored at UTC midnight — money-007).
 */
export function burnWindowStart(now: Date): Date {
  return utcMonthsAgo(now, BURN_WINDOW_MONTHS);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const at = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(at.getTime()) ? null : at;
}

/** `at` shifted FORWARD by whole months, clamping into short months the way
 *  `utcMonthsAgo` clamps backwards (Jan 31 + 1mo = Feb 28, never Mar 3). */
function shiftUtcMonths(at: Date, months: number): Date {
  return utcMonthsAgo(at, -months);
}

/**
 * Calendar months between two instants, as a FRACTION — 1.5 means "a month and
 * a half of ledger".
 *
 * Whole months first, then the remainder as a fraction of the month it falls in,
 * so the unit is a real calendar month (28–31 days) rather than an average one.
 * A 30.44-day constant would quietly move a burn figure by up to 3% depending on
 * which months the window happened to span.
 */
function monthsElapsed(start: Date, now: Date): number {
  if (now.getTime() <= start.getTime()) return 0;
  let whole =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  if (whole < 0) whole = 0;
  let anchor = shiftUtcMonths(start, whole);
  // The month numbers can be one apart while the DAY is not yet reached
  // (Aug 30 → Oct 15 is one month and a half, not two).
  if (anchor.getTime() > now.getTime()) {
    whole -= 1;
    anchor = shiftUtcMonths(start, whole);
  }
  if (whole < 0) return 0;
  const next = shiftUtcMonths(start, whole + 1);
  const span = next.getTime() - anchor.getTime();
  if (span <= 0) return whole;
  const fraction = (now.getTime() - anchor.getTime()) / span;
  return whole + Math.min(1, Math.max(0, fraction));
}

/**
 * The floor on the burn divisor, in months — and the least ledger age the pace
 * comparison needs, which is the same number for the same reason: below it the
 * divisor is clamped, so the "average" is a total, and comparing a month-to-date
 * total against itself is arithmetic rather than a signal. ONE constant, so the
 * clamp and the suppression cannot drift apart (`burnPaceComparable`).
 */
const MIN_BURN_MONTHS = 1;

/**
 * How many months of the burn window the ledger ACTUALLY covers — the divisor
 * behind every burn figure in the product.
 *
 * `ledgerStartsAt` is the date of the workspace's earliest ledger row of any
 * type (`getLedgerStart()`), not its earliest EXPENSE: a company that existed
 * for three months and only started paying salaries last month really does have
 * a three-month average with two quiet months in it, and dividing that spend by
 * one would report a burn three times the money leaving the account.
 *
 * TWO CLAMPS, both deliberate:
 *
 *   • Capped at `BURN_WINDOW_MONTHS`, because the numerator only ever contains
 *     the window's spend. A ten-year-old ledger divided by 120 months is not a
 *     burn rate, it is a historical footnote.
 *   • Floored at ONE month (`MIN_BURN_MONTHS`), because the alternative is
 *     extrapolating a very small sample. A workspace three days old that has
 *     logged one office rent would otherwise report a burn ten times that rent
 *     and a runway of a few weeks. Under a month of history, the honest statement
 *     is "this is what you have spent so far", so the first partial month counts
 *     as one month. It errs towards a LOWER burn and therefore a higher runway
 *     for the first few weeks only, where no average yet exists to be right
 *     about. That the result is a total rather than an average in that regime is
 *     exactly why `burnPaceComparable` refuses to build a pace comparison on it.
 *
 * An unknown or unparseable start (`null` — an empty ledger, or a caller that
 * cannot supply one) falls back to the whole window, which is the behaviour
 * before this fix: a figure with no history to measure cannot be corrected by
 * guessing.
 */
export function burnMonthsCovered(
  ledgerStartsAt: Date | string | null | undefined,
  now: Date
): number {
  const start = toDate(ledgerStartsAt);
  if (!start) return BURN_WINDOW_MONTHS;
  return Math.min(BURN_WINDOW_MONTHS, Math.max(MIN_BURN_MONTHS, monthsElapsed(start, now)));
}

/**
 * Average monthly burn: the burn window's expense total over the months of
 * ledger that window actually covers.
 *
 * `windowExpense` is the expense total for `[burnWindowStart(now), now]` —
 * `getTransactionTotals({ from: burnWindowStart(now) })` on the server, or
 * `burnWindowExpense()` over the row array.
 */
export function averageMonthlyBurn(
  windowExpense: number,
  ledgerStartsAt: Date | string | null | undefined,
  now: Date
): number {
  if (!(windowExpense > 0)) return 0;
  return windowExpense / burnMonthsCovered(ledgerStartsAt, now);
}

/**
 * Months of runway, or `null` for "no burn recorded".
 *
 * `null` rather than `Infinity`: JSON cannot carry Infinity and
 * `RunwayPayloadSchema` rejects a non-finite number, so the chat card needed the
 * nullable spelling anyway — and one representation across both surfaces is the
 * point of this module. Negative cash on hand yields a negative figure on
 * purpose; the card and the stat label decide how to word that.
 */
export function runwayMonths(cashOnHand: number, avgMonthlyBurn: number): number | null {
  return avgMonthlyBurn > 0 ? cashOnHand / avgMonthlyBurn : null;
}

/**
 * How much of the current month has elapsed, as a fraction in (0, 1].
 *
 * The UTC day of the month over the real length of that UTC month — the same
 * calendar the month-to-date total is bucketed in (lib/date-range.ts). Reading
 * the LOCAL day here would compare a UTC-bucketed numerator against a
 * local-bucketed denominator, and on the 1st of the month west of UTC the two
 * disagree about which month it even is.
 *
 * Today counts as elapsed, so the fraction is never 0 and the 1st of the month
 * compares one day's spend against one day of average. The alternative,
 * `(day - 1) / daysInMonth`, divides by zero on the 1st.
 */
export function monthElapsedFraction(now: Date): number {
  const start = startOfUtcMonth(now);
  const next = startOfUtcMonth(now, 1);
  const daysInMonth = Math.round((next.getTime() - start.getTime()) / 86_400_000);
  return now.getUTCDate() / daysInMonth;
}

/**
 * Whether a "vs avg pace" comparison means anything at all for this ledger.
 *
 * It does not while the ledger is younger than `MIN_BURN_MONTHS`. Below that
 * floor `burnMonthsCovered` clamps the divisor, so `averageMonthlyBurn` stops
 * being an average and becomes "what you have spent so far" — and for a workspace
 * whose every row is inside the current month, that total IS the month-to-date
 * figure. Comparing it against a pro-rated copy of itself leaves
 * `(1 / monthElapsedFraction(now) - 1) * 100`, identical for every workspace in
 * that population however much it has spent: +107% on the 15th of a 31-day month,
 * +933% on the 3rd. Arithmetic, not a signal — and misleading a young workspace
 * about its burn is the defect money-017 was opened to remove
 * (R2-money-017-pace).
 *
 * Burn and runway take the clamp and err low because they have to print
 * something. This figure does not have to: the caller's `null` branch is prose
 * ("spent this month"), so when there is no pace to compare against it says
 * nothing.
 *
 * An unknown or unparseable start is NOT comparable — the inverse of
 * `burnMonthsCovered`'s fallback, for that same reason: a start that cannot be
 * shown to be a month old cannot justify the claim. From the server `null` means
 * an empty ledger (`getLedgerStart`'s `_min(date)`), which has no average to
 * compare against either way.
 */
export function burnPaceComparable(
  ledgerStartsAt: Date | string | null | undefined,
  now: Date
): boolean {
  const start = toDate(ledgerStartsAt);
  if (!start) return false;
  return monthsElapsed(start, now) >= MIN_BURN_MONTHS;
}

/**
 * Month-to-date spend against the SAME FRACTION of an average month — the
 * dashboard's "vs avg pace" figure, as a whole-number percent.
 *
 * Pro-rating is the whole point: comparing 12 days of spend against a 30-day
 * average answers "is the month over yet", which the calendar already answers.
 * `null` means there is nothing to compare against — nothing spent in the window,
 * or no month of ledger behind the average (`burnPaceComparable`) — which the
 * caller renders as prose rather than as 0%.
 *
 * `ledgerStartsAt` is the same value `averageMonthlyBurn` was given, and it is
 * required rather than optional on purpose: an omitted one would silently restore
 * the self-referential figure for exactly the workspaces that must not see it.
 *
 * A whole number rather than a 0–1 ratio because the caller's sign test reads
 * it, and `|| 0` normalises -0: a 0.1% drift under the pace rounds to -0, which
 * passes `>= 0` and so takes the product's explicit "+" branch while Intl
 * renders the value itself as "-0%", printing "+-0%".
 */
export function burnPaceDeltaPct(
  monthToDateExpense: number,
  avgMonthlyBurn: number,
  ledgerStartsAt: Date | string | null | undefined,
  now: Date
): number | null {
  if (!(avgMonthlyBurn > 0)) return null;
  if (!burnPaceComparable(ledgerStartsAt, now)) return null;
  const expectedSoFar = avgMonthlyBurn * monthElapsedFraction(now);
  if (!(expectedSoFar > 0)) return null;
  return Math.round(((monthToDateExpense - expectedSoFar) / expectedSoFar) * 100) || 0;
}
