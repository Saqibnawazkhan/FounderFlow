/**
 * Post-write hook for addTransactionAction. After an expense lands, see if
 * any active budget for that category just crossed 80% or 100% and fan out
 * notifications to every company member.
 *
 * Failure mode: this runs OUTSIDE the addTransaction $transaction on
 * purpose. A budget-check error must NEVER roll back the user's expense.
 * We swallow + log instead.
 */

import { db } from "@/lib/db";
import { decideThreshold, monthKey } from "@/lib/budgets/threshold";
import { captureServerError } from "@/lib/sentry-server";

export async function checkBudgetThresholdAfterExpense({
  companyId,
  category,
}: {
  companyId: string;
  category: string;
}): Promise<void> {
  try {
    const budget = await db.budget.findFirst({
      where: { companyId, category, active: true },
    });
    if (!budget) return; // no budget for this category — nothing to check

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const sum = await db.transaction.aggregate({
      where: {
        companyId,
        type: "expense",
        category,
        date: { gte: monthStart, lt: nextMonthStart },
      },
      _sum: { amount: true },
    });
    const monthToDate = sum._sum.amount ?? 0;

    const decision = decideThreshold(budget, monthToDate, now);
    if (!decision) return;

    const mk = monthKey(now);
    const limitLabel = budget.monthlyLimit.toLocaleString();
    const spentLabel = monthToDate.toLocaleString();
    const pctLabel = Math.round(decision.percentUsed * 100);

    const title =
      decision.kind === "alert"
        ? `Budget exceeded: ${category}`
        : `Budget alert: ${category} at ${pctLabel}%`;
    const message =
      decision.kind === "alert"
        ? `${category} spend is PKR ${spentLabel} — over the PKR ${limitLabel} monthly cap.`
        : `${category} is at ${pctLabel}% of the PKR ${limitLabel} monthly cap (PKR ${spentLabel} so far).`;
    const notifType = decision.kind === "alert" ? "danger" : "warning";

    // Fan-out + update the budget's "last fired this month" sentinel in one
    // $transaction so we can't end up with notifications but no sentinel
    // (would re-spam everyone on the next expense).
    await db.$transaction(async (tx) => {
      const members = await tx.user.findMany({
        where: { companyId },
        select: { id: true },
      });
      if (members.length > 0) {
        await tx.notification.createMany({
          data: members.map((m) => ({
            userId: m.id,
            companyId,
            title,
            message,
            type: notifType,
            link: "/budgets",
          })),
        });
      }
      await tx.budget.update({
        where: { id: budget.id },
        data:
          decision.kind === "alert"
            ? { lastAlertedMonth: mk, lastWarnedMonth: mk }
            : { lastWarnedMonth: mk },
      });
    });
  } catch (e) {
    // Non-fatal — log + capture, never rethrow.
    captureServerError(e, {
      action: "checkBudgetThresholdAfterExpense",
      extra: { companyId, category },
    });
  }
}
