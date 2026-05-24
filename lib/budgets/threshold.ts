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

/**
 * Apply a fired decision back to the budget's "last fired" fields so the
 * caller can persist them. We mutate-by-return to keep the function pure
 * (caller decides whether to update DB).
 */
export function applyDecision<T extends BudgetForCheck>(budget: T, decision: ThresholdDecision): T {
  const mk = monthKey(new Date()); // caller passes `now`; we use a fresh key
  if (decision.kind === "alert") {
    return { ...budget, lastAlertedMonth: mk, lastWarnedMonth: mk };
  }
  return { ...budget, lastWarnedMonth: mk };
}
