/**
 * The money half of project visibility.
 *
 * WHY THESE TESTS LOOK LIKE THIS — the same reasoning as
 * tests/lib/queries/search-scoping.test.ts, applied to a different leak. There
 * is no database here, so nothing below can assert which rows came back. It
 * does not need to: the property at stake is not a property of the rows, it is
 * a property of the QUESTIONS ASKED. A member who is merely assigned a task in
 * a project must not have the project's spend aggregate issued on their behalf
 * AT ALL, because a figure that was never read cannot be serialised into the
 * RSC payload, cannot be recovered from View Source, and cannot be un-redacted
 * by flipping a client-side gate (the store's role can come from localStorage —
 * see sec-013). Masking at render is a curtain over a number that already
 * crossed the wire; the fix has to be the number not existing.
 *
 * So the Prisma client is replaced with a recorder and the assertions run over
 * what it recorded. `transaction.aggregate` / `transaction.groupBy` NOT being
 * in the recording is the finding (sec-004, projects-006); the fake client
 * would happily hand over a spend figure to anyone who asked, so "the member's
 * DTO has no money in it" is proof nothing asked rather than proof the fake was
 * empty.
 *
 * lib/auth/** is deliberately NOT mocked: `canSeeProjectFinances` and
 * `canSeeProject` are the real predicates here, the same ones the rest of the
 * product obeys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INACTIVE_PROJECT_STATUSES,
  getProjectOverview,
  getProjectTitleForUser,
  listProjectOptions,
  listProjectsForUser,
} from "@/lib/queries/projects";
import { getTasks } from "@/lib/queries/tasks";
import type { ScopedSession } from "@/lib/queries/session";

/** One call the query layer made against the (fake) Prisma client. */
type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  /** What a delegate answers with, keyed "transaction.aggregate". */
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    // `has` rather than `??`, so a deliberate `null` answer (a findFirst that
    // must miss) is distinguishable from "not stubbed".
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // Tagged-template form: `db.$queryRaw`…`` arrives as (strings, ...values).
  // Present as a real function rather than as another Proxy delegate so that a
  // roll-up moved into SQL is RECORDED here, with its text and its bound
  // parameters, instead of failing with "db.$queryRaw is not a function" —
  // which reads as a broken test rather than as the thing being measured.
  const queryRaw = vi.fn((...args: unknown[]) => record("$queryRaw", "$queryRaw", args));
  // Present so a test can prove it is never reached: `$queryRawUnsafe` takes a
  // finished string, and a fake that simply lacked the method would fail with a
  // TypeError instead of with the injection finding it would actually be.
  const queryRawUnsafe = vi.fn((...args: unknown[]) =>
    record("$queryRawUnsafe", "$queryRawUnsafe", args)
  );

  // A Proxy, not a hand-written `{ project: { findFirst } }` fake: a fake only
  // knows the delegates that existed the day it was written, so a query added
  // to lib/queries/projects.ts later would throw here (best case) or, once
  // somebody "fixed" the fake, join the file without any of the invariants
  // below ever applying to it.
  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "$queryRaw") return queryRaw;
        if (prop === "$queryRawUnsafe") return queryRawUnsafe;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db, queryRaw, queryRawUnsafe };
});

const session = vi.hoisted(() => ({
  current: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
  /** When true, requireScopedSession throws the way it does with no cookie. */
  missing: false,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));

// Who is asking is resolved from here and nowhere else. Every test changes the
// caller by changing this, never by passing an argument — there is no argument
// to pass, and that is the guarantee.
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () =>
    session.missing
      ? Promise.reject(new Error("Not authenticated"))
      : Promise.resolve(session.current),
}));

/** A Prisma.Decimal stand-in — only `.toNumber()` is ever called on it. */
function decimal(n: number) {
  return { toNumber: () => n };
}

/** The figure a member must never be handed. Distinctive on purpose. */
const SECRET_SPEND = 743219;

const SUPERVISOR_ID = "u_supervisor";
const MEMBER_ID = "u_member";

function projectRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "p_nimbus",
    companyId: "c_nimbus",
    name: "Nimbus Rebuild",
    description: null,
    supervisorId: SUPERVISOR_ID,
    status: "active",
    color: "#fff",
    targetEndDate: null,
    createdBy: "u_admin",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    supervisor: { name: "Sana" },
    _count: { tasks: 3 },
    ...overrides,
  };
}

function asRole(role: ScopedSession["role"], userId = "u_admin", companyId = "c_nimbus") {
  session.missing = false;
  session.current = {
    userId,
    userName: "Tester",
    email: "tester@nimbus.app",
    companyId,
    role,
  };
}

/**
 * Stock every delegate the two queries touch. The spend answers matter most:
 * the fake hands out SECRET_SPEND to anyone who asks, so a member's DTO
 * reading 0 proves the aggregate never ran.
 */
beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.queryRaw.mockClear();
  prisma.queryRawUnsafe.mockClear();
  prisma.answers.set("project.findFirst", projectRow());
  prisma.answers.set("project.findMany", [projectRow()]);
  prisma.answers.set("task.findFirst", { id: "t1" }); // caller holds a task
  prisma.answers.set("task.count", 2);
  prisma.answers.set("task.findMany", [{ assignedTo: MEMBER_ID }]);
  prisma.answers.set("task.groupBy", []);
  prisma.answers.set("timeEntry.findMany", []);
  prisma.answers.set("$queryRaw.$queryRaw", []);
  prisma.answers.set("transaction.aggregate", { _sum: { amount: decimal(SECRET_SPEND) } });
  prisma.answers.set("transaction.groupBy", [
    { projectId: "p_nimbus", _sum: { amount: decimal(SECRET_SPEND) } },
  ]);
  asRole("admin");
});

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
}

function whereOf(call: RecordedCall): Record<string, unknown> {
  return ((call.args[0] as { where?: Record<string, unknown> } | undefined)?.where ?? {}) as Record<
    string,
    unknown
  >;
}

/**
 * The statuses a `status` filter EXCLUDES, whichever shape it is written in.
 * Reading both `{ not: "x" }` and `{ notIn: [...] }` is the point: the bug was
 * one clause saying `not: "archived"` while the other said
 * `notIn: ["completed","archived"]`, and a test that only understood one shape
 * could not compare them.
 */
function statusExclusions(filter: unknown): string[] {
  if (filter === null || typeof filter !== "object") return [];
  const f = filter as { not?: unknown; notIn?: unknown };
  if (typeof f.not === "string") return [f.not];
  if (Array.isArray(f.notIn)) return f.notIn.filter((s): s is string => typeof s === "string");
  return [];
}

/** Every string anywhere in a value — including Prisma.Sql bound parameters. */
function stringsIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(walk);
      return;
    }
    if (typeof v === "string") found.push(v);
  };
  walk(value);
  return found;
}

/**
 * The SQL text of a tagged-template call, parameter slots marked `$?`,
 * including the text of any composed `Prisma.Sql` in the parameter list (which
 * is where `Prisma.join` puts an `IN (…)` list).
 */
function sqlTextOf(call: RecordedCall): string {
  const chunks = [(call.args[0] as string[]).join(" $? ")];
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const sql = value as { strings?: unknown; values?: unknown };
    if (Array.isArray(sql.strings)) chunks.push(sql.strings.join(" $? "));
    if (Array.isArray(sql.values)) sql.values.forEach(visit);
  };
  call.args.slice(1).forEach(visit);
  return chunks.join(" ");
}

describe("getProjectOverview — the spend aggregate is gated before it is READ", () => {
  it("never asks for the spend when the viewer is a plain assignee", async () => {
    asRole("member", MEMBER_ID);

    const overview = await getProjectOverview("p_nimbus");

    expect(overview).not.toBeNull();
    // The question was not asked…
    expect(callsTo("transaction")).toHaveLength(0);
    // …so there is no figure in the payload to redact.
    expect(overview?.monthToDateSpendPkr).toBe(0);
    expect(overview?.financeVisible).toBe(false);
  });

  it("asks for it for an admin", async () => {
    asRole("admin");

    const overview = await getProjectOverview("p_nimbus");

    expect(callsTo("transaction", "aggregate")).toHaveLength(1);
    expect(overview?.monthToDateSpendPkr).toBe(SECRET_SPEND);
    expect(overview?.financeVisible).toBe(true);
  });

  it("asks for it for the project's own supervisor, even though they are a member", async () => {
    // The supervisor escape hatch from lib/auth/project-permissions.ts — a
    // member supervising THIS project sees THIS project's money.
    asRole("member", SUPERVISOR_ID);

    const overview = await getProjectOverview("p_nimbus");

    expect(callsTo("transaction", "aggregate")).toHaveLength(1);
    expect(overview?.monthToDateSpendPkr).toBe(SECRET_SPEND);
    expect(overview?.financeVisible).toBe(true);
  });
});

describe("listProjectsForUser — the same rule, per project", () => {
  it("never asks for spend when the member supervises none of the projects", async () => {
    asRole("member", MEMBER_ID);

    const rows = await listProjectsForUser();

    expect(callsTo("transaction")).toHaveLength(0);
    expect(rows[0].monthToDateSpendPkr).toBe(0);
    expect(rows[0].financeVisible).toBe(false);
  });

  it("asks only for the projects the member supervises", async () => {
    // Two projects: one they supervise, one they merely hold a task in.
    prisma.answers.set("project.findMany", [
      projectRow({ id: "p_mine", supervisorId: MEMBER_ID }),
      projectRow({ id: "p_theirs", supervisorId: SUPERVISOR_ID }),
    ]);
    prisma.answers.set("transaction.groupBy", [
      { projectId: "p_mine", _sum: { amount: decimal(10) } },
      // The fake answers with the other project too. If the query asked for
      // it, the figure lands in the payload — which is the leak.
      { projectId: "p_theirs", _sum: { amount: decimal(SECRET_SPEND) } },
    ]);
    asRole("member", MEMBER_ID);

    const rows = await listProjectsForUser();

    const spendCalls = callsTo("transaction", "groupBy");
    expect(spendCalls).toHaveLength(1);
    // The `in` list is the enforcement, not the post-filter.
    const where = (spendCalls[0].args[0] as { where: { projectId: { in: string[] } } }).where;
    expect(where.projectId.in).toEqual(["p_mine"]);

    const mine = rows.find((r) => r.id === "p_mine");
    const theirs = rows.find((r) => r.id === "p_theirs");
    expect(mine?.monthToDateSpendPkr).toBe(10);
    expect(mine?.financeVisible).toBe(true);
    expect(theirs?.monthToDateSpendPkr).toBe(0);
    expect(theirs?.financeVisible).toBe(false);
  });

  it("asks for every project's spend for an admin", async () => {
    asRole("admin");

    const rows = await listProjectsForUser();

    expect(callsTo("transaction", "groupBy")).toHaveLength(1);
    expect(rows[0].monthToDateSpendPkr).toBe(SECRET_SPEND);
    expect(rows[0].financeVisible).toBe(true);
  });
});

describe("getProjectTitleForUser — the scoped name lookup generateMetadata needs", () => {
  it("scopes the read to the caller's company and to live rows", async () => {
    asRole("admin");

    await getProjectTitleForUser("p_nimbus");

    const reads = callsTo("project", "findFirst");
    expect(reads).toHaveLength(1);
    const where = reads[0].args[0] as { where: Record<string, unknown> };
    expect(where.where.companyId).toBe("c_nimbus");
    expect(where.where.deletedAt).toBeNull();
  });

  it("returns null for a project in another workspace", async () => {
    // A foreign id: the scoped findFirst misses, which is the whole mechanism.
    prisma.answers.set("project.findFirst", null);
    asRole("admin");

    await expect(getProjectTitleForUser("p_rival")).resolves.toBeNull();
  });

  it("returns null instead of throwing when there is no session", async () => {
    // It runs inside generateMetadata, where a throw is a 500 on a page that
    // would otherwise render its own not-found.
    session.missing = true;

    await expect(getProjectTitleForUser("p_nimbus")).resolves.toBeNull();
    expect(prisma.calls).toHaveLength(0);
  });
});

/**
 * WHERE WORK CAN BE FILED vs WHERE WORK IS VISIBLE. Finding projects-011.
 *
 * `listProjectOptions` is the source for every project picker in the task /
 * budget / transaction / clock-in forms, and it filtered only
 * `status: { not: "archived" }` — so a COMPLETED project was still offered.
 * `getTasks` on the global board filters
 * `project: { status: { notIn: ["completed", "archived"] } }`. A task created
 * against a completed project therefore existed, counted in the project's own
 * KPIs, and was invisible on /tasks for admin, cofounder and the assignee
 * alike; the `task_assigned` notification deep-linked to
 * `/tasks?taskId=<id>`, which landed on a board with nothing to highlight.
 * That surfaces as "your app lost my work", not as a bug report.
 *
 * The tests below do not name the statuses twice. The last one drives BOTH
 * queries and compares what each excludes, because the contract is not "the
 * picker excludes completed" — it is "the two clauses state the same rule".
 */
describe("listProjectOptions — the picker and the board agree", () => {
  it("does not offer a completed project to file new work into", async () => {
    asRole("admin");

    await listProjectOptions();

    const reads = callsTo("project", "findMany");
    expect(reads).toHaveLength(1);
    const excluded = statusExclusions(whereOf(reads[0]).status);
    expect(excluded).toContain("completed");
    expect(excluded).toContain("archived");
  });

  it("applies the same rule on the member branch", async () => {
    // Two branches, one rule. The member branch is a separate literal in the
    // source, which is exactly how the two drifted apart in the first place.
    asRole("member", MEMBER_ID);

    await listProjectOptions();

    const excluded = statusExclusions(whereOf(callsTo("project", "findMany")[0]).status);
    expect(excluded).toContain("completed");
    expect(excluded).toContain("archived");
  });

  it("excludes exactly what the global task board excludes", async () => {
    asRole("admin");
    prisma.answers.set("task.findMany", []);

    await listProjectOptions();
    const pickerExcludes = statusExclusions(whereOf(callsTo("project", "findMany")[0]).status);

    prisma.calls.length = 0;
    await getTasks();
    const boardProjectFilter = whereOf(callsTo("task", "findMany")[0]).project as {
      status?: unknown;
    };
    const boardExcludes = statusExclusions(boardProjectFilter?.status);

    // Neither list is written out here. If lib/queries/tasks.ts ever hides a
    // third status from the board, this fails until the picker follows —
    // which is the only way the two stay in step.
    expect(boardExcludes.length).toBeGreaterThan(0);
    expect(pickerExcludes.slice().sort()).toEqual(boardExcludes.slice().sort());
  });

  it("publishes the rule as one constant rather than two literals", async () => {
    asRole("admin");

    await listProjectOptions();

    const excluded = statusExclusions(whereOf(callsTo("project", "findMany")[0]).status);
    expect(excluded.slice().sort()).toEqual(Array.from(INACTIVE_PROJECT_STATUSES).slice().sort());
  });
});

/**
 * THE TIME ROLL-UP IS A SUM, AND SUMS BELONG IN SQL. Finding perf-003.
 *
 * Both `listProjectsForUser` and `getProjectOverview` ran
 * `db.timeEntry.findMany({ where: { projectId: … } })` with NO `take` and then
 * added the durations up in a JavaScript loop. The sibling roll-ups in the same
 * `Promise.all` (`task.groupBy`, `transaction.groupBy`) are done in SQL; the
 * time sum was the one that was not. A workspace clocking 8 entries per person
 * per week reaches ~20k TimeEntry rows in a year, and /projects pulled all of
 * them into the Node heap on every load to produce one number per card — on a
 * serverless function that is a memory ceiling, i.e. an OOM rather than a slow
 * page.
 *
 * What these tests pin is the SHAPE, not a benchmark: the unbounded read is
 * gone, the total arrives from the database, and the one read that remains is
 * bounded by "people currently clocked in" (at most one open entry per user,
 * enforced in clockInAction) rather than by history.
 */
describe("the tracked-time roll-up", () => {
  it("does not read the whole time history to total the project list", async () => {
    asRole("admin");

    await listProjectsForUser();

    for (const read of callsTo("timeEntry", "findMany")) {
      // The only per-row read allowed is the bounded open-entry one: an entry
      // with no clock-out has no duration to compute in SQL without pinning
      // `now`, and there are at most as many of them as there are people.
      expect(
        whereOf(read).clockOutAt,
        "timeEntry.findMany is not restricted to still-running entries"
      ).toBeNull();
    }
    // And the historical total came from the database.
    expect(prisma.queryRaw).toHaveBeenCalled();
    expect(prisma.queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("does not read the whole time history for one project's overview either", async () => {
    asRole("admin");

    await getProjectOverview("p_nimbus");

    for (const read of callsTo("timeEntry", "findMany")) {
      expect(
        whereOf(read).clockOutAt,
        "timeEntry.findMany is not restricted to still-running entries"
      ).toBeNull();
    }
    expect(prisma.queryRaw).toHaveBeenCalled();
  });

  it("scopes the raw sum to the caller's own company", async () => {
    // Raw SQL has no `where` object for the sweep in this file to read, so the
    // evidence is the column it compares and the parameter it binds. A raw
    // query is exactly where a tenancy filter gets forgotten.
    asRole("admin", "u_admin", "c_nimbus");

    await listProjectsForUser();

    const raws = prisma.calls.filter((c) => c.delegate === "$queryRaw");
    expect(raws.length).toBeGreaterThan(0);
    for (const raw of raws) {
      expect(sqlTextOf(raw)).toContain('"companyId" =');
      expect(stringsIn(raw.args)).toContain("c_nimbus");
      expect(stringsIn(raw.args)).not.toContain("c_rival");
    }
  });

  it("parameterizes the project ids rather than pasting them into the SQL", async () => {
    asRole("admin");

    await listProjectsForUser();

    const raw = prisma.calls.find((c) => c.delegate === "$queryRaw")!;
    // Tagged-template form: the first argument is the template strings array.
    expect(Array.isArray(raw.args[0])).toBe(true);
    expect(raw.args[0]).toHaveProperty("raw");
    expect(stringsIn(raw.args)).toContain("p_nimbus");
  });

  it("adds the still-running entries to the total the database returned", async () => {
    // The number on the card has to keep ticking for someone clocked in right
    // now — that is why the open entries are read at all. An implementation
    // that summed only the closed rows would pass every test above.
    asRole("admin");
    prisma.answers.set("$queryRaw.$queryRaw", [{ projectId: "p_nimbus", ms: 3_600_000 }]);
    prisma.answers.set("timeEntry.findMany", [
      { projectId: "p_nimbus", clockInAt: new Date(Date.now() - 60_000), clockOutAt: null },
    ]);

    const rows = await listProjectsForUser();

    expect(rows[0].trackedMs).toBeGreaterThanOrEqual(3_600_000 + 59_000);
    expect(rows[0].trackedMs).toBeLessThan(3_600_000 + 120_000);
  });

  it("reports zero tracked time without inventing a number", async () => {
    asRole("admin");
    prisma.answers.set("$queryRaw.$queryRaw", []);
    prisma.answers.set("timeEntry.findMany", []);

    const rows = await listProjectsForUser();
    const overview = await getProjectOverview("p_nimbus");

    expect(rows[0].trackedMs).toBe(0);
    expect(overview?.trackedMs).toBe(0);
  });
});
