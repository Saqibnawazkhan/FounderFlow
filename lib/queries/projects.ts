/**
 * Read-side queries for projects. Pairs with lib/actions/projects.ts.
 *
 * Visibility rules — encoded once here, mirrored in
 * lib/auth/project-permissions.ts:
 *
 *   - admin + cofounder see every project in their company.
 *   - members see a project iff they're the supervisor OR they have at
 *     least one assigned task in it. Derived via Prisma OR on the where
 *     clause so the SQL stays on one round trip.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { durationMs } from "@/lib/time/thresholds";

export interface ProjectClient {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  supervisorId: string;
  supervisorName: string;
  status: "active" | "on_hold" | "completed" | "archived";
  color: string;
  targetEndDate: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ProjectListItem extends ProjectClient {
  /** Open tasks in this project (status != "completed"). */
  openTaskCount: number;
  /** Total tasks (open + done) — used to render "3 of 8 open" style. */
  totalTaskCount: number;
  /** Sum of project-tagged expense Transactions in the current calendar month. */
  monthToDateSpendPkr: number;
  /** Sum of all TimeEntry durations across the project (ms). */
  trackedMs: number;
}

export interface ProjectOverview extends ProjectListItem {
  /** Distinct users with at least one task here. Includes the supervisor. */
  memberCount: number;
}

function toClient(p: {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  supervisorId: string;
  status: string;
  color: string;
  targetEndDate: Date | null;
  createdBy: string;
  createdAt: Date;
  supervisor: { name: string };
}): ProjectClient {
  return {
    id: p.id,
    companyId: p.companyId,
    name: p.name,
    description: p.description,
    supervisorId: p.supervisorId,
    supervisorName: p.supervisor.name,
    status: p.status as ProjectClient["status"],
    color: p.color,
    targetEndDate: p.targetEndDate ? p.targetEndDate.toISOString() : null,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Returns every project the current user is allowed to see, oldest-first.
 * Members get the filtered subset; admin/cofounder get all rows.
 */
export async function listProjectsForUser(): Promise<ProjectListItem[]> {
  const { userId, companyId, role } = await requireScopedSession();

  const baseWhere = canSeeFinances(role)
    ? { companyId }
    : {
        companyId,
        // Member-tier visibility: own supervisor OR has at least one task.
        OR: [{ supervisorId: userId }, { tasks: { some: { assignedTo: userId } } }],
      };

  const projects = await db.project.findMany({
    where: baseWhere,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      supervisor: { select: { name: true } },
      _count: { select: { tasks: true } },
    },
  });

  if (projects.length === 0) return [];
  const projectIds = projects.map((p) => p.id);

  // Open-task counts and MTD spend in two extra queries, fused on
  // projectId via Map lookup so the page paints in a single round trip.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [openCountsRows, spendRows, timeEntryRows] = await Promise.all([
    db.task.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, status: { not: "completed" } },
      _count: { _all: true },
    }),
    db.transaction.groupBy({
      by: ["projectId"],
      where: {
        projectId: { in: projectIds },
        type: "expense",
        date: { gte: monthStart, lt: nextMonthStart },
      },
      _sum: { amount: true },
    }),
    db.timeEntry.findMany({
      where: { projectId: { in: projectIds } },
      select: { projectId: true, clockInAt: true, clockOutAt: true },
    }),
  ]);

  const openByProject = new Map<string, number>();
  for (const r of openCountsRows) {
    if (r.projectId) openByProject.set(r.projectId, r._count._all);
  }
  const spendByProject = new Map<string, number>();
  for (const r of spendRows) {
    // BUGS.md P0-4: _sum.amount is Prisma.Decimal after the schema change.
    if (r.projectId) spendByProject.set(r.projectId, r._sum.amount ? r._sum.amount.toNumber() : 0);
  }
  const trackedByProject = new Map<string, number>();
  for (const e of timeEntryRows) {
    if (!e.projectId) continue;
    const ms = durationMs(e.clockInAt, e.clockOutAt, now);
    trackedByProject.set(e.projectId, (trackedByProject.get(e.projectId) ?? 0) + ms);
  }

  return projects.map((p) => ({
    ...toClient(p),
    openTaskCount: openByProject.get(p.id) ?? 0,
    totalTaskCount: p._count.tasks,
    monthToDateSpendPkr: spendByProject.get(p.id) ?? 0,
    trackedMs: trackedByProject.get(p.id) ?? 0,
  }));
}

/**
 * Fetch a single project with the same visibility rule. Returns null when
 * the caller isn't allowed to see it (so the page renders a 404 instead of
 * leaking existence to a member who happens to know the id).
 */
export async function getProjectForUser(projectId: string): Promise<ProjectClient | null> {
  const { userId, companyId, role } = await requireScopedSession();

  const project = await db.project.findFirst({
    where: { id: projectId, companyId },
    include: { supervisor: { select: { name: true } } },
  });
  if (!project) return null;

  if (!canSeeFinances(role) && project.supervisorId !== userId) {
    // Cheaper exists() than findFirst when we don't need the row.
    const hasTask = await db.task.findFirst({
      where: { projectId, assignedTo: userId },
      select: { id: true },
    });
    if (!hasTask) return null;
  }

  return toClient(project);
}

/**
 * Overview for the project detail page — folds in everything the header +
 * KPI cards need so the RSC paints in one trip.
 */
export async function getProjectOverview(projectId: string): Promise<ProjectOverview | null> {
  const project = await getProjectForUser(projectId);
  if (!project) return null;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [openTasks, totalTasks, spendSum, entries, memberIds] = await Promise.all([
    db.task.count({ where: { projectId, status: { not: "completed" } } }),
    db.task.count({ where: { projectId } }),
    db.transaction.aggregate({
      _sum: { amount: true },
      where: {
        projectId,
        type: "expense",
        date: { gte: monthStart, lt: nextMonthStart },
      },
    }),
    db.timeEntry.findMany({
      where: { projectId },
      select: { clockInAt: true, clockOutAt: true },
    }),
    db.task.findMany({
      where: { projectId },
      select: { assignedTo: true },
      distinct: ["assignedTo"],
    }),
  ]);

  const trackedMs = entries.reduce((acc, e) => acc + durationMs(e.clockInAt, e.clockOutAt, now), 0);

  // Count distinct members: task assignees + supervisor (Set dedupes).
  const memberSet = new Set<string>(memberIds.map((m) => m.assignedTo));
  memberSet.add(project.supervisorId);

  return {
    ...project,
    openTaskCount: openTasks,
    totalTaskCount: totalTasks,
    // BUGS.md P0-4: aggregate is Prisma.Decimal after Float→Decimal.
    monthToDateSpendPkr: spendSum._sum.amount ? spendSum._sum.amount.toNumber() : 0,
    trackedMs,
    memberCount: memberSet.size,
  };
}

/**
 * Lightweight `{ id, name }` list for the project pickers in the task /
 * budget / transaction / clock-in forms. Filters by visibility so a member
 * can't tag a transaction into a project they don't belong to.
 */
export async function listProjectOptions(): Promise<{ id: string; name: string; color: string }[]> {
  const { userId, companyId, role } = await requireScopedSession();
  const projects = await db.project.findMany({
    where: canSeeFinances(role as Role)
      ? { companyId, status: { not: "archived" } }
      : {
          companyId,
          status: { not: "archived" },
          OR: [{ supervisorId: userId }, { tasks: { some: { assignedTo: userId } } }],
        },
    select: { id: true, name: true, color: true },
    orderBy: { name: "asc" },
  });
  return projects;
}
