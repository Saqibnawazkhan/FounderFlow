/**
 * Read-side queries for budgets. The /budgets page consumes BudgetWithSpend
 * which folds in the current-month expense total per category so we can
 * render the progress bar without a second client-side round trip.
 *
 * Project scoping (post add_projects):
 *   - `getBudgetsWithSpend()` — every budget in the caller's company.
 *   - `getBudgetsWithSpend({ projectId })` — scoped to one project, AND
 *     spend is summed from only THAT project's transactions. The legacy
 *     unscoped call sums all company expense, including project-tagged
 *     ones, so the /budgets global page keeps its existing semantics.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";

export interface BudgetClient {
  id: string;
  companyId: string;
  projectId: string;
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

export async function getBudgetsWithSpend(
  opts: { projectId?: string } = {}
): Promise<BudgetWithSpend[]> {
  const { companyId } = await requireScopedSession();

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const budgets = await db.budget.findMany({
    where: { companyId, deletedAt: null, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });

  if (budgets.length === 0) return [];

  // One sum per category in a single groupBy. Bounded by the budget rows so
  // we don't sum categories we don't have budgets for. When scoped to a
  // project, the spend sum filters by that projectId — the threshold check
  // does the same so the figures stay in lock step.
  const categories = Array.from(new Set(budgets.map((b) => b.category)));
  const sums = await db.transaction.groupBy({
    by: ["category"],
    where: {
      companyId,
      deletedAt: null,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      type: "expense",
      category: { in: categories },
      date: { gte: monthStart, lt: nextMonthStart },
    },
    _sum: { amount: true },
  });
  // BUGS.md P0-4: `_sum` and `monthlyLimit` are `Prisma.Decimal` after the
  // Float→Decimal migration. Convert to Number at the client-shape
  // boundary — the RSC / JSON transport needs a primitive.
  const spendByCategory = new Map<string, number>(
    sums.map((s) => [s.category, s._sum.amount ? s._sum.amount.toNumber() : 0])
  );

  return budgets.map((b) => {
    const spend = spendByCategory.get(b.category) ?? 0;
    const limit = b.monthlyLimit.toNumber();
    return {
      id: b.id,
      companyId: b.companyId,
      projectId: b.projectId,
      category: b.category,
      monthlyLimit: limit,
      createdBy: b.createdBy,
      createdByName: b.createdByName,
      active: b.active,
      lastWarnedMonth: b.lastWarnedMonth,
      lastAlertedMonth: b.lastAlertedMonth,
      createdAt: b.createdAt.toISOString(),
      monthToDateSpend: spend,
      percentUsed: limit > 0 ? spend / limit : 0,
    };
  });
}
