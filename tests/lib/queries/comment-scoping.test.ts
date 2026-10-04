/**
 * Who a comment thread may be handed to, and what it collapses to when nobody
 * checks. Finding tasks-and-comments-004.
 *
 * WHAT WAS WRONG. `listCommentsForTarget` built its where clause like this:
 *
 *     if ("taskId" in target) where.taskId = target.taskId;
 *     else where.transactionId = target.transactionId;
 *
 * Nothing validated the target — there was no schema on this path at all. Call
 * it with `{}`, or with `{ taskId: undefined }`, and that assigns `undefined`;
 * Prisma reads an undefined field as "no filter at all", so the query collapsed
 * to `{ companyId }` and returned EVERY Comment row in the workspace, task and
 * transaction threads alike. There was no `take` cap either. And
 * `listCommentsAction` is an exported server action with no gate of its own, so
 * any signed-in user could send that body — which means a plain member, the
 * role "members never see finance pages" exists for, could read every comment
 * ever written about an expense, an investment or a budget in one response.
 * `createCommentAction` already refuses a member a transaction comment
 * (canSeeFinances, lib/actions/comments.ts:64); the read walked straight past
 * the same wall.
 *
 * WHY THIS TEST LOOKS LIKE THIS. Same reasoning as
 * tests/lib/queries/search-scoping.test.ts and
 * tests/lib/queries/projects-scope.test.ts: vitest has no database, so nothing
 * below asserts which rows came back. It does not need to. The properties at
 * stake are properties of the QUESTION ASKED — a read that carries no target
 * filter is the leak, and a read that is never issued cannot leak — and those
 * are visible in the calls the query makes. So the Prisma client is a recorder
 * and the assertions run over the recording. The fake hands SECRET_BODY to
 * anyone who asks, so "the member got nothing back" is proof nothing asked.
 *
 * lib/auth/** is deliberately NOT mocked: `canSeeFinances` and `canSeeProject`
 * are the real predicates, the same ones the rest of the product obeys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCommentsForTarget, type CommentTarget } from "@/lib/queries/comments";
import type { ScopedSession } from "@/lib/queries/session";

type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    // `has` rather than `??` so a deliberate `null` answer (a findFirst that
    // must miss) is distinguishable from "not stubbed".
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // A Proxy, not a hand-written `{ comment: { findMany } }` fake: a fake only
  // knows the delegates that existed the day it was written, so a query added
  // to this path later would throw here (best case) or, once someone "fixed"
  // the fake, join the file without any of the invariants below applying to it.
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
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

const session = vi.hoisted(() => ({
  current: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));

vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.current),
}));

/** The comment body a member must never be handed. Distinctive on purpose. */
const SECRET_BODY = "we are paying Falcon 4.2m for the acquisition";

const SUPERVISOR_ID = "u_supervisor";
const MEMBER_ID = "u_member";
const OUTSIDER_ID = "u_outsider";

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm1",
    companyId: "c_nimbus",
    body: SECRET_BODY,
    authorId: "u_admin",
    authorName: "Ayesha",
    authorAvatar: null,
    mentions: "[]",
    taskId: "t_theirs",
    transactionId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    editedAt: null,
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t_theirs",
    projectId: "p_nimbus",
    assignedTo: SUPERVISOR_ID,
    assignedBy: "u_admin",
    ...overrides,
  };
}

function projectRow(overrides: Record<string, unknown> = {}) {
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
    // Project.updatedAt landed with projects-010 and toClient() calls
    // .toISOString() on it, so a project row without it throws inside
    // getProjectForUser — which is how the supervisor case here failed.
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    supervisor: { name: "Sana" },
    ...overrides,
  };
}

function asRole(role: ScopedSession["role"], userId = "u_admin", companyId = "c_nimbus") {
  session.current = {
    userId,
    userName: "Tester",
    email: "tester@nimbus.app",
    companyId,
    role,
  };
}

/**
 * Stock every delegate. The comment answer matters most: the fake hands
 * SECRET_BODY to anyone who asks, so an empty result proves the read never ran
 * rather than proving the fake was empty.
 */
beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  prisma.answers.set("comment.findMany", [commentRow()]);
  prisma.answers.set("user.findMany", [{ id: "u_admin", name: "Ayesha", handle: "ayesha" }]);
  prisma.answers.set("task.findFirst", taskRow());
  prisma.answers.set("transaction.findFirst", { id: "x_1" });
  prisma.answers.set("project.findFirst", projectRow());
  asRole("admin");
});

function commentReads(): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === "comment");
}

function whereOf(call: RecordedCall): Record<string, unknown> {
  return (call.args[0] as { where: Record<string, unknown> }).where;
}

describe("listCommentsForTarget — the target is validated before it is trusted", () => {
  /**
   * THE FINDING. An empty target used to produce `{ companyId }` and return
   * every comment in the workspace.
   */
  it("refuses a target that names neither a task nor a transaction", async () => {
    await expect(listCommentsForTarget({} as CommentTarget)).rejects.toThrow();

    // And nothing was read. A rejection AFTER an unfiltered read would still
    // have put every row in this process.
    expect(commentReads()).toHaveLength(0);
  });

  it("refuses an explicitly undefined taskId", async () => {
    // `{ taskId: undefined }` passes `"taskId" in target`, which is what the
    // original branch tested, and Prisma then drops the filter entirely.
    await expect(
      listCommentsForTarget({ taskId: undefined } as unknown as CommentTarget)
    ).rejects.toThrow();

    expect(commentReads()).toHaveLength(0);
  });

  it("refuses a target that names both", async () => {
    // One thread, one target. Both set is a forged body, not a UI state.
    await expect(
      listCommentsForTarget({ taskId: "t1", transactionId: "x1" } as unknown as CommentTarget)
    ).rejects.toThrow();

    expect(commentReads()).toHaveLength(0);
  });

  it("refuses a Prisma operator object in place of an id", async () => {
    // `{ taskId: { not: "" } }` is a filter, not an id. Spliced into the where
    // clause it matches every commented task in the company — the same leak
    // with a different shape, which a mere presence check would not catch.
    await expect(
      listCommentsForTarget({ taskId: { not: "" } } as unknown as CommentTarget)
    ).rejects.toThrow();

    expect(commentReads()).toHaveLength(0);
  });

  it("filters on the named target, and caps how much it returns", async () => {
    await listCommentsForTarget({ taskId: "t_theirs" });

    const reads = commentReads();
    expect(reads).toHaveLength(1);

    const where = whereOf(reads[0]);
    expect(where.companyId).toBe("c_nimbus");
    expect(where.taskId).toBe("t_theirs");
    // An unbounded list read is the other half of the finding: this and
    // `getTasks` were the only two uncapped list reads in lib/queries.
    const take = (reads[0].args[0] as { take?: number }).take;
    expect(take, "comment.findMany has no take cap").toBeGreaterThan(0);
  });

  it("never issues a read whose only filter is the company", async () => {
    // The shape of the leak, asserted directly: whatever target is named, the
    // recorded read must narrow by something more than tenancy.
    await listCommentsForTarget({ transactionId: "x_1" });

    for (const read of commentReads()) {
      const where = whereOf(read);
      const narrowed = typeof where.taskId === "string" || typeof where.transactionId === "string";
      expect(narrowed, `${read.method} narrows by companyId alone`).toBe(true);
    }
  });
});

describe("listCommentsForTarget — the finance wall", () => {
  it("does not read a transaction thread for a member", async () => {
    asRole("member", MEMBER_ID);

    const rows = await listCommentsForTarget({ transactionId: "x_1" });

    expect(rows).toEqual([]);
    // The stronger property: the question was never asked, so a bug in a
    // post-filter could not put the bodies back.
    expect(commentReads()).toHaveLength(0);
  });

  it("reads a transaction thread for an admin", async () => {
    // The converse, so the test above cannot pass by the thread being broken
    // for everybody.
    asRole("admin");

    const rows = await listCommentsForTarget({ transactionId: "x_1" });

    expect(commentReads()).toHaveLength(1);
    expect(rows[0].body).toBe(SECRET_BODY);
  });

  it("reads a transaction thread for a cofounder too", async () => {
    // `canSeeFinances` is a two-role predicate; a gate written as
    // `role === "member" ? …` would pass both tests above and still be wrong.
    asRole("cofounder", "u_cofounder");

    expect(commentReads()).toHaveLength(0);
    const rows = await listCommentsForTarget({ transactionId: "x_1" });
    expect(rows[0].body).toBe(SECRET_BODY);
  });
});

describe("listCommentsForTarget — a task thread the reader may actually see", () => {
  it("does not read the thread of a task in a project the member has nothing to do with", async () => {
    // The global board narrows a member to `assignedTo: userId`
    // (lib/queries/tasks.ts) and the command palette mirrors it
    // (lib/queries/search.ts). A thread read by bare task id must not be the
    // way round it.
    prisma.answers.set("project.findFirst", null); // not in the project either
    prisma.answers.set("task.findFirst", null); // and no task of their own in it
    asRole("member", OUTSIDER_ID);

    const rows = await listCommentsForTarget({ taskId: "t_theirs" });

    expect(rows).toEqual([]);
    expect(commentReads()).toHaveLength(0);
  });

  /**
   * THE CASE THE REST OF THIS FILE COULD NOT SEE, and the reason it is here.
   *
   * `mayReadTarget` ends in `canManageProject(...)`, and its own comment says it
   * used to end in `getProjectForUser(...) !== null` — "any member who can open
   * the project may read any thread in it" — a projects-017 leftover that kept
   * the comment endpoint leaking after the project BOARD stopped.
   *
   * Nothing pinned the difference. The "nothing to do with the project" case
   * above stubs `project.findFirst` to null, so the task is not even found and
   * BOTH predicates refuse; the supervisor case below is granted by both. Put
   * `return true` where `canManageProject` is and this file stayed 14/14 green —
   * i.e. the defence was deletable. Verified by mutation on 2026-10-04.
   *
   * So this case is the one that separates them: the project EXISTS, the member
   * can open it (they hold a task in it, which is what `getProjectForUser`
   * answers "yes" to), and the task whose thread they are asking for belongs to
   * somebody else. A member in that position sees the teammate's card on no
   * surface — not the global board, not the command palette, and not the project
   * board since projects-017 — so the thread must be closed to them too.
   */
  it("does not read a teammate's thread for a member who merely holds a task in that project", async () => {
    // The task being asked about is a teammate's. `project.findFirst` keeps
    // answering, which is what makes the member able to OPEN the project (the
    // same stub serves `getProjectForUser`'s "do they hold a task here" probe),
    // and its supervisor is somebody else.
    prisma.answers.set("task.findFirst", taskRow({ assignedTo: "u_someone_else" }));
    prisma.answers.set("project.findFirst", projectRow({ supervisorId: SUPERVISOR_ID }));
    asRole("member", MEMBER_ID);

    const rows = await listCommentsForTarget({ taskId: "t_theirs" });

    expect(rows, "a member read the comment thread of a teammate's task").toEqual([]);
    // And the stronger property, as everywhere else in this file: the question
    // was never asked, so no post-filter bug could put the bodies back.
    expect(commentReads()).toHaveLength(0);
  });

  it("reads the thread of a task assigned to the member", async () => {
    prisma.answers.set("task.findFirst", taskRow({ assignedTo: MEMBER_ID }));
    asRole("member", MEMBER_ID);

    const rows = await listCommentsForTarget({ taskId: "t_theirs" });

    expect(commentReads()).toHaveLength(1);
    expect(rows[0].body).toBe(SECRET_BODY);
  });

  it("reads a teammate's thread for the member who supervises that project", async () => {
    // The deliberate escape hatch: `getTasks({ projectId })` has no
    // `assignedTo` filter, so a member who can open the project sees its whole
    // board — and must be able to read those threads, or the comment button on
    // a card they can see does nothing.
    prisma.answers.set("task.findFirst", taskRow({ assignedTo: "u_someone_else" }));
    prisma.answers.set("project.findFirst", projectRow({ supervisorId: SUPERVISOR_ID }));
    asRole("member", SUPERVISOR_ID);

    const rows = await listCommentsForTarget({ taskId: "t_theirs" });

    expect(commentReads()).toHaveLength(1);
    expect(rows[0].body).toBe(SECRET_BODY);
  });

  it("scopes the target lookup to the caller's own company", async () => {
    asRole("admin");

    await listCommentsForTarget({ taskId: "t_theirs" });

    // Every read on this path — the target check included — carries the
    // asker's tenancy. A target verified by bare id would confirm the
    // existence of another workspace's task.
    for (const call of prisma.calls) {
      const where = (call.args[0] as { where?: Record<string, unknown> } | undefined)?.where;
      expect(where, `${call.delegate}.${call.method} has no where clause`).toBeDefined();
      expect(where, `${call.delegate}.${call.method}`).toHaveProperty("companyId", "c_nimbus");
    }
  });

  it("returns nothing for a task id belonging to another workspace", async () => {
    // The scoped lookup misses, which is the whole mechanism — and it returns
    // an empty thread rather than an error, so it leaks no existence either.
    prisma.answers.set("task.findFirst", null);
    asRole("admin");

    const rows = await listCommentsForTarget({ taskId: "t_rival" });

    expect(rows).toEqual([]);
    expect(commentReads()).toHaveLength(0);
  });
});
