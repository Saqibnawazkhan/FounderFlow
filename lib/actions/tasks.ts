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
 *
 * Deletes (single and bulk) write the Tier 3 `deletedAt` tombstone rather than
 * hard-deleting, so a mis-click keeps the documented 90-day recovery window and
 * does not cascade the task's comment thread away. See deleteTaskAction.
 */

import { revalidatePath } from "next/cache";
import { format } from "date-fns";
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
import type { Task, TaskPriority, TaskStatus } from "@/lib/types";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

/**
 * Display labels for the priority union.
 *
 * A keyed map rather than a `.toUpperCase()` or a raw interpolation so that
 * adding a value to the zod union in lib/schemas/task.ts is a compile error
 * here, instead of quietly shipping a raw slug like "blocker_p0" into
 * somebody's inbox.
 */
const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/**
 * Render a task deadline for a notification body / assignment email.
 *
 * Two decisions worth defending:
 *
 *   • Rebuilt from UTC parts. `Task.deadline` originates in an
 *     `<input type="date">`, which components/tasks/task-form.tsx sends as
 *     UTC midnight — it is a calendar DAY, not an instant. Formatting that
 *     instant in whatever zone the host happens to run in walks the day
 *     backwards on any host west of Greenwich, so the assignee would read a
 *     due date one off from the one the assigner picked. Reading the UTC
 *     parts back prints the day that was chosen, on every host. (This is the
 *     mirror image of lib/tasks/calendar.ts, which buckets by the *viewer's*
 *     local day — correct there, because there is a viewer; there is no
 *     viewer timezone inside a server action composing one string for
 *     several recipients.)
 *
 *   • date-fns with an explicit mask, not `toLocaleDateString`. The mask
 *     matches `formatDate` in lib/utils.ts, so the email and the task card
 *     read identically; a locale-sensitive formatter would instead follow
 *     the server's ICU default, which is nobody's workspace setting.
 *     (`User.locale` is per person, and this message is composed once for
 *     the whole recipient list — per-recipient localisation needs the copy
 *     to move into lib/notify/email.ts first.)
 */
/**
 * The bulk-selection ceiling, mirrored from `TaskIdList` in lib/schemas/task.ts.
 *
 * MIRRORED, not imported, because the schema keeps the number inline and does
 * not export it. Two constants that must agree in two files is real drift risk
 * — a message promising 200 while the parser rejects at 150 — so
 * tests/lib/actions/bulk-task-selection-limit.test.ts DISCOVERS the schema's
 * actual ceiling by binary probe and asserts the sentence below names that
 * number. If lib/schemas/task.ts ever exports its cap, import it here and delete
 * this constant.
 *
 * Not exported: an export from a `"use server"` module is a public HTTP endpoint
 * (tests/lib/actions/use-server-exports.test.ts).
 */
const MAX_BULK_TASK_IDS = 200;

/**
 * A human sentence for an over-sized selection, or null if the payload is fine
 * (tasks-and-comments-010).
 *
 * `toggleSelectAll` (app/(app)/tasks/tasks-client.tsx:381) selects every
 * FILTERED id with no ceiling, and both bulk actions surfaced zod's own words
 * verbatim through `parsed.error.issues[0]?.message`. So a 201-task select-all
 * answered with "Array must contain at most 200 element(s)" — a sentence about a
 * JavaScript array, in English, shown in a product that ships Urdu, to a founder
 * who pressed a checkbox. The headline bulk feature became an error message with
 * no user-facing meaning and no hint at what to do instead.
 *
 * Checked BEFORE the schema so the count in the message is the real selection
 * size; zod reports the ceiling but not what was sent.
 */
function bulkSelectionTooLargeError(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const ids = (input as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length <= MAX_BULK_TASK_IDS) return null;
  return (
    `You selected ${ids.length} tasks, and ${MAX_BULK_TASK_IDS} is the most that can be ` +
    `changed in one go. Narrow the selection with a filter, or work through them ` +
    `${MAX_BULK_TASK_IDS} at a time.`
  );
}

function formatDeadline(deadline: Date): string {
  const utcDay = new Date(deadline.getUTCFullYear(), deadline.getUTCMonth(), deadline.getUTCDate());
  return format(utcDay, "MMM dd, yyyy");
}

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
    // deletedAt:null matters as much as companyId here (data-integrity-002).
    // deleteProjectAction soft-deletes and leaves Project.status alone, so
    // without this filter a New-task modal that was open when the project was
    // deleted — or any known id — still resolves, and the task lands in a
    // project that exists on no surface: absent from search and from
    // /projects/<id>, and — because Task.project is onDelete: Restrict — pinning
    // the project row open so the purge cron's orphan-project stage cannot
    // delete it. (lib/queries/tasks.ts used to leave such a task on the global
    // board forever, because it filtered project.status and not
    // project.deletedAt; `taskScopeWhere` there now filters both.)
    where: { id: projectId, companyId, deletedAt: null },
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
  // A tombstoned assignee is not an assignee. The picker is built from
  // lib/queries/users.ts, which filters `deletedAt: null`, but this lookup
  // checked only the company — so a form left open across a deactivation (or a
  // hand-crafted request) could file work onto someone who has lost access.
  // They cannot open it, the task carries their denormalized name forever, and
  // the assignment fans a notification + email out to them (data-integrity-004).
  if (!assignee || assignee.deletedAt) return { success: false, error: "Assignee not found" };
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
      await notifyUsers({
        event: "task_assigned",
        userIds: [assignee.id],
        companyId,
        projectId,
        title: "New task assigned",
        // Deadline + priority belong IN the body, not just behind the link.
        // The acceptance criterion is "assignment emails carry deadline and
        // priority", and an email that only says who assigned what forces
        // the recipient to open the app to learn whether it is due tomorrow
        // — which is exactly the trip the email exists to save. Both values
        // are already in hand from the row we just wrote.
        message:
          `${actor.name} assigned you "${title}" in ${project.name} — ` +
          `${PRIORITY_LABEL[priority]} priority, due ${formatDeadline(task.deadline)}.`,
        category: "task",
        // Deep-link into the tasks page and scroll/flash the specific card.
        // The tasks-client reads ?taskId= on mount and highlights the row.
        link: `/tasks?taskId=${task.id}`,
        tx,
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
  // A tombstoned task is gone as far as every caller is concerned — the same
  // rule reorderTaskAction already applies. Without it, a stale board in
  // another tab could move a deleted task between columns and write an
  // activity row for work that is no longer in the product.
  if (!task || task.deletedAt) return { success: false, error: "Task not found" };
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
      await notifyUsers({
        event: "task_completed",
        userIds: [task.assignedBy],
        companyId: task.companyId,
        title: "Task completed",
        message: `${me.name} completed "${task.title}"`,
        tone: "success",
        category: "task",
        link: `/tasks?taskId=${task.id}`,
        tx,
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
  // Already tombstoned reads as gone: a second delete would move the sentinel
  // timestamp and write a second "deleted task" activity row for one deletion.
  if (!task || task.deletedAt) return { success: false, error: "Task not found" };
  if (task.companyId !== session.user.companyId) {
    return { success: false, error: "Not authorized" };
  }
  if (task.assignedBy !== session.user.id && session.user.role !== "admin") {
    return { success: false, error: "Not authorized" };
  }

  const me = await db.user.findUnique({ where: { id: session.user.id } });
  if (!me) return { success: false, error: "User no longer exists" };

  await db.$transaction(async (tx) => {
    // TIER 3 SOFT DELETE, not a hard delete (tasks-and-comments-005).
    //
    // This was `tx.task.delete`, and the damage was wider than one row:
    // `Comment.task` is `onDelete: Cascade` (schema.prisma) and Comment carries
    // no `deletedAt` of its own, so a mis-clicked trash icon — one confirm
    // dialog away on every card and every list row — destroyed the task AND its
    // entire comment conversation, with Activity keeping only the one-line
    // "X deleted task Y". CLAUDE.md's Tier 3 section names Task as one of the
    // seven soft-delete tables and publishes a one-UPDATE restore; nothing in
    // this path had ever written the column.
    //
    // Stamping the sentinel fixes both halves at once: the row is recoverable
    // with `UPDATE "Task" SET "deletedAt" = NULL WHERE id = …`, and the cascade
    // simply never fires, so the thread is still attached when it comes back.
    // Safe because every Task read filters deletedAt:null — getTasks, the
    // project KPI counts, search, the export, bulkTaskScope, reorderTaskAction.
    //
    // Two limits worth knowing (both follow-ups, neither a reason to go back to
    // hard-deleting): the purge cron has no stage for an individually
    // tombstoned row in a live workspace, so these survive past 90 days (see
    // deleteTransactionAction for the full note); and a tombstoned task still
    // pins its project's Restrict FK, so deleteProjectAction's
    // "is it empty?" count — which looks at live children only — can tombstone
    // a project that the purge's orphan-project stage then cannot delete.
    await tx.task.update({ where: { id }, data: { deletedAt: new Date() } });
    // Sweep any outstanding notifications that deep-link at this specific
    // task (`/tasks?taskId=<id>`). Otherwise clicking a "New task assigned"
    // notification for a since-deleted task lands on /tasks with nothing to
    // highlight — audit row X10. Still a HARD delete on purpose: a
    // notification is a transient ping, not a record, and nothing promises to
    // restore one. (So a restored task comes back without its original
    // assignment ping — the task, its description and its comments are what the
    // recovery window is about.)
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

  const tooLarge = bulkSelectionTooLargeError(input);
  if (tooLarge) return { success: false, error: tooLarge };

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

  const tooLarge = bulkSelectionTooLargeError(input);
  if (tooLarge) return { success: false, error: tooLarge };

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

      // Tombstone, not deleteMany — same reasoning as deleteTaskAction, and
      // the stakes are 200x higher: this is the floating action bar, so one
      // drag-select plus Delete used to destroy up to 200 tasks and every
      // comment on them in one statement. All of them share one timestamp, so
      // an ops restore can reunite exactly this batch with a BETWEEN filter
      // (the pattern CLAUDE.md's runbook already uses for a workspace).
      const deletedAt = new Date();
      await tx.task.updateMany({ where: { id: { in: deletableIds } }, data: { deletedAt } });
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
