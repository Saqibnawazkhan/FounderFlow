"use server";

/**
 * Budget server actions: create, update (limit + active toggle), delete.
 * Threshold checking lives in lib/budgets/threshold.ts and runs from inside
 * addTransactionAction — adding a transaction is the only event that can
 * cross a threshold.
 *
 * Permissions: `canManageProject` on the budget's OWN project — admin,
 * cofounder, or the member who supervises that project (the escape hatch in
 * lib/auth/project-permissions.ts). All three actions below ask exactly that.
 *
 * This header used to say "any company member can manage budgets (mirrors the
 * 'anyone can create transactions' model). Tighten later if budgets become an
 * admin-only concept." It was accurate when it was written — budgets had no
 * project then — and the "Introduce Projects" commit that added the
 * `canManageProject` call to all three actions left the sentence behind. So it
 * described the gate too LOOSELY, which is the dangerous direction for a
 * comment about a permission: read literally it invites a UI that offers these
 * controls to every member and then gets refused by the server. Corrected with
 * finance-planning-010, which wired the supervisor's missing controls on
 * /projects/[id] against the real predicate.
 *
 * Delete writes the Tier 3 `deletedAt` tombstone rather than hard-deleting, so
 * the documented 90-day recovery window is real for a single budget too. Every
 * budget lookup in this file therefore has to carry `deletedAt: null` — the two
 * duplicate-category guards in particular (create, and resume), or a deleted
 * budget blocks its own replacement forever.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewBudgetSchema, UpdateBudgetSchema } from "@/lib/schemas/budget";
import { limiters } from "@/lib/rate-limit";
import { captureServerError } from "@/lib/sentry-server";
import type { Role } from "@/lib/auth/role-gates";
import { canManageProject } from "@/lib/auth/project-permissions";

import type { ActionResult } from "@/lib/actions/types";

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
      // deletedAt:null — see addTaskAction for the full argument
      // (data-integrity-002). Budget.project is onDelete: Restrict too, so a
      // budget filed into a soft-deleted project pins that project row open and
      // the purge cron's orphan-project stage cannot ever clear it.
      where: { id: projectId, companyId, deletedAt: null },
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
    //
    // HALF of the invariant. `updateBudgetAction` runs the same probe when a
    // paused cap is resumed (finance-planning-011) — creation was never the
    // only way to reach two active rows, and a guard that only covers the
    // create path is one the ordinary replace-a-cap workflow walks around.
    //
    // deletedAt:null is load-bearing now that deleteBudgetAction tombstones
    // instead of hard-deleting. A tombstoned row deliberately KEEPS
    // `active: true` (so a restore comes back in the state it left), so an
    // unfiltered check would read a deleted budget as the live one and lock
    // that category out of the project permanently — a regression the soft
    // delete itself would have introduced.
    const existing = await db.budget.findFirst({
      where: { projectId, category, active: true, deletedAt: null },
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
  // finance-planning-014. The same bucket `createBudgetAction` spends, in the
  // same place: ahead of the parse and the row lookup, so a refused call costs
  // no query. Editing and pausing a cap were the two unmetered writes on this
  // surface, and pausing is a button a script can hold down.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = UpdateBudgetSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid request" };
  const { budgetId, monthlyLimit, active } = parsed.data;

  try {
    const budget = await db.budget.findUnique({
      where: { id: budgetId },
      include: { project: { select: { id: true, supervisorId: true } } },
    });
    // A tombstoned budget is gone: editing its limit would silently resurrect
    // figures into a restore nobody asked for, and /budgets cannot show it.
    if (!budget || budget.deletedAt) return { success: false, error: "Budget not found" };
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

    // THE OTHER HALF of createBudgetAction's uniqueness probe
    // (finance-planning-011). "One active budget per category per project" is
    // the invariant prisma/schema.prisma states, and it was checked only at
    // create time — so three ordinary clicks broke it: pause Marketing/Alpha,
    // which makes the category pickable again (the New-budget form's
    // `takenCategories` counts ACTIVE caps only), create the replacement, then
    // resume the first one. Two active Marketing caps on Alpha, and
    // lib/budgets/check.ts evaluates exactly one of them — so the other cap
    // could never fire a warning or an alert, with nothing on screen saying
    // which one was live. Silent under-alerting on money.
    //
    // Only on the way TO active, and only from paused: an ordinary cap edit on
    // a workspace that already holds two such rows must still be possible, or
    // the guard strands the customer with precisely the rows they need to
    // correct. Pausing is never refused.
    //
    // `deletedAt: null` for the same reason as the create-time probe — a
    // tombstoned budget keeps `active: true`, and reading it as live would lock
    // the category out of the project forever. `id: { not: budgetId }` is belt
    // and braces: this row is still paused on disk here, so `active: true`
    // already excludes it, but the probe stays correct if the transition gate
    // above is ever relaxed.
    if (active === true && !budget.active) {
      const clash = await db.budget.findFirst({
        where: {
          projectId: budget.projectId,
          category: budget.category,
          active: true,
          deletedAt: null,
          id: { not: budgetId },
        },
        select: { id: true },
      });
      if (clash) {
        return {
          success: false,
          error: `A budget for "${budget.category}" is already active in this project. Pause or delete that one first.`,
        };
      }
    }

    const data: { monthlyLimit?: number; active?: boolean } = {};
    if (monthlyLimit !== undefined) data.monthlyLimit = monthlyLimit;
    if (active !== undefined) data.active = active;
    if (Object.keys(data).length === 0) {
      // Reject the no-op explicitly so the UI doesn't show a green
      // "saved" toast when nothing actually got saved. Previously this
      // returned success — a silent no-op.
      return { success: false, error: "Nothing to update" };
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
  // finance-planning-014 — see updateBudgetAction. Metered even though the
  // delete is a tombstone and `revalidatePath` is idempotent: this is still
  // write load from an authenticated session, and until this change the bucket
  // was spent by one of the three actions in this file and not the other two,
  // which is not a coverage rule anyone could reason about from the outside.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  if (!budgetId) return { success: false, error: "Missing budget id" };

  try {
    const budget = await db.budget.findUnique({
      where: { id: budgetId },
      include: { project: { select: { id: true, supervisorId: true } } },
    });
    // Already tombstoned reads as gone — don't move the sentinel timestamp a
    // restore may be keyed off.
    if (!budget || budget.deletedAt) return { success: false, error: "Budget not found" };
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
    // TIER 3 SOFT DELETE, not a hard delete (data-integrity-001). Budget is one
    // of the seven tables CLAUDE.md promises a 90-day window for, and
    // `Budget.deletedAt` was written by nothing but the whole-workspace sweep —
    // so deleting a cap someone spent a planning session setting was final.
    // Every Budget read filters deletedAt:null (lib/queries/budgets.ts, the
    // threshold check in lib/budgets/check.ts, search, the export, and the
    // duplicate-category guard above), so the row leaves the product at once.
    await db.budget.update({ where: { id: budgetId }, data: { deletedAt: new Date() } });
    revalidatePath("/budgets");
    revalidatePath(`/projects/${budget.projectId}`);
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteBudgetAction" });
    return { success: false, error: "Couldn't delete the budget right now." };
  }
}
