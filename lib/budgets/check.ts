/**
 * Post-write hook for addTransactionAction. After an expense lands, see if
 * any active budget for that category just crossed 80% or 100% and fan out
 * notifications.
 *
 * Project scoping:
 *   - If the transaction was tagged with a projectId, only that project's
 *     budgets get checked, the threshold sum aggregates ONLY project-tagged
 *     transactions, and the fan-out is limited to the supervisor + everyone
 *     with an assigned task on the project. The link points back to the
 *     project detail page.
 *   - If the transaction is project-less (legacy / non-project spend), we
 *     skip the budget check entirely — every Budget now belongs to a
 *     project, so there's nothing global to cross.
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
  projectId,
  category,
}: {
  companyId: string;
  projectId: string | null;
  category: string;
}): Promise<void> {
  // No project tag → no per-project budget to cross. We deliberately skip
  // here rather than aggregate company-wide — projects own budgets now.
  if (!projectId) return;

  try {
    const budget = await db.budget.findFirst({
      where: { projectId, category, active: true, deletedAt: null },
    });
    if (!budget) return; // no budget for this category in this project

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const sum = await db.transaction.aggregate({
      where: {
        companyId,
        projectId,
        deletedAt: null,
        type: "expense",
        category,
        date: { gte: monthStart, lt: nextMonthStart },
      },
      _sum: { amount: true },
    });
    // BUGS.md P0-4: aggregate + budget.monthlyLimit are Prisma.Decimal after
    // Float→Decimal. decideThreshold operates on numbers; convert at boundary.
    const monthToDate = sum._sum.amount ? sum._sum.amount.toNumber() : 0;
    const monthlyLimit = budget.monthlyLimit.toNumber();

    const decision = decideThreshold({ ...budget, monthlyLimit }, monthToDate, now);
    if (!decision) return;

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, supervisorId: true },
    });
    if (!project) return; // race: project deleted between writes

    const mk = monthKey(now);
    const limitLabel = monthlyLimit.toLocaleString();
    const spentLabel = monthToDate.toLocaleString();
    const pctLabel = Math.round(decision.percentUsed * 100);

    const title =
      decision.kind === "alert"
        ? `Budget exceeded: ${category} — ${project.name}`
        : `Budget alert: ${category} at ${pctLabel}% — ${project.name}`;
    const message =
      decision.kind === "alert"
        ? `${category} spend on ${project.name} is PKR ${spentLabel} — over the PKR ${limitLabel} monthly cap.`
        : `${category} on ${project.name} is at ${pctLabel}% of the PKR ${limitLabel} monthly cap (PKR ${spentLabel} so far).`;
    const notifType = decision.kind === "alert" ? "danger" : "warning";

    // Fan-out target: the supervisor + every assignee of a task in this
    // project. Replaces the old "every company member" blast so unrelated
    // teammates don't get pinged about budgets they don't own.
    await db.$transaction(async (tx) => {
      const assignees = await tx.task.findMany({
        where: { projectId },
        select: { assignedTo: true },
        distinct: ["assignedTo"],
      });
      const recipientIds = new Set<string>([project.supervisorId]);
      for (const a of assignees) recipientIds.add(a.assignedTo);

      if (recipientIds.size > 0) {
        await tx.notification.createMany({
          data: Array.from(recipientIds).map((userId) => ({
            userId,
            companyId,
            projectId,
            title,
            message,
            type: notifType,
            category: "finance",
            link: `/projects/${projectId}`,
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
      extra: { companyId, projectId, category },
    });
  }
}
