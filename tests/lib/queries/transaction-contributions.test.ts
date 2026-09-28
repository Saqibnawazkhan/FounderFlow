/**
 * money-008, the last roll-up that did not exist.
 *
 * The file header of lib/queries/transactions.ts lists what is still owed: the
 * finance PAGES hand their client components the windowed array and reduce it
 * there. For six of those surfaces the roll-up they need already exists
 * (`getTransactionTotals`, `getMonthlyTotals`, `getExpenseTotalsByCategory`), so
 * wiring them is one prop each. TWO of them cannot be wired at all, because the
 * figure they render is PER PERSON and there is no per-person aggregate:
 *
 *   app/(app)/dashboard/dashboard-client.tsx:~236  "founder contributions"
 *       transactions.filter(t => t.addedBy === u.id && t.type === "investment")
 *                   .reduce((s, t) => s + t.amount, 0)
 *
 *   app/(app)/team/team-client.tsx:237-242         per-member contributed / spent
 *       the same reduce, twice, for every member on the page
 *
 * Both read the capped array, so both understate exactly the way money-008
 * describes — and the rows dropped are the OLDEST, which for a startup are the
 * seed investments, so the founder-contribution figure is the one most likely to
 * be wrong and the one a founder is most likely to notice. Neither page can be
 * fixed until a `groupBy(["addedBy", "type"])` exists for it to read.
 *
 * As everywhere else in this file's siblings, what is asserted is the QUESTION
 * ASKED — there is no database in vitest, and every property money-008 needs is
 * visible in the query: an aggregate, no ceiling, the tenant scope, the
 * tombstone filter, and every type reported as a number rather than a hole.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["transaction"];
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

  return { db, calls, results };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
/**
 * Both gates are stubbed with the same admin scope. The roll-ups moved from
 * `requireScopedSession` to `requireFinanceSession` when sec-002 was wired in
 * (a signed-in member could otherwise read every founder's capital), and this
 * file is not where that boundary is proven — tests/lib/queries/
 * finance-reader-gates.test.ts runs the REAL gate against a real `auth()` for
 * that. Here the session is a fixture so the assertions can stay about the
 * aggregate's shape.
 */
const ADMIN_SCOPE = vi.hoisted(() => ({
  userId: "u-1",
  userName: "Ada",
  email: "ada@example.com",
  companyId: "co-1",
  role: "admin",
}));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => ADMIN_SCOPE,
  requireFinanceSession: async () => ADMIN_SCOPE,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

// Namespace import: a named import of a roll-up that does not exist yet is a
// link error that fails the whole file with one message.
import * as txns from "@/lib/queries/transactions";

/** Stand-in for `Prisma.Decimal` (P0-4 Float→Decimal). */
function dec(n: number): unknown {
  return { toNumber: () => n };
}

function callsTo(path: string) {
  return H.calls.filter((c) => c.path === path);
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
});

describe("money-008 — per-person contributions come from an aggregate", () => {
  it("exists at all", () => {
    expect(
      typeof txns.getContributionTotalsByUser,
      "/dashboard's founder-contribution card and /team's per-member cells have no aggregate to read, so both must sum the capped array"
    ).toBe("function");
  });

  it("groups by (addedBy, type) in SQL and reads no rows", async () => {
    H.results.set("transaction.groupBy", () => [
      { addedBy: "u-1", type: "investment", _sum: { amount: dec(500_000) } },
      { addedBy: "u-1", type: "expense", _sum: { amount: dec(12_000) } },
      { addedBy: "u-2", type: "investment", _sum: { amount: dec(250_000) } },
    ]);

    const byUser = await txns.getContributionTotalsByUser();

    const call = callsTo("transaction.groupBy")[0];
    expect(call.args.by).toEqual(["addedBy", "type"]);
    expect(call.args._sum).toEqual({ amount: true });
    expect(
      callsTo("transaction.findMany").length,
      "an aggregate built from findMany is capped, so the figure is wrong past the ceiling — which is the whole of money-008"
    ).toBe(0);
    expect(call.args.take, "a take on an aggregate is an aggregate that is quietly wrong").toBe(
      undefined
    );

    expect(byUser["u-1"].investment).toBe(500_000);
    expect(byUser["u-1"].expense).toBe(12_000);
    expect(byUser["u-2"].investment).toBe(250_000);
  });

  it("reports 0 for a type a person has no rows in, never a hole", async () => {
    H.results.set("transaction.groupBy", () => [
      { addedBy: "u-2", type: "investment", _sum: { amount: dec(250_000) } },
    ]);

    const byUser = await txns.getContributionTotalsByUser();
    // A missing key renders "NaN" through `money()`; a 0 renders "PKR 0".
    expect(byUser["u-2"].expense).toBe(0);
    expect(byUser["u-2"].income).toBe(0);
  });

  it("treats a null _sum as 0 rather than NaN", async () => {
    H.results.set("transaction.groupBy", () => [
      { addedBy: "u-3", type: "expense", _sum: { amount: null } },
    ]);
    const byUser = await txns.getContributionTotalsByUser();
    expect(byUser["u-3"].expense).toBe(0);
  });

  it("scopes to the company and excludes tombstoned rows", async () => {
    H.results.set("transaction.groupBy", () => []);
    await txns.getContributionTotalsByUser();

    const where = callsTo("transaction.groupBy")[0].args.where as Record<string, unknown>;
    expect(where.companyId).toBe("co-1");
    expect(where.deletedAt).toBeNull();
  });

  it("pushes an optional date window into SQL as a half-open range", async () => {
    H.results.set("transaction.groupBy", () => []);
    const from = new Date("2026-09-01T00:00:00.000Z");
    const to = new Date("2026-10-01T00:00:00.000Z");
    await txns.getContributionTotalsByUser({ from, to });

    const where = callsTo("transaction.groupBy")[0].args.where as Record<string, unknown>;
    expect(where.date, "an inclusive end double-counts the boundary day").toEqual({
      gte: from,
      lt: to,
    });
  });

  it("skips a type outside the enum instead of throwing on a finance page", async () => {
    H.results.set("transaction.groupBy", () => [
      { addedBy: "u-1", type: "refund", _sum: { amount: dec(99) } },
      { addedBy: "u-1", type: "expense", _sum: { amount: dec(1) } },
    ]);
    const byUser = await txns.getContributionTotalsByUser();
    expect(byUser["u-1"].expense).toBe(1);
    expect((byUser["u-1"] as unknown as Record<string, number>).refund).toBe(undefined);
  });

  it("returns an empty map for a workspace with no ledger, not undefined", async () => {
    H.results.set("transaction.groupBy", () => []);
    const byUser = await txns.getContributionTotalsByUser();
    expect(byUser).toEqual({});
  });
});
