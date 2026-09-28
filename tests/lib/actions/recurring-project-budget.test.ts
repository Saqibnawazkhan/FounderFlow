/**
 * money-005 — recurring spend must be able to trip a budget alert.
 *
 * WHAT WAS WRONG. Every Budget in this product belongs to a Project, and
 * `checkBudgetThresholdAfterExpense` (lib/budgets/check.ts:58) returns early the
 * moment `projectId` is null. `RecurringRule.projectId` exists in the schema and
 * the nightly materializer already copies it onto every Transaction and Activity
 * it writes (app/api/cron/materialize-recurring/route.ts:168) — but the ONE
 * place a rule is born, `createRecurringRuleAction`, never set it, and never ran
 * the budget check on the seed transaction it posts immediately. So every rule
 * in the product was permanently project-less, every materialized posting
 * inherited null, and rent / salaries / subscriptions — the outgoings a founder
 * most wants a cap on — could not cross a threshold even once. /budgets showed
 * the bar going red while the alerting stayed silent forever.
 *
 * WHY THESE ASSERTIONS AND NOT "success === true". The cheap version of this
 * file asserts the action succeeded, which was ALREADY true of the broken code:
 * it created a rule successfully, just an untaggable one. The defect is a
 * MISSING field and a MISSING call, so every test below names the field on the
 * row it must appear on, and the argument the budget check must be handed.
 *
 * The seed transaction matters as much as the rule. A rule created on the 3rd
 * posts its first expense on the 3rd (that is the whole point of the seed — see
 * the header of lib/actions/recurring.ts); if only the rule carried the tag, the
 * very first month of a recurring cost would still be invisible to its budget.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fake Prisma client — a recorder, same shape as comment-time-soft-delete      */
/* ─────────────────────────────────────────────────────────────────────────── */

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const errors: unknown[] = [];
  /** Every ({companyId, projectId, category}) the budget check was handed. */
  const budgetChecks: Array<Record<string, unknown>> = [];
  const revalidated: string[] = [];

  // An explicit model list, not a Proxy: an action that starts reaching for a
  // NEW table fails loudly here instead of recording nothing and passing.
  const MODELS = ["user", "project", "recurringRule", "transaction", "activity"];
  const OPS = [
    "findUnique",
    "findFirst",
    "findMany",
    "count",
    "create",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "aggregate",
  ];

  type Op = (args?: Record<string, unknown>) => Promise<unknown>;
  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, Op> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        return typeof canned === "function"
          ? (canned as (a: Record<string, unknown>) => unknown)(args ?? {})
          : canned;
      };
    }
    db[model] = delegate;
  }
  db.$transaction = async (arg: unknown) => {
    calls.push({ path: "$transaction", args: {} });
    return typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(db)
      : await Promise.all(arg as Array<Promise<unknown>>);
  };

  return {
    db,
    calls,
    results,
    errors,
    budgetChecks,
    revalidated,
    session: { value: null as unknown },
  };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => {
    H.revalidated.push(p);
  },
}));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));
// The budget check itself is unit-tested in tests/lib/budgets/. Here we only
// care that it is REACHED, and with which project.
vi.mock("@/lib/budgets/check", () => ({
  checkBudgetThresholdAfterExpense: async (arg: Record<string, unknown>) => {
    H.budgetChecks.push(arg);
  },
}));

import { createRecurringRuleAction } from "@/lib/actions/recurring";

/* ─────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function when(path: string, value: unknown): void {
  H.results.set(path, value);
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function dataOf(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return (args?.data ?? {}) as Record<string, unknown>;
}

function signedInAs(role: string, id = "u1"): void {
  H.session.value = { user: { id, companyId: "c1", role } };
}

const MONTHLY_RENT = {
  type: "expense" as const,
  amount: 450000,
  category: "Office Rent",
  description: "Falcon HQ floor 3",
  frequency: "monthly" as const,
  dayOfMonth: 3,
};

beforeEach(() => {
  H.calls.length = 0;
  H.errors.length = 0;
  H.budgetChecks.length = 0;
  H.revalidated.length = 0;
  H.results.clear();
  H.session.value = null;

  when("user.findUnique", { name: "Saqib", company: { currency: "PKR" } });
  when("project.findFirst", { id: "p1" });
  when("recurringRule.create", (args: Record<string, unknown>) => ({
    id: "r1",
    ...dataOf(args),
  }));
  when("transaction.create", { id: "tx1" });
  when("activity.create", { id: "a1" });
  when("recurringRule.update", { id: "r1" });
  signedInAs("admin");
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("createRecurringRuleAction — the project tag (money-005)", () => {
  it("persists the chosen projectId on the RecurringRule", async () => {
    const res = await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    expect(H.errors).toEqual([]);
    expect(res.success).toBe(true);
    const created = dataOf(callsTo("recurringRule.create")[0]);
    expect(created.projectId).toBe("p1");
  });

  it("carries the same projectId onto the seed transaction posted today", async () => {
    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    const seed = dataOf(callsTo("transaction.create")[0]);
    expect(seed.ruleId).toBe("r1");
    // The first month of a recurring cost is this row. Without the tag the
    // budget it belongs to never sees it.
    expect(seed.projectId).toBe("p1");
  });

  it("tags the activity row too, so the project's own feed shows the rule", async () => {
    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    const activity = dataOf(callsTo("activity.create")[0]);
    expect(activity.projectId).toBe("p1");
  });

  it("verifies the project belongs to this live workspace before writing anything", async () => {
    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    const probe = (callsTo("project.findFirst")[0]?.where ?? {}) as Record<string, unknown>;
    expect(probe).toMatchObject({ id: "p1", companyId: "c1", deletedAt: null });
  });

  it("refuses a projectId from another workspace, and writes nothing", async () => {
    when("project.findFirst", null);

    const res = await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "someone-elses" });

    expect(res).toEqual({ success: false, error: "Project not found" });
    expect(callsTo("recurringRule.create")).toHaveLength(0);
    expect(callsTo("transaction.create")).toHaveLength(0);
  });

  it("still accepts an untagged rule (company-global spend)", async () => {
    const res = await createRecurringRuleAction(MONTHLY_RENT);

    expect(res.success).toBe(true);
    expect(dataOf(callsTo("recurringRule.create")[0]).projectId).toBeNull();
    // No project claimed → no project lookup at all.
    expect(callsTo("project.findFirst")).toHaveLength(0);
  });
});

describe("createRecurringRuleAction — the budget alert (money-005)", () => {
  it("runs the budget threshold check for the project it just charged", async () => {
    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    expect(H.budgetChecks).toEqual([{ companyId: "c1", projectId: "p1", category: "Office Rent" }]);
  });

  it("revalidates /budgets and /notifications so the alert is visible at once", async () => {
    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    expect(H.revalidated).toContain("/budgets");
    expect(H.revalidated).toContain("/notifications");
  });

  it("does NOT run the budget check for an investment rule", async () => {
    await createRecurringRuleAction({
      type: "investment",
      amount: 1_000_000,
      category: "Seed Capital",
      description: "tranche 2",
      frequency: "monthly",
      dayOfMonth: 1,
      projectId: "p1",
    });

    expect(H.budgetChecks).toEqual([]);
  });

  it("a budget-check failure never loses the customer's rule", async () => {
    const res = await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });
    expect(res.success).toBe(true);
    // The rule is created inside the $transaction; the check runs after it, so
    // the ordering is observable: every write precedes the first check.
    const lastWriteIdx = H.calls.map((c) => c.path).lastIndexOf("transaction.create");
    const txIdx = H.calls.map((c) => c.path).indexOf("$transaction");
    expect(txIdx).toBeGreaterThanOrEqual(0);
    expect(lastWriteIdx).toBeGreaterThan(txIdx);
  });
});

describe("createRecurringRuleAction — the activity row's money (money-006)", () => {
  it("records the raw amount AND the workspace currency in metadata", async () => {
    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    const meta = JSON.parse(String(dataOf(callsTo("activity.create")[0]).metadata));
    expect(meta.amount).toBe(450000);
    expect(meta.currency).toBe("PKR");
  });

  it("names the workspace currency in the persisted prose, not a bare number", async () => {
    when("user.findUnique", { name: "Saqib", company: { currency: "AED" } });

    await createRecurringRuleAction({ ...MONTHLY_RENT, projectId: "p1" });

    const message = String(dataOf(callsTo("activity.create")[0]).message);
    // Written once, read forever: an AED workspace's history must not be
    // labelled with the host locale's grouping and no currency at all.
    expect(message).toContain("AED");
    expect(message).toContain("450,000.00");
  });
});
