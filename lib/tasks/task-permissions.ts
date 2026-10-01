/**
 * Who may move a task — the board's rule and the server's rule, as one
 * function.
 *
 * Finding tasks-and-comments-009. `updateTaskStatusAction` and
 * `reorderTaskAction` each computed this inline, and `app/(app)/tasks/
 * tasks-client.tsx` computed nothing at all: every card rendered an enabled
 * status `<select>` and a drag handle for every viewer. A COFOUNDER is not in
 * the server's set, so the second seat every workspace buys was handed the whole
 * kanban and could move nothing that was not their own — and because the drag
 * applies optimistically first, the card visibly moved, an error toast fired,
 * and it snapped back. CLAUDE.md's rule is that the two layers must agree.
 *
 * THE RULE IS NOT WIDENED HERE, DELIBERATELY. Adding `cofounder` to the set
 * would also have made both layers agree, and it is the other half of the
 * product decision this finding raises. Two things argued against doing it from
 * a fix wave: it is a permission WIDENING, which needs the product owner rather
 * than an auditor; and the nearest written acceptance criterion on file says the
 * opposite — "an admin can delete anyone's; a cofounder cannot delete mine"
 * (FaultsAudit X20, on chat messages). So this states today's server rule
 * exactly, and the UI is made to match it. If the decision goes the other way,
 * this one function is the only place that changes, and both layers move
 * together.
 *
 * Pure and I/O-free: a plain module both a `"use server"` action and a
 * `"use client"` component can import. React replaces every export of a
 * `"use client"` module with a client-reference proxy, so a predicate shared
 * across that boundary has to live somewhere neither side owns
 * (tests/app/dashboard/client-boundary.test.ts guards the inverse mistake).
 */

import type { Role } from "@/lib/auth/role-gates";

export type TaskActor = {
  userId: string;
  role: Role;
};

/** The two denormalised owner columns every Task row carries. */
export type TaskOwnership = {
  assignedTo: string;
  assignedBy: string;
};

/**
 * True when `actor` may change this task's status or its manual board order.
 *
 * Mirrored by `bulkTaskScope` in lib/actions/tasks.ts, which has to express the
 * same rule as a Prisma `where` because it runs as one `updateMany` — it cannot
 * call this, and the correspondence is noted there.
 */
export function canEditTask({ actor, task }: { actor: TaskActor; task: TaskOwnership }): boolean {
  if (actor.role === "admin") return true;
  return task.assignedTo === actor.userId || task.assignedBy === actor.userId;
}

/**
 * True when `actor` may delete this task: the creator, or an admin. Stricter
 * than `canEditTask` — being handed a task does not entitle you to destroy it —
 * and it mirrors `deleteTaskAction` plus the non-admin branch of
 * `bulkDeleteTasksAction`.
 */
export function canDeleteTask({ actor, task }: { actor: TaskActor; task: TaskOwnership }): boolean {
  if (actor.role === "admin") return true;
  return task.assignedBy === actor.userId;
}
