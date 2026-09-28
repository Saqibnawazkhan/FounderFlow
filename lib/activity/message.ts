/**
 * Reading money back out of an activity row (money-006, the read half).
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 * `Activity.message` is prose written ONCE and read by every member of the
 * workspace forever. Whatever figure the writer interpolated is frozen into it:
 * the grouping, the number of decimal places, and — until 2026-09-28 — no
 * currency code at all. So a workspace's ledger history is only ever as right as
 * the formatting decision that happened to be in force on the day, and no later
 * code change repairs it. That is money-001 (a `Decimal(12,2)` written as
 * "1,234.5" by `toLocaleString()`, whose grouping also depended on the host
 * container's LANG) and money-006 (an AED workspace's history with no code, or
 * a hardcoded "PKR", on every row).
 *
 * The writers now ALSO put `{ amount, currency }` into `Activity.metadata`
 * (lib/actions/transactions.ts:212, lib/actions/recurring.ts). This module is
 * the reader that was missing — without it that metadata is data written for a
 * consumer that does not exist, which is the defect this codebase produces most.
 *
 * ── WHAT IT DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────
 * It re-renders the FIGURE through `formatCurrency` at read time and leaves
 * every other character of the sentence alone. Two consequences, both the point:
 *
 *   • Scale and grouping come from today's `currencyMinorUnits` table, so a
 *     history full of "1,234.5" and "1,234" for the same column becomes
 *     consistent without a backfill anybody could actually perform.
 *   • The CURRENCY is the one the row was written in, taken from the row. It is
 *     never re-derived from the live company: a workspace that switches from PKR
 *     to USD must not have its rupee history relabelled as dollars — a ~280x
 *     misreading dressed as a formatting preference. Same reasoning as
 *     components/chat/runway-card.tsx:50.
 *
 * And when the row cannot prove its own figure, the message is returned BYTE
 * IDENTICAL. A partial rewrite of an audit trail is worse than stale
 * formatting, so every uncertain case falls back to what was written.
 */

import type { ActivityMetadata } from "@/lib/types";
import { formatAmountForMessage, formatCurrency } from "@/lib/utils";

/** ISO 4217 is three letters. Also the guard that keeps an unvalidated value
 *  out of the `RegExp` constructor below — `metadata` is JSON parsed out of a
 *  text column and cast, never validated, so "P.*R" is a value it can hold. */
const ISO_4217 = /^[A-Za-z]{3}$/;

export interface ActivityMoney {
  amount: number;
  currency: string;
}

/**
 * The amount + currency a row carries, or null if it carries neither usably.
 *
 * Read STRUCTURALLY rather than by narrowing on `kind`, on purpose. The rows
 * this most needs to reach are the recurring ones, and the nightly materializer
 * writes `kind: "expense"` / `"investment"` — values `ActivityMetadata` has
 * never declared. Keying on the discriminant would silently exclude exactly the
 * spend money-005 just made budget-relevant, and would break again the next time
 * a writer invents a kind. What matters is whether the two fields are there.
 */
export function activityMoney(metadata?: ActivityMetadata): ActivityMoney | null {
  if (!metadata || typeof metadata !== "object") return null;
  const { amount, currency } = metadata as { amount?: unknown; currency?: unknown };
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (typeof currency !== "string" || !ISO_4217.test(currency)) return null;
  return { amount, currency };
}

/** Occurrences of `needle` in `haystack`, without a regex. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The message as it should be READ today: the same sentence, with its money
 * re-rendered from the row's own structured record of it.
 *
 * Two passes, strictest first:
 *
 *  1. The exact token today's writers bake in —
 *     `` `${formatAmountForMessage(amount, currency)} ${currency}` ``. If it
 *     occurs exactly once there is nothing to guess about, even if some other
 *     figure shares the sentence.
 *  2. A legacy row, written before the code travelled with the figure or with a
 *     floating scale. Match a digit run sitting immediately against the currency
 *     code. Only if there is EXACTLY ONE such run — two means the only way to
 *     choose is to guess, and a wrong guess restates a customer's ledger.
 *
 * Anything else returns `message` unchanged.
 */
export function activityDisplayMessage(message: string, metadata?: ActivityMetadata): string {
  const money = activityMoney(metadata);
  if (!money) return message;

  const live = formatCurrency(money.amount, money.currency);

  const baked = `${formatAmountForMessage(money.amount, money.currency)} ${money.currency}`;
  if (countOccurrences(message, baked) === 1) return message.replace(baked, live);

  // NBSP (U+00A0) and NARROW NBSP (U+202F) are in the class because CLDR
  // grouping emits them and `sanitizeNumericOutput` only ever ran on figures
  // this app formatted itself — a row written by an older build can still hold
  // one. The code is `ISO_4217`-checked above, so nothing user-supplied reaches
  // the pattern.
  const nearCode = new RegExp(`\\d[\\d.,   ]*${money.currency}`, "g");
  const found = message.match(nearCode);
  if (!found || found.length !== 1) return message;
  return message.replace(nearCode, live);
}
