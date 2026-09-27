"use server";

/**
 * Project server actions: create, duplicate, update, change supervisor,
 * archive, delete. Permission gates run in lib/auth/project-permissions.ts
 * so the test suite can exercise them in isolation.
 *
 * Activity + notification side effects:
 *   create   → Activity { type: "project_created" }
 *   duplicate → Activity { type: "project_created" } + Notification to the
 *               carried-over supervisor (same shape as create — from the
 *               feed's point of view a duplicate IS a project creation)
 *   update   → Activity { type: "project_updated" } (when name/desc/etc.)
 *   archive  → Activity { type: "project_archived" }
 *   change-supervisor → Activity + Notification to the new supervisor
 *
 * Delete is hard-blocked when the project still has tasks or budgets —
 * the Prisma onDelete: Restrict policy catches it at the DB layer too,
 * but we surface a clean error here so the UI doesn't 500.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  ChangeSupervisorSchema,
  DuplicateProjectSchema,
  MAX_DUPLICATED_TASKS,
  NewProjectSchema,
  UpdateProjectSchema,
} from "@/lib/schemas/project";
import { limiters } from "@/lib/rate-limit";
import {
  canCreateProject,
  canManageProject,
  canReassignSupervisor,
  canSeeProject,
} from "@/lib/auth/project-permissions";
import { captureServerError } from "@/lib/sentry-server";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import type { Role } from "@/lib/auth/role-gates";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

/** Logs an Activity row scoped to the project. Fire-and-await inside the
 *  surrounding Prisma transaction so the activity feed never gets out of
 *  sync with the underlying mutation. */
async function logProjectActivity(
  tx: Pick<typeof db, "activity">,
  args: {
    companyId: string;
    projectId: string;
    type: string;
    message: string;
    userId: string;
    userName: string;
    metadata?: Record<string, unknown>;
  }
) {
  await tx.activity.create({
    data: {
      companyId: args.companyId,
      projectId: args.projectId,
      type: args.type,
      message: args.message,
      userId: args.userId,
      userName: args.userName,
      metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    },
  });
}

export async function createProjectAction(
  input: unknown
): Promise<ActionResult<{ projectId: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canCreateProject(session.user.role as Role)) {
    return { success: false, error: "Only founders + cofounders can create projects" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewProjectSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid project" };
  }
  const { name, description, supervisorId, color, targetEndDate } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    // The supervisor must be a real member of THIS company. Stops a forged
    // userId from being slipped in.
    const supervisor = await db.user.findFirst({
      where: { id: supervisorId, companyId },
      select: { id: true, name: true },
    });
    if (!supervisor) {
      return { success: false, error: "Supervisor must be a member of this company" };
    }

    const creator = await db.user.findUnique({ where: { id: userId } });
    if (!creator) return { success: false, error: "User no longer exists" };

    const project = await db.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          companyId,
          name,
          description: description ?? null,
          supervisorId,
          color,
          targetEndDate: targetEndDate ?? null,
          createdBy: userId,
        },
      });

      await logProjectActivity(tx, {
        companyId,
        projectId: created.id,
        type: "project_created",
        message: `${creator.name} created project "${name}"`,
        userId,
        userName: creator.name,
        metadata: { kind: "project", projectId: created.id, projectName: name },
      });

      // `exclude` covers the "supervisor is the creator" case.
      await notifyUsers({
        event: "project_supervisor",
        userIds: [supervisorId],
        exclude: userId,
        companyId,
        projectId: created.id,
        title: "You're a project supervisor",
        message: `${creator.name} made you supervisor of "${name}"`,
        category: "task",
        link: `/projects/${created.id}`,
        tx,
      });

      return created;
    });

    revalidatePath("/projects");
    revalidatePath("/dashboard");
    return { success: true, data: { projectId: project.id } };
  } catch (e) {
    captureServerError(e, { action: "createProjectAction" });
    return { success: false, error: "Couldn't create the project right now." };
  }
}

/**
 * How far forward to push every copied deadline, in milliseconds.
 *
 * ONE delta for the whole set, not one per task: the point of copying a plan
 * is its internal spacing ("design due Monday, review the Friday after"), and
 * clamping each overdue date to today individually would collapse a six-week
 * schedule onto a single day. So we find the EARLIEST deadline in the set and
 * move it to the start of today; every other date travels the same distance
 * and the intervals survive intact.
 *
 * `Math.max(0, …)` is the second half of the rule: if the source's earliest
 * deadline is already in the future, the plan has not started yet and needs no
 * rescuing — shifting would be *pulling it backwards*, inventing urgency the
 * user never asked for. Zero means "copy verbatim", which is right there.
 *
 * Start-of-today rather than `now` so a task due later today stays due today,
 * matching the boundary `NewTaskSchema` already uses to decide whether a
 * deadline counts as past.
 *
 * Pure and separate from the action so the rule can be read (and argued with)
 * without a database in the room.
 */
function deadlineShiftMs(deadlines: Date[], now: Date): number {
  if (deadlines.length === 0) return 0;
  let earliest = Number.POSITIVE_INFINITY;
  for (const d of deadlines) earliest = Math.min(earliest, d.getTime());
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return Math.max(0, startOfToday.getTime() - earliest);
}

/**
 * Duplicate an existing project into a new one.
 *
 * WHAT CARRIES OVER and WHY lives on `DuplicateProjectSchema` — including the
 * argument for why money, time entries and comments have no flag at all. This
 * function's job is to enforce that shape safely.
 *
 * Three decisions worth defending here rather than in the schema:
 *
 * 1. GATED ON `canCreateProject`, NOT on `canManageProject` of the source.
 *    Duplicating MINTS a project, so it has to clear the same bar as pressing
 *    "New project" — otherwise it is a loophole around exactly the rule
 *    `canCreateProject` exists to state ("members can't create projects, even
 *    if they're going to be the supervisor"). A member who supervises one
 *    project could otherwise mint a second, then a third, from a button.
 *
 *    `canSeeProject` is then asked separately about the source, because "may
 *    create a project" and "may read THIS project" are different questions.
 *    Today the first implies the second (`canCreateProject` and
 *    `canSeeAllProjects` both mean admin|cofounder), so the second gate never
 *    fires — it is written out anyway for the reason project-permissions.ts
 *    already gives for keeping `canSeeAllProjects` apart from `canSeeFinances`
 *    (CODEBASE-AUDIT.md §4.3): the day a narrower project-creating role
 *    exists, the implication quietly stops holding, and the failure mode is a
 *    role copying a project it was never allowed to open. `canManageProject` is
 *    deliberately NOT required: duplication never writes to the source, so
 *    demanding edit rights over it would be a permission we don't use.
 *
 * 2. ONE TRANSACTION. A project row that exists with half its tasks is worse
 *    than no project at all — the user sees a plausible-looking duplicate,
 *    trusts it, and discovers the gap weeks later. Either all of it lands or
 *    none of it does.
 *
 * 3. ONE `createMany` FOR THE TASKS, and a hard ceiling before we start.
 *    A 500-task project must not become 500 round trips inside a transaction
 *    that has a 5s clock running. `MAX_DUPLICATED_TASKS` is checked from a
 *    `take: N + 1` read, so an absurdly large source costs us 501 rows to
 *    detect rather than all 12,000.
 *
 * The bulk-mutation canary fires above 100 rows. This is a CREATE, so it can't
 * lose anybody's data the way the delete call sites can — but "one click
 * produced 4,000 rows" is precisely the shape the canary exists to surface
 * (a retry storm, a stuck button, a loop that got a flag wrong), and it is
 * telemetry rather than a gate, so the cost of being wrong is one Sentry
 * event nobody acts on.
 */
export async function duplicateProjectAction(
  input: unknown
): Promise<ActionResult<{ projectId: string }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canCreateProject(session.user.role as Role)) {
    return { success: false, error: "Only founders + cofounders can create projects" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = DuplicateProjectSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  }
  const { sourceProjectId, name, copyTasks, keepAssignees, shiftDeadlines } = parsed.data;
  const { id: userId, companyId, role } = session.user;

  try {
    // Re-verify the client-supplied id against the caller's company. Scoped
    // read, so a forged id from another workspace is simply not found — and
    // `deletedAt: null` keeps a tombstoned project from being resurrected
    // sideways as a copy, which would put its task list back in front of
    // people after someone deliberately deleted it.
    //
    // No status filter, on purpose: duplicating an ARCHIVED project to start
    // the next round of the same work is the single most likely reason anyone
    // presses this. `addTaskAction` refuses to file tasks into an archived
    // project, but that rule protects the archived project — the copy is a new
    // one and lands `active`, so the tasks go somewhere live.
    const source = await db.project.findFirst({
      where: { id: sourceProjectId, companyId, deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        supervisorId: true,
        color: true,
      },
    });
    if (!source) return { success: false, error: "Project not found" };

    // Probe with `hasTaskInProject: false` first and only pay for the task
    // lookup if that denies — the predicate documents itself as monotone in
    // that flag, so a false-then-true probe can never wrongly deny access.
    let visible = canSeeProject({
      userId,
      role: role as Role,
      project: source,
      hasTaskInProject: false,
    });
    if (!visible) {
      const ownTasks = await db.task.count({
        where: { projectId: source.id, assignedTo: userId, deletedAt: null },
      });
      visible = canSeeProject({
        userId,
        role: role as Role,
        project: source,
        hasTaskInProject: ownTasks > 0,
      });
    }
    // Same message as "not in your company" on purpose: a caller who can't
    // see the project shouldn't learn it exists.
    if (!visible) return { success: false, error: "Project not found" };

    const creator = await db.user.findUnique({ where: { id: userId } });
    if (!creator) return { success: false, error: "User no longer exists" };

    // The copy keeps the source's supervisor — the same person is still
    // running the same kind of work — but that id has to be re-checked, not
    // trusted. `Project.supervisorId` is an FK to User, and a soft-deleted
    // user's ROW still satisfies the FK (Tier 3 tombstones, never erases), so
    // nothing at the database layer stops us handing a brand-new project to
    // someone who was deactivated six months ago. If they're gone, the copy
    // falls to the person making it, who is present by definition.
    const sourceSupervisor = await db.user.findFirst({
      where: { id: source.supervisorId, companyId, deletedAt: null },
      select: { id: true },
    });
    const supervisorId = sourceSupervisor?.id ?? userId;

    // `take: MAX + 1` — enough to KNOW we're over the ceiling without
    // dragging an unbounded task table into memory to find out.
    const sourceTasks = copyTasks
      ? await db.task.findMany({
          where: { projectId: source.id, deletedAt: null },
          select: {
            title: true,
            description: true,
            priority: true,
            assignedTo: true,
            assignedToName: true,
            deadline: true,
            order: true,
          },
          take: MAX_DUPLICATED_TASKS + 1,
        })
      : [];
    if (sourceTasks.length > MAX_DUPLICATED_TASKS) {
      return {
        success: false,
        error: `"${source.name}" has more than ${MAX_DUPLICATED_TASKS} tasks — too many to copy in one go. Duplicate it without its tasks, or split the project first.`,
      };
    }

    // Carried-over assignees get the same treatment as the supervisor: a
    // tombstoned or since-removed user must not be handed new work. Anyone
    // who fails the check falls back to the duplicator.
    // `Array.from` rather than spreading the Set — tsconfig has no
    // `downlevelIteration`, so iterating one directly is TS2802.
    const carriedAssigneeIds = keepAssignees
      ? Array.from(new Set(sourceTasks.map((t) => t.assignedTo)))
      : [];
    const liveAssignees =
      carriedAssigneeIds.length > 0
        ? await db.user.findMany({
            where: { id: { in: carriedAssigneeIds }, companyId, deletedAt: null },
            select: { id: true, name: true },
          })
        : [];
    const liveAssigneeNameById = new Map(liveAssignees.map((u) => [u.id, u.name]));

    const shiftMs = shiftDeadlines
      ? deadlineShiftMs(
          sourceTasks.map((t) => t.deadline),
          new Date()
        )
      : 0;

    const taskRows = sourceTasks.map((t) => {
      const keptName = keepAssignees ? liveAssigneeNameById.get(t.assignedTo) : undefined;
      return {
        companyId,
        title: t.title,
        description: t.description,
        // Reset, unconditionally — see DuplicateProjectSchema.copyTasks. A
        // duplicate is a plan nobody has executed yet.
        status: "pending",
        completedAt: null,
        priority: t.priority,
        assignedTo: keptName === undefined ? userId : t.assignedTo,
        assignedToName: keptName ?? creator.name,
        // The duplicator is the one creating these rows right now, whoever
        // ends up holding them. Copying the source's `assignedBy` would
        // attribute this act to someone who wasn't in the room.
        assignedBy: userId,
        assignedByName: creator.name,
        deadline: new Date(t.deadline.getTime() + shiftMs),
        // Kanban sort key copied verbatim: `order` is scoped per project, so
        // reusing the source's values reproduces the column ordering that was
        // half the reason to duplicate. Regenerating it would shuffle the plan.
        order: t.order,
      };
    });

    const created = await db.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          companyId,
          name,
          description: source.description,
          supervisorId,
          color: source.color,
          // targetEndDate deliberately NOT copied. Unlike `Task.deadline`,
          // this column IS nullable, so "no date yet" is representable — and
          // it is the truthful state for a plan that hasn't been scheduled.
          // Carrying the source's date over would render the card's "Overdue"
          // chip (components/projects/project-card.tsx) the instant the
          // project appeared, which is a red flag about nothing.
          targetEndDate: null,
          createdBy: userId,
        },
      });

      if (taskRows.length > 0) {
        // One statement, not one per task — see the header note on the ceiling.
        await tx.task.createMany({
          data: taskRows.map((t) => ({ ...t, projectId: project.id })),
        });
      }

      // Reuses "project_created" rather than minting a "project_duplicated"
      // type: the ActivityType union (lib/types.ts) and the feed's icon map
      // (activities-client.tsx) would both need an entry, and an unknown type
      // renders as a fallback row. The message carries the distinction, and
      // `duplicatedFrom` in the metadata makes the lineage queryable.
      await logProjectActivity(tx, {
        companyId,
        projectId: project.id,
        type: "project_created",
        message: `${creator.name} duplicated "${source.name}" as "${name}"`,
        userId,
        userName: creator.name,
        metadata: {
          kind: "project",
          projectId: project.id,
          projectName: name,
          duplicatedFrom: source.id,
          taskCount: taskRows.length,
        },
      });

      // `exclude` covers the common case where the duplicator IS the
      // supervisor, and the fallback case where the copy landed on them.
      await notifyUsers({
        event: "project_supervisor",
        userIds: [supervisorId],
        exclude: userId,
        companyId,
        projectId: project.id,
        title: "You're a project supervisor",
        message: `${creator.name} made you supervisor of "${name}"`,
        category: "task",
        link: `/projects/${project.id}`,
        tx,
      });

      return project;
    });

    // +1 for the project row itself, so the number in Sentry matches what was
    // actually written rather than just the task count.
    warnBulkMutation(taskRows.length + 1, {
      action: "duplicateProjectAction",
      userId,
      companyId,
      extra: {
        sourceProjectId: source.id,
        newProjectId: created.id,
        taskCount: taskRows.length,
        keepAssignees,
        shiftDeadlines,
      },
    });

    revalidatePath("/projects");
    revalidatePath(`/projects/${created.id}`);
    revalidatePath("/dashboard");
    // The copied tasks show up on the global board and in its counts too —
    // skipping this leaves /tasks stale until something else revalidates it.
    if (taskRows.length > 0) revalidatePath("/tasks");
    return { success: true, data: { projectId: created.id } };
  } catch (e) {
    captureServerError(e, { action: "duplicateProjectAction", userId, companyId });
    return { success: false, error: "Couldn't duplicate the project right now." };
  }
}

export async function updateProjectAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }

  const parsed = UpdateProjectSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid update" };
  }
  const { projectId, name, description, color, status, targetEndDate } = parsed.data;
  const { id: userId, companyId, role } = session.user;

  try {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.companyId !== companyId) {
      return { success: false, error: "Project not found" };
    }
    if (!canManageProject({ userId, role: role as Role, project })) {
      return { success: false, error: "Only the supervisor or a founder can edit this project" };
    }

    const me = await db.user.findUnique({ where: { id: userId } });
    if (!me) return { success: false, error: "User no longer exists" };

    const wasArchived = project.status === "archived";
    const willBeArchived = status === "archived";

    await db.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: {
          name,
          description: description ?? null,
          color,
          status,
          targetEndDate: targetEndDate ?? null,
        },
      });

      // Distinct activity type when the status transition is archive — the
      // activity feed reads better than a generic "updated".
      if (!wasArchived && willBeArchived) {
        await logProjectActivity(tx, {
          companyId,
          projectId,
          type: "project_archived",
          message: `${me.name} archived project "${name}"`,
          userId,
          userName: me.name,
          metadata: { kind: "project", projectId, projectName: name },
        });
      } else {
        await logProjectActivity(tx, {
          companyId,
          projectId,
          type: "project_updated",
          message: `${me.name} updated project "${name}"`,
          userId,
          userName: me.name,
          metadata: { kind: "project", projectId, projectName: name },
        });
      }
    });

    revalidatePath("/projects");
    revalidatePath(`/projects/${projectId}`);
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateProjectAction" });
    return { success: false, error: "Couldn't update the project right now." };
  }
}

export async function changeSupervisorAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canReassignSupervisor(session.user.role as Role)) {
    return { success: false, error: "Only founders can reassign a supervisor" };
  }

  const parsed = ChangeSupervisorSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  }
  const { projectId, supervisorId } = parsed.data;
  const { id: userId, companyId } = session.user;

  try {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.companyId !== companyId) {
      return { success: false, error: "Project not found" };
    }
    const supervisor = await db.user.findFirst({
      where: { id: supervisorId, companyId },
      select: { id: true, name: true },
    });
    if (!supervisor) {
      return { success: false, error: "Supervisor must be a member of this company" };
    }

    const me = await db.user.findUnique({ where: { id: userId } });
    if (!me) return { success: false, error: "User no longer exists" };

    await db.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: { supervisorId },
      });
      await logProjectActivity(tx, {
        companyId,
        projectId,
        type: "project_supervisor_changed",
        message: `${me.name} made ${supervisor.name} supervisor of "${project.name}"`,
        userId,
        userName: me.name,
        metadata: {
          kind: "project",
          projectId,
          projectName: project.name,
        },
      });
      await notifyUsers({
        event: "project_supervisor",
        userIds: [supervisorId],
        exclude: userId,
        companyId,
        projectId,
        title: "You're a project supervisor",
        message: `You now supervise "${project.name}"`,
        category: "task",
        link: `/projects/${projectId}`,
        tx,
      });
    });

    revalidatePath("/projects");
    revalidatePath(`/projects/${projectId}`);
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "changeSupervisorAction" });
    return { success: false, error: "Couldn't change the supervisor right now." };
  }
}

export async function deleteProjectAction(projectId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!projectId) return { success: false, error: "Missing project id" };

  try {
    const project = await db.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });
    if (!project || project.companyId !== session.user.companyId) {
      return { success: false, error: "Project not found" };
    }
    if (!canManageProject({ userId: session.user.id, role: session.user.role as Role, project })) {
      return { success: false, error: "Only the supervisor or a founder can delete this project" };
    }

    // Only empty projects are deletable — otherwise archive/reparent first.
    const [taskCount, budgetCount] = await Promise.all([
      db.task.count({ where: { projectId, deletedAt: null } }),
      db.budget.count({ where: { projectId, deletedAt: null } }),
    ]);
    if (taskCount > 0 || budgetCount > 0) {
      return {
        success: false,
        error: `Project still has ${taskCount} task(s) and ${budgetCount} budget(s). Archive it instead, or reparent its work first.`,
      };
    }

    // Tier 3 soft-delete (matches the documented recovery model): stamp
    // deletedAt instead of a hard delete so an accidental project delete has
    // the same 90-day recovery window as every other soft-delete table. The
    // deletedAt:null read filters hide it immediately.
    await db.project.update({ where: { id: projectId }, data: { deletedAt: new Date() } });
    revalidatePath("/projects");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteProjectAction" });
    return { success: false, error: "Couldn't delete the project right now." };
  }
}
