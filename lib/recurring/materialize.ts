/**
 * Pure materializer for recurring transactions. Given a list of rules + a
 * timestamp, returns the list of new transactions that should be created.
 *
 * Pulled out into a pure function so we can unit-test edge cases (month
 * boundaries, dayOfMonth=31 in February, idempotency on same-day reruns)
 * without spinning up Prisma or a clock-mock-friendly server action.
 *
 * Callers (cron route, manual trigger) are responsible for:
 *   1. Loading active rules from DB
 *   2. Passing them in
 *   3. Persisting the returned transactions in a $transaction alongside
 *      updating each rule's lastMaterializedAt = now
 */

import type { RecurringRule } from "@prisma/client";

export interface MaterializedTransaction {
  ruleId: string;
  companyId: string;
  type: "expense" | "investment";
  amount: number;
  category: string;
  description: string;
  addedBy: string;
  addedByName: string;
  /** ISO date for the Transaction.date field — we use `now` so the entry
   * lands in the month it fires; the recurring source is signaled by ruleId. */
  date: Date;
}

/**
 * Decide whether a single rule should fire on the given date.
 *
 * Monthly rule:
 *   - Fires when today's day-of-month matches rule.dayOfMonth, OR
 *   - today is the LAST day of the month AND rule.dayOfMonth > daysInMonth
 *     (clamps Jan-31 / Feb-30 / Apr-31 etc. to the last available day)
 *
 * Weekly rule:
 *   - Fires when today's day-of-week matches rule.dayOfWeek (0=Sun..6=Sat)
 *
 * Idempotency (deferred to the materializer below): a rule with
 * lastMaterializedAt within the current calendar day is skipped, so two
 * cron runs in the same UTC day can't double-fire.
 */
export function isRuleDueOn(rule: RecurringRule, when: Date): boolean {
  if (!rule.active) return false;
  // Don't fire before the rule's start date (avoids backfilling history).
  if (when < startOfDayUTC(rule.startDate)) return false;

  if (rule.frequency === "monthly") {
    if (rule.dayOfMonth == null) return false;
    const today = when.getUTCDate();
    const daysInMonth = new Date(
      Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + 1, 0)
    ).getUTCDate();
    // Exact match, OR clamp-to-last-day for the short-month case.
    return today === rule.dayOfMonth || (rule.dayOfMonth > daysInMonth && today === daysInMonth);
  }

  if (rule.frequency === "weekly") {
    if (rule.dayOfWeek == null) return false;
    return when.getUTCDay() === rule.dayOfWeek;
  }

  return false;
}

/**
 * Idempotency check: did this rule already fire today?
 * lastMaterializedAt is set to `now` after every successful run, so we
 * compare its UTC-date to today's UTC-date.
 */
export function alreadyFiredToday(rule: RecurringRule, when: Date): boolean {
  if (!rule.lastMaterializedAt) return false;
  return sameUTCDay(rule.lastMaterializedAt, when);
}

/**
 * Top-level: given all active rules + a clock, return the array of
 * transactions to materialize. Pure — no DB, no side effects.
 */
export function materialize(rules: RecurringRule[], when: Date): MaterializedTransaction[] {
  const out: MaterializedTransaction[] = [];
  for (const rule of rules) {
    if (!isRuleDueOn(rule, when)) continue;
    if (alreadyFiredToday(rule, when)) continue;
    out.push({
      ruleId: rule.id,
      companyId: rule.companyId,
      type: rule.type as "expense" | "investment",
      // BUGS.md P0-4: RecurringRule.amount is Prisma.Decimal after Float→Decimal.
      // The MaterializedTransaction shape stays `number` so downstream JSON
      // paths and tests don't have to know about Decimal.
      amount: rule.amount.toNumber(),
      category: rule.category,
      description: rule.description,
      addedBy: rule.addedBy,
      addedByName: rule.addedByName,
      date: when,
    });
  }
  return out;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function sameUTCDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
