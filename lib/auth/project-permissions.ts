/**
 * Per-project permission helpers. Layered on top of the company-level role
 * gates in role-gates.ts so a member designated as a project supervisor
 * gets elevated capabilities INSIDE that project without escalating their
 * global access.
 *
 * Permission model:
 *   - admin   — manage every project in the company
 *   - cofounder — manage every project in the company
 *   - supervisor (the user pointed at by Project.supervisorId)
 *         — manage their own project (tasks, budgets, status)
 *         — see their own project's finance figures
 *         — CANNOT reach the global /budgets, /expenses, /investments pages
 *   - assigned member (a user with at least one task in the project)
 *         — see the project's tasks + time tabs
 *         — NOT see the Budgets tab
 *   - everyone else — no visibility
 */

import { canSeeFinances, type Role } from "./role-gates";

export type ProjectActor = {
  userId: string;
  role: Role;
};

export type ProjectGuardInput = {
  /** ID of the user whose access we're checking. */
  userId: string;
  /** That user's company-level role. */
  role: Role;
  /** The project being inspected — only its supervisorId is needed here. */
  project: { supervisorId: string };
};

/**
 * True when the caller can create/edit/delete the project's own tasks and
 * budgets, change status, or rename it. Admin + cofounder always can;
 * a member who's the supervisor of THIS project can too.
 *
 * Used by `addTaskAction`, `createBudgetAction`, `updateProjectAction`, etc.
 * Project creation itself is gated separately (`canCreateProject`).
 */
export function canManageProject({ userId, role, project }: ProjectGuardInput): boolean {
  if (role === "admin" || role === "cofounder") return true;
  return project.supervisorId === userId;
}

/**
 * True when the caller can SEE the project's finance figures (budgets +
 * project-tagged transactions). Mirrors `canSeeFinances` for the company-
 * wide pages, plus the supervisor escape hatch so a member supervising a
 * project can manage its budget.
 */
export function canSeeProjectFinances({ userId, role, project }: ProjectGuardInput): boolean {
  if (canSeeFinances(role)) return true;
  return project.supervisorId === userId;
}

/**
 * True when the caller can VIEW the project at all (overview page + tasks
 * tab). Admin + cofounder see everything; the supervisor sees their own;
 * members see only projects where they have at least one task.
 *
 * Use this at the entry to `/projects/[id]/page.tsx` to 404 (or redirect)
 * non-members away.
 */
export function canSeeProject({
  userId,
  role,
  project,
  hasTaskInProject,
}: ProjectGuardInput & { hasTaskInProject: boolean }): boolean {
  if (role === "admin" || role === "cofounder") return true;
  if (project.supervisorId === userId) return true;
  return hasTaskInProject;
}

/**
 * Project creation. Members can't create projects — even if they're going
 * to be the supervisor — because the company-level "founders or other
 * managers" guard belongs at the action layer, not at supervisor-resolve
 * time. Admin + cofounder only.
 */
export function canCreateProject(role: Role): boolean {
  return role === "admin" || role === "cofounder";
}

/**
 * Supervisor reassignment is admin/cofounder-only — a supervisor cannot
 * hand off without escalation. This prevents a member-supervisor from
 * unilaterally repointing the project at a colleague to escape oversight.
 */
export function canReassignSupervisor(role: Role): boolean {
  return role === "admin" || role === "cofounder";
}
