"use server";

/**
 * Project server actions: create, update, change supervisor, archive,
 * delete. Permission gates run in lib/auth/project-permissions.ts so the
 * test suite can exercise them in isolation.
 *
 * Activity + notification side effects:
 *   create   → Activity { type: "project_created" }
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
  NewProjectSchema,
  UpdateProjectSchema,
} from "@/lib/schemas/project";
import { limiters } from "@/lib/rate-limit";
import {
  canCreateProject,
  canManageProject,
  canReassignSupervisor,
} from "@/lib/auth/project-permissions";
import { captureServerError } from "@/lib/sentry-server";
import type { Role } from "@/lib/auth/role-gates";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

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

      // If the supervisor is someone OTHER than the creator, ping them.
      if (supervisorId !== userId) {
        await tx.notification.create({
          data: {
            userId: supervisorId,
            companyId,
            projectId: created.id,
            title: "You're a project supervisor",
            message: `${creator.name} made you supervisor of "${name}"`,
            type: "info",
            link: `/projects/${created.id}`,
          },
        });
      }

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
      // Notify the new supervisor unless they're the one who hit Save.
      if (supervisorId !== userId) {
        await tx.notification.create({
          data: {
            userId: supervisorId,
            companyId,
            projectId,
            title: "You're a project supervisor",
            message: `You now supervise "${project.name}"`,
            type: "info",
            link: `/projects/${projectId}`,
          },
        });
      }
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
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.companyId !== session.user.companyId) {
      return { success: false, error: "Project not found" };
    }
    if (!canManageProject({ userId: session.user.id, role: session.user.role as Role, project })) {
      return { success: false, error: "Only the supervisor or a founder can delete this project" };
    }

    // Restrict policy in the schema would surface this as a 500 — preempt
    // with a friendly message + a count so the user knows what to clean up.
    const [taskCount, budgetCount] = await Promise.all([
      db.task.count({ where: { projectId } }),
      db.budget.count({ where: { projectId } }),
    ]);
    if (taskCount > 0 || budgetCount > 0) {
      return {
        success: false,
        error: `Project still has ${taskCount} task(s) and ${budgetCount} budget(s). Archive it instead, or reparent its work first.`,
      };
    }

    await db.project.delete({ where: { id: projectId } });
    revalidatePath("/projects");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "deleteProjectAction" });
    return { success: false, error: "Couldn't delete the project right now." };
  }
}
