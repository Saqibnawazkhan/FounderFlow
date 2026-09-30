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

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Role } from "@/lib/auth/role-gates";
import {
  canSeeAllProjects,
  canSeeProject,
  canSeeProjectFinances,
} from "@/lib/auth/project-permissions";
import { durationMs } from "@/lib/time/thresholds";

/**
 * The statuses in which a project no longer takes part in day-to-day work.
 *
 * ONE CONSTANT, BECAUSE TWO LITERALS DRIFTED. Finding projects-011.
 * `listProjectOptions` — the source for every project picker in the task /
 * budget / transaction / clock-in forms — filtered only
 * `status: { not: "archived" }`, so a COMPLETED project was still offered. The
 * global task board filters `project: { status: { notIn: ["completed",
 * "archived"] } }` (lib/queries/tasks.ts). A task filed into a completed
 * project therefore existed, counted in that project's own KPIs, and was
 * invisible on /tasks for admin, cofounder and the assignee alike — while the
 * `task_assigned` notification deep-linked to `/tasks?taskId=<id>` and landed
 * on a board with nothing to highlight. That reads to the customer as "your app
 * lost my work".
 *
 * The two rules have to be the same rule, so they are the same array. The one
 * remaining literal is in lib/queries/tasks.ts's board clause; it should import
 * this. `tests/lib/queries/projects-scope.test.ts` drives both queries and
 * compares what each excludes, so the two cannot diverge again silently even
 * while the literal is still there.
 */
export const INACTIVE_PROJECT_STATUSES: readonly string[] = ["completed", "archived"];

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
  /**
   * OPTIMISTIC-CONCURRENCY TOKEN (projects-010). The row's `updatedAt`, which
   * Prisma rewrites on every single write.
   *
   * It is on the DTO for one reason: `updateProjectAction` refuses an edit whose
   * `expectedUpdatedAt` no longer matches the row, and the only way the Edit
   * modal can send that is if the value reached the client. Drop this field and
   * the server-side check becomes unreachable from the one surface that needs
   * it — this repo's most productive defect shape (see
   * tests/lib/architecture/decision-reachability.test.ts).
   *
   * An ISO STRING, like every other timestamp on this DTO. These cross the RSC
   * boundary, where a `Date` would arrive as a Date in one render and as a
   * string after `router.refresh()`; the token has to compare equal either way.
   * The action parses it back with `new Date()`.
   */
  updatedAt: string;
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
  updatedAt: Date;
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
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * One row per project from the tracked-time SUM. `ms` is null for a group with
 * no finished entries, and `Prisma.Decimal` would be the type if the cast in the
 * SQL were ever dropped — hence `number | string` and a `Number()` at the use
 * site rather than trusting the driver.
 */
type ClosedTimeSumRow = { projectId: string | null; ms: number | string | null };

/**
 * TRACKED TIME IS A SUM, AND SUMS BELONG IN SQL. Finding perf-003.
 *
 * Both roll-ups here used to run `db.timeEntry.findMany({ where: { projectId:
 * … } })` with NO `take` and add the durations up in a JavaScript loop. The
 * sibling roll-ups in the same `Promise.all` (`task.groupBy`,
 * `transaction.groupBy`) were already done in SQL; the time sum was the one that
 * was not. A workspace clocking eight entries per person per week reaches ~20k
 * TimeEntry rows inside a year, and /projects pulled every one of them into the
 * Node heap on each load to produce one number per card. On a serverless
 * function that is not a slow page, it is the memory ceiling.
 *
 * WHY THE SPLIT INTO TWO READS — deliberate, and not an optimisation that can be
 * "simplified" into one. A FINISHED entry's duration is a function of two stored
 * columns, so Postgres can sum it. A RUNNING entry's duration depends on `now`,
 * and pinning `now` inside the SQL means binding a JavaScript Date against a
 * Prisma `DateTime` column (`timestamp(3)`, no time zone) and hoping the
 * implicit cast in `COALESCE("clockOutAt", $1)` means what we think it means —
 * a timezone bug in a money-adjacent figure, in exchange for nothing. Open
 * entries are instead read as rows and passed through the same `durationMs`
 * every other surface uses, and that read is bounded by the number of people
 * currently clocked in: `clockInAction` enforces one open entry per user, so it
 * is at most the size of the team, not the size of the history.
 *
 * `GREATEST(0, …)` mirrors `durationMs`'s `Math.max(0, …)`: a manually edited
 * entry whose clock-out precedes its clock-in contributes zero, not a negative.
 */
function closedTrackedMsByProject(rows: ClosedTimeSumRow[]): Map<string, number> {
  const byProject = new Map<string, number>();
  for (const row of rows) {
    if (!row.projectId || row.ms === null) continue;
    byProject.set(row.projectId, Math.round(Number(row.ms)));
  }
  return byProject;
}

/** The single-project form of the same sum. */
function closedTrackedMs(rows: { ms: number | string | null }[]): number {
  const total = rows.length > 0 ? rows[0].ms : null;
  return total === null || total === undefined ? 0 : Math.round(Number(total));
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

  const [openCountsRows, spendRows, closedTimeRows, openTimeEntries] = await Promise.all([
    db.task.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, deletedAt: null, status: { not: "completed" } },
      _count: { _all: true },
    }),
    spendRowsPromise,
    // The finished hours, summed BY POSTGRES. See the note on
    // `closedTrackedMsByProject` below for why this is raw SQL and why the
    // still-running entries are a separate, bounded read.
    db.$queryRaw<ClosedTimeSumRow[]>`
      SELECT "projectId",
             SUM(GREATEST(0, EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt")) * 1000))
               ::double precision AS ms
        FROM "TimeEntry"
       WHERE "companyId" = ${companyId}
         AND "clockOutAt" IS NOT NULL
         AND "projectId" IN (${Prisma.join(projectIds)})
       GROUP BY "projectId"
    `,
    db.timeEntry.findMany({
      where: { companyId, projectId: { in: projectIds }, clockOutAt: null },
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
  const trackedByProject = closedTrackedMsByProject(closedTimeRows);
  // …plus whatever is still on the clock. `durationMs` is reused verbatim so an
  // open entry accrues to exactly the same `now` the rest of this function uses.
  for (const e of openTimeEntries) {
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
  const { userId, companyId, role } = await requireScopedSession();
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

  const [openTasks, totalTasks, spendSum, closedTimeRows, openTimeEntries, memberIds] =
    await Promise.all([
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
      // Finished hours summed by Postgres; see `closedTrackedMsByProject` above
      // for why this is raw SQL and why the running entries are read separately.
      db.$queryRaw<{ ms: number | string | null }[]>`
        SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM ("clockOutAt" - "clockInAt")) * 1000))
                 ::double precision AS ms
          FROM "TimeEntry"
         WHERE "companyId" = ${companyId}
           AND "projectId" = ${projectId}
           AND "clockOutAt" IS NOT NULL
      `,
      db.timeEntry.findMany({
        where: { companyId, projectId, clockOutAt: null },
        select: { clockInAt: true, clockOutAt: true },
      }),
      db.task.findMany({
        where: { projectId, deletedAt: null },
        select: { assignedTo: true },
        distinct: ["assignedTo"],
      }),
    ]);

  const trackedMs =
    closedTrackedMs(closedTimeRows) +
    openTimeEntries.reduce((acc, e) => acc + durationMs(e.clockInAt, e.clockOutAt, now), 0);

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
      ? { companyId, deletedAt: null, status: { notIn: [...INACTIVE_PROJECT_STATUSES] } }
      : {
          companyId,
          deletedAt: null,
          // Spread, not the constant itself: Prisma's `notIn` takes a mutable
          // `string[]` and the constant is `readonly` so nothing can push to it.
          status: { notIn: [...INACTIVE_PROJECT_STATUSES] },
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

/**
 * How long a tombstoned project survives before `/api/cron/purge-soft-deleted`
 * erases it. Mirrors `RETENTION_DAYS` in that route, which is the authority.
 *
 * Duplicated rather than imported because the route is a Next.js Route Handler
 * and cannot export a constant — Next validates route exports. The number is
 * shown to the user, so `tests/lib/queries/deleted-projects.test.ts` reads the
 * route's own literal and asserts the two agree: a countdown that disagrees with
 * the job doing the deleting is worse than no countdown.
 */
export const PROJECT_RETENTION_DAYS = 90;

/** A tombstoned project, as the "Recently deleted" panel needs it. */
export interface DeletedProjectListItem {
  id: string;
  name: string;
  color: string;
  status: string;
  supervisorName: string | null;
  /** ISO 8601, so it crosses the RSC boundary unchanged. */
  deletedAt: string;
  /**
   * Whole days left before the purge erases it, floored, never below 0.
   *
   * Computed on the SERVER on purpose. The client has the customer's clock, and
   * this number is the difference between "you can still get it back" and "it is
   * gone" — a browser an hour fast must not tell somebody their window closed.
   */
  daysUntilPurge: number;
}

/**
 * Projects this caller deleted-but-can-still-recover. data-integrity-010.
 *
 * WHY THIS EXISTS. `deleteProjectAction` writes `Project.deletedAt` and says, in
 * its own comment, that it does so "so an accidental project delete has the same
 * 90-day recovery window as every other soft-delete table". Nothing ever cleared
 * that column: a grep for `deletedAt: null` WRITES across lib/ and app/ found
 * exactly one, `reactivateUserAction`. So the window existed in the database and
 * was unusable from the product — /projects excluded the row, /projects/<id>
 * 404'd, search excluded it, and the only recovery was ops SQL the customer could
 * not even ASK for, because they could no longer see that the project existed.
 * The tombstone bought none of what it was written to buy.
 *
 * The visibility rule is the same one `listProjectsForUser` uses, minus the half
 * that cannot apply: admin/cofounder see every deleted project, and anyone else
 * sees the ones they supervised. The task-assignment branch is deliberately
 * absent — `deleteProjectAction` refuses a project with any live task, so a
 * deleted project has no assignees to derive visibility from.
 */
export async function listDeletedProjectsForUser(
  now: Date = new Date()
): Promise<DeletedProjectListItem[]> {
  const { userId, companyId, role } = await requireScopedSession();

  const rows = await db.project.findMany({
    where: canSeeAllProjects(role as Role)
      ? { companyId, deletedAt: { not: null } }
      : { companyId, deletedAt: { not: null }, supervisorId: userId },
    include: { supervisor: { select: { name: true } } },
    orderBy: { deletedAt: "desc" },
  });

  const msPerDay = 24 * 60 * 60 * 1000;
  return rows.map((p) => {
    // `deletedAt` is non-null by the WHERE above; the fallback keeps TypeScript
    // honest without inventing a date that would read as "deleted just now".
    const deletedAt = p.deletedAt ?? now;
    const elapsedDays = (now.getTime() - deletedAt.getTime()) / msPerDay;
    const left = Math.floor(PROJECT_RETENTION_DAYS - elapsedDays);
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      status: p.status,
      supervisorName: p.supervisor?.name ?? null,
      deletedAt: deletedAt.toISOString(),
      daysUntilPurge: left > 0 ? left : 0,
    };
  });
}
