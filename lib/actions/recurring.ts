"use server";

/**
 * Recurring-transaction server actions: create, list (via query), pause/resume,
 * delete. The actual materialization (turning a rule into a Transaction row)
 * is handled by /api/cron/materialize-recurring on a daily Vercel cron.
 *
 * Authoritative invariants:
 *   • Reads + writes scoped to session.user.companyId
 *   • Only the rule's creator OR an admin can pause/delete (mirrors the
 *     delete-transaction permission model)
 *   • Creating a rule ALSO creates a seed transaction for today so the user
 *     sees immediate effect — otherwise a rule for "rent on the 15th"
 *     created on the 16th would look broken until next month
 *   • A rule may be tagged to a Project, and that tag rides onto the seed
 *     transaction, the activity row, and (via the materializer) every future
 *     posting — see the money-005 note on `createRecurringRuleAction`
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewRecurringRuleSchema, ToggleRecurringRuleSchema } from "@/lib/schemas/recurring";
import { limiters } from "@/lib/rate-limit";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { captureServerError } from "@/lib/sentry-server";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
// money-001, persisted half: the activity `message` below is written once and
// read by every member of the workspace forever, so its figure cannot come from
// `toLocaleString()` — that resolves to the HOST's default locale and to a
// floating 0-3 decimal places. Same reason as lib/actions/transactions.ts.
import { formatAmountForMessage } from "@/lib/utils";

import type { ActionResult } from "@/lib/actions/types";

/**
 * The optional project tag, parsed separately from `NewRecurringRuleSchema`.
 *
 * `NewRecurringRuleSchema` is a discriminated union of plain `z.object`s, so it
 * runs in strip mode and silently drops any key it does not declare — including
 * `projectId`. Declaring the tag inside that union is the better long-term home
 * (it is the type the /recurring form builds its payload against), and it is
 * requested; until it lands this parse keeps the SERVER half complete, so the
 * form only has to start sending the field. Parsing it twice once the union
 * carries it is harmless.
 *
 * `.nullish()` because the form's "no project" option sends null, and an
 * untagged rule stays legal — it is the pre-projects, company-global spend path.
 */
const RuleProjectTagSchema = z.object({
  projectId: z.string().trim().min(1).nullish(),
});

/**
 * Create a recurring rule, post its first occurrence immediately, and — if that
 * occurrence is an expense — let it cross a budget threshold (money-005).
 *
 * WHY THE PROJECT TAG IS LOAD-BEARING HERE. Every Budget in this product belongs
 * to a Project, and `checkBudgetThresholdAfterExpense` returns early the instant
 * `projectId` is null (lib/budgets/check.ts:58). `RecurringRule.projectId` and
 * the materializer's copy of it onto each posting both already existed, so the
 * NIGHTLY path worked — but this function, the only place a rule is born, never
 * set the field and never ran the check on the seed transaction it posts. So
 * every rule in the product was permanently project-less and recurring spend —
 * rent, salaries, subscriptions, the outgoings a founder most wants a cap on —
 * could not trip an alert even once. /budgets went red in silence.
 */
export async function createRecurringRuleAction(
  input: unknown
): Promise<ActionResult<{ ruleId: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewRecurringRuleSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid rule" };
  }
  const data = parsed.data;
  const tag = RuleProjectTagSchema.safeParse(input);
  if (!tag.success) return { success: false, error: "Invalid project" };
  const projectId = tag.data.projectId ?? null;
  const { id: userId, companyId } = session.user;

  try {
    // If a project was claimed, verify it belongs to this LIVE workspace before
    // anything is written. `deletedAt: null` matters: a stale modal must not
    // file recurring spend against a project deleted while it was open, which
    // would land every future posting in a ledger tab nobody can open while
    // still counting toward that project's spend aggregate. Same shape and same
    // reasoning as addTransactionAction (lib/actions/transactions.ts:141).
    if (projectId) {
      const project = await db.project.findFirst({
        where: { id: projectId, companyId, deletedAt: null },
        select: { id: true },
      });
      if (!project) return { success: false, error: "Project not found" };
    }

    // The workspace CURRENCY rides along on the authoritative user lookup: the
    // activity `message` below quotes a figure and is written once and read
    // forever, so "no currency at all" (money-006) mislabels a USD or AED
    // workspace's history permanently and no later code change repairs it.
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { name: true, company: { select: { currency: true } } },
    });
    if (!user) return { success: false, error: "User no longer exists" };
    const currency = user.company.currency;

    const now = new Date();
    const startOfTodayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );

    // Build the create-data with the right day-field set based on frequency.
    const ruleCreateData =
      data.frequency === "monthly"
        ? {
            companyId,
            projectId,
            type: data.type,
            amount: data.amount,
            category: data.category,
            description: data.description,
            addedBy: userId,
            addedByName: user.name,
            frequency: "monthly",
            dayOfMonth: data.dayOfMonth,
            dayOfWeek: null,
            startDate: startOfTodayUtc,
          }
        : {
            companyId,
            projectId,
            type: data.type,
            amount: data.amount,
            category: data.category,
            description: data.description,
            addedBy: userId,
            addedByName: user.name,
            frequency: "weekly",
            dayOfMonth: null,
            dayOfWeek: data.dayOfWeek,
            startDate: startOfTodayUtc,
          };

    // Seed transaction + activity created in the same Prisma tx as the rule
    // so the user sees immediate feedback. Mark the seed with ruleId so the
    // UI can show its 🔁 badge.
    const created = await db.$transaction(async (tx) => {
      const rule = await tx.recurringRule.create({ data: ruleCreateData });
      await tx.transaction.create({
        data: {
          companyId,
          // The seed IS the first month of this recurring cost. Tagging only
          // the rule would leave that first posting invisible to the budget it
          // belongs to, which is the half of money-005 easiest to miss.
          projectId,
          type: data.type,
          amount: data.amount,
          category: data.category,
          description: data.description,
          date: now,
          addedBy: userId,
          addedByName: user.name,
          ruleId: rule.id,
        },
      });
      await tx.recurringRule.update({
        where: { id: rule.id },
        data: { lastMaterializedAt: now },
      });
      await tx.activity.create({
        data: {
          companyId,
          projectId,
          type: data.type === "expense" ? "expense_added" : "investment_added",
          message: `${user.name} set up a ${data.frequency} ${data.type} of ${formatAmountForMessage(
            data.amount,
            currency
          )} ${currency} for ${data.category}`,
          userId,
          userName: user.name,
          // `kind: "transaction"` is the member `ActivityMetadata` actually
          // declares (lib/types.ts) — "expense"/"investment" matched nothing in
          // the union, so a reader could never narrow this row. `currency`
          // travels with the raw figure so the feed can format at READ time and
          // a later currency switch cannot relabel history (money-006).
          metadata: JSON.stringify({
            kind: "transaction",
            amount: data.amount,
            currency,
            category: data.category,
            description: data.description,
            recurring: true,
          }),
        },
      });
      return rule;
    });

    // Budget threshold, after the money is in and OUTSIDE the $transaction: an
    // alerting error must never roll back the customer's rule. Expenses only —
    // investments don't count against caps. Mirrors addTransactionAction.
    if (data.type === "expense") {
      await checkBudgetThresholdAfterExpense({ companyId, projectId, category: data.category });
      revalidatePath("/budgets");
      revalidatePath("/notifications");
    }

    revalidatePath("/recurring");
    revalidatePath("/expenses");
    revalidatePath("/investments");
    revalidatePath("/activities");
    revalidatePath("/dashboard");
    if (projectId) revalidatePath(`/projects/${projectId}`);

    return { success: true, data: { ruleId: created.id } };
  } catch (e) {
    captureServerError(e, { action: "createRecurringRuleAction" });
    return { success: false, error: "Couldn't create the recurring rule right now." };
  }
}

export async function toggleRecurringRuleAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  const parsed = ToggleRecurringRuleSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { ruleId, active } = parsed.data;

  try {
    const rule = await db.recurringRule.findUnique({ where: { id: ruleId } });
    if (!rule) return { success: false, error: "Rule not found" };
    if (rule.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (rule.addedBy !== session.user.id && session.user.role !== "admin") {
      return { success: false, error: "Only the rule's creator or an admin can change it" };
    }

    await db.recurringRule.update({ where: { id: ruleId }, data: { active } });
    revalidatePath("/recurring");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "toggleRecurringRuleAction" });
    return { success: false, error: "Couldn't update the rule right now." };
  }
}

export async function deleteRecurringRuleAction(ruleId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  if (!ruleId) return { success: false, error: "Missing rule id" };

  try {
    const rule = await db.recurringRule.findUnique({ where: { id: ruleId } });
    if (!rule) return { success: false, error: "Rule not found" };
    if (rule.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (rule.addedBy !== session.user.id && session.user.role !== "admin") {
      return { success: false, error: "Only the rule's creator or an admin can delete it" };
    }

    // Schema sets onDelete: SetNull on Transaction.ruleId, so historical
    // materialized transactions survive — they just lose the 🔁 link.
    await db.recurringRule.delete({ where: { id: ruleId } });
    revalidatePath("/recurring");
    revalidatePath("/expenses");
    revalidatePath("/investments");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteRecurringRuleAction" });
    return { success: false, error: "Couldn't delete the rule right now." };
  }
}
