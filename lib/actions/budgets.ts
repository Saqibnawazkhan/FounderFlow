"use server";

/**
 * Budget server actions: create, update (limit + active toggle), delete.
 * Threshold checking lives in lib/budgets/threshold.ts and runs from inside
 * addTransactionAction — adding a transaction is the only event that can
 * cross a threshold.
 *
 * Permissions: any company member can manage budgets (mirrors the
 * "anyone can create transactions" model). Tighten later if budgets
 * become an admin-only concept.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewBudgetSchema, UpdateBudgetSchema } from "@/lib/schemas/budget";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import type { Role } from "@/lib/auth/role-gates";
import { canManageProject } from "@/lib/auth/project-permissions";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function createBudgetAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewBudgetSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid budget" };
  }
  const { projectId, category, monthlyLimit } = parsed.data;
  const { id: userId, companyId, role } = session.user;

  try {
    // Project must live in this company. Supervisor of THIS project can
    // create budgets even as a member-tier user; otherwise admin/cofounder.
    const project = await db.project.findFirst({
      where: { id: projectId, companyId },
      select: { id: true, supervisorId: true, status: true },
    });
    if (!project) return { success: false, error: "Project not found" };
    if (project.status === "archived") {
      return { success: false, error: "Can't add budgets to an archived project" };
    }
    if (!canManageProject({ userId, role: role as Role, project })) {
      return { success: false, error: "Only the supervisor or a founder can add budgets here" };
    }

    // Soft uniqueness: refuse a second ACTIVE budget for the same category
    // within the SAME project. Different projects can share a category.
    const existing = await db.budget.findFirst({
      where: { projectId, category, active: true },
    });
    if (existing) {
      return {
        success: false,
        error: `A budget for "${category}" already exists in this project. Edit or pause it instead.`,
      };
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: "User no longer exists" };

    const created = await db.budget.create({
      data: {
        companyId,
        projectId,
        category,
        monthlyLimit,
        createdBy: userId,
        createdByName: user.name,
      },
    });

    revalidatePath("/budgets");
    revalidatePath(`/projects/${projectId}`);
    return { success: true, data: { id: created.id } };
  } catch (e) {
    captureServerError(e, { action: "createBudgetAction" });
    return { success: false, error: "Couldn't create the budget right now." };
  }
}

export async function updateBudgetAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const parsed = UpdateBudgetSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { budgetId, monthlyLimit, active } = parsed.data;

  try {
    const budget = await db.budget.findUnique({
      where: { id: budgetId },
      include: { project: { select: { id: true, supervisorId: true } } },
    });
    if (!budget) return { success: false, error: "Budget not found" };
    if (budget.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (
      !canManageProject({
        userId: session.user.id,
        role: session.user.role as Role,
        project: budget.project,
      })
    ) {
      return { success: false, error: "Not authorized" };
    }

    const data: { monthlyLimit?: number; active?: boolean } = {};
    if (monthlyLimit !== undefined) data.monthlyLimit = monthlyLimit;
    if (active !== undefined) data.active = active;
    if (Object.keys(data).length === 0) {
      return { success: true, data: undefined };
    }

    await db.budget.update({ where: { id: budgetId }, data });
    revalidatePath("/budgets");
    revalidatePath(`/projects/${budget.projectId}`);
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateBudgetAction" });
    return { success: false, error: "Couldn't update the budget right now." };
  }
}

export async function deleteBudgetAction(budgetId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!budgetId) return { success: false, error: "Missing budget id" };

  try {
    const budget = await db.budget.findUnique({
      where: { id: budgetId },
      include: { project: { select: { id: true, supervisorId: true } } },
    });
    if (!budget) return { success: false, error: "Budget not found" };
    if (budget.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    if (
      !canManageProject({
        userId: session.user.id,
        role: session.user.role as Role,
        project: budget.project,
      })
    ) {
      return { success: false, error: "Not authorized" };
    }
    await db.budget.delete({ where: { id: budgetId } });
    revalidatePath("/budgets");
    revalidatePath(`/projects/${budget.projectId}`);
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteBudgetAction" });
    return { success: false, error: "Couldn't delete the budget right now." };
  }
}
