/**
 * money-004: /budgets charged EVERY expense in a category against EVERY
 * project's cap for that category — including other projects' spend and
 * untagged spend.
 *
 * WHAT THE PRODUCT SHOWED. Two projects with a 1,000 "Office Rent" cap each,
 * 600 spent by project A and 900 by project B. `getBudgetsWithSpend()` (no
 * projectId — the shape /budgets calls) grouped the sum by `category` ALONE and
 * mapped that one figure onto every budget row carrying that category. So both
 * cards read the same number, the page whose entire job is "are we over budget"
 * showed A at 150% and flagged it Over, while /projects/[id] read A at 60% —
 * and the notification, which sums `{ companyId, projectId, category }` in
 * lib/budgets/check.ts, stayed silent. A customer learns the Over badge is
 * noise and stops trusting all of them. The reverse case is worse: a project
 * genuinely over its own cap hides inside a bigger company-wide figure.
 *
 * WHY THESE TESTS LOOK LIKE THIS. There is no database here, so nothing below
 * asserts over real rows. Two things are asserted instead, and each catches a
 * different half of the bug:
 *
 *   1. THE QUESTION ASKED. `by` must include "projectId" and the `where` must
 *      constrain `projectId` to the projects that actually have budgets. That
 *      second one is what keeps UNTAGGED spend (projectId IS NULL) out of a
 *      project's cap — `lib/budgets/check.ts` returns early for an untagged
 *      expense, so an untagged row reaching a cap here is the two surfaces
 *      disagreeing again.
 *   2. THE FOLD. The fixture deliberately gives two projects the SAME category
 *      and different sums. A map keyed on category alone silently collapses
 *      them — last row wins — which is the original defect, and the only test
 *      that can see it is one where the two sums differ.
 *
 * The cheap version of this file would assert `monthToDateSpend >= 0` or that a
 * groupBy happened at all. Both were already true of the broken code.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startOfUtcMonth } from "@/lib/date-range";

/**
 * `vi.mock` factories hoist above the imports, so the recorder has to be built
 * inside `vi.hoisted` — a module-scope `const` is still undefined when the
 * factory runs and the failure reads like a broken test, not a broken query.
 * Same shape as tests/lib/actions/soft-delete.test.ts.
 */
const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  // Deliberately short: a query that starts reaching for a new table fails
  // loudly ("db.timeEntry is undefined") instead of recording nothing and
  // passing.
  const MODELS = ["budget", "transaction"];
  const OPS = ["findMany", "groupBy", "aggregate", "count"];

  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        return results.get(path) ?? [];
      };
    }
    db[model] = delegate;
  }

  return { db, calls, results, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
// The real `requireScopedSession` runs — it is the tenancy path, and stubbing it
// would test that the query calls a stub rather than that it scopes by company.
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));

import { getBudgetsWithSpend } from "@/lib/queries/budgets";

/** Stand-in for `Prisma.Decimal` — the query calls `.toNumber()` at the
 *  client-shape boundary (P0-4, Float→Decimal). */
function money(n: number): unknown {
  return { toNumber: () => n };
}

function budgetRow(id: string, projectId: string, category: string, limit: number): unknown {
  return {
    id,
    companyId: "c1",
    projectId,
    category,
    monthlyLimit: money(limit),
    // The query includes the owning project's name so the card can print it
    // (R3-money-018-cards); the DTO reads it straight off this relation.
    project: { name: `Project ${projectId}` },
    createdBy: "u1",
    createdByName: "Ada",
    active: true,
    lastWarnedMonth: null,
    lastAlertedMonth: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function sumRow(projectId: string | null, category: string, amount: number): unknown {
  return { projectId, category, _sum: { amount: money(amount) } };
}

function argsOf(path: string): Record<string, unknown> {
  const call = H.calls.filter((c) => c.path === path)[0];
  return call ? call.args : {};
}

/**
 * THE FIXTURE THAT CATCHES THE BUG: "Office Rent" is capped at 1,000 in BOTH
 * p1 and p2, and the two projects have spent different amounts. p1 is at 60%
 * and must not be shown as over budget because p2 spent 900.
 */
beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = { user: { id: "u1", companyId: "c1", role: "admin", name: "Ada" } };
  H.results.set("budget.findMany", [
    budgetRow("b1", "p1", "Office Rent", 1000),
    budgetRow("b2", "p2", "Office Rent", 1000),
    budgetRow("b3", "p1", "Tools", 500),
  ]);
  H.results.set("transaction.groupBy", [
    sumRow("p1", "Office Rent", 600),
    sumRow("p2", "Office Rent", 900),
    sumRow("p1", "Tools", 100),
  ]);
});

describe("getBudgetsWithSpend() — the /budgets page shape (money-004)", () => {
  it("charges each cap only its own project's spend", async () => {
    const budgets = await getBudgetsWithSpend();
    const byId = new Map(budgets.map((b) => [b.id, b]));

    // 600, not 1,500 and not 900: p2's rent is p2's problem.
    expect(byId.get("b1")?.monthToDateSpend).toBe(600);
    expect(byId.get("b2")?.monthToDateSpend).toBe(900);
    expect(byId.get("b3")?.monthToDateSpend).toBe(100);
  });

  it("does not badge a 60%-used cap as over budget", async () => {
    const budgets = await getBudgetsWithSpend();
    const b1 = budgets.filter((b) => b.id === "b1")[0];
    expect(b1.percentUsed).toBeCloseTo(0.6, 10);
    expect(b1.percentUsed).toBeLessThan(1);
  });

  it("groups the spend by project AND category", async () => {
    await getBudgetsWithSpend();
    const by = argsOf("transaction.groupBy").by as string[];
    expect(by).toContain("projectId");
    expect(by).toContain("category");
  });

  it("keeps untagged spend out of every cap", async () => {
    // lib/budgets/check.ts returns early when a transaction has no projectId
    // ("projects own budgets now"). The page has to ask the same question, so
    // the sum is constrained to the projects that HAVE budgets — a `where` with
    // no projectId constraint sums `projectId IS NULL` rows too.
    await getBudgetsWithSpend();
    const where = argsOf("transaction.groupBy").where as Record<string, unknown>;
    expect(where.projectId).toEqual({ in: ["p1", "p2"] });
  });

  it("still scopes by company, tombstone and type", async () => {
    await getBudgetsWithSpend();
    const where = argsOf("transaction.groupBy").where as Record<string, unknown>;
    expect(where.companyId).toBe("c1");
    expect(where.deletedAt).toBeNull();
    expect(where.type).toBe("expense");
  });

  it("sums the UTC calendar month, the same window check.ts and the project page use", async () => {
    const now = new Date();
    await getBudgetsWithSpend();
    const where = argsOf("transaction.groupBy").where as Record<string, unknown>;
    const date = where.date as { gte: Date; lt: Date };
    expect(date.gte.toISOString()).toBe(startOfUtcMonth(now).toISOString());
    expect(date.lt.toISOString()).toBe(startOfUtcMonth(now, 1).toISOString());
  });
});

describe("getBudgetsWithSpend({ projectId }) — the project-page shape", () => {
  it("narrows the sum to that one project", async () => {
    H.results.set("budget.findMany", [budgetRow("b1", "p1", "Office Rent", 1000)]);
    H.results.set("transaction.groupBy", [sumRow("p1", "Office Rent", 600)]);

    const budgets = await getBudgetsWithSpend({ projectId: "p1" });
    const where = argsOf("transaction.groupBy").where as Record<string, unknown>;
    expect(where.projectId).toBe("p1");
    expect(budgets[0].monthToDateSpend).toBe(600);
  });

  it("agrees with the unscoped page about the same cap", async () => {
    // The whole point of money-004: /budgets and /projects/[id] must print the
    // same figure for the same budget row.
    const globalView = await getBudgetsWithSpend();
    H.calls.length = 0;
    H.results.set("transaction.groupBy", [sumRow("p1", "Office Rent", 600)]);
    const projectView = await getBudgetsWithSpend({ projectId: "p1" });

    expect(projectView[0].monthToDateSpend).toBe(
      globalView.filter((b) => b.id === "b1")[0].monthToDateSpend
    );
  });
});
