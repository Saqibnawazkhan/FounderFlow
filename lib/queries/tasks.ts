/**
 * Read-side queries for tasks. Pairs with lib/actions/tasks.ts which still
 * owns add/update/delete/status-change.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Task } from "@/lib/types";

function toClient(t: {
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
}): Task {
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
  };
}

export async function getTasks(): Promise<Task[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.task.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toClient);
}
