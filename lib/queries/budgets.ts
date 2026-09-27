/**
 * Read-side queries for budgets. The /budgets page consumes BudgetWithSpend
 * which folds in the current-month expense total per category so we can
 * render the progress bar without a second client-side round trip.
 *
 * Project scoping (post add_projects):
 *   - `getBudgetsWithSpend()` — every budget in the caller's company, each
 *     charged the spend of ITS OWN project.
 *   - `getBudgetsWithSpend({ projectId })` — the same, narrowed to one
 *     project's budgets. Both modes compute spend identically; the only
 *     difference is which budget ROWS come back.
 *
 * money-004 — WHAT THIS DOC COMMENT USED TO CLAIM, AND WHY IT WAS WRONG. It
 * said the unscoped call "sums all company expense … so the /budgets global
 * page keeps its existing semantics", as though that were a design decision.
 * It was the bug: the sum was grouped by `category` alone and the one figure
 * was mapped onto every budget row carrying that category, so a project's cap
 * was charged other projects' spend AND untagged spend. Two 1,000 rent caps
 * with 600 and 900 spent both rendered "Spent 900 of 1,000"; a cap 60% used
 * rendered as Over. Meanwhile /projects/[id] (which passed a projectId) and
 * the alert in lib/budgets/check.ts (which sums `{ companyId, projectId,
 * category }`) both read the true, smaller figure — so the page screamed and
 * the notification stayed silent, which is the worst combination available.
 *
 * A "budget" here is per PROJECT: `Budget.projectId` is NOT NULL (add_projects
 * back-filled every legacy row to a "General" project per company). There is no
 * company-wide cap to display, so there is nothing for the unscoped page to sum
 * company-wide. If one is ever wanted it needs its own row shape and its own
 * label — not a project's cap quietly measuring everyone's spend.
 *
 * Untagged spend (`Transaction.projectId IS NULL`) counts against NO cap, which
 * is the rule lib/budgets/check.ts already enforces by returning early for an
 * untagged expense. This file has to ask the same question or the page and the
 * alert disagree again.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { startOfUtcMonth } from "@/lib/date-range";

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

/** Map key for a (project, category) spend bucket. See the NUL note below. */
function spendKey(projectId: string, category: string): string {
  return `${projectId}\u0000${category}`;
}

export async function getBudgetsWithSpend(
  opts: { projectId?: string } = {}
): Promise<BudgetWithSpend[]> {
  const { companyId } = await requireScopedSession();

  // The UTC calendar month — the same boundary lib/budgets/check.ts,
  // lib/queries/projects.ts and (since money-007) the client cards use. Spelled
  // once in lib/date-range.ts now; the inline `Date.UTC(y, m, 1)` that used to
  // sit here is how a second, local-calendar spelling got into the clients
  // without anyone noticing the two disagreed.
  const now = new Date();
  const monthStart = startOfUtcMonth(now);
  const nextMonthStart = startOfUtcMonth(now, 1);

  const budgets = await db.budget.findMany({
    where: { companyId, deletedAt: null, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
  });

  if (budgets.length === 0) return [];

  // One sum per (project, category) pair in a single groupBy — grouping by
  // category ALONE was money-004, because two projects capping the same
  // category collapsed into one map entry and the last row won.
  //
  // Both bounds matter:
  //   • `category: { in: … }` so we don't sum categories nobody capped.
  //   • `projectId: { in: … }` so an expense tagged to a project WITHOUT a cap
  //     — and, critically, an UNTAGGED expense (projectId IS NULL) — can never
  //     land on someone else's cap. Prisma's `in` excludes NULL, which is
  //     exactly the semantics lib/budgets/check.ts gets from returning early
  //     on an untagged expense.
  const categories = Array.from(new Set(budgets.map((b) => b.category)));
  const budgetProjectIds = Array.from(new Set(budgets.map((b) => b.projectId)));
  const sums = await db.transaction.groupBy({
    by: ["projectId", "category"],
    where: {
      companyId,
      deletedAt: null,
      // Scoped mode narrows to the one project; unscoped mode still constrains
      // to the projects that have budgets rather than leaving projectId open.
      projectId: opts.projectId ? opts.projectId : { in: budgetProjectIds },
      type: "expense",
      category: { in: categories },
      date: { gte: monthStart, lt: nextMonthStart },
    },
    _sum: { amount: true },
  });
  // FaultsAudit.md P0-4: `_sum` and `monthlyLimit` are `Prisma.Decimal` after the
  // Float→Decimal migration. Convert to Number at the client-shape
  // boundary — the RSC / JSON transport needs a primitive.
  //
  // NUL as the key separator, not "-" or ":": a cuid never contains one and a
  // category is free text, so ("p1", "Rent-2") and ("p1-Rent", "2") cannot
  // collide into one entry the way they could with a printable delimiter.
  const spendByProjectCategory = new Map<string, number>();
  for (const s of sums) {
    // `by` on a nullable column widens the row type to `string | null`. The
    // `in` filter above already excludes NULL; this narrows for TS and would
    // drop an untagged row if that filter were ever loosened.
    if (!s.projectId) continue;
    spendByProjectCategory.set(
      spendKey(s.projectId, s.category),
      s._sum.amount ? s._sum.amount.toNumber() : 0
    );
  }

  return budgets.map((b) => {
    const spend = spendByProjectCategory.get(spendKey(b.projectId, b.category)) ?? 0;
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
