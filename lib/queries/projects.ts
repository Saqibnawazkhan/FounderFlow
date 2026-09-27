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
 *
 * MONEY IS A SECOND, NARROWER GATE, AND IT IS APPLIED BEFORE THE READ.
 * Seeing a project is not seeing its spend: a plain assignee gets the tasks
 * and time tabs, never the figures (lib/auth/project-permissions.ts spells
 * this out). That used to be enforced only at render — the queries computed
 * `monthToDateSpendPkr` for every viewer and the components painted an
 * em-dash over it — which is not enforcement at all, because the RSC hands
 * a client component its props through the Flight payload: the number was in
 * the served HTML, readable from View Source with no tooling, and recoverable
 * by anyone who flipped the client-side gate open (the store's role can come
 * from localStorage). Findings sec-004 / projects-006.
 *
 * So the aggregate is SKIPPED, not masked. `canSeeProjectFinances` decides
 * whether to ask the question, and `financeVisible` on the DTO carries the
 * server's answer so the UI masks an absent value instead of a present one —
 * and so the mask stops depending on the client re-deriving the same rule
 * from a role it keeps in browser storage. lib/queries/chat.ts:247 argues the
 * identical discipline for the runway card.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Role } from "@/lib/auth/role-gates";
import {
  canSeeAllProjects,
  canSeeProject,
  canSeeProjectFinances,
} from "@/lib/auth/project-permissions";
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
  /**
   * Sum of project-tagged expense Transactions in the current calendar month,
   * or 0 when `financeVisible` is false — in which case the aggregate was
   * never run and this field carries no information about the real spend.
   *
   * It is 0 rather than `null` only because the two consumers
   * (components/projects/project-card.tsx, app/(app)/projects/[id]/
   * project-detail-client.tsx) pass it straight into `money()`, which takes a
   * number. Read `financeVisible` — never a zero — to decide whether to show
   * it; a genuinely empty month is also 0.
   */
  monthToDateSpendPkr: number;
  /**
   * Whether the SERVER decided this viewer may see this project's money. The
   * UI must mask on this, not on a role it re-derives client-side: the store's
   * role is hydrated into the browser and a client-only gate is a curtain,
   * not a boundary.
   */
  financeVisible: boolean;
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

  const baseWhere = canSeeAllProjects(role)
    ? { companyId, deletedAt: null }
    : {
        companyId,
        deletedAt: null,
        // Member-tier visibility: own supervisor OR has at least one task.
        OR: [
          { supervisorId: userId },
          { tasks: { some: { assignedTo: userId, deletedAt: null } } },
        ],
      };

  const projects = await db.project.findMany({
    where: baseWhere,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      supervisor: { select: { name: true } },
      _count: { select: { tasks: { where: { deletedAt: null } } } },
    },
  });

  if (projects.length === 0) return [];
  const projectIds = projects.map((p) => p.id);

  // The subset whose money this caller may see. For admin/cofounder that is
  // every row; for a member it is only the projects they supervise — being
  // assigned a task grants tasks + time, never figures. Computed BEFORE the
  // spend query so the `in` list, not a post-filter, is the enforcement: a
  // filtered-after read has already put the number in this process, one
  // `...p` spread away from the Flight payload. Plain `.filter` + array
  // membership rather than a Set, deliberately — tsconfig has no `target` so
  // tsc defaults to ES5, where iterating a Set is TS2802 (see CLAUDE.md's
  // verification notes).
  const financeProjectIds = projects
    .filter((p) => canSeeProjectFinances({ userId, role, project: p }))
    .map((p) => p.id);

  // Open-task counts and MTD spend in two extra queries, fused on
  // projectId via Map lookup so the page paints in a single round trip.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // `null`, not an empty array, when the caller may see no project's money —
  // a member with only assigned work. Kept as a nullable promise rather than a
  // resolved `[]` so the two branches don't union their element types and turn
  // `_sum.amount` into `unknown` at the `.toNumber()` below.
  const spendRowsPromise =
    financeProjectIds.length === 0
      ? null
      : db.transaction.groupBy({
          by: ["projectId"],
          where: {
            projectId: { in: financeProjectIds },
            deletedAt: null,
            type: "expense",
            date: { gte: monthStart, lt: nextMonthStart },
          },
          _sum: { amount: true },
        });

  const [openCountsRows, spendRows, timeEntryRows] = await Promise.all([
    db.task.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, deletedAt: null, status: { not: "completed" } },
      _count: { _all: true },
    }),
    spendRowsPromise,
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
  for (const r of spendRows ?? []) {
    // FaultsAudit.md P0-4: _sum.amount is Prisma.Decimal after the schema change.
    if (r.projectId) spendByProject.set(r.projectId, r._sum.amount ? r._sum.amount.toNumber() : 0);
  }
  const trackedByProject = new Map<string, number>();
  for (const e of timeEntryRows) {
    if (!e.projectId) continue;
    const ms = durationMs(e.clockInAt, e.clockOutAt, now);
    trackedByProject.set(e.projectId, (trackedByProject.get(e.projectId) ?? 0) + ms);
  }

  return projects.map((p) => {
    const financeVisible = financeProjectIds.indexOf(p.id) !== -1;
    return {
      ...toClient(p),
      openTaskCount: openByProject.get(p.id) ?? 0,
      totalTaskCount: p._count.tasks,
      // Gated a second time on the way OUT, not only on the way in. The `in`
      // list above is the real fix; this is the belt-and-braces half, so that
      // widening the spend query later (adding a project the caller can SEE
      // but whose money they may not) cannot quietly put a figure back into
      // the payload. A miss is both "no spend this month" and "not yours" —
      // which is why `financeVisible` travels alongside rather than the UI
      // trying to read meaning into a zero.
      monthToDateSpendPkr: financeVisible ? (spendByProject.get(p.id) ?? 0) : 0,
      financeVisible,
      trackedMs: trackedByProject.get(p.id) ?? 0,
    };
  });
}

/**
 * Fetch a single project with the same visibility rule. Returns null when
 * the caller isn't allowed to see it (so the page renders a 404 instead of
 * leaking existence to a member who happens to know the id).
 */
export async function getProjectForUser(projectId: string): Promise<ProjectClient | null> {
  const { userId, companyId, role } = await requireScopedSession();

  const project = await db.project.findFirst({
    where: { id: projectId, companyId, deletedAt: null },
    include: { supervisor: { select: { name: true } } },
  });
  if (!project) return null;

  // Probe the cheap clauses first (role, supervisor). Only if those don't
  // grant access do we pay for the task lookup — `canSeeProject` is monotone
  // in `hasTaskInProject`, so a false probe can never wrongly deny.
  if (!canSeeProject({ userId, role, project, hasTaskInProject: false })) {
    // Cheaper exists() than findFirst when we don't need the row.
    const hasTask = await db.task.findFirst({
      where: { projectId, assignedTo: userId, deletedAt: null },
      select: { id: true },
    });
    if (!canSeeProject({ userId, role, project, hasTaskInProject: !!hasTask })) return null;
  }

  return toClient(project);
}

/**
 * Overview for the project detail page — folds in everything the header +
 * KPI cards need so the RSC paints in one trip.
 */
export async function getProjectOverview(projectId: string): Promise<ProjectOverview | null> {
  const { userId, role } = await requireScopedSession();
  const project = await getProjectForUser(projectId);
  if (!project) return null;

  // The money decision, taken before the aggregate runs. The page computes the
  // same predicate for its own `canSeeBudgets` prop (and uses it to skip the
  // budget query entirely) — this is the other half of that: skipping the
  // SPEND read too, so a plain assignee's payload carries no figure to unmask.
  const financeVisible = canSeeProjectFinances({
    userId,
    role,
    project: { supervisorId: project.supervisorId },
  });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [openTasks, totalTasks, spendSum, entries, memberIds] = await Promise.all([
    db.task.count({ where: { projectId, deletedAt: null, status: { not: "completed" } } }),
    db.task.count({ where: { projectId, deletedAt: null } }),
    // `null` rather than a resolved zero-sum: the point is that the question is
    // not asked, and a reader of the recorded queries can see that.
    financeVisible
      ? db.transaction.aggregate({
          _sum: { amount: true },
          where: {
            projectId,
            deletedAt: null,
            type: "expense",
            date: { gte: monthStart, lt: nextMonthStart },
          },
        })
      : null,
    db.timeEntry.findMany({
      where: { projectId },
      select: { clockInAt: true, clockOutAt: true },
    }),
    db.task.findMany({
      where: { projectId, deletedAt: null },
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
    // FaultsAudit.md P0-4: aggregate is Prisma.Decimal after Float→Decimal.
    monthToDateSpendPkr: spendSum?._sum.amount ? spendSum._sum.amount.toNumber() : 0,
    financeVisible,
    trackedMs,
    memberCount: memberSet.size,
  };
}

/**
 * The project's name, but only if this caller is allowed to know it — the
 * scoped lookup `generateMetadata` in app/(app)/projects/[id]/page.tsx needs.
 *
 * WHY THIS EXISTS. That metadata function ran its own
 * `db.project.findUnique({ where: { id: params.id } })` with no companyId, no
 * `deletedAt: null` and no session check at all, and used the result as the
 * document `<title>`. So a signed-in user who typed another tenant's project
 * URL got a page reading "not found" whose browser tab carried the other
 * company's project name — often a client or deal name. It also made the
 * deliberate 404-rather-than-403 choice in `getProjectForUser` pointless: the
 * title confirmed both that the id existed and what it was. Findings sec-003 /
 * projects-014.
 *
 * Two properties this has and a raw `findUnique` cannot:
 *   • It reuses `getProjectForUser`, so tenancy AND in-tenant visibility come
 *     from the one audited predicate rather than a second, drifting copy.
 *     That costs an extra round trip beside the page's own overview query —
 *     worth it; a metadata read that reimplements the scope is how this bug
 *     happened.
 *   • It returns null instead of throwing when there is no session.
 *     `requireScopedSession` throws by design, and a throw inside
 *     `generateMetadata` is a 500 on a page that would otherwise render its
 *     own not-found.
 */
export async function getProjectTitleForUser(projectId: string): Promise<string | null> {
  const project = await getProjectForUser(projectId).catch(() => null);
  return project ? project.name : null;
}

/**
 * Lightweight `{ id, name }` list for the project pickers in the task /
 * budget / transaction / clock-in forms. Filters by visibility so a member
 * can't tag a transaction into a project they don't belong to.
 */
export async function listProjectOptions(): Promise<{ id: string; name: string; color: string }[]> {
  const { userId, companyId, role } = await requireScopedSession();
  const projects = await db.project.findMany({
    where: canSeeAllProjects(role as Role)
      ? { companyId, deletedAt: null, status: { not: "archived" } }
      : {
          companyId,
          deletedAt: null,
          status: { not: "archived" },
          OR: [
            { supervisorId: userId },
            { tasks: { some: { assignedTo: userId, deletedAt: null } } },
          ],
        },
    select: { id: true, name: true, color: true },
    orderBy: { name: "asc" },
  });
  return projects;
}
