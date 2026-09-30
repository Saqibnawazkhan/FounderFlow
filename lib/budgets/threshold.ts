/**
 * Pure helpers for budget-threshold logic. Pulled out of the action layer
 * so they can be unit-tested without Prisma.
 *
 * Threshold semantics:
 *   • warning  = monthToDate >= 80% of monthlyLimit AND not yet fired this month
 *   • alert    = monthToDate >= 100% of monthlyLimit AND not yet fired this month
 *
 * We track per-month "last fired" sentinels (YYYY-MM strings) so each
 * threshold fires once per calendar month. Crossing 80% on the 5th + then
 * adding another expense on the 6th won't double-notify; rolling into the
 * next month resets both sentinels.
 */

export const WARN_PCT = 0.8;
export const ALERT_PCT = 1.0;

export type BudgetThresholdKind = "warning" | "alert";

export interface BudgetForCheck {
  id: string;
  monthlyLimit: number;
  lastWarnedMonth: string | null;
  lastAlertedMonth: string | null;
}

export interface ThresholdDecision {
  budgetId: string;
  kind: BudgetThresholdKind;
  percentUsed: number; // 0..>1
}

/** Returns "YYYY-MM" for a Date in UTC. */
export function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Sentinel columns to CLEAR, or null when there is nothing to correct. */
export interface RearmDecision {
  lastWarnedMonth?: null;
  lastAlertedMonth?: null;
}

/**
 * Should a budget's fired sentinels be cleared, because the spend they were fired
 * about is no longer there? finance-planning-005.
 *
 * THE BUG THIS EXISTS FOR. The sentinels below are per-MONTH, and nothing ever
 * cleared them — a grep across lib/ found writes only in lib/budgets/check.ts,
 * and only ever setting them. So a founder who fat-fingered 5,000,000 instead of
 * 5,000 got the 100% alert emailed and pushed to everyone who can see the
 * project's money, deleted the typo, and then had a budget that would not warn or
 * alert again until the 1st of the next month however much the project really
 * spent. The sentinel recorded "we notified THIS MONTH" when the thing worth
 * recording is "we notified about THIS STATE".
 *
 * PER THRESHOLD, not one flag for both, because the two thresholds mean different
 * things:
 *
 *   • under 80% → both clear. Neither threshold is crossed, so neither claim is
 *     true any more.
 *   • 80-100% → the ALERT sentinel clears; the warning one does not. They have
 *     already been told they are at 85% and repeating it is noise — but a genuine
 *     crossing of 100% later in the month is news, and under the old behaviour it
 *     was silence.
 *   • at or over 100% → nothing. The alert they were sent is still true.
 *
 * Returns null rather than an empty object when there is nothing to do, so the
 * caller writes only when it has a correction to make. That matters: the write is
 * a row lock on a budget two concurrent expenses may share, and a re-arm on every
 * expense would be a heartbeat rather than a correction.
 *
 * A sentinel from a PREVIOUS month is left alone: `decideThreshold` already reads
 * it as "not this month", so clearing it would be a write that changes no
 * decision. And a zero or negative cap is left alone for the same reason
 * `decideThreshold` refuses it — the percentage is NaN or infinite and the two
 * functions must agree about the degenerate row or one of them writes on it.
 */
export function decideRearm(
  budget: BudgetForCheck,
  monthToDateSpend: number,
  now: Date
): RearmDecision | null {
  if (budget.monthlyLimit <= 0) return null;
  const pct = monthToDateSpend / budget.monthlyLimit;
  const mk = monthKey(now);

  const clearWarned = budget.lastWarnedMonth === mk && pct < WARN_PCT;
  const clearAlerted = budget.lastAlertedMonth === mk && pct < ALERT_PCT;
  if (!clearWarned && !clearAlerted) return null;

  const decision: RearmDecision = {};
  if (clearWarned) decision.lastWarnedMonth = null;
  if (clearAlerted) decision.lastAlertedMonth = null;
  return decision;
}

/**
 * Decide whether a budget should fire a notification given the current
 * month-to-date spend. Returns the strongest applicable kind (alert beats
 * warning) or null if no fresh threshold was crossed.
 */
export function decideThreshold(
  budget: BudgetForCheck,
  monthToDateSpend: number,
  now: Date
): ThresholdDecision | null {
  if (budget.monthlyLimit <= 0) return null;
  const pct = monthToDateSpend / budget.monthlyLimit;
  const mk = monthKey(now);

  // Alert wins — if we crossed 100%, send the alert (whether or not the
  // 80% warning fired earlier). Suppress duplicate alerts within the month.
  if (pct >= ALERT_PCT && budget.lastAlertedMonth !== mk) {
    return { budgetId: budget.id, kind: "alert", percentUsed: pct };
  }
  // Otherwise check the 80% warning.
  if (pct >= WARN_PCT && pct < ALERT_PCT && budget.lastWarnedMonth !== mk) {
    return { budgetId: budget.id, kind: "warning", percentUsed: pct };
  }
  return null;
}
