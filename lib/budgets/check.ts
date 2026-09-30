/**
 * Post-write hook for addTransactionAction. After an expense lands, see if
 * any active budget for that category just crossed 80% or 100% and fan out
 * notifications.
 *
 * Project scoping:
 *   - If the transaction was tagged with a projectId, only that project's
 *     budgets get checked, the threshold sum aggregates ONLY project-tagged
 *     transactions, and the fan-out is limited to the people allowed to see
 *     that project's money. The link points back to the project detail page.
 *   - If the transaction is project-less (legacy / non-project spend), we
 *     skip the budget check entirely — every Budget now belongs to a
 *     project, so there's nothing global to cross.
 *
 * Failure mode: this runs OUTSIDE the addTransaction $transaction on
 * purpose. A budget-check error must NEVER roll back the user's expense.
 * We swallow + log instead.
 *
 * Delivery: at most one notification per threshold per calendar month, even
 * when two expenses land concurrently. The per-month sentinel on the Budget
 * row is claimed with a conditional update before anything fans out — see
 * the comment on that update for why the ordering and the WHERE clause are
 * both load-bearing.
 *
 * WHO IT REACHES — the strictest figures in the product. This message carries
 * both a budget's cap and its spend, and `budget_alert` defaults to
 * `{ inApp: true, email: true, push: true }` (lib/notify/preferences.ts:45),
 * so it is an inbox and a lock screen, not just a dropdown — unrecallable the
 * moment it is sent. The recipient set used to be the supervisor PLUS every
 * assignee of any task in the project, with `canSeeProjectFinances` never
 * consulted, so assigning a contractor one task disclosed the project's budget
 * to them by default, with no setting that could prevent it. Finding sec-006;
 * lib/auth/project-permissions.ts:15-17 is explicit that an assigned member
 * does NOT see the Budgets tab. The recipient list is now filtered through
 * that same predicate, and plain assignees are dropped rather than sent a
 * redacted variant: the link goes to a page whose Budgets tab is empty for
 * them, so a ping they cannot act on is noise as well as a leak.
 */

import { db } from "@/lib/db";
import { decideRearm, decideThreshold, monthKey } from "@/lib/budgets/threshold";
import { captureServerError } from "@/lib/sentry-server";
import { notifyUsers } from "@/lib/notify/fan-out";
import { canSeeProjectFinances } from "@/lib/auth/project-permissions";
import type { Role } from "@/lib/auth/role-gates";

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
    // FaultsAudit.md P0-4: aggregate + budget.monthlyLimit are Prisma.Decimal after
    // Float→Decimal. decideThreshold operates on numbers; convert at boundary.
    const monthToDate = sum._sum.amount ? sum._sum.amount.toNumber() : 0;
    const monthlyLimit = budget.monthlyLimit.toNumber();

    // finance-planning-005 — RE-ARM BEFORE DECIDING.
    //
    // The month sentinels were only ever set, never cleared, so a budget went
    // silent for the rest of the calendar month the moment it fired once —
    // including after the mis-typed expense that tripped it was deleted. The
    // sentinel recorded "we notified this month" when the claim worth recording is
    // "we notified about this state". `decideRearm` clears each sentinel when its
    // own threshold is no longer crossed; see it for why the two thresholds
    // re-arm at different points.
    //
    // Before, not after: a correction applied afterwards would be judged against
    // the state it was supposed to correct. The two are mutually exclusive per
    // threshold anyway — a sentinel only clears while its threshold is BELOW the
    // line, at which point `decideThreshold` would not have fired it.
    //
    // The write pins the observed sentinel values, exactly like the claim further
    // down: if a concurrent expense has just fired this threshold, this pass's
    // snapshot is stale and it must not undo their claim.
    let sentinels = {
      lastWarnedMonth: budget.lastWarnedMonth,
      lastAlertedMonth: budget.lastAlertedMonth,
    };
    const rearm = decideRearm({ ...budget, monthlyLimit }, monthToDate, now);
    if (rearm) {
      const cleared = await db.budget.updateMany({
        where: {
          id: budget.id,
          lastWarnedMonth: budget.lastWarnedMonth,
          lastAlertedMonth: budget.lastAlertedMonth,
        },
        data: rearm,
      });
      // Only believe the re-arm landed if it did. Losing the race means somebody
      // else's decision is now the current state and ours was computed from a
      // stale read, so this pass stops rather than deciding from a mixture.
      if (cleared.count === 0) return;
      sentinels = { ...sentinels, ...rearm };
    }

    const decision = decideThreshold({ ...budget, ...sentinels, monthlyLimit }, monthToDate, now);
    if (!decision) return;

    const [project, company] = await Promise.all([
      db.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, supervisorId: true },
      }),
      // The workspace's chosen currency. Per-workspace currency shipped in
      // 5bb359c and this string never got threaded, so a USD or AED workspace
      // had its own money labelled "PKR" — a ~280x difference in reading —
      // and because a Notification row is written once and read forever, no
      // later code change repairs the history. Finding money-006. The code
      // travels with the figure for the same reason components/chat/
      // runway-card.tsx:48-55 refuses to re-derive it at render time.
      db.company.findUnique({ where: { id: companyId }, select: { currency: true } }),
    ]);
    if (!project) return; // race: project deleted between writes
    // Fall back to the schema default rather than skipping the alert: a budget
    // breach is worth telling people about even if the currency read raced.
    const currency = company?.currency ?? "PKR";

    const mk = monthKey(now);
    const limitLabel = monthlyLimit.toLocaleString();
    const spentLabel = monthToDate.toLocaleString();
    const pctLabel = Math.round(decision.percentUsed * 100);

    const title =
      decision.kind === "alert"
        ? `Budget exceeded: ${category} — ${project.name}`
        : `Budget alert: ${category} at ${pctLabel}% — ${project.name}`;
    // `toLocaleString()` + the bare code, not `formatCurrency`: that helper
    // rounds to whole units (maximumFractionDigits: 0), which would quietly
    // restate the cap and the spend in a message people compare against the
    // ledger.
    const message =
      decision.kind === "alert"
        ? `${category} spend on ${project.name} is ${currency} ${spentLabel} — over the ${currency} ${limitLabel} monthly cap.`
        : `${category} on ${project.name} is at ${pctLabel}% of the ${currency} ${limitLabel} monthly cap (${currency} ${spentLabel} so far).`;
    const notifType = decision.kind === "alert" ? "danger" : "warning";

    // Fan-out target: the people `canSeeProjectFinances` admits, drawn from
    // the supervisor + the assignees of tasks in this project. Replaces the old
    // "every company member" blast so unrelated teammates don't get pinged
    // about budgets they don't own — and then the finance predicate so the
    // ones who ARE on the project don't get figures they may not see.
    await db.$transaction(async (tx) => {
      // ── Claim the month sentinel BEFORE notifying anyone ──────────────
      //
      // The race this closes: `decideThreshold` is a read-modify-write, and
      // the read above runs on the base client, outside any transaction. Two
      // expenses landing on the same budget at the same moment both read
      // lastAlertedMonth = null, both decide "alert", and both fan out — so a
      // budget crossing 100% emails twice, against the "once, not once per
      // transaction" rule the whole sentinel scheme exists to enforce.
      //
      // The fix is optimistic concurrency, not a stronger isolation level:
      // the WHERE pins the *exact* sentinel state this pass observed, so the
      // second writer's update matches zero rows and it sends nothing. Under
      // READ COMMITTED the loser blocks on the winner's row lock and then
      // re-evaluates the predicate against the committed row, which is what
      // makes one query sufficient. Both sentinels are pinned even on the
      // warning path: if a concurrent pass just set lastAlertedMonth, our
      // snapshot is stale and our decision was computed from it.
      //
      // It also has to happen FIRST. notifyUsers fires push and email as
      // un-rollback-able side effects, so claiming after the fan-out would
      // still let both writers mail before either lost.
      const claimed = await tx.budget.updateMany({
        where: {
          id: budget.id,
          // `sentinels`, not `budget.*`: the re-arm above may have just cleared
          // one of these, and pinning the pre-re-arm values would make this claim
          // match nothing and silently skip an alert we had decided to send.
          lastWarnedMonth: sentinels.lastWarnedMonth,
          lastAlertedMonth: sentinels.lastAlertedMonth,
        },
        data:
          decision.kind === "alert"
            ? { lastAlertedMonth: mk, lastWarnedMonth: mk }
            : { lastWarnedMonth: mk },
      });
      // Lost the race — a concurrent expense already fired this threshold
      // for this month. Nothing was written, so there is nothing to undo.
      if (claimed.count === 0) return;

      // `deletedAt: null` on the tasks: a tombstoned task's assignee is not on
      // this project any more, and a soft-deleted row must not widen a
      // recipient list.
      const assignees = await tx.task.findMany({
        where: { projectId, deletedAt: null },
        select: { assignedTo: true },
        distinct: ["assignedTo"],
      });
      const candidateIds = new Set<string>([project.supervisorId]);
      for (const a of assignees) candidateIds.add(a.assignedTo);

      // Resolve each candidate's ROLE before anyone is told anything. The
      // `deletedAt: null` + `companyId` filter does double duty: it keeps the
      // figures away from a tombstoned account's inbox (notifyUsers already
      // filters email that way, but push and the in-app row did not) and it
      // pins the lookup to this workspace.
      const people = await tx.user.findMany({
        where: { id: { in: Array.from(candidateIds) }, companyId, deletedAt: null },
        select: { id: true, role: true },
      });
      const recipientIds = people
        .filter((u) =>
          canSeeProjectFinances({
            userId: u.id,
            role: u.role as Role,
            project: { supervisorId: project.supervisorId },
          })
        )
        .map((u) => u.id);

      // Everyone on the project is a plain assignee (or the supervisor is
      // gone). Send nothing rather than an empty fan-out. The sentinel above is
      // already claimed and stays claimed on purpose: the threshold DID cross
      // this month, and re-arming it would mean the next expense fires an alert
      // that has just as few people to reach.
      if (recipientIds.length === 0) return;

      await notifyUsers({
        event: "budget_alert",
        userIds: recipientIds,
        companyId,
        projectId,
        title,
        message,
        tone: notifType,
        category: "finance",
        link: `/projects/${projectId}`,
        tx,
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
