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
import {
  NewTaskSchema,
  TaskStatusUpdateSchema,
  BulkTaskStatusSchema,
  BulkTaskDeleteSchema,
  ReorderTaskSchema,
} from "@/lib/schemas/task";
import { limiters } from "@/lib/rate-limit";
import { canManageProject } from "@/lib/auth/project-permissions";
import { captureServerError } from "@/lib/sentry-server";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import type { Role } from "@/lib/auth/role-gates";
import type { Task, TaskStatus } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

function toClient(t: {
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
}): Task {
  return {
    id: t.id,
    companyId: t.companyId,
    projectId: t.projectId,
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
    order: t.order,
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
  const { title, description, status, priority, projectId, assignedTo, deadline } = parsed.data;
  const { id: actorId, companyId, role } = session.user;

  // Project must live in this company. Then check the caller can manage it
  // (admin / cofounder always; supervisor of this project too). Stops a
  // member from filing a task in a project they shouldn't see.
  const project = await db.project.findFirst({
    where: { id: projectId, companyId },
    select: { id: true, name: true, supervisorId: true, status: true },
  });
  if (!project) return { success: false, error: "Project not found" };
  if (project.status === "archived") {
    return { success: false, error: "Can't add tasks to an archived project" };
  }
  if (!canManageProject({ userId: actorId, role: role as Role, project })) {
    return { success: false, error: "Only the supervisor or a founder can add tasks here" };
  }

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
        projectId,
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
        // Smaller order = higher in the column; -now() lands the new task at
        // the top, matching the previous newest-first behavior.
        order: -Date.now(),
      },
    });

    await tx.activity.create({
      data: {
        companyId,
        projectId,
        type: "task_created",
        message: `${actor.name} added "${title}" to ${project.name}`,
        userId: actorId,
        userName: actor.name,
        metadata: JSON.stringify({ kind: "task", taskId: task.id, title }),
      },
    });

    // Assignment is a distinct event — fires when assignee != actor.
    if (assignee.id !== actorId) {
      await tx.activity.create({
        data: {
          companyId,
          projectId,
          type: "task_assigned",
          message: `${actor.name} assigned "${title}" to ${assignee.name}`,
          userId: actorId,
          userName: actor.name,
          metadata: JSON.stringify({ kind: "task", taskId: task.id, title }),
        },
      });
      await tx.notification.create({
        data: {
          userId: assignee.id,
          companyId,
          projectId,
          title: "New task assigned",
          message: `${actor.name} assigned you "${title}" in ${project.name}`,
          type: "info",
          // Deep-link into the tasks page and scroll/flash the specific card.
          // The tasks-client reads ?taskId= on mount and highlights the row.
          link: `/tasks?taskId=${task.id}`,
        },
      });
    }

    return task;
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  revalidatePath("/activities");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);

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
          link: `/tasks?taskId=${task.id}`,
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

/**
 * Persist a manual kanban reorder. The client computes the target `order`
 * (a midpoint between the drop neighbors) so the server work is just a
 * permission check + a one-field update — no activity row (reordering is
 * noise, not news) and no revalidatePath (the client already applied the
 * move optimistically; a refresh would fight the drag animation).
 *
 * Permission mirrors updateTaskStatusAction: assignee, creator, or admin.
 */
export async function reorderTaskAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ReorderTaskSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid reorder" };
  const { id, order } = parsed.data;

  try {
    const task = await db.task.findUnique({
      where: { id },
      select: { companyId: true, assignedTo: true, assignedBy: true, deletedAt: true },
    });
    if (!task || task.deletedAt) return { success: false, error: "Task not found" };
    if (task.companyId !== session.user.companyId) {
      return { success: false, error: "Not authorized" };
    }
    const canEdit =
      task.assignedTo === session.user.id ||
      task.assignedBy === session.user.id ||
      session.user.role === "admin";
    if (!canEdit) return { success: false, error: "Not authorized" };

    await db.task.update({ where: { id }, data: { order } });
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, {
      action: "reorderTask",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return { success: false, error: "Couldn't reorder that task right now." };
  }
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
    // Sweep any outstanding notifications that deep-link at this specific
    // task (`/tasks?taskId=<id>`). Otherwise clicking a "New task assigned"
    // notification for a since-deleted task lands on /tasks with nothing to
    // highlight — audit row X10.
    await tx.notification.deleteMany({
      where: { companyId: task.companyId, link: { contains: `taskId=${task.id}` } },
    });
    await tx.activity.create({
      data: {
        companyId: task.companyId,
        // Task.projectId is non-nullable post-add_projects, so always carry
        // it through. The per-project Activity tab depends on this row to
        // show "X deleted task Y".
        projectId: task.projectId,
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
  revalidatePath(`/projects/${task.projectId}`);

  return { success: true, data: undefined };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Bulk writes (audit T3)                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Permission-encoded WHERE for bulk task writes. Rather than loop-and-check
 * per task, we push the same rule the single-task actions enforce into the
 * SQL: an admin can touch any company task; everyone else only tasks they're
 * the assignee or creator of. deletedAt: null keeps tombstoned rows out.
 * Anything the caller isn't allowed to touch is simply not matched — a bulk
 * op silently skips forbidden rows rather than failing the whole batch.
 */
function bulkTaskScope(
  session: {
    user: { id: string; companyId: string; role: string };
  },
  ids: string[]
) {
  const base = { id: { in: ids }, companyId: session.user.companyId, deletedAt: null };
  if (session.user.role === "admin") return base;
  return {
    ...base,
    OR: [{ assignedTo: session.user.id }, { assignedBy: session.user.id }],
  };
}

export async function bulkUpdateTaskStatusAction(
  input: unknown
): Promise<ActionResult<{ updated: number }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = BulkTaskStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  }
  const { ids, status } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "User no longer exists" };

    const scope = bulkTaskScope(
      { user: { id: session.user.id, companyId: session.user.companyId, role: session.user.role } },
      ids
    );

    const result = await db.$transaction(async (tx) => {
      const { count } = await tx.task.updateMany({
        where: scope,
        data: {
          status,
          completedAt: status === "completed" ? new Date() : null,
        },
      });
      // One SUMMARY activity row — not one per task — so a 40-task bulk
      // update doesn't flood the feed (and matches the dedupe intent).
      if (count > 0) {
        await tx.activity.create({
          data: {
            companyId: session.user.companyId,
            type: status === "completed" ? "task_completed" : "task_updated",
            message: `${me.name} moved ${count} task${count === 1 ? "" : "s"} to ${status.replace("_", " ")}`,
            userId: me.id,
            userName: me.name,
            metadata: JSON.stringify({ kind: "task", bulk: true, count, status }),
          },
        });
      }
      return count;
    });

    warnBulkMutation(result, {
      action: "bulkUpdateTaskStatus",
      userId: session.user.id,
      companyId: session.user.companyId,
      extra: { requested: ids.length, status },
    });

    revalidatePath("/tasks");
    revalidatePath("/dashboard");
    revalidatePath("/activities");
    return { success: true, data: { updated: result } };
  } catch (e) {
    captureServerError(e, {
      action: "bulkUpdateTaskStatus",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return { success: false, error: "Couldn't update those tasks right now. Try again." };
  }
}

export async function bulkDeleteTasksAction(
  input: unknown
): Promise<ActionResult<{ deleted: number }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = BulkTaskDeleteSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  }
  const { ids } = parsed.data;

  try {
    const me = await db.user.findUnique({ where: { id: session.user.id } });
    if (!me) return { success: false, error: "User no longer exists" };

    // Delete is stricter than status change: only the creator or an admin,
    // matching the single-task deleteTaskAction. Non-admins can't bulk-delete
    // tasks merely assigned to them.
    const scope =
      session.user.role === "admin"
        ? { id: { in: ids }, companyId: session.user.companyId, deletedAt: null }
        : {
            id: { in: ids },
            companyId: session.user.companyId,
            deletedAt: null,
            assignedBy: session.user.id,
          };

    const result = await db.$transaction(async (tx) => {
      // Capture the ids we're actually allowed to delete so the notification
      // sweep + count are accurate (deleteMany doesn't return the rows).
      const deletable = await tx.task.findMany({ where: scope, select: { id: true } });
      const deletableIds = deletable.map((t) => t.id);
      if (deletableIds.length === 0) return 0;

      await tx.task.deleteMany({ where: { id: { in: deletableIds } } });
      // Sweep task-deep-link notifications for every deleted task (audit X10).
      await tx.notification.deleteMany({
        where: {
          companyId: session.user.companyId,
          OR: deletableIds.map((id) => ({ link: { contains: `taskId=${id}` } })),
        },
      });
      await tx.activity.create({
        data: {
          companyId: session.user.companyId,
          type: "task_deleted",
          message: `${me.name} deleted ${deletableIds.length} task${deletableIds.length === 1 ? "" : "s"}`,
          userId: me.id,
          userName: me.name,
          metadata: JSON.stringify({ kind: "task", bulk: true, count: deletableIds.length }),
        },
      });
      return deletableIds.length;
    });

    warnBulkMutation(result, {
      action: "bulkDeleteTasks",
      userId: session.user.id,
      companyId: session.user.companyId,
      extra: { requested: ids.length },
    });

    revalidatePath("/tasks");
    revalidatePath("/dashboard");
    revalidatePath("/activities");
    return { success: true, data: { deleted: result } };
  } catch (e) {
    captureServerError(e, {
      action: "bulkDeleteTasks",
      userId: session.user.id,
      companyId: session.user.companyId,
    });
    return { success: false, error: "Couldn't delete those tasks right now. Try again." };
  }
}
