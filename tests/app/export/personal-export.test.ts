// @vitest-environment node

/**
 * acct-009 — every user can take a copy of their OWN data, and a member still
 * cannot take the workspace's.
 *
 * The finding: /settings offered a member exactly one data operation, "Delete
 * my account". The export card was gated on `canSeeFinances` and the route
 * returned 403, both for a sound reason — a full-workspace JSON carries every
 * transaction past the app's finance wall — but nothing narrower existed, so
 * the people with the least power in a workspace were the only ones who could
 * not get their data out.
 *
 * WHY THESE ASSERTIONS AND NOT A SNAPSHOT. The property at stake is not "the
 * member export has the right shape", it is "widening WHO may export did not
 * widen WHAT a member sees". A shape assertion goes green the moment the route
 * returns any JSON; the two that matter here are:
 *
 *   • the negative one (`transaction` / `budget` / `recurringRule` are never
 *     ASKED FOR on the personal path, asserted on the recorded calls, not on
 *     the body) — the fake client answers whatever it is stocked with
 *     regardless of the WHERE clause, so a future edit that adds a finance read
 *     to the personal path puts the stocked "Series A wire" row straight into a
 *     member's file and turns this red; and
 *   • the WHERE clauses, because "scoped by the role" has to be a property of
 *     the QUESTION asked of the database, not of a filter applied to the answer
 *     afterwards. That is the same rule tests/lib/auth/finance-gate.test.ts
 *     enforces for the workspace export, for the same reason.
 *
 * `lib/auth/role-gates.ts` is the REAL predicate throughout — stubbing it would
 * assert that the route calls a stub rather than that it obeys the rule the
 * sidebar and the middleware obey.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedSession } from "@/lib/queries/session";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

type RecordedCall = { delegate: string; method: string; args: unknown[] };

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  // A Proxy rather than a literal fake: a delegate added to the route later
  // is recorded automatically instead of throwing (or, worse, being quietly
  // added to a hand-written fake without any of these invariants applying).
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

  const db: Record<string, unknown> = new Proxy(
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

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

const session = vi.hoisted(() => ({
  scoped: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.scoped),
}));
// Mocked so the test passes against the route BEFORE and AFTER the fix: the
// pre-fix route reached its gate through `auth()`, the fixed one through
// `requireScopedSession()`. Importing the real module drags next-auth's env
// shim in, which vitest cannot resolve from node_modules.
vi.mock("@/lib/auth", () => ({
  auth: () =>
    Promise.resolve({
      user: {
        id: session.scoped.userId,
        companyId: session.scoped.companyId,
        role: session.scoped.role,
        email: session.scoped.email,
        name: session.scoped.userName,
      },
    }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

function asRole(role: ScopedSession["role"], userId: string) {
  session.scoped = {
    userId,
    userName: "Tester",
    email: "tester@nimbus.app",
    companyId: "c_nimbus",
    role,
  };
}

function callsTo(delegate: string, method?: string): RecordedCall[] {
  return prisma.calls.filter((c) => c.delegate === delegate && (!method || c.method === method));
}

function whereOf(delegate: string, method = "findMany"): Record<string, unknown> {
  const call = callsTo(delegate, method)[0];
  if (!call) throw new Error(`expected a ${delegate}.${method} call, saw none`);
  return (call.args[0] as { where: Record<string, unknown> }).where;
}

/** A Prisma.Decimal stand-in — the route calls `.toNumber()` on money columns. */
function money(n: number) {
  return { toNumber: () => n } as unknown as { toNumber(): number };
}

/**
 * Stock every table the WORKSPACE export reads, with a recognisable finance row
 * so "did any of this reach the member?" is answerable by string search.
 */
function stockWorkspaceTables() {
  for (const key of [
    "user.findMany",
    "project.findMany",
    "task.findMany",
    "budget.findMany",
    "recurringRule.findMany",
    "timeEntry.findMany",
    "comment.findMany",
    "activity.findMany",
    "notification.findMany",
    "notificationPreference.findMany",
    "inviteToken.findMany",
  ]) {
    prisma.answers.set(key, []);
  }
  prisma.answers.set("transaction.findMany", [
    {
      id: "tx_1",
      companyId: "c_nimbus",
      description: "Series A wire",
      amount: money(250000),
      date: new Date("2026-05-01T00:00:00.000Z"),
      deletedAt: null,
    },
  ]);
  prisma.answers.set("budget.findMany", [
    { id: "b_1", companyId: "c_nimbus", category: "Payroll", monthlyLimit: money(88000) },
  ]);
  prisma.answers.set("recurringRule.findMany", [
    { id: "r_1", companyId: "c_nimbus", description: "Office rent", amount: money(4200) },
  ]);
  prisma.answers.set("company.findFirst", { id: "c_nimbus", name: "Nimbus", deletedAt: null });
}

/** Stock every table the PERSONAL export reads. */
function stockPersonalTables(userId: string) {
  stockWorkspaceTables();
  prisma.answers.set("user.findFirst", {
    id: userId,
    name: "Tester",
    email: "tester@nimbus.app",
    role: "member",
    companyId: "c_nimbus",
    passwordHash: "$2b$10$notarealhashbutlongenough",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    deletedAt: null,
  });
  prisma.answers.set("task.findMany", [
    { id: "t_1", companyId: "c_nimbus", title: "Ship the invoice screen", assignedTo: userId },
  ]);
  prisma.answers.set("timeEntry.findMany", [
    { id: "te_1", companyId: "c_nimbus", userId, note: "Sprint work" },
  ]);
  prisma.answers.set("comment.findMany", [
    { id: "cm_1", companyId: "c_nimbus", authorId: userId, body: "Looks good to me" },
  ]);
  prisma.answers.set("activity.findMany", [
    { id: "a_1", companyId: "c_nimbus", userId, type: "task_completed", message: "closed a task" },
  ]);
  prisma.answers.set("notification.findMany", [
    { id: "n_1", companyId: "c_nimbus", userId, category: "task", title: "You were assigned" },
  ]);
  prisma.answers.set("notificationPreference.findMany", [
    { id: "np_1", userId, event: "task_assigned", inApp: true, email: true, push: false },
  ]);
}

async function get(url?: string) {
  const { GET } = await import("@/app/api/export/route");
  // `GET()` with no argument is the historical unit-call shape and still the
  // "no scope given" case; the route must not depend on being handed a Request.
  return url === undefined
    ? (GET as (req?: Request) => Promise<Response>)()
    : (GET as (req?: Request) => Promise<Response>)(new Request(url));
}

const ME = "https://app.founderflow.test/api/export?scope=me";
const WORKSPACE = "https://app.founderflow.test/api/export?scope=workspace";

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  sentry.captureServerError.mockClear();
  asRole("admin", "u_admin");
});

/* ─────────────────── 1. a member can get their own data ─────────────────── */

describe("GET /api/export?scope=me — the data-subject download", () => {
  it("lets a member take a copy of their own data", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    const res = await get(ME);

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.meta.scope).toBe("me");
    expect(body.tasks).toHaveLength(1);
    expect(body.timeEntries).toHaveLength(1);
    expect(body.comments).toHaveLength(1);
    expect(body.notificationPreferences).toHaveLength(1);
    expect(body.user.email).toBe("tester@nimbus.app");
  });

  it("offers it as a download, not a page", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    const res = await get(ME);

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("never ships the caller's password hash", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    const res = await get(ME);

    const raw = await res.text();
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("$2b$10$notarealhashbutlongenough");
  });

  it("is available to an admin too — it is a personal download, not a demotion", async () => {
    stockPersonalTables("u_admin");
    asRole("admin", "u_admin");

    const res = await get(ME);

    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).meta.scope).toBe("me");
  });
});

/* ───────────── 2. the negative assertion: no finance, at all ─────────────── */

describe("the member export carries none of the finance data an admin's does", () => {
  it("does not even ASK for transactions, budgets or recurring rules", async () => {
    // First: prove the stocked finance rows DO reach an admin's workspace
    // export, so the negative below is about the scope and not about the
    // fixture being empty.
    stockWorkspaceTables();
    asRole("admin", "u_admin");
    const adminRaw = await (await get(WORKSPACE)).text();
    expect(adminRaw).toContain("Series A wire");
    expect(adminRaw).toContain("250000");
    expect(adminRaw).toContain("Office rent");

    prisma.calls.length = 0;
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    const res = await get(ME);
    expect(res.status).toBe(200);
    const memberRaw = await res.text();

    // Nothing an admin's export names is in the member's file…
    expect(memberRaw).not.toContain("Series A wire");
    expect(memberRaw).not.toContain("250000");
    expect(memberRaw).not.toContain("Office rent");
    expect(memberRaw).not.toContain("Payroll");
    // …and the money tables were never queried, so no later edit can leak them
    // through a filter someone forgets to apply to the answer.
    expect(callsTo("transaction")).toHaveLength(0);
    expect(callsTo("budget")).toHaveLength(0);
    expect(callsTo("recurringRule")).toHaveLength(0);

    const body = JSON.parse(memberRaw);
    expect(body.transactions).toBeUndefined();
    expect(body.budgets).toBeUndefined();
    expect(body.recurringRules).toBeUndefined();
  });

  it("puts the finance wall in the WHERE clause for a non-finance caller", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    await get(ME);

    // A comment can hang off a Transaction (Comment.transactionId), a finance
    // Activity names a figure, and a finance Notification is the row the
    // notifications page already hides from members. All three are excluded by
    // the query, not by a post-filter.
    expect(whereOf("comment").transactionId).toBeNull();
    expect(JSON.stringify(whereOf("activity"))).toContain("expense_added");
    expect(whereOf("notification").category).toEqual({ not: "finance" });
  });

  it("does not impose that wall on a caller who may see money", async () => {
    stockPersonalTables("u_admin");
    asRole("admin", "u_admin");

    await get(ME);

    expect(whereOf("comment").transactionId).toBeUndefined();
    expect(whereOf("activity").type).toBeUndefined();
    expect(whereOf("notification").category).toBeUndefined();
  });
});

/* ─────────── 3. the workspace export is exactly as closed as before ──────── */

describe("widening who can export did not widen what a member may take", () => {
  it("still refuses a member the workspace export", async () => {
    stockWorkspaceTables();
    asRole("member", "u_member");

    const res = await get(WORKSPACE);

    expect(res.status).toBe(403);
    expect(prisma.calls).toHaveLength(0);
  });

  it("still refuses a member a scope-less request", async () => {
    // The historical default. A member asking for /api/export with no scope is
    // asking for the workspace file, and the answer is the same 403 it was.
    stockWorkspaceTables();
    asRole("member", "u_member");

    const res = await get("https://app.founderflow.test/api/export");

    expect(res.status).toBe(403);
    expect(prisma.calls).toHaveLength(0);
  });

  it("still serves the whole workspace to an admin", async () => {
    stockWorkspaceTables();
    asRole("admin", "u_admin");

    const res = await get(WORKSPACE);

    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.meta.scope).toBe("workspace");
    expect(body.transactions).toHaveLength(1);
  });

  it("rejects a scope it does not recognise rather than guessing", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    const res = await get("https://app.founderflow.test/api/export?scope=everything");

    expect(res.status).toBe(400);
    expect(prisma.calls).toHaveLength(0);
  });
});

/* ───────────────── 4. every personal read is keyed to the caller ─────────── */

describe("the personal export reads rows ABOUT the caller, not rows near them", () => {
  it("keys every read to the caller's own id", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    await get(ME);

    expect(whereOf("user", "findFirst").id).toBe("u_member");
    expect(whereOf("timeEntry").userId).toBe("u_member");
    expect(whereOf("comment").authorId).toBe("u_member");
    expect(whereOf("activity").userId).toBe("u_member");
    expect(whereOf("notification").userId).toBe("u_member");
    expect(whereOf("notificationPreference").userId).toBe("u_member");
    // Tasks are "mine" through either end of the assignment.
    expect(JSON.stringify(whereOf("task"))).toContain("u_member");
  });

  it("keeps every read inside the caller's workspace", async () => {
    stockPersonalTables("u_member");
    asRole("member", "u_member");

    await get(ME);

    for (const delegate of ["task", "timeEntry", "comment", "activity", "notification"]) {
      expect(whereOf(delegate).companyId).toBe("c_nimbus");
    }
  });
});
