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
    commentCount,
  };
}

export async function getTasks(opts: { projectId?: string } = {}): Promise<TaskWithCount[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.task.findMany({
    where: { companyId, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { comments: true } },
      project: { select: { name: true } },
    },
  });
  return rows.map((r) => toClient(r, r._count.comments));
}
