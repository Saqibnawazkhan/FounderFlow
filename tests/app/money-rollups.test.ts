/**
 * Every money figure on /dashboard and /expenses comes from an AGGREGATE, not
 * from the row array the page happens to have been handed (money-008).
 *
 * THE DEFECT SHAPE. `getTransactions()` is a windowed LIST read, capped at
 * `MAX_TRANSACTIONS_PER_TYPE` (5,000 per type) and its own docstring says "DO
 * NOT SUM THE RESULT". Both client pages did exactly that — `transactions
 * .filter(...).reduce(...)` for the Balance card, the This-month card, the
 * cash-flow chart, the category pie and the per-founder contributions. Past the
 * ceiling those figures silently shrink, and the rows a ceiling drops are the
 * OLDEST, so the first number to go wrong is the founder's seed investment: the
 * person whose capital started the company is the one whose contribution
 * quietly disappears as the workspace grows.
 *
 * This is the same defect the dashboard's task KPI had (19bd7e7: `tasks.length`
 * over a 300-row window, replaced by `getTaskStatusCounts()`), and the same one
 * /reports' "Net Balance" had (money-010: a six-month flow labelled as a
 * balance). It has now cost this repo six bugs.
 *
 * WHY THE ROLL-UPS WERE NOT ALREADY WIRED. lib/queries/transactions.ts already
 * exports `getTransactionTotals`, `getMonthlyTotals`,
 * `getExpenseTotalsByCategory`, `getMonthToDateExpense` and
 * `getContributionTotalsByUser`, each unbounded, each unit-tested — and until
 * this change **not one of them had a single caller**. Correct, unreachable code
 * is this repo's most repeated defect (generateMetadata's scoped query,
 * `getDeactivatedUsers`, six server actions unreachable from the UI). A roll-up
 * nobody calls fixes nothing, so the last assertion block here is about the two
 * page.tsx files that must call them.
 *
 * TZ: pinned by `npm test` to America/Bogota. It matters here because the
 * month-to-date fallback buckets in UTC (lib/date-range.ts, money-007) and under
 * TZ=UTC a local/UTC mix-up would be invisible.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

// /expenses' client imports the transaction + comment server actions (through
// its form, its CSV modal and the comment thread), and those pull `lib/auth` and
// therefore `next-auth`, which cannot resolve `next/server` under vitest. The
// functions under test are pure and touch none of it, so the action modules are
// stubbed at the module boundary rather than the page being split up to suit a
// test runner.
vi.mock("@/lib/actions/transactions", () => ({
  addTransactionAction: vi.fn(),
  bulkImportTransactionsAction: vi.fn(),
  deleteTransactionAction: vi.fn(),
}));
vi.mock("@/lib/actions/comments", () => ({
  listCommentsAction: vi.fn(),
  addCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));
import type { Transaction, User } from "@/lib/types";
import type { TransactionTotals } from "@/lib/queries/transactions";
import {
  burnWindowExpense,
  cashFlowSeries,
  expenseCategorySlices,
  founderContributionRows,
  ledgerTotals,
  monthToDateExpense,
  type DashboardRollups,
} from "@/app/(app)/dashboard/dashboard-client";
import {
  expenseCategoryRows,
  expenseHeadline,
  type ExpenseRollups,
} from "@/app/(app)/expenses/expenses-client";

/** Mid-month, so "this month" is unambiguous in both calendars. */
const NOW = new Date("2026-09-15T12:00:00.000Z");

function txn(over: Partial<Transaction> & { amount: number }): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    companyId: "c1",
    type: "expense",
    category: "Salaries",
    description: "",
    date: "2026-09-10T00:00:00.000Z",
    addedBy: "u1",
    addedByName: "Saqib",
    createdAt: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

function user(id: string, name: string, role: User["role"] = "cofounder"): User {
  return {
    id,
    name,
    email: `${id}@example.com`,
    password: "",
    role,
    companyId: "c1",
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

function totals(over: {
  expense?: [number, number];
  income?: [number, number];
  investment?: [number, number];
}): TransactionTotals {
  const pair = (p: [number, number] | undefined) => ({
    total: p ? p[0] : 0,
    count: p ? p[1] : 0,
  });
  const byType = {
    expense: pair(over.expense),
    income: pair(over.income),
    investment: pair(over.investment),
  };
  return {
    byType,
    balance: byType.investment.total + byType.income.total - byType.expense.total,
    rowCount: byType.expense.count + byType.income.count + byType.investment.count,
  };
}

/**
 * The truncated list a capped read hands the page, alongside roll-ups that know
 * about rows the list does not contain. Every "prefers the roll-up" case below
 * is this pair: if a figure comes out of the array it is visibly, provably
 * short.
 */
const TRUNCATED: Transaction[] = [
  txn({ type: "expense", amount: 100, date: "2026-09-10T00:00:00.000Z", category: "Salaries" }),
  txn({ type: "investment", amount: 200, date: "2026-09-02T00:00:00.000Z", addedBy: "u1" }),
];

const ROLLUPS: DashboardRollups = {
  // 5,000 expense rows totalling 900,000 and a 10,000,000 seed the list dropped.
  totals: totals({ expense: [900_000, 5000], investment: [10_000_000, 12], income: [50_000, 3] }),
  monthToDateExpense: 75_000,
  burnWindowExpense: 210_000,
  monthly: [
    { month: "Apr", monthStart: "2026-04-01T00:00:00.000Z", expense: 1, income: 2, investment: 3 },
    { month: "May", monthStart: "2026-05-01T00:00:00.000Z", expense: 4, income: 5, investment: 6 },
    { month: "Jun", monthStart: "2026-06-01T00:00:00.000Z", expense: 7, income: 8, investment: 9 },
    {
      month: "Jul",
      monthStart: "2026-07-01T00:00:00.000Z",
      expense: 10,
      income: 11,
      investment: 12,
    },
    {
      month: "Aug",
      monthStart: "2026-08-01T00:00:00.000Z",
      expense: 13,
      income: 14,
      investment: 15,
    },
    {
      month: "Sep",
      monthStart: "2026-09-01T00:00:00.000Z",
      expense: 16,
      income: 17,
      investment: 18,
    },
  ],
  categories: [
    { category: "Salaries", amount: 600_000 },
    { category: "Marketing", amount: 300_000 },
  ],
  contributions: {
    u1: { expense: 900_000, income: 50_000, investment: 4_000_000 },
    u2: { expense: 0, income: 0, investment: 6_000_000 },
  },
};

/* ─────────────────────────── the timezone pin ───────────────────────────── */

describe("the test's own timezone", () => {
  it("is west of UTC, or the month-to-date fallback case proves nothing", () => {
    expect(NOW.getTimezoneOffset()).toBe(300);
  });
});

/* ───────────────────────── /dashboard money figures ─────────────────────── */

describe("ledgerTotals (money-008)", () => {
  it("reads the Balance card from the roll-up, not from the capped list", () => {
    const t = ledgerTotals(TRUNCATED, ROLLUPS);
    expect(t.investments).toBe(10_000_000);
    expect(t.revenue).toBe(50_000);
    expect(t.expenses).toBe(900_000);
    // Cash in (capital + revenue) − cash out: the definition /reports'
    // "Cash balance (all time)" row uses, so the two surfaces cannot drift.
    expect(t.balance).toBe(10_000_000 + 50_000 - 900_000);
  });

  it("reproduces what summing the list gave: a balance short by the dropped rows", () => {
    // The old code, exactly: filter + reduce over `transactions`.
    const fromList = ledgerTotals(TRUNCATED);
    expect(fromList.balance).toBe(100); // 200 invested − 100 spent
    expect(ledgerTotals(TRUNCATED, ROLLUPS).balance).toBeGreaterThan(fromList.balance);
  });

  it("still computes from the list when no roll-up is supplied", () => {
    const t = ledgerTotals(TRUNCATED);
    expect(t.investments).toBe(200);
    expect(t.expenses).toBe(100);
  });
});

describe("monthToDateExpense (money-008 + money-007)", () => {
  it("prefers the roll-up's month-to-date figure", () => {
    expect(monthToDateExpense(TRUNCATED, NOW, ROLLUPS)).toBe(75_000);
  });

  it("falls back to the UTC calendar month, not the local one", () => {
    // 2026-09-01T00:00Z is September in UTC and August 31st in Bogota. A local
    // boundary drops it; the shared UTC boundary keeps it (money-007).
    const firstOfMonth = txn({ type: "expense", amount: 40, date: "2026-09-01T00:00:00.000Z" });
    const lastMonth = txn({ type: "expense", amount: 900, date: "2026-08-20T00:00:00.000Z" });
    expect(monthToDateExpense([...TRUNCATED, firstOfMonth, lastMonth], NOW)).toBe(140);
  });
});

describe("burnWindowExpense (money-008)", () => {
  it("prefers the roll-up over the rolling-window sum of the list", () => {
    expect(burnWindowExpense(TRUNCATED, NOW, ROLLUPS)).toBe(210_000);
  });

  it("falls back to a rolling three-month window, excluding older rows", () => {
    const inside = txn({ type: "expense", amount: 30, date: "2026-08-01T00:00:00.000Z" });
    const outside = txn({ type: "expense", amount: 5_000, date: "2026-01-01T00:00:00.000Z" });
    expect(burnWindowExpense([...TRUNCATED, inside, outside], NOW)).toBe(130);
  });
});

describe("cashFlowSeries (money-008 + money-007)", () => {
  it("uses the roll-up's six UTC buckets, oldest first, with its own labels", () => {
    const series = cashFlowSeries(TRUNCATED, NOW, ROLLUPS);
    expect(series.map((b) => b.month)).toEqual(["Apr", "May", "Jun", "Jul", "Aug", "Sep"]);
    expect(series[5]).toEqual({ month: "Sep", expenses: 16, revenue: 17, investments: 18 });
  });

  it("falls back to six UTC buckets built from the list", () => {
    const series = cashFlowSeries(TRUNCATED, NOW);
    expect(series).toHaveLength(6);
    expect(series[5].month).toBe("Sep");
    // The two September rows in TRUNCATED, in the right buckets.
    expect(series[5].expenses).toBe(100);
    expect(series[5].investments).toBe(200);
  });

  it("files a row dated the 1st in that month and not the previous one", () => {
    const first = txn({ type: "expense", amount: 7, date: "2026-09-01T00:00:00.000Z" });
    const series = cashFlowSeries([first], NOW);
    expect(series[5].expenses).toBe(7);
    expect(series[4].expenses).toBe(0);
  });
});

describe("expenseCategorySlices (money-008)", () => {
  it("prefers the roll-up, whose categories the capped list no longer contains", () => {
    const slices = expenseCategorySlices(TRUNCATED, ROLLUPS);
    expect(slices).toEqual([
      { name: "Salaries", value: 600_000 },
      { name: "Marketing", value: 300_000 },
    ]);
  });

  it("keeps the six-slice cap so the pie stays readable", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      category: `cat${i}`,
      amount: 100 - i,
    }));
    expect(expenseCategorySlices([], { ...ROLLUPS, categories: many })).toHaveLength(6);
  });

  it("falls back to the list, biggest first", () => {
    const rows = [
      txn({ type: "expense", amount: 10, category: "Marketing" }),
      txn({ type: "expense", amount: 90, category: "Salaries" }),
      txn({ type: "investment", amount: 999, category: "Seed" }),
    ];
    expect(expenseCategorySlices(rows)).toEqual([
      { name: "Salaries", value: 90 },
      { name: "Marketing", value: 10 },
    ]);
  });
});

describe("founderContributionRows (money-008, the sharpest case)", () => {
  const users = [user("u1", "Saqib Nawaz", "admin"), user("u2", "Ayesha Khan")];

  it("reads each person's capital from the roll-up", () => {
    const rows = founderContributionRows(users, TRUNCATED, ROLLUPS);
    expect(rows).toEqual([
      { name: "Ayesha Khan", amount: 6_000_000, role: "cofounder" },
      { name: "Saqib Nawaz", amount: 4_000_000, role: "admin" },
    ]);
  });

  it("reproduces the bug it replaces: the list knows about one founder only", () => {
    // The dropped rows are the oldest, i.e. the seed. Over the list, the founder
    // who put in 6,000,000 has no bar at all and the other one's is 200.
    const fromList = founderContributionRows(users, TRUNCATED);
    expect(fromList).toEqual([{ name: "Saqib Nawaz", amount: 200, role: "admin" }]);
  });

  it("hides a member who has invested nothing, from either source", () => {
    const rows = founderContributionRows(users, [], {
      ...ROLLUPS,
      contributions: { u1: { expense: 5, income: 0, investment: 0 } },
    });
    expect(rows).toEqual([]);
  });
});

/* ───────────────────────── /expenses money figures ─────────────────────── */

const EXPENSE_ROLLUPS: ExpenseRollups = {
  expense: { total: 900_000, count: 5000 },
  monthToDateExpense: 75_000,
  categories: [
    { category: "Salaries", amount: 600_000 },
    { category: "Marketing", amount: 300_000 },
  ],
};

describe("expenseHeadline (money-008)", () => {
  const listed = [
    txn({ type: "expense", amount: 100, date: "2026-09-10T00:00:00.000Z" }),
    txn({ type: "expense", amount: 300, date: "2026-07-10T00:00:00.000Z" }),
  ];

  it("reads Total spend, the row count and This month from the roll-up", () => {
    const h = expenseHeadline(listed, NOW, EXPENSE_ROLLUPS);
    expect(h.total).toBe(900_000);
    expect(h.count).toBe(5000);
    expect(h.thisMonth).toBe(75_000);
  });

  it("averages over the aggregate count, not the length of the visible page", () => {
    // 900,000 / 5,000 = 180. Over the list it would be 400/2 = 200 — an average
    // computed from one numerator and a different denominator.
    const h = expenseHeadline(listed, NOW, EXPENSE_ROLLUPS);
    expect(h.average).toBe(180);
  });

  it("does not pre-round the average (money-001)", () => {
    const h = expenseHeadline(listed, NOW, {
      ...EXPENSE_ROLLUPS,
      expense: { total: 1.5, count: 3 },
    });
    expect(h.average).toBeCloseTo(0.5, 10);
  });

  it("does not divide by zero on an empty ledger", () => {
    const h = expenseHeadline([], NOW, { ...EXPENSE_ROLLUPS, expense: { total: 0, count: 0 } });
    expect(h.average).toBe(0);
    expect(h.total).toBe(0);
  });

  it("falls back to the list, bucketing This month in UTC", () => {
    const firstOfMonth = txn({ type: "expense", amount: 40, date: "2026-09-01T00:00:00.000Z" });
    const h = expenseHeadline([...listed, firstOfMonth], NOW);
    expect(h.total).toBe(440);
    expect(h.count).toBe(3);
    expect(h.thisMonth).toBe(140);
  });
});

describe("expenseCategoryRows (money-008)", () => {
  it("prefers the roll-up", () => {
    expect(expenseCategoryRows([], EXPENSE_ROLLUPS)).toEqual(EXPENSE_ROLLUPS.categories);
  });

  it("falls back to the list, biggest first", () => {
    const rows = [
      txn({ type: "expense", amount: 10, category: "Marketing" }),
      txn({ type: "expense", amount: 90, category: "Salaries" }),
    ];
    expect(expenseCategoryRows(rows)).toEqual([
      { category: "Salaries", amount: 90 },
      { category: "Marketing", amount: 10 },
    ]);
  });
});

/* ──────────────────── the half that lives in the pages ──────────────────── */

/**
 * A roll-up with no caller is not a fix.
 *
 * The two client components above now PREFER an aggregate and fall back to the
 * array, so they are correct under either wiring — which means nothing at all
 * until the Server Component actually fetches the aggregate and passes it. The
 * fallback is the compatibility shim that let this land in a shared tree without
 * a red typecheck, not the destination.
 *
 * These two assertions are the handover. They fail until the two page.tsx files
 * (owned by the orchestrator, not by a09) call the roll-ups and pass them down.
 * The exact patch is in a09's report under `needsOtherFiles`. Do not delete
 * these to go green; that is how `getTransactionTotals` came to exist for a
 * whole wave with no caller in the first place.
 */
describe("the Server Components pass the roll-ups down", () => {
  const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  it("/dashboard fetches the aggregates and hands DashboardClient a `rollups` prop", () => {
    const code = source("app", "(app)", "dashboard", "page.tsx");
    expect(code).toContain("getTransactionTotals");
    expect(code).toContain("getMonthlyTotals");
    expect(code).toContain("getContributionTotalsByUser");
    expect(code).toMatch(/rollups=\{/);
  });

  it("/expenses fetches the aggregates and hands ExpensesClient a `rollups` prop", () => {
    const code = source("app", "(app)", "expenses", "page.tsx");
    expect(code).toContain("getTransactionTotals");
    expect(code).toContain("getExpenseTotalsByCategory");
    expect(code).toMatch(/rollups=\{/);
  });
});
