/**
 * Read-side queries for recurring rules. Pairs with lib/actions/recurring.ts
 * which owns create/toggle/delete.
 *
 * ── WHO MAY ASK (sec-002) ──────────────────────────────────────────────────
 * `requireFinanceSession()`, matching the three WRITE paths next door: every one
 * of `createRecurringRuleAction`, `toggleRecurringRuleAction` and
 * `deleteRecurringRuleAction` already refuses a caller who fails
 * `canSeeFinances` (lib/actions/recurring.ts:34, :146, :178). The read did not,
 * so a demoted co-founder could not change a rule but could still list every
 * standing payment the company makes, with its amount — for as long as their
 * cookie's stale `role` claim survived. `/recurring` is in
 * `MEMBER_BLOCKED_ROUTES` and app/(app)/recurring/page.tsx is the only caller,
 * so the redirect can only fire for that stale cookie.
 * Pinned in tests/lib/queries/finance-reader-gates.test.ts.
 */

import { db } from "@/lib/db";
import { requireFinanceSession } from "@/lib/queries/session";

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
  const { companyId } = await requireFinanceSession();
  const rows = await db.recurringRule.findMany({
    // RecurringRule has no own deletedAt; scope to a live company so a stale
    // session in a soft-deleted workspace can't read its rules back.
    where: { companyId, company: { deletedAt: null } },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    include: { _count: { select: { transactions: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    type: r.type as "expense" | "investment",
    // FaultsAudit.md P0-4: RecurringRule.amount is Prisma.Decimal.
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
