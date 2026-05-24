"use server";

/**
 * Task server actions. Mirrors the transactions module:
 *   - All reads scoped to session.user.companyId
 *   - Writes happen in a Prisma $transaction alongside the activity log
 *     and any notifications they should fan out
 *   - Mutations revalidatePath the routes that show tasks
 *
 * Permissions enforced server-side:
 *   - addTaskAction: any company member can create. The DB constraint
 *     ensures assignedTo also belongs to the same company.
 *   - updateTaskStatusAction: the assignee, the creator, or an admin
 *     can change status. Anyone else gets "Not authorized".
 *   - deleteTaskAction: only the creator or an admin.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewTaskSchema, TaskStatusUpdateSchema } from "@/lib/schemas/task";
import { limiters } from "@/lib/rate-limit";
import type { Task, TaskStatus } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

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
    status: t.status as TaskStatus,
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reads                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function listTasksAction(): Promise<ActionResult<Task[]>> {
  const session = await auth();
  if (!session?.user?.companyId) return { success: false, error: "Not authenticated" };

  const rows = await db.task.findMany({
    where: { companyId: session.user.companyId },
    orderBy: { createdAt: "desc" },
  });
  return { success: true, data: rows.map(toClient) };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Writes                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function addTaskAction(input: unknown): Promise<ActionResult<Task>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewTaskSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid task" };
  }
  const { title, description, status, priority, assignedTo, deadline } = parsed.data;
  const { id: actorId, companyId } = session.user;

  const [actor, assignee] = await Promise.all([
    db.user.findUnique({ where: { id: actorId } }),
    db.user.findUnique({ where: { id: assignedTo } }),
  ]);
  if (!actor) return { success: false, error: "User no longer exists" };
  if (!assignee) return { success: false, error: "Assignee not found" };
  // Prevent cross-company assignment even if a malicious client picks an ID
  // from another workspace.
  if (assignee.companyId !== companyId) {
    return { success: false, error: "Assignee is not in your company" };
  }

  const created = await db.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        companyId,
        title,
        description,
        status,
        priority,
        assignedTo,
        assignedToName: assignee.name,
        assignedBy: actorId,
        assignedByName: actor.name,
        deadline: new Date(deadline),
        completedAt: status === "completed" ? new Date() : null,
      },
    });

    await tx.activity.create({
      data: {
        companyId,
        type: "task_assigned",
        message: `${actor.name} assigned "${title}" to ${assignee.name}`,
        userId: actorId,
        userName: actor.name,
        metadata: JSON.stringify({ kind: "task", taskId: task.id, title }),
      },
    });

    // Notify the assignee unless they assigned the task to themselves.
    if (assignee.id !== actorId) {
      await tx.notification.create({
        data: {
          userId: assignee.id,
          companyId,
          title: "New task assigned",
          message: `${actor.name} assigned you "${title}"`,
          type: "info",
          link: "/tasks",
        },
      });
    }

    return task;
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  revalidatePath("/activities");

  return { success: true, data: toClient(created) };
}

export async function updateTaskStatusAction(input: unknown): Promise<ActionResult<Task>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const parsed = TaskStatusUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Invalid status update" };
  }
  const { id, status } = parsed.data;

  const task = await db.task.findUnique({ where: { id } });
  if (!task) return { success: false, error: "Task not found" };
  if (task.companyId !== session.user.companyId) {
    return { success: false, error: "Not authorized" };
  }
  const canEdit =
    task.assignedTo === session.user.id ||
    task.assignedBy === session.user.id ||
    session.user.role === "admin";
  if (!canEdit) return { success: false, error: "Not authorized" };

  const me = await db.user.findUnique({ where: { id: session.user.id } });
  if (!me) return { success: false, error: "User no longer exists" };

  const updated = await db.$transaction(async (tx) => {
    const u = await tx.task.update({
      where: { id },
      data: {
        status,
        completedAt: status === "completed" ? new Date() : null,
      },
    });

    const readable = status.replace("_", " ");
    await tx.activity.create({
      data: {
        companyId: task.companyId,
        type: status === "completed" ? "task_completed" : "task_updated",
        message:
          status === "completed"
            ? `${me.name} completed "${task.title}"`
            : `${me.name} moved "${task.title}" to ${readable}`,
        userId: me.id,
        userName: me.name,
        metadata: JSON.stringify({ kind: "task", taskId: task.id, title: task.title }),
      },
    });

    // Tell the creator when the assignee finishes a task (and they're not
    // the same person).
    if (status === "completed" && task.assignedBy !== me.id) {
      await tx.notification.create({
        data: {
          userId: task.assignedBy,
          companyId: task.companyId,
          title: "Task completed",
          message: `${me.name} completed "${task.title}"`,
          type: "success",
          link: "/tasks",
        },
      });
    }

    return u;
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  revalidatePath("/activities");

  return { success: true, data: toClient(updated) };
}

export async function deleteTaskAction(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const task = await db.task.findUnique({ where: { id } });
  if (!task) return { success: false, error: "Task not found" };
  if (task.companyId !== session.user.companyId) {
    return { success: false, error: "Not authorized" };
  }
  if (task.assignedBy !== session.user.id && session.user.role !== "admin") {
    return { success: false, error: "Not authorized" };
  }

  const me = await db.user.findUnique({ where: { id: session.user.id } });
  if (!me) return { success: false, error: "User no longer exists" };

  await db.$transaction(async (tx) => {
    await tx.task.delete({ where: { id } });
    await tx.activity.create({
      data: {
        companyId: task.companyId,
        type: "task_deleted",
        message: `${me.name} deleted task "${task.title}"`,
        userId: me.id,
        userName: me.name,
        metadata: JSON.stringify({ kind: "task", taskId: task.id, title: task.title }),
      },
    });
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  revalidatePath("/activities");

  return { success: true, data: undefined };
}
