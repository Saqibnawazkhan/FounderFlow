/**
 * /reports money correctness: the period window, the export labels and the
 * founder breakdown. Findings money-007, money-010, rep-004 (plus the residual
 * money-001 rounding on /expenses' average card).
 *
 * WHY THE TZ ASSERTION IS FIRST — the same reason
 * tests/lib/queries/month-boundary.test.ts opens that way. Under TZ=UTC the
 * local and UTC month boundaries coincide and every money-007 case below is
 * vacuous: the file goes green without testing anything. This repo has already
 * shipped date tests made vacuous exactly that way, which is why `npm test`
 * pins TZ=America/Bogota (UTC-5, no DST). Run this file as:
 *
 *     npx cross-env TZ=America/Bogota vitest run tests/app/reports/reports-period.test.ts
 *
 * THE THREE DEFECTS THIS ENCODES.
 *
 *  1. money-007. /dashboard and /expenses were moved onto the shared UTC
 *     boundary in lib/date-range.ts; /reports was not. It kept date-fns
 *     `startOfMonth` / `endOfMonth` / `eachMonthOfInterval` / `subMonths`,
 *     which all work in the RUNTIME's local calendar. `Transaction.date` is a
 *     date-only value stored at UTC midnight, so in Bogota a row the customer
 *     dated "October 1st" sat at 2026-10-01T00:00Z while local start-of-October
 *     was 2026-10-01T05:00Z — the row fell in the SEPTEMBER bucket on the
 *     cash-flow chart and dropped out of a "last 6 months" window whose first
 *     month it should have opened. /budgets counted the same row in October.
 *
 *  2. money-010. Both exporters printed `["Net Balance", money(inv + rev -
 *     exp)]` where all three sums are WINDOWED by the period picker, which
 *     defaults to 6 months. A company that raised its seed eight months ago
 *     exported an "investor-ready" PDF whose "Net Balance" excluded the raise
 *     and could be deeply negative. "Net Balance" has one meaning to a reader —
 *     the cash the company holds, the number /dashboard prints on its Balance
 *     card — so the windowed figure needs a different name AND the real balance
 *     needs a row of its own.
 *
 *  3. rep-004. Every per-person row iterated `users`, which is
 *     getCompanyUsers() and filters `deletedAt: null`. Deactivating a co-founder
 *     (lib/actions/team.ts stamps the tombstone and deliberately leaves their
 *     transactions in the records) therefore deleted their ROW while leaving
 *     their capital in `totalInvestments` — so the "% of capital" column, the
 *     closest thing this product has to a cap table, silently stopped summing
 *     to 100% at the exact moment someone would generate the report.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Transaction, User } from "@/lib/types";
import {
  contributorRows,
  monthBuckets,
  reportWindow,
  summaryFigures,
} from "@/app/(app)/reports/reports-client";
import { formatUtcDate, formatUtcDay, formatUtcMonthYear } from "@/lib/utils";

/** Mid-October, so "this month" has a real inside and a real outside. */
const NOW = new Date("2026-10-14T12:00:00.000Z");

let seq = 0;
function txn(partial: Partial<Transaction> & { date: string; amount: number }): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    companyId: "c1",
    type: "expense",
    category: "Salaries",
    description: "",
    addedBy: "u1",
    addedByName: "Live One",
    createdAt: partial.date,
    ...partial,
  } as Transaction;
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

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

/** Strip comments, so a comment that NAMES a banned helper isn't a hit.
 *  Lifted from tests/lib/queries/month-boundary.test.ts. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf("//");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

const REPORTS = join("app", "(app)", "reports", "reports-client.tsx");
const EXPENSES = join("app", "(app)", "expenses", "expenses-client.tsx");

describe("the test's own timezone", () => {
  it("is west of UTC, or every money-007 case in this file is vacuous", () => {
    // 300 = UTC-5 = America/Bogota, which has no DST so the offset is constant.
    expect(NOW.getTimezoneOffset()).toBe(300);
  });
});

/* ───────────────────────────── money-007 ────────────────────────────────── */

describe("reportWindow (money-007)", () => {
  const empty: Transaction[] = [];

  it("opens a 6-month preset on the UTC 1st, five months back", () => {
    const w = reportWindow({ mode: "6m", now: NOW, transactions: empty });
    expect(w.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(w.endExclusive.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("includes a row dated the 1st of the window's opening month", () => {
    // The row the date picker stores for "May 1st". date-fns
    // `startOfMonth(subMonths(now, 5))` is 2026-05-01T05:00Z in Bogota, so this
    // row — the first day the customer asked for — fell OUTSIDE the window.
    const w = reportWindow({ mode: "6m", now: NOW, transactions: empty });
    const may1 = new Date("2026-05-01T00:00:00.000Z");
    expect(may1 >= w.start && may1 < w.endExclusive).toBe(true);
  });

  it("reproduces the bug it replaces: the local boundary excluded that row", () => {
    // Exactly what date-fns computed. This assertion IS the defect, written down.
    const localStart = new Date(NOW.getFullYear(), NOW.getMonth() - 5, 1);
    expect(new Date("2026-05-01T00:00:00.000Z") >= localStart).toBe(false);
  });

  it("is half-open, so the last instant of the final month is in and the next 1st is out", () => {
    const w = reportWindow({ mode: "6m", now: NOW, transactions: empty });
    expect(new Date("2026-10-31T23:59:59.999Z") < w.endExclusive).toBe(true);
    expect(new Date("2026-11-01T00:00:00.000Z") < w.endExclusive).toBe(false);
  });

  it("sizes 3m and 1y presets the same way", () => {
    expect(reportWindow({ mode: "3m", now: NOW, transactions: empty }).start.toISOString()).toBe(
      "2026-08-01T00:00:00.000Z"
    );
    expect(reportWindow({ mode: "1y", now: NOW, transactions: empty }).start.toISOString()).toBe(
      "2025-11-01T00:00:00.000Z"
    );
  });

  it("opens 'all time' on the UTC month of the earliest row", () => {
    const w = reportWindow({
      mode: "all",
      now: NOW,
      transactions: [txn({ date: "2024-03-01T00:00:00.000Z", amount: 1 })],
    });
    expect(w.start.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(w.endExclusive.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reads a custom from/to as whole UTC days, both ends inclusive", () => {
    const w = reportWindow({
      mode: "custom",
      now: NOW,
      customFrom: "2026-09-10",
      customTo: "2026-09-12",
      transactions: empty,
    });
    expect(w.start.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    // endExclusive = the day AFTER the "to" day, so a row dated the 12th counts.
    expect(w.endExclusive.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    const sep12 = new Date("2026-09-12T00:00:00.000Z");
    expect(sep12 >= w.start && sep12 < w.endExclusive).toBe(true);
  });

  it("forgives a reversed custom range instead of showing nothing", () => {
    const w = reportWindow({
      mode: "custom",
      now: NOW,
      customFrom: "2026-09-12",
      customTo: "2026-09-10",
      transactions: empty,
    });
    expect(w.start.toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(w.endExclusive.toISOString()).toBe("2026-09-13T00:00:00.000Z");
  });

  it("falls back to the 6-month window when a custom date is missing or unparseable", () => {
    const six = reportWindow({ mode: "6m", now: NOW, transactions: empty });
    for (const args of [
      { customFrom: "", customTo: "" },
      { customFrom: "2026-09-10", customTo: "" },
      { customFrom: "not-a-date", customTo: "2026-09-10" },
    ]) {
      const w = reportWindow({ mode: "custom", now: NOW, transactions: empty, ...args });
      expect(w.start.toISOString()).toBe(six.start.toISOString());
      expect(w.endExclusive.toISOString()).toBe(six.endExclusive.toISOString());
    }
  });
});

describe("monthBuckets (money-007)", () => {
  const w = {
    start: new Date("2026-05-01T00:00:00.000Z"),
    endExclusive: new Date("2026-11-01T00:00:00.000Z"),
  };

  it("emits one bucket per UTC month spanned, labelled in UTC", () => {
    const buckets = monthBuckets([], w);
    expect(buckets.map((b) => b.month)).toEqual([
      "May 26",
      "Jun 26",
      "Jul 26",
      "Aug 26",
      "Sep 26",
      "Oct 26",
    ]);
  });

  it("files a row dated the 1st in that month, not the previous one", () => {
    const buckets = monthBuckets([txn({ date: "2026-10-01T00:00:00.000Z", amount: 500 })], w);
    const sep = buckets.find((b) => b.month === "Sep 26");
    const oct = buckets.find((b) => b.month === "Oct 26");
    expect(sep?.expenses).toBe(0);
    expect(oct?.expenses).toBe(500);
  });

  it("buckets abut exactly — no row lands in two buckets or in none", () => {
    const rows = [
      txn({ date: "2026-05-01T00:00:00.000Z", amount: 1 }),
      txn({ date: "2026-05-31T23:59:59.999Z", amount: 2 }),
      txn({ date: "2026-06-01T00:00:00.000Z", amount: 4 }),
      txn({ date: "2026-10-31T23:59:59.999Z", amount: 8 }),
    ];
    const buckets = monthBuckets(rows, w);
    const total = buckets.reduce((s, b) => s + b.expenses, 0);
    expect(total).toBe(15);
    expect(buckets.find((b) => b.month === "May 26")?.expenses).toBe(3);
    expect(buckets.find((b) => b.month === "Jun 26")?.expenses).toBe(4);
    expect(buckets.find((b) => b.month === "Oct 26")?.expenses).toBe(8);
  });

  it("nets each month as investments + revenue - expenses", () => {
    const buckets = monthBuckets(
      [
        txn({ date: "2026-07-05T00:00:00.000Z", amount: 100, type: "investment" }),
        txn({ date: "2026-07-06T00:00:00.000Z", amount: 30, type: "income" }),
        txn({ date: "2026-07-07T00:00:00.000Z", amount: 50, type: "expense" }),
      ],
      w
    );
    const jul = buckets.find((b) => b.month === "Jul 26");
    expect(jul).toMatchObject({ investments: 100, revenue: 30, expenses: 50, netFlow: 80 });
  });
});

/* ───────────────────────────── money-010 ────────────────────────────────── */

describe("summaryFigures (money-010)", () => {
  // Seed raised 8 months ago; the default window is 6 months, so the raise is
  // outside it. This is the exact shape of company the finding describes.
  const seed = txn({ date: "2026-02-10T00:00:00.000Z", amount: 5_000_000, type: "investment" });
  const rentA = txn({ date: "2026-09-02T00:00:00.000Z", amount: 300_000, type: "expense" });
  const rentB = txn({ date: "2026-10-02T00:00:00.000Z", amount: 300_000, type: "expense" });
  const sale = txn({ date: "2026-10-03T00:00:00.000Z", amount: 100_000, type: "income" });
  const all = [seed, rentA, rentB, sale];
  const ranged = [rentA, rentB, sale];
  const figures = () => summaryFigures({ ranged, all });
  const labelled = (needle: string) =>
    figures().find((f) => f.label.toLowerCase().includes(needle.toLowerCase()));

  it("does not print a row called 'Net Balance' at all", () => {
    // The word "balance" may only appear on a row that IS the balance, and that
    // row must not be the period net flow. A reader holds the company to this.
    const netBalance = figures().find((f) => f.label.trim().toLowerCase() === "net balance");
    expect(netBalance).toBeUndefined();
  });

  it("names the windowed net figure as a flow over the period", () => {
    const flow = labelled("net flow");
    expect(flow).toBeDefined();
    expect(flow?.label.toLowerCase()).toContain("period");
    // 100,000 revenue - 600,000 expenses, with the out-of-window raise excluded.
    expect(flow?.amount).toBe(-500_000);
  });

  it("carries an all-time cash balance that includes the out-of-window raise", () => {
    const balance = labelled("cash balance");
    expect(balance).toBeDefined();
    // Exactly /dashboard's Balance card: investments + revenue - expenses over
    // EVERY transaction, so the two surfaces cannot disagree.
    expect(balance?.amount).toBe(4_500_000);
    expect(balance?.label.toLowerCase()).toContain("all time");
  });

  it("marks every windowed figure as windowed, so no label stands bare", () => {
    for (const needle of ["investments", "revenue", "expenses", "net flow"]) {
      expect(labelled(needle)?.label.toLowerCase()).toContain("period");
    }
  });

  it("keeps the windowed component sums correct", () => {
    expect(labelled("investments")?.amount).toBe(0);
    expect(labelled("revenue")?.amount).toBe(100_000);
    expect(labelled("expenses")?.amount).toBe(600_000);
  });

  it("puts the cash balance last, after the flows it is not one of", () => {
    const f = figures();
    expect(f[f.length - 1]?.label.toLowerCase()).toContain("cash balance");
  });

  /* ─────────────────────── money-008, on the same row ────────────────────── *
   *
   * The all-time balance closed money-010 by deriving from `all` — the full
   * ledger the page is handed. But that prop is `getTransactions()`, a LIST
   * window capped at `MAX_TRANSACTIONS_PER_TYPE` (5,000 per type) whose own
   * docstring ends "DO NOT SUM THE RESULT". So on a workspace past the ceiling
   * the row labelled "Cash balance (all time)" is not the all-time balance
   * either — it is the balance of the most recent 5,000 rows per type, and the
   * rows a ceiling drops are the OLDEST, which for a startup is the seed. The
   * mislabelled export was the finding; this is the same wrong number arriving
   * by a different route, in the one artefact a customer hands an investor.
   *
   * Unlike the windowed rows, this one CAN come from an aggregate: it does not
   * depend on the client-side period picker. `getTransactionTotals().balance` is
   * exactly this figure with no ceiling.
   */
  it("prefers an unbounded balance from the server over summing the capped list", () => {
    const withRollup = summaryFigures({ ranged, all, allTimeBalance: 92_000_000 });
    const balance = withRollup[withRollup.length - 1];
    expect(balance.label.toLowerCase()).toContain("cash balance");
    expect(balance.amount).toBe(92_000_000);
  });

  it("keeps the windowed rows windowed even when the balance comes from the server", () => {
    // The period figures must NOT follow the all-time number — that would undo
    // money-010 from the other direction.
    const withRollup = summaryFigures({ ranged, all, allTimeBalance: 92_000_000 });
    const flow = withRollup.find((f) => f.label.toLowerCase().includes("net flow"));
    expect(flow?.amount).toBe(-500_000);
  });

  it("still sums the ledger when the server figure is absent", () => {
    expect(summaryFigures({ ranged, all, allTimeBalance: undefined }).pop()?.amount).toBe(
      4_500_000
    );
  });
});

/**
 * `allTimeBalance` reaching `summaryFigures` is only half the fix: the Server
 * Component has to fetch it. This assertion fails until
 * app/(app)/reports/page.tsx calls `getTransactionTotals()` and passes
 * `allTimeBalance` — see a09's report under `needsOtherFiles` for the patch.
 * Deleting this to go green is how `getTransactionTotals` came to exist for a
 * whole wave with no caller at all.
 */
describe("/reports' Server Component supplies the unbounded balance", () => {
  it("fetches the roll-up and passes allTimeBalance", () => {
    const code = source("app", "(app)", "reports", "page.tsx");
    expect(code).toContain("getTransactionTotals");
    expect(code).toMatch(/allTimeBalance=\{/);
  });
});

describe("both exporters state the date range before the figures it qualifies", () => {
  const text = codeOnly(source(REPORTS));

  /** Where the summary figures are laid into a table, in each exporter. */
  const FIGURE_ROWS = "summary.map";

  it("PDF: the 'Date range' row precedes the amount rows", () => {
    const body = text.slice(text.indexOf('doc.text("Financial Summary"'));
    const range = body.indexOf("Date range");
    const figures = body.indexOf(FIGURE_ROWS);
    expect(range).toBeGreaterThan(-1);
    expect(figures).toBeGreaterThan(-1);
    expect(range).toBeLessThan(figures);
  });

  it("Excel: the same, on the Summary sheet", () => {
    const body = text.slice(text.indexOf("const summarySheet"));
    const range = body.indexOf("Date range");
    const figures = body.indexOf(FIGURE_ROWS);
    expect(range).toBeGreaterThan(-1);
    expect(figures).toBeGreaterThan(-1);
    expect(range).toBeLessThan(figures);
  });

  it("neither exporter hardcodes its own net figure any more", () => {
    // `totalInvestments + totalRevenue - totalExpenses` inline in an exporter is
    // how the mislabelled row got written twice. One function, two callers.
    expect(text).not.toMatch(/"Net Balance"/);
  });
});

/* ───────────────────────────── rep-004 ──────────────────────────────────── */

describe("contributorRows (rep-004)", () => {
  const live = [user("u1", "Live One"), user("u2", "Live Two")];
  const rows = [
    txn({
      date: "2026-09-01T00:00:00.000Z",
      amount: 300,
      type: "investment",
      addedBy: "u1",
      addedByName: "Live One",
    }),
    txn({
      date: "2026-09-02T00:00:00.000Z",
      amount: 300,
      type: "investment",
      addedBy: "u2",
      addedByName: "Live Two",
    }),
    // The departed co-founder. removeUserAction stamped User.deletedAt, so
    // getCompanyUsers() no longer returns them — but the transaction stayed,
    // with its denormalised addedByName, and still counts in totalInvestments.
    txn({
      date: "2026-09-03T00:00:00.000Z",
      amount: 400,
      type: "investment",
      addedBy: "u3",
      addedByName: "Departed Founder",
    }),
    txn({
      date: "2026-09-04T00:00:00.000Z",
      amount: 50,
      type: "expense",
      addedBy: "u3",
      addedByName: "Departed Founder",
    }),
  ];
  const breakdown = () => contributorRows(live, rows);

  it("gives the departed contributor a row of their own", () => {
    const departed = breakdown().find((r) => r.id === "u3");
    expect(departed).toBeDefined();
    expect(departed?.name).toBe("Departed Founder");
    expect(departed?.investments).toBe(400);
    expect(departed?.expenses).toBe(50);
  });

  it("flags them as former, so the column is not read as a current member", () => {
    expect(breakdown().find((r) => r.id === "u3")?.former).toBe(true);
    expect(breakdown().find((r) => r.id === "u1")?.former).toBe(false);
  });

  it("reconciles '% of capital' to 100%", () => {
    const sum = breakdown().reduce((s, r) => s + r.capitalRatio, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("accounts for every unit of capital the totals claim", () => {
    const totalInvestments = rows
      .filter((t) => t.type === "investment")
      .reduce((s, t) => s + t.amount, 0);
    const accounted = breakdown().reduce((s, r) => s + r.investments, 0);
    expect(accounted).toBe(totalInvestments);
  });

  it("reproduces the bug it replaces: iterating live users alone loses the capital", () => {
    const liveOnly = live.reduce(
      (s, u) =>
        s +
        rows
          .filter((t) => t.addedBy === u.id && t.type === "investment")
          .reduce((a, t) => a + t.amount, 0),
      0
    );
    expect(liveOnly).toBe(600);
    expect(liveOnly).not.toBe(1000);
  });

  it("lists live members first, former contributors after", () => {
    expect(breakdown().map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("still gives a live member with no transactions a zero row", () => {
    const only = contributorRows([user("u9", "Idle")], []);
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ investments: 0, expenses: 0, capitalRatio: 0, former: false });
  });

  it("does not invent a former row for a contributor with nothing in the window", () => {
    const onlyLive = contributorRows(live, [
      txn({ date: "2026-09-01T00:00:00.000Z", amount: 10, type: "investment", addedBy: "u1" }),
    ]);
    expect(onlyLive.map((r) => r.id)).toEqual(["u1", "u2"]);
  });
});

/* ──────────────── the structural sweep: no local calendar left ──────────── */

describe("/reports no longer carries its own month boundary (money-007)", () => {
  const text = codeOnly(source(REPORTS));

  it("does not reach for date-fns month arithmetic", () => {
    // `startOfUtcMonth` does not match — the \b pins the date-fns spellings.
    const banned =
      /\b(startOfMonth|endOfMonth|subMonths|eachMonthOfInterval|startOfDay|endOfDay)\s*\(/;
    expect(text).not.toMatch(banned);
  });

  it("imports the shared boundary instead", () => {
    expect(source(REPORTS)).toContain('from "@/lib/date-range"');
  });

  it("does not label a bucket or a range edge with the local formatter", () => {
    // date-fns `format(...)` renders a UTC-midnight Date in the viewer's zone,
    // so an October bucket prints "Sep" west of UTC. Dates that ARE wall-clock
    // instants (the "Generated on" stamp, the filename) may still use it.
    expect(text).not.toMatch(/format\s*\(\s*(monthStart|rangeStart|rangeEnd|new Date\(t\.date\))/);
  });
});

/* ───────── the UTC date formatters the exports and the ledger need ──────── */

describe("formatUtcDate / formatUtcDay / formatUtcMonthYear", () => {
  // A date-only value the customer entered as "2026-01-15". Stored at UTC
  // midnight, which is 2026-01-14 19:00 in Bogota — so the LOCAL formatter
  // prints the day before, on every transaction row and in every export.
  const dateOnly = "2026-01-15T00:00:00.000Z";

  it("renders the stored day, not the viewer's", () => {
    expect(formatUtcDate(dateOnly)).toBe("Jan 15, 2026");
  });

  it("renders an ISO day for the spreadsheet", () => {
    expect(formatUtcDay(dateOnly)).toBe("2026-01-15");
  });

  it("renders a short month + 2-digit year for a chart bucket", () => {
    expect(formatUtcMonthYear(new Date("2026-10-01T00:00:00.000Z"))).toBe("Oct 26");
  });

  it("accepts a Date as well as the ISO string the RSC boundary hands over", () => {
    expect(formatUtcDate(new Date(dateOnly))).toBe("Jan 15, 2026");
  });
});

/* ───────── money-001 residual: the average-expense card on /expenses ────── */

describe("/expenses average card does not pre-round money (money-001)", () => {
  it("does not hand Math.round() to the money formatter", () => {
    // `money(Math.round(total / count))` threw the cents away BEFORE the
    // formatter — the same defect money-001 removed from formatCurrency, one
    // call site further out, and now disguised by a trailing ".00". Three 0.50
    // expenses averaged to "PKR 1.00".
    expect(codeOnly(source(EXPENSES))).not.toMatch(/money\(\s*[^)]*Math\.round/);
  });
});
