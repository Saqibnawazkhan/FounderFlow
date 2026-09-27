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
  getProjectOverview,
  getProjectTitleForUser,
  listProjectsForUser,
} from "@/lib/queries/projects";
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
  prisma.answers.set("project.findFirst", projectRow());
  prisma.answers.set("project.findMany", [projectRow()]);
  prisma.answers.set("task.findFirst", { id: "t1" }); // caller holds a task
  prisma.answers.set("task.count", 2);
  prisma.answers.set("task.findMany", [{ assignedTo: MEMBER_ID }]);
  prisma.answers.set("task.groupBy", []);
  prisma.answers.set("timeEntry.findMany", []);
  prisma.answers.set("transaction.aggregate", { _sum: { amount: decimal(SECRET_SPEND) } });
  prisma.answers.set("transaction.groupBy", [
    { projectId: "p_nimbus", _sum: { amount: decimal(SECRET_SPEND) } },
  ]);
  asRole("admin");
});

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
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
