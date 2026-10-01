/**
 * Who may open a TASK's comment thread — the one predicate, stated once.
 *
 * Finding tasks-and-comments-015. `lib/queries/comments.ts` grew `mayReadTarget`
 * for finding tasks-and-comments-004 and got the rule right: a member reads a
 * task thread only when the task is theirs or when they can manage its project,
 * which is exactly the set of tasks `visibleProjectTasks` shows them. But that
 * rule lived inside a read query, so `createCommentAction` — the WRITE — checked
 * only `task.companyId === session.user.companyId`. A member holding an id could
 * not read a teammate's thread and could still post into it, which is the
 * failure CLAUDE.md's two-layer rule exists to prevent: "middleware for routes,
 * server actions for writes. Both must agree."
 *
 * It is pure and I/O-free so both layers can hold it and so the rule is
 * unit-testable without a database — the same split as
 * `lib/auth/project-permissions.ts`, whose predicates it composes rather than
 * re-deriving.
 *
 * MONOTONE IN `project`, deliberately. `null` means "the project has not been
 * looked up", not "the task has no project" (`Task.projectId` is non-nullable
 * since `add_projects`). Passing `null` can only ever make the answer more
 * restrictive, so a caller may probe with `null` first and pay for the project
 * read only when that answer is `false` — the pattern `canSeeProject` documents
 * for its own `hasTaskInProject` flag. An admin or cofounder therefore never
 * issues the extra query at all.
 */

import { canManageProject, canSeeAllProjects } from "@/lib/auth/project-permissions";
import type { Role } from "@/lib/auth/role-gates";

export type TaskThreadReader = {
  userId: string;
  role: Role;
};

/** The two denormalised owner columns every Task row carries. */
export type TaskThreadTask = {
  assignedTo: string;
  assignedBy: string;
};

export function mayAccessTaskThread({
  reader,
  task,
  project,
}: {
  reader: TaskThreadReader;
  task: TaskThreadTask;
  /** The task's project, or `null` when it has not been read yet. */
  project: { supervisorId: string } | null;
}): boolean {
  if (canSeeAllProjects(reader.role)) return true;
  if (task.assignedTo === reader.userId) return true;
  if (task.assignedBy === reader.userId) return true;
  if (!project) return false;
  return canManageProject({ userId: reader.userId, role: reader.role, project });
}
