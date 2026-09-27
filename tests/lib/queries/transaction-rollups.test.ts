/**
 * money-008 (filed a second time as transactions-ledger-001): past 5,000
 * transactions every money figure in the product silently understated, and
 * nothing on screen or in a log said a row had been dropped.
 *
 * THE MECHANISM. `getTransactions()` was `findMany({ orderBy: { date: "desc" },
 * take: 5000 })` with NO type filter, and all seven consumers — /dashboard,
 * /expenses, /revenue, /investments, /reports, /team and the chat runway card —
 * filtered and SUMMED that one capped array client-side. Two consequences, and
 * the second is worse than the ceiling itself:
 *
 *   • The rows dropped are the OLDEST, which for a startup are the seed
 *     investments. `balance = investments + revenue − expenses` therefore loses
 *     money-IN first: balance and runway both fall, with no error and no banner,
 *     exactly when the account has grown valuable enough to matter.
 *   • The cap was taken across ALL THREE TYPES AT ONCE. A workspace whose 5,000
 *     newest rows are expenses renders /revenue as literally empty — "No revenue
 *     yet" — while its income rows sit untouched in the table.
 *     `bulkImportTransactionsAction` accepts 1,000 rows per import, so five
 *     imports reach the ceiling.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS THE QUESTION ASKED RATHER THAN THE ROWS
 * RETURNED. There is no database in vitest, so no test here can sum real rows.
 * But every property money-008 needs is a property of the QUERY:
 *
 *   1. A page-sized read is per TYPE, so no type can be starved by another's
 *      volume. This is the /revenue-is-empty bug, and it is visible in the
 *      `where` of each findMany.
 *   2. Type and date window are pushed into SQL, so a page stops paying for
 *      other pages' rows.
 *   3. Every ROLL-UP reaches for `groupBy`/`aggregate` and NEVER `findMany`.
 *      That is the whole fix for the understatement: an aggregate has no `take`,
 *      so no row above any ceiling can be excluded from a total.
 *   4. Hitting the ceiling emits a warning. "No log line" was half the finding.
 *
 * The cheap version of this file would assert that `getTransactions()` returns
 * rows. It did that before too — that is precisely why the bug shipped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { startOfUtcMonth, utcMonthShortLabel } from "@/lib/date-range";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  /** "model.op" → canned value, or a function of the call args. */
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

  const captureMessage = vi.fn();
  return { db, calls, results, captureMessage, session: { value: null as unknown } };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
// Sentry is the ceiling's only voice, so it is recorded rather than stubbed
// silent. Mocked at all because @sentry/nextjs pulls a browser/server runtime
// into a jsdom test for no benefit here.
vi.mock("@sentry/nextjs", () => ({ captureMessage: H.captureMessage }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

/**
 * NAMESPACE import on purpose. A named `import { getTransactionTotals }` of an
 * export that does not exist yet is a LINK error, which fails the whole file
 * with one message and hides which behaviours are missing. Through a namespace
 * each absent roll-up fails its own test ("not a function") and the
 * `getTransactions` cases below still run against the shipped code — so the
 * first, pre-fix run reports the bug per property.
 */
import * as txns from "@/lib/queries/transactions";

/** Stand-in for `Prisma.Decimal` (P0-4 Float→Decimal). */
function money(n: number): unknown {
  return { toNumber: () => n };
}

function row(id: string, type: string, amount: number, date: string): unknown {
  return {
    id,
    companyId: "c1",
    type,
    amount: money(amount),
    category: "Misc",
    description: id,
    date: new Date(date),
    addedBy: "u1",
    addedByName: "Ada",
    createdAt: new Date(date),
    _count: { comments: 0 },
  };
}

function callsTo(path: string): Array<Record<string, unknown>> {
  return H.calls.filter((c) => c.path === path).map((c) => c.args);
}

function whereOf(args: Record<string, unknown>): Record<string, unknown> {
  return (args.where ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.captureMessage.mockClear();
  H.session.value = { user: { id: "u1", companyId: "c1", role: "admin", name: "Ada" } };
});

describe("getTransactions() — the page-sized read (money-008)", () => {
  it("asks for each type separately, so no type can be starved by another's volume", async () => {
    H.results.set("transaction.findMany", (args: Record<string, unknown>) => {
      const type = whereOf(args).type;
      return type === "income" ? [row("i1", "income", 500, "2026-01-02T00:00:00.000Z")] : [];
    });

    const rows = await txns.getTransactions();

    // One read per type, each naming its own type in SQL. The single untyped
    // read this replaces is the /revenue-renders-empty bug.
    const types = callsTo("transaction.findMany").map((a) => whereOf(a).type);
    expect(types.slice().sort()).toEqual(["expense", "income", "investment"]);
    // The one income row survives even though the expense window is full.
    expect(rows.map((r) => r.id)).toEqual(["i1"]);
  });

  it("caps each type's window rather than the three together", async () => {
    await txns.getTransactions();
    const takes = callsTo("transaction.findMany").map((a) => a.take);
    expect(takes.length).toBe(3);
    for (const take of takes) {
      expect(take).toBe(txns.MAX_TRANSACTIONS_PER_TYPE);
    }
  });

  it("returns the merged pages in date order, newest first", async () => {
    H.results.set("transaction.findMany", (args: Record<string, unknown>) => {
      const type = whereOf(args).type;
      if (type === "expense") {
        return [
          row("e-new", "expense", 10, "2026-03-10T00:00:00.000Z"),
          row("e-old", "expense", 10, "2026-01-01T00:00:00.000Z"),
        ];
      }
      if (type === "income") return [row("i-mid", "income", 10, "2026-02-01T00:00:00.000Z")];
      return [row("v-oldest", "investment", 10, "2025-12-31T00:00:00.000Z")];
    });

    const rows = await txns.getTransactions();
    expect(rows.map((r) => r.id)).toEqual(["e-new", "i-mid", "e-old", "v-oldest"]);
  });

  it("pushes a single type into SQL instead of filtering client-side", async () => {
    await txns.getTransactions({ type: "income" });
    const reads = callsTo("transaction.findMany");
    expect(reads.length).toBe(1);
    expect(whereOf(reads[0]).type).toBe("income");
  });

  it("pushes the date window into SQL as a half-open interval", async () => {
    const from = new Date("2026-09-01T00:00:00.000Z");
    const to = new Date("2026-10-01T00:00:00.000Z");
    await txns.getTransactions({ type: "expense", from, to });
    const where = whereOf(callsTo("transaction.findMany")[0]);
    expect(where.date).toEqual({ gte: from, lt: to });
  });

  it("clamps a caller's take to the ceiling", async () => {
    await txns.getTransactions({ type: "expense", take: 10_000_000 });
    expect(callsTo("transaction.findMany")[0].take).toBe(txns.MAX_TRANSACTIONS_PER_TYPE);
  });

  it("scopes every read by company and tombstone", async () => {
    await txns.getTransactions();
    for (const args of callsTo("transaction.findMany")) {
      expect(whereOf(args).companyId).toBe("c1");
      expect(whereOf(args).deletedAt).toBeNull();
    }
  });

  it("says something when a window fills up — the ceiling used to be silent", async () => {
    const full: unknown[] = [];
    for (let i = 0; i < txns.MAX_TRANSACTIONS_PER_TYPE; i++) {
      full.push(row(`e${i}`, "expense", 1, "2026-01-01T00:00:00.000Z"));
    }
    H.results.set("transaction.findMany", (args: Record<string, unknown>) =>
      whereOf(args).type === "expense" ? full : []
    );

    await txns.getTransactions();

    expect(H.captureMessage).toHaveBeenCalled();
    const [message, options] = H.captureMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("expense");
    expect((options.tags as Record<string, string>).boundary).toBe("read-ceiling");
  });

  it("stays quiet below the ceiling", async () => {
    H.results.set("transaction.findMany", [row("e1", "expense", 1, "2026-01-01T00:00:00.000Z")]);
    await txns.getTransactions();
    expect(H.captureMessage).not.toHaveBeenCalled();
  });
});

describe("getTransactionTotals() — the roll-up no ceiling can reach (money-008)", () => {
  beforeEach(() => {
    H.results.set("transaction.groupBy", [
      { type: "expense", _sum: { amount: money(300) }, _count: { _all: 12 } },
      { type: "income", _sum: { amount: money(500) }, _count: { _all: 3 } },
      { type: "investment", _sum: { amount: money(1000) }, _count: { _all: 1 } },
    ]);
  });

  it("never reads rows — an aggregate has no take, so nothing can be dropped", async () => {
    await txns.getTransactionTotals();
    expect(callsTo("transaction.findMany").length).toBe(0);
    expect(callsTo("transaction.groupBy").length).toBe(1);
  });

  it("returns the whole ledger's sums and counts per type", async () => {
    const totals = await txns.getTransactionTotals();
    expect(totals.byType.expense.total).toBe(300);
    expect(totals.byType.income.total).toBe(500);
    expect(totals.byType.investment.total).toBe(1000);
    expect(totals.byType.expense.count).toBe(12);
    expect(totals.rowCount).toBe(16);
  });

  it("computes balance the way the dashboard card defines it", async () => {
    // investments + revenue − expenses. This is the figure that silently fell
    // as a workspace grew, because the oldest rows dropped first and the oldest
    // rows are the money IN.
    const totals = await txns.getTransactionTotals();
    expect(totals.balance).toBe(1000 + 500 - 300);
  });

  it("reports zero for a type with no rows instead of leaving it undefined", async () => {
    H.results.set("transaction.groupBy", [
      { type: "expense", _sum: { amount: money(300) }, _count: { _all: 2 } },
    ]);
    const totals = await txns.getTransactionTotals();
    expect(totals.byType.income.total).toBe(0);
    expect(totals.byType.income.count).toBe(0);
    expect(totals.balance).toBe(-300);
  });

  it("accepts a window and pushes it into SQL half-open", async () => {
    const from = startOfUtcMonth(new Date());
    const to = startOfUtcMonth(new Date(), 1);
    await txns.getTransactionTotals({ from, to });
    const where = whereOf(callsTo("transaction.groupBy")[0]);
    expect(where.date).toEqual({ gte: from, lt: to });
    expect(where.companyId).toBe("c1");
    expect(where.deletedAt).toBeNull();
  });
});

describe("getMonthlyTotals() — the cash-flow series (money-008 + money-007)", () => {
  it("buckets in UTC, oldest first, one abutting window per month", async () => {
    const ref = new Date("2026-10-14T12:00:00.000Z");
    H.results.set("transaction.groupBy", []);

    const series = await txns.getMonthlyTotals(6, ref);

    expect(series.length).toBe(6);
    expect(series[0].monthStart).toBe("2026-05-01T00:00:00.000Z");
    expect(series[5].monthStart).toBe("2026-10-01T00:00:00.000Z");
    // Labelled in UTC: `format(monthStart, "MMM")` would print "Sep" for the
    // October bucket west of UTC (money-007).
    expect(series[5].month).toBe(utcMonthShortLabel(startOfUtcMonth(ref)));
    expect(series[5].month).toBe("Oct");

    const windows = callsTo("transaction.groupBy").map(
      (a) => whereOf(a).date as { gte: Date; lt: Date }
    );
    expect(windows.length).toBe(6);
    for (let i = 0; i < windows.length - 1; i++) {
      expect(windows[i].lt.toISOString()).toBe(windows[i + 1].gte.toISOString());
    }
  });

  it("sums each month in SQL rather than from a capped array", async () => {
    const ref = new Date("2026-10-14T12:00:00.000Z");
    H.results.set("transaction.groupBy", (args: Record<string, unknown>) => {
      const date = whereOf(args).date as { gte: Date };
      // Only October has rows.
      if (date.gte.toISOString() !== "2026-10-01T00:00:00.000Z") return [];
      return [
        { type: "expense", _sum: { amount: money(40) }, _count: { _all: 2 } },
        { type: "income", _sum: { amount: money(90) }, _count: { _all: 1 } },
      ];
    });

    const series = await txns.getMonthlyTotals(6, ref);
    expect(callsTo("transaction.findMany").length).toBe(0);
    expect(series[5].expense).toBe(40);
    expect(series[5].income).toBe(90);
    expect(series[5].investment).toBe(0);
    expect(series[0].expense).toBe(0);
  });
});

describe("getExpenseTotalsByCategory() — the breakdown charts (money-008)", () => {
  it("groups by category in SQL, biggest first, expenses only", async () => {
    H.results.set("transaction.groupBy", [
      { category: "Tools", _sum: { amount: money(50) } },
      { category: "Office Rent", _sum: { amount: money(900) } },
    ]);

    const rows = await txns.getExpenseTotalsByCategory();

    expect(callsTo("transaction.findMany").length).toBe(0);
    const where = whereOf(callsTo("transaction.groupBy")[0]);
    expect(where.type).toBe("expense");
    expect(where.companyId).toBe("c1");
    expect(where.deletedAt).toBeNull();
    expect(rows).toEqual([
      { category: "Office Rent", amount: 900 },
      { category: "Tools", amount: 50 },
    ]);
  });
});
