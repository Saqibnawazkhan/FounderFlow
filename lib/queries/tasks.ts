/**
 * Read-side queries for tasks. Pairs with lib/actions/tasks.ts which still
 * owns add/update/delete/status-change.
 *
 * Project scoping:
 *   - `getTasks()` (no args) — every company task. Used by /dashboard for
 *     the "open tasks" KPI and the legacy /tasks board.
 *   - `getTasks({ projectId })` — scoped to one project. Used inside the
 *     project detail page's Tasks tab.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Task } from "@/lib/types";

// Includes the comment count so the kanban / list can render a "💬 N"
// badge without a second round trip per row.
export type TaskWithCount = Task & { commentCount: number };

function toClient(
  t: {
    id: string;
    companyId: string;
    projectId: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    assignedTo: string;
    assignedToName: string;
    assignedBy: string;
    assignedByName: string;
    deadline: Date;
    createdAt: Date;
    completedAt: Date | null;
    order: number;
    project?: { name: string } | null;
  },
  commentCount = 0
): TaskWithCount {
  return {
    id: t.id,
    companyId: t.companyId,
    projectId: t.projectId,
    projectName: t.project?.name,
    title: t.title,
    description: t.description,
    status: t.status as Task["status"],
    priority: t.priority as Task["priority"],
    assignedTo: t.assignedTo,
    assignedToName: t.assignedToName,
    assignedBy: t.assignedBy,
    assignedByName: t.assignedByName,
    deadline: t.deadline.toISOString(),
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt ? t.completedAt.toISOString() : undefined,
    order: t.order,
    commentCount,
  };
}

export async function getTasks(opts: { projectId?: string } = {}): Promise<TaskWithCount[]> {
  const { companyId, userId, role } = await requireScopedSession();
  const rows = await db.task.findMany({
    where: {
      companyId,
      deletedAt: null,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      // On the GLOBAL board a member only ever sees tasks assigned to THEM —
      // never a teammate's, admin's, or co-founder's work. Enforced here at the
      // data boundary so it can't be unfiltered from the client. Project-scoped
      // reads (opts.projectId) are left to the project's own access control so
      // the per-project supervisor escape-hatch (a member who supervises a
      // project can see its board) keeps working.
      ...(role === "member" && !opts.projectId ? { assignedTo: userId } : {}),
    },
    // Manual sort key first (kanban reorder), createdAt as a stable tiebreak
    // for any rows that still share an order value.
    orderBy: [{ order: "asc" }, { createdAt: "desc" }],
    include: {
      _count: { select: { comments: true } },
      project: { select: { name: true } },
    },
  });
  return rows.map((r) => toClient(r, r._count.comments));
}
