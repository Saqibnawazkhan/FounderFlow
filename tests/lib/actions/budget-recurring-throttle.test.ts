// @vitest-environment node

/**
 * finance-planning-014 — the budgets / recurring-rules surface has seven write
 * actions and only two of them spent the write budget.
 *
 * `createBudgetAction` (lib/actions/budgets.ts) and
 * `createRecurringRuleAction` (lib/actions/recurring.ts) each consume
 * `limiters.write` — 60 writes per user per minute. The four actions pinned
 * here did not: `updateBudgetAction`, `deleteBudgetAction`,
 * `toggleRecurringRuleAction` and `deleteRecurringRuleAction` ran
 * `auth()` → role/ownership check → `db.*.update`/`delete` → `revalidatePath`
 * with no `consume` anywhere in the body. So the two cheapest buttons on the
 * surface to hold down — Pause/Resume on a standing charge, and Delete — were
 * the two with no ceiling, and a scripted loop could repeat either of them as
 * fast as Postgres would answer.
 *
 * WHAT THE COST ACTUALLY IS, because the original filing overstated it. It
 * called each delete "a hard delete… cheap denial-of-service against the
 * customer's own data". For budgets that is no longer true: `deleteBudgetAction`
 * writes the Tier 3 `deletedAt` tombstone, and `revalidatePath` is idempotent.
 * And every one of these four callers has already passed `canSeeFinances` or
 * `canManageProject` on a row in their OWN workspace, so there is no
 * cross-tenant reach here. What is left is real but narrower: unbounded write
 * load plus RSC-cache churn from an authenticated session, and — the part worth
 * the test — a limiter whose coverage could not be reasoned about from the
 * outside, because "writes on this surface are metered" was true of two actions
 * out of seven. `deleteRecurringRuleAction` is still a hard `delete`.
 *
 * WHY THESE ASSERTIONS AND NOT A STRUCTURAL ONE. `@/lib/rate-limit` is NOT
 * mocked in this file: the bucket is the real one and 60 is the real number. A
 * test that greps the source for `limiters.write` cannot tell a wired gate from
 * an unused import, and this repo has shipped that shape repeatedly. The
 * load-bearing assertion is therefore not "the 61st call was refused" but
 * "THE 61ST CALL TOUCHED THE DATABASE NOT AT ALL" — the write is the resource
 * the finding is about, so the gate has to sit in front of the row lookup too,
 * exactly where the two create paths put it.
 *
 * Three counter-assertions guard against the fix being wrong in the other
 * direction: the four actions share ONE budget with each other (so alternating
 * pause → resume → delete buys no fresh allowance), a second admin in the same
 * workspace is never refused for the first one's hammering (the key is the user,
 * not the company), and 60 ordinary edits in a minute all succeed — this is a
 * ceiling on a script, not on a person doing a planning session.
 *
 * NODE ENVIRONMENT: nothing renders. Prisma is a recorder (the shape
 * tests/lib/actions/recurring-author-removed.test.ts uses); `canManageProject`,
 * `canSeeFinances` and `canManageRecurringRule` are the real predicates, because
 * stubbing them would assert that these actions call a stub.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  /** Every Prisma call these actions made, writes and reads alike. */
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const errors: unknown[] = [];
  const revalidated: string[] = [];
  const session = { value: null as unknown };

  /** A live Marketing cap on project Alpha, as the two budget actions load it. */
  const budgetRow = {
    id: "b1",
    companyId: "c_nimbus",
    projectId: "p_alpha",
    category: "Marketing",
    monthlyLimit: { toNumber: () => 10_000 },
    active: true,
    deletedAt: null as Date | null,
    project: { id: "p_alpha", supervisorId: "u_hira" },
  };

  /** A live monthly rule, plus the author tombstone the manage gate reads. */
  const ruleRow = {
    id: "r1",
    companyId: "c_nimbus",
    addedBy: "u_ayesha",
    active: true,
    projectId: null as string | null,
    user: { deletedAt: null as Date | null },
  };

  function record(path: string, args?: Record<string, unknown>): void {
    calls.push({ path, args: args ?? {} });
  }

  const db = {
    budget: {
      findUnique: async (args?: Record<string, unknown>) => {
        record("budget.findUnique", args);
        return budgetRow;
      },
      findFirst: async (args?: Record<string, unknown>) => {
        record("budget.findFirst", args);
        return null;
      },
      update: async (args?: Record<string, unknown>) => {
        // One Prisma op serves both the cap edit and the Tier 3 soft delete, so
        // the `data` shape is what tells them apart.
        const data = (args?.data ?? {}) as Record<string, unknown>;
        record(data.deletedAt ? "budget.softDelete" : "budget.update", args);
        return budgetRow;
      },
    },
    recurringRule: {
      findUnique: async (args?: Record<string, unknown>) => {
        record("recurringRule.findUnique", args);
        return ruleRow;
      },
      update: async (args?: Record<string, unknown>) => {
        record("recurringRule.update", args);
        return ruleRow;
      },
      delete: async (args?: Record<string, unknown>) => {
        record("recurringRule.delete", args);
        return ruleRow;
      },
    },
  };

  return { db, calls, errors, revalidated, session, budgetRow, ruleRow };
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
// Pulled in by lib/actions/recurring.ts for the CREATE path only; nothing here
// creates a rule, so this just keeps the notifier out of the module graph.
vi.mock("@/lib/budgets/check", () => ({
  checkBudgetThresholdAfterExpense: async () => {},
}));

import { updateBudgetAction, deleteBudgetAction } from "@/lib/actions/budgets";
import { toggleRecurringRuleAction, deleteRecurringRuleAction } from "@/lib/actions/recurring";
import { limiters } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/actions/types";

/** `limiters.write` — 60 per user per minute (lib/rate-limit.ts). */
const WRITE_LIMIT = 60;

function signedInAs(id: string): void {
  H.session.value = {
    user: { id, companyId: "c_nimbus", role: "admin", email: `${id}@nimbus.app` },
  };
}

function refused(r: ActionResult): boolean {
  return r.success === false && /Too many requests/.test(r.error);
}

/** The four actions the finding names, each with the Prisma write it performs. */
const PROBES: Array<{
  label: string;
  write: string;
  run: () => Promise<ActionResult>;
}> = [
  {
    label: "updateBudgetAction",
    write: "budget.update",
    run: () => updateBudgetAction({ budgetId: "b1", monthlyLimit: 5000 }),
  },
  {
    label: "deleteBudgetAction",
    write: "budget.softDelete",
    run: () => deleteBudgetAction("b1"),
  },
  {
    label: "toggleRecurringRuleAction",
    write: "recurringRule.update",
    run: () => toggleRecurringRuleAction({ ruleId: "r1", active: false }),
  },
  {
    label: "deleteRecurringRuleAction",
    write: "recurringRule.delete",
    run: () => deleteRecurringRuleAction("r1"),
  },
];

function countOf(path: string): number {
  return H.calls.filter((c) => c.path === path).length;
}

beforeEach(() => {
  limiters.write.reset();
  H.calls.length = 0;
  H.errors.length = 0;
  H.revalidated.length = 0;
  H.budgetRow.deletedAt = null;
  H.budgetRow.active = true;
  H.ruleRow.user.deletedAt = null;
  signedInAs("u_ayesha");
});

describe("finance-planning-014 — every write on budgets + recurring is metered", () => {
  for (const probe of PROBES) {
    it(`${probe.label} stops writing once the write budget is spent`, async () => {
      for (let i = 0; i < WRITE_LIMIT; i++) {
        const r = await probe.run();
        expect(r.success, `call ${i + 1} should still be allowed`).toBe(true);
      }
      expect(countOf(probe.write)).toBe(WRITE_LIMIT);

      // The 61st call in the same minute. The finding is about the write, so
      // assert the write first and the message second.
      const callsBefore = H.calls.length;
      const over = await probe.run();
      expect(countOf(probe.write)).toBe(WRITE_LIMIT);
      expect(refused(over)).toBe(true);
      // And nothing was read either: the gate belongs in front of the row
      // lookup, where createBudgetAction / createRecurringRuleAction put it.
      expect(H.calls.length).toBe(callsBefore);
      expect(H.errors).toEqual([]);
    });
  }

  it("refuses a scripted loop long before it can churn the cache or the tables", async () => {
    for (let i = 0; i < 400; i++) await deleteRecurringRuleAction("r1");
    expect(countOf("recurringRule.delete")).toBeLessThanOrEqual(WRITE_LIMIT);
    // revalidatePath fires three times per successful delete and never on a
    // refusal, so the RSC-cache churn is bounded by the same 60.
    expect(H.revalidated.length).toBeLessThanOrEqual(WRITE_LIMIT * 3);
  });

  it("shares one budget across the four, so alternating the buttons buys nothing", async () => {
    // A quarter of the minute's allowance on each of the four actions…
    for (let i = 0; i < WRITE_LIMIT / 4; i++) {
      for (const probe of PROBES) {
        expect((await probe.run()).success).toBe(true);
      }
    }
    // …spends the whole of it, whichever one is pressed next.
    for (const probe of PROBES) {
      expect(refused(await probe.run()), `${probe.label} after the shared budget`).toBe(true);
    }
  });

  it("keys the bucket on the user, not the workspace", async () => {
    for (let i = 0; i < WRITE_LIMIT + 5; i++) await deleteBudgetAction("b1");
    expect(refused(await deleteBudgetAction("b1"))).toBe(true);

    // Their co-founder, in the same company, did nothing wrong.
    signedInAs("u_bilal");
    const colleague = await deleteBudgetAction("b1");
    expect(colleague.success).toBe(true);
  });

  it("lets a person do 60 ordinary cap edits in a minute without being throttled", async () => {
    // The counter-assertion to all of the above: this is a ceiling on a script.
    for (let i = 0; i < WRITE_LIMIT; i++) {
      const r = await updateBudgetAction({ budgetId: "b1", monthlyLimit: 1000 + i });
      expect(r.success).toBe(true);
    }
    expect(countOf("budget.update")).toBe(WRITE_LIMIT);
  });
});
