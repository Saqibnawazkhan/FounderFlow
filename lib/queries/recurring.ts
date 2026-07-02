/**
 * Read-side queries for recurring rules. Pairs with lib/actions/recurring.ts
 * which owns create/toggle/delete.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";

export interface RecurringRuleClient {
  id: string;
  companyId: string;
  type: "expense" | "investment";
  amount: number;
  category: string;
  description: string;
  addedBy: string;
  addedByName: string;
  frequency: "monthly" | "weekly";
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  active: boolean;
  startDate: string;
  lastMaterializedAt: string | null;
  createdAt: string;
  /** Count of Transaction rows already generated from this rule. */
  materializedCount: number;
}

export async function getRecurringRules(): Promise<RecurringRuleClient[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.recurringRule.findMany({
    where: { companyId },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { transactions: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    type: r.type as "expense" | "investment",
    // BUGS.md P0-4: RecurringRule.amount is Prisma.Decimal.
    amount: r.amount.toNumber(),
    category: r.category,
    description: r.description,
    addedBy: r.addedBy,
    addedByName: r.addedByName,
    frequency: r.frequency as "monthly" | "weekly",
    dayOfMonth: r.dayOfMonth,
    dayOfWeek: r.dayOfWeek,
    active: r.active,
    startDate: r.startDate.toISOString(),
    lastMaterializedAt: r.lastMaterializedAt ? r.lastMaterializedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    materializedCount: r._count.transactions,
  }));
}
