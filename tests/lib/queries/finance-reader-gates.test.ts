/**
 * sec-002, the half that was never reachable: the finance gate at the place the
 * MONEY IS READ.
 *
 * WHAT THE CUSTOMER EXPERIENCES TODAY. An admin demotes a departing co-founder
 * to member. The co-founder's browser keeps loading /expenses, /budgets,
 * /recurring, /activities and /dashboard for up to thirty days, because the only
 * thing standing in the way is `authorized()` in auth.config.ts, which reads
 * `role` out of that person's own cookie — and the Edge `jwt` callback performs
 * no database read, so the claim is whatever was baked in at sign-in. One
 * devtools rule blocking /api/auth/session keeps it stale for the JWT lifetime.
 * CLAUDE.md promises two layers that agree; seven of the eight blocked routes
 * had one.
 *
 * `requireFinanceSession()` (lib/queries/session.ts) was written, reviewed and
 * unit-tested to close this — and had ZERO callers, which is the defect shape
 * this repo keeps producing (tests/lib/actions/reachability.test.ts). A green
 * session-gate suite plus an ungated reader is exactly as leaky as no fix at
 * all, so this file asserts the property at the READER, not at the decision
 * function: for each finance read, a caller who fails `canSeeFinances` must be
 * diverted and NO LEDGER QUERY MUST RUN.
 *
 * WHY "zero db calls" IS THE LOAD-BEARING ASSERTION. A reader that gates after
 * it queries still sends the SELECT, still pays for it, and still holds the rows
 * in server memory a `console.log` away from the payload. Asserting the returned
 * value is empty cannot tell those two apart; asserting the recorder is empty
 * can.
 *
 * THE ESCAPE HATCH IS A FIRST-CLASS CASE, not an edge case. CLAUDE.md: "Members
 * never see finance pages. Per-project supervisors get an escape hatch inside
 * their own project." `canSeeFinances` is FALSE for a member-supervisor, so a
 * blanket `requireFinanceSession()` inside `getBudgetsWithSpend` would bounce a
 * supervisor off their own project's Budgets tab — a worse regression than the
 * bug being fixed. The project-scoped suite at the bottom pins both directions:
 * the supervisor still gets their rows, and a member who merely holds a task in
 * the project still gets none.
 *
 * NO DATABASE HERE. Prisma is a recorder (the shape
 * tests/lib/queries/budget-spend-scoping.test.ts and
 * tests/lib/auth/finance-gate.test.ts use), and `requireFinanceSession`,
 * `canSeeFinances` and `canSeeProjectFinances` are the REAL predicates —
 * stubbing them would assert that the readers call a stub rather than that they
 * obey the rule the rest of the product obeys. Only `auth()` is faked, because
 * the cookie is the thing under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

const H = vi.hoisted(() => {
  const calls: { path: string; args: Record<string, unknown> }[] = [];
  /** Canned answer per "model.op". `has`, not `??`, so a deliberate `null`
   *  (a findFirst that must MISS) stays distinguishable from "not stubbed". */
  const results = new Map<string, unknown>();

  // A Proxy rather than a literal `{ budget: { findMany } }` fake, for the
  // reason tests/lib/auth/finance-gate.test.ts gives: a literal fake only knows
  // the delegates that existed the day it was written, so a reader that starts
  // touching a new table either throws here or, once somebody "fixes" the fake,
  // joins the module with none of the invariants below applying to it.
  const delegates = new Map<string, unknown>();
  const db = new Proxy({} as Record<string, unknown>, {
    get(_target, model) {
      if (typeof model !== "string") return undefined;
      const cached = delegates.get(model);
      if (cached) return cached;
      const made = new Proxy(
        {},
        {
          get(_t, op) {
            if (typeof op !== "string") return undefined;
            const path = model + "." + op;
            return (args?: Record<string, unknown>) => {
              calls.push({ path, args: args ?? {} });
              return Promise.resolve(results.has(path) ? results.get(path) : []);
            };
          },
        }
      );
      delegates.set(model, made);
      return made;
    },
  });

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
// @sentry/nextjs drags a whole runtime into a jsdom test for no benefit here;
// the read-ceiling warning is not what this file is about.
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

import * as activities from "@/lib/queries/activities";
import * as budgets from "@/lib/queries/budgets";
import * as recurring from "@/lib/queries/recurring";
import * as txns from "@/lib/queries/transactions";

/* ───────────────────────────────── fixtures ─────────────────────────────── */

/** Stand-in for `Prisma.Decimal` (P0-4 Float→Decimal). */
function money(n: number): unknown {
  return { toNumber: () => n };
}

function sessionFor(role: string, userId = "u_demoted") {
  return { user: { id: userId, name: "Bilal", email: "b@nimbus.app", companyId: "c1", role } };
}

/** What was thrown — a redirect carries a `digest`; a plain Error does not. */
function thrownFrom(p: Promise<unknown>): Promise<{ digest?: string; message?: string }> {
  return p.then(
    () => {
      throw new Error("expected the read to divert, but it returned normally");
    },
    (e: { digest?: string; message?: string }) => e
  );
}

function pathsHit(): string[] {
  return H.calls.map((c) => c.path);
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = sessionFor("admin");

  H.results.set("transaction.findMany", [
    {
      id: "t1",
      companyId: "c1",
      type: "expense",
      amount: money(250),
      category: "Office Rent",
      description: "September rent",
      date: new Date("2026-09-02T00:00:00.000Z"),
      addedBy: "u1",
      addedByName: "Ada",
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      _count: { comments: 0 },
    },
  ]);
  H.results.set("transaction.groupBy", [
    {
      type: "expense",
      projectId: "p1",
      category: "Office Rent",
      addedBy: "u1",
      _sum: { amount: money(250) },
      _count: { _all: 1 },
    },
  ]);
  H.results.set("activity.findMany", [
    {
      id: "a1",
      companyId: "c1",
      type: "transaction_logged",
      message: "Ada logged 250 PKR",
      userId: "u1",
      userName: "Ada",
      metadata: null,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
    },
  ]);
  H.results.set("recurringRule.findMany", [
    {
      id: "r1",
      companyId: "c1",
      type: "expense",
      amount: money(1000),
      category: "Office Rent",
      description: "Rent",
      addedBy: "u1",
      addedByName: "Ada",
      frequency: "monthly",
      dayOfMonth: 1,
      dayOfWeek: null,
      active: true,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      lastMaterializedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      _count: { transactions: 3 },
    },
  ]);
  H.results.set("budget.findMany", [
    {
      id: "b1",
      companyId: "c1",
      projectId: "p1",
      category: "Office Rent",
      monthlyLimit: money(1000),
      // Included by getBudgetsWithSpend so the card can name the project
      // (R3-money-018-cards).
      project: { name: "Apollo" },
      createdBy: "u1",
      createdByName: "Ada",
      active: true,
      lastWarnedMonth: null,
      lastAlertedMonth: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  ]);
});

/* ────────────────────── every company-wide finance read ─────────────────── */

/**
 * Deliberately a table rather than ten hand-written tests: the finding is that
 * SEVEN of eight surfaces were missed one at a time. A reader added to one of
 * these modules next quarter is meant to be added here in one line, and a reader
 * that goes ungated fails by name.
 */
const COMPANY_WIDE: { name: string; run: () => Promise<unknown> }[] = [
  { name: "getTransactions (the ledger list)", run: () => txns.getTransactions() },
  { name: "getTransactionTotals (balance + runway)", run: () => txns.getTransactionTotals() },
  { name: "getMonthlyTotals (the cash-flow chart)", run: () => txns.getMonthlyTotals(3) },
  { name: "getExpenseTotalsByCategory (the pie)", run: () => txns.getExpenseTotalsByCategory() },
  {
    name: "getContributionTotalsByUser (per-founder capital)",
    run: () => txns.getContributionTotalsByUser(),
  },
  { name: "getMonthToDateExpense (the This-month card)", run: () => txns.getMonthToDateExpense() },
  { name: "getActivities (the /dashboard feed)", run: () => activities.getActivities(50) },
  {
    name: "getActivitiesPage (the /activities timeline)",
    run: () => activities.getActivitiesPage(),
  },
  { name: "getRecurringRules (/recurring)", run: () => recurring.getRecurringRules() },
  {
    name: "getBudgetsWithSpend (the company-wide /budgets page)",
    run: () => budgets.getBudgetsWithSpend(),
  },
];

describe("a demoted teammate's stale cookie no longer reads the ledger (sec-002)", () => {
  for (const reader of COMPANY_WIDE) {
    it(reader.name + " diverts a member to /tasks", async () => {
      H.session.value = sessionFor("member");
      const e = await thrownFrom(reader.run());
      expect(e.digest).toMatch(/^NEXT_REDIRECT/);
      // The same destination middleware sends a member to, so the two layers
      // agree on the outcome as well as on the predicate.
      expect(e.digest).toContain("/tasks");
    });

    it(reader.name + " runs no query at all for a member", async () => {
      H.session.value = sessionFor("member");
      await thrownFrom(reader.run());
      // Not "returns nothing" — nothing may be ASKED. A gate placed after the
      // SELECT still ships the rows into server memory and still pays for them.
      expect(pathsHit()).toEqual([]);
    });

    it(reader.name + " refuses a role nobody has heard of", async () => {
      // auth.config.ts had to fix this exact fail-open: a claim that is not
      // literally "member" must not reach the ledger either.
      H.session.value = sessionFor("accountant");
      const e = await thrownFrom(reader.run());
      expect(e.digest).toContain("/tasks");
      expect(pathsHit()).toEqual([]);
    });

    it(reader.name + " still answers an admin", async () => {
      // The other half of the wiring risk: a gate that quietly breaks the page
      // for the people it exists to serve.
      await reader.run();
      expect(pathsHit().length).toBeGreaterThan(0);
    });

    it(reader.name + " still answers a cofounder", async () => {
      H.session.value = sessionFor("cofounder");
      await reader.run();
      expect(pathsHit().length).toBeGreaterThan(0);
    });

    it(reader.name + " sends a signed-out caller to /login, not to /tasks", async () => {
      H.session.value = null;
      const e = await thrownFrom(reader.run());
      expect(e.digest).toContain("/login");
    });
  }

  it("hands an admin the real figures, not an empty shell", async () => {
    // Guards against "gate it by returning []", which would satisfy every
    // assertion above and make every finance page read zero.
    // Three rows, not one: with no `type` the reader runs one window per type
    // (MAX_TRANSACTIONS_PER_TYPE is per type) and the recorder answers each.
    const rows = await txns.getTransactions();
    expect(rows.length).toBe(3);
    expect(rows[0].amount).toBe(250);
    const totals = await txns.getTransactionTotals();
    expect(totals.byType.expense.total).toBe(250);
    const feed = await activities.getActivities(50);
    expect(feed[0].message).toContain("250");
    const rules = await recurring.getRecurringRules();
    expect(rules[0].amount).toBe(1000);
  });
});

/* ───────────── the per-project supervisor escape hatch (CLAUDE.md) ───────── */

describe("getBudgetsWithSpend({ projectId }) — the supervisor escape hatch survives", () => {
  it("lets a MEMBER who supervises the project read its budgets", async () => {
    // The promise in CLAUDE.md: "Members never see finance pages. Per-project
    // supervisors get an escape hatch inside their own project." A blanket
    // requireFinanceSession() here would redirect this person off a Budgets tab
    // app/(app)/projects/[id]/page.tsx deliberately renders for them.
    H.session.value = sessionFor("member", "u_super");
    H.results.set("project.findFirst", { supervisorId: "u_super" });

    const rows = await budgets.getBudgetsWithSpend({ projectId: "p1" });
    expect(rows.length).toBe(1);
    expect(rows[0].monthlyLimit).toBe(1000);
    expect(pathsHit()).toContain("budget.findMany");
  });

  it("checks the supervisor against the project's own row, scoped to the company", async () => {
    // Not against anything the caller said: the projectId is client-supplied.
    H.session.value = sessionFor("member", "u_super");
    H.results.set("project.findFirst", { supervisorId: "u_super" });
    await budgets.getBudgetsWithSpend({ projectId: "p1" });

    const call = H.calls.filter((c) => c.path === "project.findFirst")[0];
    expect(call, "the supervisor claim must be verified against the project row").toBeTruthy();
    const where = call.args.where as Record<string, unknown>;
    expect(where.id).toBe("p1");
    expect(where.companyId).toBe("c1");
    expect(where.deletedAt).toBeNull();
  });

  it("gives a member who merely holds a task in the project no budget rows, and no redirect", async () => {
    // This person CAN see /projects/[id] (getProjectForUser lets an assignee in)
    // so a redirect would bounce them off a page they are entitled to. The right
    // answer is the one the page already computes: no Budgets tab, no rows.
    H.session.value = sessionFor("member", "u_assignee");
    H.results.set("project.findFirst", { supervisorId: "u_someone_else" });

    await expect(budgets.getBudgetsWithSpend({ projectId: "p1" })).resolves.toEqual([]);
    expect(pathsHit()).not.toContain("budget.findMany");
  });

  it("gives nothing when the project is not in the caller's company", async () => {
    H.session.value = sessionFor("member", "u_super");
    H.results.set("project.findFirst", null);
    await expect(budgets.getBudgetsWithSpend({ projectId: "p_other" })).resolves.toEqual([]);
    expect(pathsHit()).not.toContain("budget.findMany");
  });

  it("does not pay for the supervisor lookup when the caller can already see finances", async () => {
    // Same economy as visibleNotifications: the common case buys no extra query.
    const rows = await budgets.getBudgetsWithSpend({ projectId: "p1" });
    expect(rows.length).toBe(1);
    expect(pathsHit()).not.toContain("project.findFirst");
  });

  it("still sends a signed-out caller to /login", async () => {
    H.session.value = null;
    const e = await thrownFrom(budgets.getBudgetsWithSpend({ projectId: "p1" }));
    expect(e.digest).toContain("/login");
  });
});
