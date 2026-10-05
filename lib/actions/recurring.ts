"use server";

/**
 * Recurring-transaction server actions: create, list (via query), pause/resume,
 * delete. The actual materialization (turning a rule into a Transaction row)
 * is handled by /api/cron/materialize-recurring on a daily Vercel cron.
 *
 * Authoritative invariants:
 *   • Reads + writes scoped to session.user.companyId
 *   • Only the rule's creator OR an admin can pause/delete (mirrors the
 *     delete-transaction permission model) — plus the one orphan case in
 *     `lib/recurring/manage-gate.ts`: once the creator has been deactivated,
 *     nobody the gate names can ever act again, so any finance-capable user
 *     may stop the charge (finance-planning-013)
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
import { seedStampFor } from "@/lib/recurring/materialize";
import { captureServerError } from "@/lib/sentry-server";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { canManageRecurringRule } from "@/lib/recurring/manage-gate";
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
 * runs in strip mode and silently drops any key it does not declare. It now
 * DECLARES `projectId` (money-005), which is the better long-term home — it is
 * the type the /recurring form builds its payload against. This parse stays
 * because it reads the tag off the RAW input, and parsing it twice is harmless.
 *
 * KEEPING IT IS NOT COSMETIC. Because this runs on the raw input, it sees the
 * value BEFORE the union's `"" -> undefined` transform, so a literal empty
 * string reaches `.min(1)` and is refused as "Invalid project". That is why the
 * /recurring form narrows `"" -> undefined` in its own submit handler rather
 * than posting the select's empty value: without that, picking "Not tagged to a
 * project" would be rejected. Pinned by
 * tests/app/recurring/new-rule-project-tag.test.tsx.
 *
 * `.nullish()` so both spellings pass: the form sends `undefined` (it must, per
 * the paragraph above) and a direct caller may send `null`. An untagged rule
 * stays legal — it is the pre-projects, company-global spend path.
 */
const RuleProjectTagSchema = z.object({
  projectId: z.string().trim().min(1).nullish(),
});

/**
 * The manage gate, applied to the row the two writers below load.
 *
 * Deliberately NOT exported: this module is `"use server"`, so an export is a
 * public endpoint (tests/lib/actions/use-server-exports.test.ts). The decision
 * itself lives in `lib/recurring/manage-gate.ts` so the /recurring card can
 * import the same one rather than mirror it.
 *
 * Takes the loaded `user` relation, not a second query: the liveness of the
 * author has to be read in the same statement as the rule it gates.
 */
function canManageRule(
  rule: { addedBy: string; user: { deletedAt: Date | null } },
  viewerId: string,
  viewerRole: string
): boolean {
  return canManageRecurringRule(
    { addedBy: rule.addedBy, authorRemoved: rule.user.deletedAt !== null },
    { id: viewerId, role: viewerRole as Role }
  );
}

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
      // finance-planning-004. `lastMaterializedAt: now` charged the customer
      // TWICE in the month they set the rule up: `dueDatesFor` walks
      // (lastMaterializedAt, today], so a rule created on the 3rd with
      // `dayOfMonth: 15` came due again on the 15th — of the same month — and both
      // rows carry the same rule badge, so neither looks like the mistake. It was
      // correct when created on or after the due day, which is why it survived.
      //
      // `seedStampFor` stamps past the current period's scheduled occurrence,
      // because the seed above IS that occurrence. Dropping the seed instead
      // would leave the first month of a recurring cost invisible to its budget
      // (the hardest half of money-005 to find) and show nothing at all on a
      // brand-new rule until its day came round.
      await tx.recurringRule.update({
        where: { id: rule.id },
        data: { lastMaterializedAt: seedStampFor(rule, now) },
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

  // finance-planning-014. Same bucket and same position as
  // `createRecurringRuleAction` above — after the role gate, before the parse
  // and the row lookup, so a refused call costs no query. Pause/Resume is the
  // cheapest write on this surface to repeat, and it was the one with no
  // ceiling at all.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ToggleRecurringRuleSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { ruleId, active } = parsed.data;

  try {
    const rule = await db.recurringRule.findUnique({
      where: { id: ruleId },
      // The author's tombstone, for the orphaned-rule case below.
      include: { user: { select: { deletedAt: true } } },
    });
    if (!rule) return { success: false, error: "Rule not found" };
    if (rule.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (!canManageRule(rule, session.user.id, session.user.role)) {
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

  // finance-planning-014 — see toggleRecurringRuleAction. This one really is a
  // hard `delete` (onDelete: SetNull keeps the materialized transactions), so
  // it is the one write of the four with no tombstone behind it.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  if (!ruleId) return { success: false, error: "Missing rule id" };

  try {
    const rule = await db.recurringRule.findUnique({
      where: { id: ruleId },
      // The author's tombstone, for the orphaned-rule case in `canManageRule`.
      include: { user: { select: { deletedAt: true } } },
    });
    if (!rule) return { success: false, error: "Rule not found" };
    if (rule.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (!canManageRule(rule, session.user.id, session.user.role)) {
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
