/**
 * perf-002 / tasks-and-comments-010 (the same defect, filed twice) and the
 * global-board half of data-integrity-002.
 *
 * THE MECHANISM. `getTasks()` was `db.task.findMany({ where, orderBy, include })`
 * with NO `take` — the only uncapped list read in lib/queries/. Every sibling
 * has a documented ceiling (transactions 5,000 per type, activities 500,
 * notifications 200, time 500, chat 50/page, search GROUP_LIMIT), and four
 * pages call this one on every visit:
 *
 *   app/(app)/tasks/page.tsx:22      the board
 *   app/(app)/dashboard/page.tsx:27  only to derive an "open tasks" NUMBER
 *   app/(app)/team/page.tsx:30       per-member completion cells
 *   app/(app)/time/page.tsx:32       to build `{id,title}` dropdown options
 *
 * So the customer who uses the product successfully is the one it breaks: at a
 * few thousand tasks each of those four responses carries the workspace's whole
 * task history — every field, every comment count, every project name — into
 * the RSC payload, and the client renders every filtered row into a plain
 * `<table>` with no virtualisation. /dashboard pays for it to print one
 * integer; /time pays for it to fill a `<select>`.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS THE QUERY AND NOT THE ROWS. There is no
 * database in vitest (and this wave may not touch one), but every property the
 * finding needs is a property of the QUESTION ASKED:
 *
 *   1. A list read carries a finite, bounded `take`, and a caller cannot lift
 *      the ceiling — only lower it. ("Add a take" is worthless if any page can
 *      pass `take: 1e9`.)
 *   2. Paging is possible at all: a cursor, and an ORDER TOTAL ENOUGH TO PAGE
 *      ON. `orderBy: [{order},{createdAt}]` is not unique, so a cursor over it
 *      can silently drop or repeat rows — the tiebreak matters as much as the
 *      cursor.
 *   3. The dashboard's KPI comes from an aggregate, never from `findMany`, so
 *      the number is exact no matter how large the workspace gets. A capped
 *      array feeding a count is the money-008 mistake in a different table.
 *   4. The /time picker reads two columns, not the whole row graph.
 *   5. A bounded read must not quietly widen the tenant scope: the member-sees-
 *      only-their-own-tasks filter and the companyId scope survive paging.
 *   6. data-integrity-002: the global board excludes tasks whose PROJECT is
 *      soft-deleted. lib/queries/search.ts:366 already filters
 *      `project: { deletedAt: null }` and comments that "a tombstoned project's
 *      tasks are gone from every other surface" — this read is the surface that
 *      made that comment false.
 *
 * The cheap version of this file would assert that `getTasks()` returns rows.
 * It did that before too, which is exactly why the bug shipped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  /** "model.op" → canned value, or a function of the call args. */
  const results = new Map<string, unknown>();

  const MODELS = ["task"];
  const OPS = ["findMany", "groupBy", "aggregate", "count"];

  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        if (typeof canned === "function") {
          return (canned as (a: Record<string, unknown>) => unknown)(args ?? {});
        }
        return canned ?? [];
      };
    }
    db[model] = delegate;
  }

  const session = {
    value: {
      userId: "u-admin",
      userName: "Ada",
      email: "ada@example.com",
      companyId: "co-1",
      role: "admin" as "admin" | "cofounder" | "member",
    },
  };
  return { db, calls, results, session };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => H.session.value,
}));

/**
 * NAMESPACE import on purpose. A named import of an export that does not exist
 * yet is a LINK error: it fails the whole file with one message and hides which
 * behaviours are missing. Through a namespace each absent helper fails its own
 * test ("not a function") while the `getTasks` cases still run against the
 * shipped code — so the first, pre-fix run reports the bug per property.
 */
import * as tasks from "@/lib/queries/tasks";

/** One Prisma-shaped task row. */
function row(i: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `t-${i}`,
    companyId: "co-1",
    projectId: "p-1",
    title: `Task ${i}`,
    description: "",
    status: "pending",
    priority: "medium",
    assignedTo: "u-admin",
    assignedToName: "Ada",
    assignedBy: "u-admin",
    assignedByName: "Ada",
    deadline: new Date("2026-10-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    completedAt: null,
    order: -i,
    project: { name: "Launch" },
    _count: { comments: 0 },
    ...over,
  };
}

function rows(n: number) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(row(i));
  return out;
}

/** Every recorded call to one delegate op. */
function callsTo(path: string) {
  return H.calls.filter((c) => c.path === path);
}

function lastFindMany(): Record<string, unknown> {
  const all = callsTo("task.findMany");
  expect(all.length, "expected getTasks to run a task.findMany").toBeGreaterThan(0);
  return all[all.length - 1].args;
}

/** `where` of the last findMany, as a loose record. */
function lastWhere(): Record<string, unknown> {
  return (lastFindMany().where ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = {
    userId: "u-admin",
    userName: "Ada",
    email: "ada@example.com",
    companyId: "co-1",
    role: "admin",
  };
});

describe("perf-002 / tasks-and-comments-010 — the task board is a bounded read", () => {
  it("asks for a finite page of tasks, not the whole table", async () => {
    H.results.set("task.findMany", () => rows(10));
    await tasks.getTasks();

    const take = lastFindMany().take;
    expect(
      typeof take,
      "getTasks() ran a findMany with no `take` — the workspace's entire task history ships on /tasks, /dashboard, /team and /time"
    ).toBe("number");
    expect(Number.isFinite(take as number)).toBe(true);
    expect(take as number).toBeGreaterThan(0);
  });

  it("publishes the page size it uses, so a caller can page instead of guessing", () => {
    expect(typeof tasks.TASK_PAGE_SIZE, "TASK_PAGE_SIZE is not exported").toBe("number");
    expect(typeof tasks.MAX_TASK_PAGE_SIZE, "MAX_TASK_PAGE_SIZE is not exported").toBe("number");
    expect(tasks.TASK_PAGE_SIZE).toBeGreaterThan(0);
    expect(tasks.MAX_TASK_PAGE_SIZE).toBeGreaterThanOrEqual(tasks.TASK_PAGE_SIZE);
  });

  it("lets a caller LOWER the ceiling but never lift it", async () => {
    H.results.set("task.findMany", () => rows(3));

    await tasks.getTasks({ take: 5 });
    // +1 is the has-more probe; either shape is fine as long as it is bounded.
    expect(lastFindMany().take as number).toBeLessThanOrEqual(6);

    await tasks.getTasks({ take: 1_000_000 });
    expect(
      lastFindMany().take as number,
      "a page passed take: 1e6 and got it — the ceiling is advice, not a bound"
    ).toBeLessThanOrEqual(tasks.MAX_TASK_PAGE_SIZE + 1);
  });

  it("orders on a UNIQUE final key, so a cursor cannot drop or repeat a row", async () => {
    H.results.set("task.findMany", () => rows(3));
    await tasks.getTasks();

    const orderBy = lastFindMany().orderBy as Array<Record<string, unknown>>;
    expect(Array.isArray(orderBy)).toBe(true);
    const last = orderBy[orderBy.length - 1];
    expect(
      Object.keys(last),
      "the last orderBy key must be unique (id) or paging over equal `order`/`createdAt` values silently skips and duplicates tasks"
    ).toEqual(["id"]);
  });

  it("reports whether more tasks exist, and where to resume", async () => {
    // One more row than the page size → there IS a next page.
    H.results.set("task.findMany", (args: Record<string, unknown>) =>
      rows(Math.min((args.take as number) ?? 0, 51))
    );

    const page = await tasks.getTaskPage({ take: 50 });
    expect(page.tasks.length, "a 50-row page must contain 50 rows, not the probe row").toBe(50);
    expect(page.hasMore, "hasMore must be true when a 51st row came back").toBe(true);
    expect(page.nextCursor, "nextCursor must name the last row of the page").toBe(
      page.tasks[page.tasks.length - 1].id
    );
  });

  it("stops paging when the last page is short", async () => {
    H.results.set("task.findMany", () => rows(12));
    const page = await tasks.getTaskPage({ take: 50 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("resumes AFTER the cursor row rather than repeating it", async () => {
    H.results.set("task.findMany", () => rows(4));
    await tasks.getTaskPage({ take: 50, cursor: "t-99" });

    const args = lastFindMany();
    expect(args.cursor, "no cursor reached Prisma, so page 2 is page 1 again").toEqual({
      id: "t-99",
    });
    expect(args.skip, "without skip: 1 the cursor row is returned twice").toBe(1);
  });
});

describe("tasks-and-comments-010 — the dashboard KPI is a count, not a capped array", () => {
  it("derives task status counts from an aggregate with no ceiling", async () => {
    H.results.set("task.groupBy", () => [
      { status: "pending", _count: { _all: 7 } },
      { status: "in_progress", _count: { _all: 2 } },
      { status: "completed", _count: { _all: 41 } },
    ]);

    const counts = await tasks.getTaskStatusCounts();

    expect(callsTo("task.groupBy").length, "the KPI must be a groupBy/aggregate").toBe(1);
    expect(
      callsTo("task.findMany").length,
      "a count built from findMany is capped, so the KPI is wrong past the ceiling"
    ).toBe(0);
    expect(callsTo("task.groupBy")[0].args.take, "an aggregate must never carry a take").toBe(
      undefined
    );
    expect(counts.open).toBe(9);
    expect(counts.completed).toBe(41);
    expect(counts.total).toBe(50);
  });

  it("reports zero for a status with no rows instead of leaving the key missing", async () => {
    H.results.set("task.groupBy", () => [{ status: "pending", _count: { _all: 3 } }]);
    const counts = await tasks.getTaskStatusCounts();
    expect(counts.in_progress).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.open).toBe(3);
  });
});

describe("perf-002 — /time's dropdown stops paying for the whole task table", () => {
  it("selects only id + title, with a bound", async () => {
    H.results.set("task.findMany", () => [
      { id: "t-1", title: "One" },
      { id: "t-2", title: "Two" },
    ]);

    const options = await tasks.listTaskOptions();

    const args = lastFindMany();
    expect(args.select, "the picker must SELECT id + title").toEqual({ id: true, title: true });
    expect(args.include, "the picker must not include the comment count or the project row").toBe(
      undefined
    );
    expect(typeof args.take).toBe("number");
    expect(options).toEqual([
      { id: "t-1", title: "One" },
      { id: "t-2", title: "Two" },
    ]);
  });
});

describe("a bounded read must not widen the scope it reads", () => {
  it("still confines a member to their own tasks on the global board", async () => {
    H.session.value = { ...H.session.value, userId: "u-member", role: "member" };
    H.results.set("task.findMany", () => rows(2));
    await tasks.getTasks();

    const where = lastWhere();
    expect(where.companyId).toBe("co-1");
    expect(where.assignedTo, "a member must only ever see tasks assigned to them").toBe("u-member");
    expect(where.deletedAt).toBeNull();
  });

  it("leaves the per-project supervisor escape hatch alone", async () => {
    H.session.value = { ...H.session.value, userId: "u-member", role: "member" };
    H.results.set("task.findMany", () => rows(2));
    await tasks.getTasks({ projectId: "p-7" });

    const where = lastWhere();
    expect(where.projectId).toBe("p-7");
    expect(
      where.assignedTo,
      "a project-scoped read must NOT filter by assignee — that is the supervisor escape hatch"
    ).toBe(undefined);
  });

  it("keeps the member filter when the caller also pages", async () => {
    H.session.value = { ...H.session.value, userId: "u-member", role: "member" };
    H.results.set("task.findMany", () => rows(2));
    await tasks.getTaskPage({ take: 20, cursor: "t-3" });

    expect(lastWhere().assignedTo).toBe("u-member");
  });
});

describe("data-integrity-002 — a tombstoned project's tasks leave the global board", () => {
  it("excludes tasks whose project is soft-deleted", async () => {
    H.results.set("task.findMany", () => rows(2));
    await tasks.getTasks();

    const project = lastWhere().project as Record<string, unknown> | undefined;
    expect(
      project,
      "the global board's where has no `project` filter at all — a deleted project's tasks stay on it forever"
    ).toBeTruthy();
    expect(
      (project as Record<string, unknown>).deletedAt,
      "the board filters project.status but not project.deletedAt, so a soft-deleted project's tasks render forever while search (lib/queries/search.ts:366) hides them"
    ).toBeNull();
  });

  it("still hides completed / archived projects' tasks from the global board", async () => {
    H.results.set("task.findMany", () => rows(2));
    await tasks.getTasks();

    const project = lastWhere().project as Record<string, unknown>;
    expect(project.status).toEqual({ notIn: ["completed", "archived"] });
  });

  it("excludes a tombstoned project on the project-scoped read too", async () => {
    H.results.set("task.findMany", () => rows(2));
    await tasks.getTasks({ projectId: "p-7" });

    const project = lastWhere().project as Record<string, unknown> | undefined;
    expect(project, "the project-scoped read has no project filter either").toBeTruthy();
    expect((project as Record<string, unknown>).deletedAt).toBeNull();
    expect(
      (project as Record<string, unknown>).status,
      "the project's OWN page must still show a completed/archived project's tasks"
    ).toBe(undefined);
  });
});

describe("getTasks stays a plain array for the four pages that already call it", () => {
  it("returns TaskWithCount[] with the comment count folded in", async () => {
    H.results.set("task.findMany", () => [row(1, { _count: { comments: 4 } })]);
    const out = await tasks.getTasks();
    expect(Array.isArray(out)).toBe(true);
    expect(out[0].commentCount).toBe(4);
    expect(out[0].projectName).toBe("Launch");
    expect(out[0].deadline).toBe("2026-10-01T00:00:00.000Z");
  });
});
