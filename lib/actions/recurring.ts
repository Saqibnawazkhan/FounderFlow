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
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewRecurringRuleSchema, ToggleRecurringRuleSchema } from "@/lib/schemas/recurring";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function createRecurringRuleAction(
  input: unknown
): Promise<ActionResult<{ ruleId: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewRecurringRuleSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid rule" };
  }
  const data = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: "User no longer exists" };

    const now = new Date();
    const startOfTodayUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );

    // Build the create-data with the right day-field set based on frequency.
    const ruleCreateData =
      data.frequency === "monthly"
        ? {
            companyId,
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
          type: data.type === "expense" ? "expense_added" : "investment_added",
          message: `${user.name} set up a ${data.frequency} ${data.type} of ${data.amount.toLocaleString()} for ${data.category}`,
          userId,
          userName: user.name,
          metadata: JSON.stringify({
            kind: data.type === "expense" ? "expense" : "investment",
            amount: data.amount,
            category: data.category,
            description: data.description,
            recurring: true,
          }),
        },
      });
      return rule;
    });

    revalidatePath("/recurring");
    revalidatePath("/expenses");
    revalidatePath("/investments");
    revalidatePath("/activities");
    revalidatePath("/dashboard");

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
