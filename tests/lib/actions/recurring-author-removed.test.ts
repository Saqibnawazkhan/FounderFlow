/**
 * finance-planning-013, the OFF-SWITCH half: a standing charge whose author has
 * left the company must be stoppable, and the page must say it has stopped.
 *
 * WHAT WENT WRONG. `toggleRecurringRuleAction` and `deleteRecurringRuleAction`
 * gate on `rule.addedBy === me || role === "admin"`, mirrored in the card by
 * `canManage`. That is a sound rule while the creator is still around. Once
 * `removeUserAction` has tombstoned them it names a person who can never sign in
 * again — and because there is deliberately no individual-user purge
 * (CLAUDE.md), that state is permanent. A co-founder with full finance access
 * then looks at a rule that is posting real money every month and sees a card
 * with no Pause and no Delete.
 *
 * THE WIDENING IS NARROW, deliberately. The creator-or-admin rule is unchanged
 * for every rule whose author is still at the company: this is not "any finance
 * user may manage any rule", which is a product decision nobody has taken. It is
 * "when there is no creator left to ask, the people who own the books may act".
 * Both actions already refuse a caller who fails `canSeeFinances`, so the
 * widening reaches admins and co-founders and nobody else.
 *
 * AND THE TENANT CHECK STILL COMES FIRST. A removed author is not a way into
 * another workspace's rules — the escape hatch is reached only after
 * `rule.companyId !== session.user.companyId` has already refused.
 *
 * NO DATABASE HERE. Prisma is a recorder, the shape
 * tests/lib/actions/recurring-project-budget.test.ts uses; `canSeeFinances` and
 * `requireFinanceSession` are the real predicates, because stubbing them would
 * assert that this module calls a stub rather than that it obeys the rule the
 * rest of the product obeys. Only `auth()` is faked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();
  const errors: unknown[] = [];

  // An explicit model list, not a Proxy: an action that starts reaching for a
  // NEW table fails loudly here instead of recording nothing and passing.
  const MODELS = ["recurringRule"];
  const OPS = ["findUnique", "findFirst", "findMany", "update", "updateMany", "delete"];

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

  return { db, calls, results, errors, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/sentry-server", () => ({
  captureServerError: (e: unknown) => {
    H.errors.push(e);
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  limiters: { write: { consume: () => ({ allowed: true }) } },
}));
// Imported by lib/actions/recurring.ts for the CREATE path only; nothing below
// creates a rule. Stubbed so this file does not drag the notifier in.
vi.mock("@/lib/budgets/check", () => ({
  checkBudgetThresholdAfterExpense: async () => {},
}));

import { toggleRecurringRuleAction, deleteRecurringRuleAction } from "@/lib/actions/recurring";
import { getRecurringRules } from "@/lib/queries/recurring";

/* ─────────────────────────────── fixtures ───────────────────────────────── */

/** Stand-in for `Prisma.Decimal` (FaultsAudit P0-4 Float→Decimal). */
function money(n: number): unknown {
  return { toNumber: () => n };
}

const GONE = new Date("2026-09-01T10:00:00.000Z");

/**
 * A monthly salary rule, as the action loads it: the row plus the tombstone of
 * the user named by `addedBy`.
 */
function ruleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    companyId: "c1",
    type: "expense",
    amount: money(250000),
    category: "Salaries",
    description: "Ops lead salary",
    addedBy: "u-gone",
    addedByName: "Hira",
    frequency: "monthly",
    dayOfMonth: 1,
    dayOfWeek: null,
    active: true,
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    lastMaterializedAt: new Date("2026-09-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    projectId: null,
    user: { deletedAt: GONE },
    ...over,
  };
}

function signedInAs(role: string, id = "u-cofounder"): void {
  H.session.value = { user: { id, name: "Bilal", email: "b@nimbus.app", companyId: "c1", role } };
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

beforeEach(() => {
  H.calls.length = 0;
  H.errors.length = 0;
  H.results.clear();
  H.results.set("recurringRule.findUnique", ruleRow());
  H.results.set("recurringRule.update", { id: "r1" });
  H.results.set("recurringRule.delete", { id: "r1" });
  H.results.set("recurringRule.findMany", [{ ...ruleRow(), _count: { transactions: 9 } }]);
  signedInAs("cofounder");
});

/* ───────────────────────── pausing an orphaned rule ─────────────────────── */

describe("toggleRecurringRuleAction — the author has been deactivated", () => {
  it("lets a co-founder pause a rule whose creator was removed", async () => {
    const res = await toggleRecurringRuleAction({ ruleId: "r1", active: false });

    expect(H.errors).toEqual([]);
    expect(res.success).toBe(true);
    expect(callsTo("recurringRule.update")[0]).toMatchObject({
      where: { id: "r1" },
      data: { active: false },
    });
  });

  it("still refuses a co-founder for a rule whose creator is still here", async () => {
    // The unchanged contract. A fix that widened this to every rule would be a
    // permission change nobody asked for.
    H.results.set(
      "recurringRule.findUnique",
      ruleRow({ addedBy: "u-other", user: { deletedAt: null } })
    );

    const res = await toggleRecurringRuleAction({ ruleId: "r1", active: false });

    expect(res).toEqual({
      success: false,
      error: "Only the rule's creator or an admin can change it",
    });
    expect(callsTo("recurringRule.update")).toHaveLength(0);
  });

  it("refuses a rule in ANOTHER workspace even when its author is removed", async () => {
    // The escape hatch must sit behind the tenant check, not beside it.
    H.results.set("recurringRule.findUnique", ruleRow({ companyId: "c2" }));

    const res = await toggleRecurringRuleAction({ ruleId: "r1", active: false });

    expect(res).toEqual({ success: false, error: "Not authorized" });
    expect(callsTo("recurringRule.update")).toHaveLength(0);
  });

  it("still refuses a member outright, author removed or not", async () => {
    // `canSeeFinances` comes first and reads nothing: a member must not even
    // learn that the rule exists.
    signedInAs("member", "u-member");

    const res = await toggleRecurringRuleAction({ ruleId: "r1", active: false });

    expect(res).toEqual({ success: false, error: "Not authorized" });
    expect(H.calls).toEqual([]);
  });

  it("asks the database for the author's tombstone at all — guard the guard", async () => {
    // Without this, every assertion above would pass against a row that simply
    // carries a `user` key the action never asked for.
    await toggleRecurringRuleAction({ ruleId: "r1", active: false });

    const args = callsTo("recurringRule.findUnique")[0] as {
      include?: { user?: { select?: { deletedAt?: boolean } } };
    };
    expect(args?.include?.user?.select?.deletedAt).toBe(true);
  });
});

/* ──────────────────────── deleting an orphaned rule ─────────────────────── */

describe("deleteRecurringRuleAction — the author has been deactivated", () => {
  it("lets a co-founder delete a rule whose creator was removed", async () => {
    const res = await deleteRecurringRuleAction("r1");

    expect(H.errors).toEqual([]);
    expect(res.success).toBe(true);
    expect(callsTo("recurringRule.delete")[0]).toMatchObject({ where: { id: "r1" } });
  });

  it("still refuses a co-founder for a rule whose creator is still here", async () => {
    H.results.set(
      "recurringRule.findUnique",
      ruleRow({ addedBy: "u-other", user: { deletedAt: null } })
    );

    const res = await deleteRecurringRuleAction("r1");

    expect(res).toEqual({
      success: false,
      error: "Only the rule's creator or an admin can delete it",
    });
    expect(callsTo("recurringRule.delete")).toHaveLength(0);
  });

  it("refuses a rule in ANOTHER workspace even when its author is removed", async () => {
    H.results.set("recurringRule.findUnique", ruleRow({ companyId: "c2" }));

    const res = await deleteRecurringRuleAction("r1");

    expect(res).toEqual({ success: false, error: "Not authorized" });
    expect(callsTo("recurringRule.delete")).toHaveLength(0);
  });
});

/* ───────────────── the page has to SAY the charge has stopped ───────────── */

/**
 * The materializer now suspends these rules (the finance-planning-013 block in
 * tests/lib/cron/materialize-route.test.ts). A charge that stops silently is its
 * own defect: without a per-rule signal the card still reads as an active rule
 * that fires every month, and the founder's own books are the only place the
 * change shows up. So the reader carries the author's liveness to the page.
 */
describe("getRecurringRules — the author's liveness reaches the page", () => {
  it("flags a rule whose creator has been deactivated", async () => {
    const rules = await getRecurringRules();

    expect(rules).toHaveLength(1);
    expect(rules[0].authorRemoved).toBe(true);
    // The rest of the row is unchanged — this is an added field, not a filter.
    expect(rules[0].active).toBe(true);
    expect(rules[0].amount).toBe(250000);
  });

  it("does not flag a rule whose creator is still at the company", async () => {
    H.results.set("recurringRule.findMany", [
      { ...ruleRow({ user: { deletedAt: null } }), _count: { transactions: 9 } },
    ]);

    const rules = await getRecurringRules();

    expect(rules[0].authorRemoved).toBe(false);
  });

  it("asks for the author's tombstone at all — guard the guard", async () => {
    await getRecurringRules();

    const args = callsTo("recurringRule.findMany")[0] as {
      include?: { user?: { select?: { deletedAt?: boolean } } };
    };
    expect(args?.include?.user?.select?.deletedAt).toBe(true);
  });
});
