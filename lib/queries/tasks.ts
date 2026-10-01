/**
 * Read-side queries for tasks. Pairs with lib/actions/tasks.ts which still
 * owns add/update/delete/status-change.
 *
 * Project scoping:
 *   - `getTasks()` (no args) — the company's task board. Used by /tasks,
 *     /dashboard, /team and /time.
 *   - `getTasks({ projectId })` — scoped to one project. Used inside the
 *     project detail page's Tasks tab.
 *
 * ── TWO KINDS OF READ, AND WHY THE DIFFERENCE MATTERS (perf-002 /
 *    tasks-and-comments-010) ────────────────────────────────────────────────
 *
 * ROW READS (`getTasks`, `getTaskPage`, `listTaskOptions`) are for rendering a
 * LIST. They are windowed: always bounded by a row ceiling the caller cannot
 * lift, and pageable by cursor.
 *
 * COUNTS (`getTaskStatusCounts`) are for rendering a NUMBER. They run as a
 * `groupBy` in SQL and have no ceiling at all, because a count taken over a
 * capped array is a count that is quietly wrong.
 *
 * Before that split this was the ONLY uncapped list read in lib/queries/ —
 * every sibling has a documented ceiling (transactions 5,000 per type,
 * activities 500, notifications 200, time 500, chat 50/page, search
 * GROUP_LIMIT). Four pages called it on every visit:
 *
 *   app/(app)/tasks/page.tsx      the board itself
 *   app/(app)/dashboard/page.tsx  only to derive an "open tasks" NUMBER
 *   app/(app)/team/page.tsx       per-member completion cells
 *   app/(app)/time/page.tsx       only to build `{ id, title }` picker options
 *
 * So the customer who used the product successfully was the one it broke: at a
 * few thousand tasks each of those four responses carried the workspace's
 * entire task history — every field, every comment count, every project name —
 * into the RSC payload, and the client rendered every filtered row into a plain
 * `<table>` with no virtualisation. /dashboard paid for all of it to print one
 * integer; /time paid for all of it to fill a `<select>`.
 *
 * `getTasks()` deliberately keeps its `TaskWithCount[]` shape so the four
 * existing callers keep compiling; it is now the first page of `getTaskPage()`.
 * A surface that needs to page (or to say "showing the first N") reaches for
 * `getTaskPage()` and gets `hasMore` + `nextCursor` with it.
 *
 * Tested in tests/lib/queries/task-pagination.test.ts.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { INACTIVE_PROJECT_STATUSES } from "@/lib/queries/projects";
import { canSeeAllProjects } from "@/lib/auth/project-permissions";
import type { Role } from "@/lib/auth/role-gates";
import type { Task, TaskStatus } from "@/lib/types";

// Includes the comment count so the kanban / list can render a "💬 N"
// badge without a second round trip per row.
export type TaskWithCount = Task & { commentCount: number };

/**
 * Default board window.
 *
 * 300 is chosen to be larger than any board a human can work with and smaller
 * than any board that breaks a browser: it is above the 200-id ceiling the bulk
 * actions enforce (lib/schemas/task.ts), so "select all" on a full page is
 * still one request away from being legal, and far below the few thousand rows
 * at which the RSC payload starts costing megabytes.
 */
export const TASK_PAGE_SIZE = 300;

/**
 * Hard ceiling on one page, which a caller can LOWER but never lift.
 *
 * The distinction is the whole point. "Add a `take`" is worthless if any page
 * can pass `take: 1e9` — that is the original unbounded read with extra steps,
 * and it is how a perf ceiling becomes advice instead of a bound.
 */
export const MAX_TASK_PAGE_SIZE = 500;

/** Ceiling on the `{ id, title }` picker list. See `listTaskOptions`. */
export const MAX_TASK_OPTIONS = 500;

export interface TaskQuery {
  /** Scope to one project (the project detail page's Tasks tab). */
  projectId?: string;
  /** Page size. Clamped to `MAX_TASK_PAGE_SIZE`; a caller cannot lift it. */
  take?: number;
  /** Id of the last task of the previous page. Resumes strictly after it. */
  cursor?: string;
}

export interface TaskPage {
  tasks: TaskWithCount[];
  /** True when at least one more task exists after this page. */
  hasMore: boolean;
  /** Pass back as `cursor` to fetch the next page; null when there is none. */
  nextCursor: string | null;
}

function toClient(
  t: {
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
    project?: { name: string } | null;
  },
  commentCount = 0
): TaskWithCount {
  return {
    id: t.id,
    companyId: t.companyId,
    projectId: t.projectId,
    projectName: t.project?.name,
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
    order: t.order,
    commentCount,
  };
}

/**
 * The one place the visibility rules live, so a row read, a paged read and a
 * count can never disagree about which tasks exist.
 *
 * Pure and separate from the queries: every property perf-002 and
 * data-integrity-002 need is a property of this object, and it can be read
 * (and tested) without a database in the room.
 *
 * `project: { deletedAt: null }` on BOTH branches is data-integrity-002.
 * `deleteProjectAction` soft-deletes and leaves `Project.status` alone, so a
 * status filter does not hide a tombstoned project's tasks: they stayed on the
 * global board forever while lib/queries/search.ts:366 filtered them out and
 * commented that "a tombstoned project's tasks are gone from every other
 * surface" — this read was the surface that made that false. The
 * project-scoped branch gets it too: /projects/<id> already 404s for a deleted
 * project (getProjectForUser filters `deletedAt`), so it costs nothing there
 * and means no future caller can reintroduce the hole.
 */
function taskScopeWhere(args: {
  companyId: string;
  userId: string;
  role: "admin" | "cofounder" | "member";
  projectId?: string;
}) {
  return {
    companyId: args.companyId,
    deletedAt: null,
    ...(args.projectId
      ? { projectId: args.projectId, project: { deletedAt: null } }
      : // GLOBAL board / dashboard / team: hide tasks whose parent project is
        // completed or archived — a done/shelved project's tasks shouldn't
        // clutter the active board. They stay visible on the project's own
        // detail page, which passes opts.projectId (no status filter).
        { project: { deletedAt: null, status: { notIn: ["completed", "archived"] } } }),
    // On the GLOBAL board a member only ever sees tasks assigned to THEM —
    // never a teammate's, admin's, or co-founder's work. Enforced here at the
    // data boundary so it can't be unfiltered from the client. Project-scoped
    // reads (opts.projectId) are left to the project's own access control so
    // the per-project supervisor escape-hatch (a member who supervises a
    // project can see its board) keeps working.
    ...(args.role === "member" && !args.projectId ? { assignedTo: args.userId } : {}),
  };
}

/** Clamp to `[1, MAX_TASK_PAGE_SIZE]`, defaulting to `TASK_PAGE_SIZE`. */
function pageSize(take?: number): number {
  return Math.min(Math.max(1, Math.floor(take ?? TASK_PAGE_SIZE)), MAX_TASK_PAGE_SIZE);
}

/**
 * One bounded page of tasks, plus whether there is another.
 *
 * ON THE ORDER: the manual kanban sort key comes first, `createdAt` breaks its
 * ties — and `id` breaks THOSE, which is not decoration. Prisma's cursor
 * pagination is "resume after this row in this order"; if the order is not a
 * total order, two rows sharing an `order` and a `createdAt` can land either
 * side of the page boundary between two queries, so a task is silently
 * returned twice or skipped entirely. `id` is unique, so appending it makes the
 * order total and the paging exact.
 *
 * `take + 1` is the has-more probe: one extra row is cheaper than a second
 * `count()` and cannot disagree with the page it describes.
 */
export async function getTaskPage(opts: TaskQuery = {}): Promise<TaskPage> {
  const { companyId, userId, role } = await requireScopedSession();
  const take = pageSize(opts.take);

  const rows = await db.task.findMany({
    where: taskScopeWhere({ companyId, userId, role, projectId: opts.projectId }),
    orderBy: [{ order: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: {
      _count: { select: { comments: true } },
      project: { select: { name: true } },
    },
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    tasks: page.map((r) => toClient(r, r._count.comments)),
    hasMore,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
  };
}

/**
 * The first page of the board, as a plain array.
 *
 * Kept at this shape on purpose: four pages already destructure it as
 * `TaskWithCount[]`, and changing the return type would have meant editing four
 * files to fix one query. A surface that needs to page — or to tell the user it
 * is showing a window — calls `getTaskPage()` instead.
 */
export async function getTasks(opts: TaskQuery = {}): Promise<TaskWithCount[]> {
  const page = await getTaskPage(opts);
  return page.tasks;
}

/** Every status in `Task.status`, enumerated so a count always reports all
 *  three — a status with no rows has to come back as 0, not as a missing key
 *  that renders "NaN". */
export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"];

export type TaskStatusCounts = Record<TaskStatus, number> & {
  /** pending + in_progress — the "open tasks" KPI. */
  open: number;
  total: number;
};

/**
 * Task counts per status, in ONE `groupBy`.
 *
 * This is what a KPI must read. No `take`, so no task can be excluded from the
 * number no matter how large the workspace gets — which is the half of
 * tasks-and-comments-010 that a page size alone does NOT fix: /dashboard was
 * deriving "open tasks" by filtering the row array, so the moment the board
 * became a window the headline number would have started under-reporting. Same
 * mistake as money-008, different table.
 */
export async function getTaskStatusCounts(
  opts: { projectId?: string } = {}
): Promise<TaskStatusCounts> {
  const { companyId, userId, role } = await requireScopedSession();
  const rows = await db.task.groupBy({
    by: ["status"],
    where: taskScopeWhere({ companyId, userId, role, projectId: opts.projectId }),
    _count: { _all: true },
  });

  const counts: TaskStatusCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    open: 0,
    total: 0,
  };
  for (const r of rows) {
    const n = r._count._all;
    counts.total += n;
    // A status outside the union means a writer invented one; counting it in
    // `total` but not in a named bucket keeps the rest of the figures right
    // instead of throwing on the dashboard.
    if (TASK_STATUSES.indexOf(r.status as TaskStatus) === -1) continue;
    counts[r.status as TaskStatus] += n;
    if (r.status !== "completed") counts.open += n;
  }
  return counts;
}

/**
 * `{ id, title }` for a task picker — the /time edit modal's dropdown.
 *
 * /time used to call `getTasks()` and throw away every field but two, which
 * meant the whole task table (with a comment-count subquery and a project join
 * per row) was read to populate a `<select>`. Two columns and a bound instead.
 */
export async function listTaskOptions(
  opts: { projectId?: string; limit?: number } = {}
): Promise<{ id: string; title: string }[]> {
  const { companyId, userId, role } = await requireScopedSession();
  const take = Math.min(Math.max(1, Math.floor(opts.limit ?? MAX_TASK_OPTIONS)), MAX_TASK_OPTIONS);
  return db.task.findMany({
    where: taskScopeWhere({ companyId, userId, role, projectId: opts.projectId }),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take,
    select: { id: true, title: true },
  });
}

/**
 * The projects this caller may actually FILE A TASK INTO.
 *
 * Deliberately NOT `listProjectOptions` (tasks-and-comments-008). That function
 * answers "which projects may this caller SEE", which for a member is every
 * project they supervise OR hold a task in — and /tasks used it to fill the
 * new-task form's picker. `addTaskAction` gates on `canManageProject`, which for
 * a member is supervisor-only. So the most ordinary case in the product — a
 * member with tasks in a project they do not supervise — was offered the CTA,
 * the whole form and the project in the dropdown, and was refused on submit
 * with "Only the supervisor or a founder can add tasks here", after typing a
 * title, a description, an assignee and a deadline.
 *
 * This is the SAME predicate the action applies, expressed as a `where` so the
 * page can also answer "can this person file anywhere at all" and hide the CTA
 * when the answer is no. `canManageProject` cannot be called here for the same
 * reason `bulkTaskScope` cannot call `canEditTask` — the rule has to run in SQL
 * — so the correspondence is: admin/cofounder ⇒ every project, otherwise
 * `supervisorId === userId`.
 *
 * `status` excludes `INACTIVE_PROJECT_STATUSES` rather than only `"archived"`
 * (which is all `addTaskAction` refuses). That is intentional and matches what
 * the picker has always offered — `listProjectOptions` excludes completed
 * projects too, and shares this same constant, which is what
 * tests/lib/queries/projects-scope.test.ts pins for it. Offering a COMPLETED
 * project here would let a task be filed where the global board would then hide
 * it: the bug that constant was extracted to fix.
 */
export async function listFilableProjectOptions(): Promise<{ id: string; name: string }[]> {
  const { userId, companyId, role } = await requireScopedSession();
  const manageableWhere = canSeeAllProjects(role as Role) ? {} : { supervisorId: userId };
  return db.project.findMany({
    where: {
      companyId,
      deletedAt: null,
      // Spread, not the constant: Prisma's `notIn` takes a mutable `string[]`
      // and the constant is `readonly`.
      status: { notIn: [...INACTIVE_PROJECT_STATUSES] },
      ...manageableWhere,
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
