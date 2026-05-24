/**
 * Read-side queries for tasks. Pairs with lib/actions/tasks.ts which still
 * owns add/update/delete/status-change.
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
  },
  commentCount = 0
): TaskWithCount {
  return {
    id: t.id,
    companyId: t.companyId,
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

export async function getTasks(): Promise<TaskWithCount[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.task.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { comments: true } } },
  });
  return rows.map((r) => toClient(r, r._count.comments));
}
