/**
 * Read-side queries for budgets. The /budgets page consumes BudgetWithSpend
 * which folds in the current-month expense total per category so we can
 * render the progress bar without a second client-side round trip.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";

export interface BudgetClient {
  id: string;
  companyId: string;
  category: string;
  monthlyLimit: number;
  createdBy: string;
  createdByName: string;
  active: boolean;
  lastWarnedMonth: string | null;
  lastAlertedMonth: string | null;
  createdAt: string;
}

export interface BudgetWithSpend extends BudgetClient {
  monthToDateSpend: number;
  percentUsed: number; // 0..>1 — caller decides whether to clamp the bar
}

export async function getBudgetsWithSpend(): Promise<BudgetWithSpend[]> {
  const { companyId } = await requireScopedSession();

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const budgets = await db.budget.findMany({
    where: { companyId },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });

  if (budgets.length === 0) return [];

  // One sum per category in a single groupBy. Bounded by the budget rows so
  // we don't sum categories we don't have budgets for.
  const categories = Array.from(new Set(budgets.map((b) => b.category)));
  const sums = await db.transaction.groupBy({
    by: ["category"],
    where: {
      companyId,
      type: "expense",
      category: { in: categories },
      date: { gte: monthStart, lt: nextMonthStart },
    },
    _sum: { amount: true },
  });
  const spendByCategory = new Map<string, number>(
    sums.map((s) => [s.category, s._sum.amount ?? 0])
  );

  return budgets.map((b) => {
    const spend = spendByCategory.get(b.category) ?? 0;
    return {
      id: b.id,
      companyId: b.companyId,
      category: b.category,
      monthlyLimit: b.monthlyLimit,
      createdBy: b.createdBy,
      createdByName: b.createdByName,
      active: b.active,
      lastWarnedMonth: b.lastWarnedMonth,
      lastAlertedMonth: b.lastAlertedMonth,
      createdAt: b.createdAt.toISOString(),
      monthToDateSpend: spend,
      percentUsed: b.monthlyLimit > 0 ? spend / b.monthlyLimit : 0,
    };
  });
}
