/**
 * The four finance surfaces money-008 left behind: /revenue, /investments,
 * /team and the chat runway card (transactions-ledger-001).
 *
 * WHAT WAS ALREADY FIXED. `lib/queries/transactions.ts` grew a per-type read
 * ceiling (so /revenue can no longer render empty while income rows exist), a
 * `boundary: read-ceiling` warning, and five unbounded `groupBy` roll-ups.
 * /dashboard, /expenses and /reports were then wired onto them — that half is
 * pinned by tests/app/money-rollups.test.ts.
 *
 * WHAT WAS NOT. Four surfaces still summed `getTransactions()`, a LIST window
 * capped at `MAX_TRANSACTIONS_PER_TYPE` (5,000 per type) whose own docstring
 * ends "DO NOT SUM THE RESULT":
 *
 *   • /revenue      "Total revenue", "Avg / entry", the N-entries caption and
 *                   every category bar.
 *   • /investments  "Total raised", "Avg cheque", the contributor count and the
 *                   per-founder bars.
 *   • /team         each member's "invested / spent" cells.
 *   • chat          the Runway card — cash on hand, monthly burn, runway months,
 *                   frozen into a row that is never recomputed and read by the
 *                   whole channel.
 *
 * Past the ceiling every one of those is short, silently, and a capped read
 * drops the OLDEST rows — which for a startup are the seed investments. So the
 * figure that goes wrong first is the founder's capital, on the three surfaces
 * that exist to display it, and the runway card is a permanent record of the
 * wrong number.
 *
 * Each case below is the same pair: a TRUNCATED list (what the capped read hands
 * the page) alongside roll-ups that know about rows the list does not contain.
 * If a figure comes out of the array it is provably short.
 *
 * ── WHAT THE SECOND ROUND ADDED (the tester's caveats) ──────────────────────
 *
 *   • /team must not FETCH the row window either. Once the cells read the
 *     per-person aggregate, the array had no reader at all — up to 15,000 ledger
 *     rows (every amount, description, category and author name) marshalled into
 *     the RSC payload of every admin who opens /team, for a page that renders
 *     none of them.
 *   • The caller list in lib/queries/transactions.ts is now DERIVED from source
 *     rather than remembered. Its predecessor stated that /team and the chat
 *     runway card "still ALSO call getTransactions()", which this same change
 *     had made false — the shape CLAUDE.md keeps flagging.
 *   • The written reason /revenue's bars come from the ledger has to name a
 *     write path that really admits an off-list category. It blamed the CSV
 *     importer, which is the one path that provably cannot: it re-checks every
 *     row against `categoriesForType(type)` and counts the rest as `skipped`.
 *   • /dashboard's "Total spend" card still captioned itself with
 *     `transactions.filter(…).length` under a roll-up-derived total, so it and
 *     /expenses (already on `headline.count`) printed different row counts for
 *     the same ledger.
 *   • A ceiling that exists is a ceiling the customer gets told about. There is
 *     no pagination in any ledger client, so rows past the per-type window are
 *     unreachable in the product, not on page 2.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

// These client components reach the transaction/comment/team server actions
// through their forms, CSV modals and comment threads, and those pull
// `lib/auth` → `next-auth`, which cannot resolve `next/server` under vitest.
// The functions under test are pure and touch none of it, so the action modules
// are stubbed at the module boundary rather than the components being split up
// to suit a test runner.
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
vi.mock("@/lib/actions/team", () => ({
  inviteUserAction: vi.fn(),
  reactivateUserAction: vi.fn(),
  removeUserAction: vi.fn(),
  resendInviteAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  updateUserRoleAction: vi.fn(),
}));

import type { Transaction, User } from "@/lib/types";
import type { TransactionTotals } from "@/lib/queries/transactions";
import {
  revenueCategoryRows,
  revenueHeadline,
  type RevenueRollups,
} from "@/app/(app)/revenue/revenue-client";
import {
  founderStatRows,
  investmentHeadline,
  type InvestmentRollups,
} from "@/app/(app)/investments/investments-client";
import { memberFinanceTotals } from "@/app/(app)/team/team-client";
import { ledgerTotals, type DashboardRollups } from "@/app/(app)/dashboard/dashboard-client";
import { ledgerTruncation } from "@/components/transactions/ledger-truncation-notice";

const ROOT = process.cwd();

/** One repo file, read by its repo-relative, "/"-separated path. */
function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** A doc comment as one line: comment markers gone, whitespace collapsed. The
 *  idiom tests/lib/finance/runway-doc-claims.test.ts established. */
function prose(text: string): string {
  return text.replace(/^[\t ]*(?:\/\*+|\*\/|\*|\/\/)[\t ]?/gm, " ").replace(/\s+/g, " ");
}

function txn(over: Partial<Transaction> & { amount: number }): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    companyId: "c1",
    type: "income",
    category: "Product Sales",
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

/** The two rows that survived the ceiling, out of a ledger with thousands. */
const LISTED_INCOME: Transaction[] = [
  txn({ type: "income", amount: 100, category: "Product Sales" }),
  txn({ type: "income", amount: 300, category: "Services" }),
];

const LISTED_INVESTMENTS: Transaction[] = [
  txn({ type: "investment", amount: 200, category: "Seed Round", addedBy: "u1" }),
];

/* ───────────────────────────── /revenue ─────────────────────────────────── */

const REVENUE_ROLLUPS: RevenueRollups = {
  // 5,000 income rows totalling 7,000,000 — the list above holds two of them.
  income: { total: 7_000_000, count: 5000 },
  categories: [
    { category: "Product Sales", amount: 5_000_000 },
    { category: "Services", amount: 2_000_000 },
  ],
};

describe("/revenue totals (transactions-ledger-001)", () => {
  it("reads Total revenue and the entry count from the roll-up, not the capped list", () => {
    const h = revenueHeadline(LISTED_INCOME, REVENUE_ROLLUPS);
    expect(h.total).toBe(7_000_000);
    expect(h.count).toBe(5000);
  });

  it("averages over the aggregate count, not the length of the visible page", () => {
    // 7,000,000 / 5,000 = 1,400. Over the list it is 400/2 = 200 — a numerator
    // and a denominator drawn from two different populations.
    expect(revenueHeadline(LISTED_INCOME, REVENUE_ROLLUPS).average).toBe(1_400);
  });

  it("does not pre-round the average (money-001)", () => {
    const h = revenueHeadline(LISTED_INCOME, {
      ...REVENUE_ROLLUPS,
      income: { total: 1.5, count: 3 },
    });
    expect(h.average).toBeCloseTo(0.5, 10);
  });

  it("does not divide by zero on an empty ledger", () => {
    const h = revenueHeadline([], { ...REVENUE_ROLLUPS, income: { total: 0, count: 0 } });
    expect(h.average).toBe(0);
    expect(h.total).toBe(0);
  });

  it("reproduces what summing the list gave: a total short by the dropped rows", () => {
    const fromList = revenueHeadline(LISTED_INCOME);
    expect(fromList.total).toBe(400);
    expect(revenueHeadline(LISTED_INCOME, REVENUE_ROLLUPS).total).toBeGreaterThan(fromList.total);
  });

  it("builds the category bars from the roll-up, biggest first", () => {
    expect(revenueCategoryRows(LISTED_INCOME, REVENUE_ROLLUPS)).toEqual([
      { name: "Product Sales", amount: 5_000_000 },
      { name: "Services", amount: 2_000_000 },
    ]);
  });

  it("keeps the bars consistent with the headline: they sum to the roll-up total", () => {
    // The bars render as a percentage of the headline. Mixing an aggregate
    // denominator with array numerators makes every bar silently narrow.
    const bars = revenueCategoryRows(LISTED_INCOME, REVENUE_ROLLUPS);
    const sum = bars.reduce((s, b) => s + b.amount, 0);
    expect(sum).toBe(revenueHeadline(LISTED_INCOME, REVENUE_ROLLUPS).total);
  });

  it("falls back to the list, biggest first, dropping empty categories", () => {
    expect(revenueCategoryRows(LISTED_INCOME)).toEqual([
      { name: "Services", amount: 300 },
      { name: "Product Sales", amount: 100 },
    ]);
  });
});

/* ──────────────────────────── /investments ──────────────────────────────── */

const INVESTMENT_ROLLUPS: InvestmentRollups = {
  investment: { total: 10_000_000, count: 12 },
  contributions: {
    u1: { expense: 900_000, income: 50_000, investment: 4_000_000 },
    u2: { expense: 0, income: 0, investment: 6_000_000 },
  },
};

describe("/investments totals (transactions-ledger-001)", () => {
  it("reads Total raised and the contribution count from the roll-up", () => {
    const h = investmentHeadline(LISTED_INVESTMENTS, INVESTMENT_ROLLUPS);
    expect(h.total).toBe(10_000_000);
    expect(h.count).toBe(12);
    // 10,000,000 / 12, un-rounded.
    expect(h.average).toBeCloseTo(10_000_000 / 12, 6);
  });

  it("does not divide by zero on an empty ledger", () => {
    const h = investmentHeadline([], {
      ...INVESTMENT_ROLLUPS,
      investment: { total: 0, count: 0 },
    });
    expect(h.average).toBe(0);
  });

  it("reads each founder's capital from the roll-up, biggest first", () => {
    const users = [user("u1", "Saqib Nawaz", "admin"), user("u2", "Ayesha Khan")];
    expect(founderStatRows(users, LISTED_INVESTMENTS, INVESTMENT_ROLLUPS)).toEqual([
      { name: "Ayesha Khan", amount: 6_000_000, role: "cofounder" },
      { name: "Saqib Nawaz", amount: 4_000_000, role: "admin" },
    ]);
  });

  it("reproduces the bug it replaces: the list knows about one founder only", () => {
    // The rows a ceiling drops are the oldest, i.e. the seed. Over the list the
    // founder who put in 6,000,000 has no bar at all.
    const users = [user("u1", "Saqib Nawaz", "admin"), user("u2", "Ayesha Khan")];
    expect(founderStatRows(users, LISTED_INVESTMENTS)).toEqual([
      { name: "Saqib Nawaz", amount: 200, role: "admin" },
    ]);
  });

  it("hides someone who has invested nothing", () => {
    const users = [user("u3", "Nobody", "member")];
    expect(founderStatRows(users, [], INVESTMENT_ROLLUPS)).toEqual([]);
  });
});

/* ────────────────────────────── /team ───────────────────────────────────── */

describe("/team per-member finance cells (transactions-ledger-001)", () => {
  const CONTRIBUTIONS = INVESTMENT_ROLLUPS.contributions;

  it("reads invested and spent from the roll-up", () => {
    expect(memberFinanceTotals("u1", CONTRIBUTIONS)).toEqual({
      invested: 4_000_000,
      spent: 900_000,
    });
  });

  it("shows a founder whose rows the capped list dropped entirely", () => {
    expect(memberFinanceTotals("u2", CONTRIBUTIONS).invested).toBe(6_000_000);
  });

  it("is zero, not undefined, for someone with no rows at all", () => {
    expect(memberFinanceTotals("u9", CONTRIBUTIONS)).toEqual({ invested: 0, spent: 0 });
  });

  it("takes no row array at all, because the page no longer fetches one", () => {
    // THE SECOND HALF OF THE FIX. While this function still accepted a
    // `Transaction[]` fallback, app/(app)/team/page.tsx went on fetching
    // `getTransactions()` to feed it — and the fallback was unreachable: it ran
    // only when `contributions` was undefined, which is exactly when the server
    // had already withheld the rows and passed `[]`. So the branch could only
    // ever reduce an empty array, while the fetch it justified shipped up to
    // 15,000 rows into the payload. A member, who is sent no finance data,
    // floors at 0 here and never sees the cells anyway.
    expect(memberFinanceTotals("u1")).toEqual({ invested: 0, spent: 0 });
    expect(memberFinanceTotals.length).toBe(2);
  });
});

/* ───────────────── /dashboard's one surviving array-derived count ────────── */

/**
 * "Total spend" on /dashboard quotes an uncapped roll-up and then captions
 * itself "N transactions" — and N was `transactions.filter(…).length` over the
 * window. /expenses had already moved the identical caption onto
 * `headline.count` (money-008), so the two surfaces printed different row counts
 * for the same ledger: 6,000 on /expenses, 5,000 on /dashboard, with the same
 * money above both.
 */
const DASHBOARD_ROLLUPS: DashboardRollups = {
  totals: {
    byType: {
      // 6,000 expense rows — a thousand of them past the list ceiling.
      expense: { total: 900_000, count: 6000 },
      income: { total: 50_000, count: 12 },
      investment: { total: 10_000_000, count: 9 },
    },
    balance: 10_000_000 + 50_000 - 900_000,
    rowCount: 6021,
  } satisfies TransactionTotals,
  monthToDateExpense: 0,
  burnWindowExpense: 0,
  ledgerStartsAt: null,
  monthly: [],
  categories: [],
  contributions: {},
};

const LISTED_EXPENSES: Transaction[] = [
  txn({ type: "expense", amount: 100, category: "Office Rent" }),
  txn({ type: "expense", amount: 40, category: "Software" }),
  txn({ type: "income", amount: 300, category: "Services" }),
];

describe("/dashboard's Total spend caption (transactions-ledger-001)", () => {
  it("counts expense rows from the roll-up, not from the capped window", () => {
    expect(ledgerTotals(LISTED_EXPENSES, DASHBOARD_ROLLUPS).expenseCount).toBe(6000);
  });

  it("falls back to the window's own expense rows when no roll-up is supplied", () => {
    // Same prefer-aggregate-then-array shape as every other figure in that file,
    // and the income row must not be counted as spend.
    expect(ledgerTotals(LISTED_EXPENSES).expenseCount).toBe(2);
  });

  it("is what the card renders, so the array is not filtered inline", () => {
    const code = read("app/(app)/dashboard/dashboard-client.tsx");
    const at = code.indexOf('label: "Total spend"');
    expect(at, "/dashboard no longer has a Total spend card").toBeGreaterThan(-1);
    const after = code.slice(at);
    const end = after.search(/\n[\t ]{4}\},/);
    const card = end === -1 ? after : after.slice(0, end);
    expect(
      /transactions\s*\.\s*filter/.test(card),
      "the Total spend caption still counts the 5,000-row-per-type window while its own figure comes from an aggregate"
    ).toBe(false);
    expect(/expenseCount/.test(card), "the caption reads no row count at all").toBe(true);
  });
});

/* ──────── the list window's callers, derived from source not memory ─────── */

const QUERY_MODULE = "lib/queries/transactions.ts";
const ACTION_MODULE = "lib/actions/transactions.ts";

/** Every .ts/.tsx file under app/ and lib/, repo-relative, "/"-separated. */
function appAndLibFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(join(ROOT, rel), { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.charAt(0) === ".") continue;
        walk(child);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk("app");
  walk("lib");
  return out;
}

/**
 * The files that really import `getTransactions` from the query module.
 *
 * Matched on the IMPORT, not on a bare `getTransactions()`: eight files mention
 * the old call in a docstring on purpose, and a text match would read that
 * history as the bug (the same reason the chat assertion below is written this
 * way).
 */
function realListWindowCallers(): string[] {
  const re = /import\s*\{[^}]*\bgetTransactions\b[^}]*\}\s*from\s*"@\/lib\/queries\/transactions"/;
  return appAndLibFiles()
    .filter((p) => p !== QUERY_MODULE && re.test(read(p)))
    .sort();
}

/** The paths the query module's own docstring enumerates as list-window callers. */
function enumeratedListWindowCallers(): string[] {
  const text = read(QUERY_MODULE);
  const at = text.indexOf("LIST-WINDOW CALLERS");
  expect(
    at,
    `${QUERY_MODULE} no longer enumerates who may call getTransactions, so the claim cannot be checked`
  ).toBeGreaterThan(-1);
  const rest = text.slice(at);
  // The enumeration ends at the first blank comment line.
  const end = rest.search(/\n[\t ]*\*[\t ]*\n/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const re = /(?:[\w().[\]-]+\/)+[\w.()[\]-]+\.tsx?/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = re.exec(block);
  while (m !== null) {
    const path = m[0].replace(/^\(+/, "");
    // The block names the test that enforces it; that is not a caller.
    if (path.indexOf("tests/") !== 0) out.push(path);
    m = re.exec(block);
  }
  return out.sort();
}

describe("who may hold ledger ROWS is checked, not remembered", () => {
  it("the query module names exactly the files that import the list window", () => {
    // The predecessor of this block said the surfaces listed there "still ALSO
    // call getTransactions(), which is correct: they render a list as well as a
    // total" — of /team and lib/actions/chat.ts, neither of which renders a list
    // and neither of which still imports it. CLAUDE.md weights a false comment
    // as a defect equal to wrong code, so the enumeration is derived here.
    expect(enumeratedListWindowCallers()).toEqual(realListWindowCallers());
  });

  it("every path it names is a file that exists", () => {
    const named = enumeratedListWindowCallers();
    expect(named.length, "the enumeration is empty").toBeGreaterThan(0);
    for (let i = 0; i < named.length; i++) {
      expect(appAndLibFiles().indexOf(named[i]), `${named[i]} does not exist`).toBeGreaterThan(-1);
    }
  });

  it("neither /team nor the chat runway card is one of them", () => {
    // Both display FIGURES ONLY. A surface that renders no rows has no business
    // holding rows, and on /team the rows were a cross-tenant-shaped payload
    // surface kept open for a reader that could never run.
    const callers = realListWindowCallers();
    expect(callers.indexOf("app/(app)/team/page.tsx")).toBe(-1);
    expect(callers.indexOf("lib/actions/chat.ts")).toBe(-1);
  });
});

/* ──────────────── the ceiling the customer gets told about ──────────────── */

/**
 * The EXPECTED clause of this finding is "every row is counted in the totals —
 * or, if a ceiling must exist, the UI says 'showing the 5,000 most recent of
 * N'". The totals half is done; a ceiling still exists, so the second half is
 * owed, and it was declined on the grounds that what remains windowed is
 * "pagination, not wrong money".
 *
 * THERE IS NO PAGINATION. None of the three ledger clients has a loadMore, a
 * page param or a "showing N" of any kind, so rows past the per-type window are
 * unreachable in the product rather than on page 2. The only signal the ceiling
 * had been hit was a server-side Sentry `boundary: read-ceiling` warning the
 * customer never sees — so a workspace with 6,000 expenses read a correct
 * "Total expenses" above a table silently missing its 1,000 oldest rows, which
 * is the original "my numbers stopped matching my bank" complaint relocated
 * rather than closed.
 *
 * Derived from the two numbers the page already holds — the rows it received of
 * this type, and the type's uncapped `count` — so it cannot drift from the
 * ceiling if `MAX_TRANSACTIONS_PER_TYPE` ever moves, and it is silent for every
 * workspace below it.
 */
describe("the truncation notice (transactions-ledger-001)", () => {
  it("says how many of how many once the window is short of the ledger", () => {
    expect(ledgerTruncation(5000, 6000)).toEqual({ shown: 5000, total: 6000, hidden: 1000 });
  });

  it("stays silent while the page is showing every row there is", () => {
    // Which is every workspace this product has today: no banner, no furniture.
    expect(ledgerTruncation(12, 12)).toBeNull();
    expect(ledgerTruncation(0, 0)).toBeNull();
  });

  it("stays silent when the caller has no aggregate to compare against", () => {
    // /expenses' `rollups` prop is optional; a notice that guessed would be
    // worse than none.
    expect(ledgerTruncation(5000)).toBeNull();
  });

  it("never claims a negative remainder", () => {
    // A roll-up read microseconds before a delete can come back SMALLER than the
    // row window. "−3 older entries" is a bug report, not a disclosure.
    expect(ledgerTruncation(12, 9)).toBeNull();
  });

  it("is rendered by all three ledger clients", () => {
    // Pinned from the caller side, like the roll-ups above: a notice component
    // nobody renders is the same non-fix as a roll-up nobody calls, and
    // `TransactionTotals.rowCount` sat for a whole wave with a docstring naming
    // a caller it did not have.
    const clients = [
      "app/(app)/expenses/expenses-client.tsx",
      "app/(app)/revenue/revenue-client.tsx",
      "app/(app)/investments/investments-client.tsx",
    ];
    for (let i = 0; i < clients.length; i++) {
      expect(
        read(clients[i]).indexOf("<LedgerTruncationNotice") !== -1,
        `${clients[i]} renders no truncation notice, so its table can be short of the ledger with nothing on screen saying so`
      ).toBe(true);
    }
  });
});

/* ───── the written reason /revenue's bars come from the ledger (doc) ─────── */

/** The two copies of that justification. */
const CATEGORY_DOCS = [QUERY_MODULE, "app/(app)/revenue/revenue-client.tsx"];

/** Every write path in lib/actions/transactions.ts that can create a row. */
const WRITE_PATHS = [
  "addTransactionAction",
  "bulkImportTransactionsAction",
  "updateTransactionAction",
];

/** One action's body, from its `export async function` to the next one. */
function actionBody(name: string): string {
  const text = read(ACTION_MODULE);
  const at = text.indexOf("export async function " + name);
  expect(at, `${ACTION_MODULE} no longer exports ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(at + 1);
  const end = rest.indexOf("\nexport async function ");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("the reason the category bars read the ledger (transactions-ledger-001)", () => {
  it("the CSV importer is the one write path that cannot admit an off-list category", () => {
    // The premise, executed rather than asserted in prose. `categoriesForType`
    // is the server-side "which set may this type use" check; the importer drops
    // every row that fails it and counts them as `skipped`.
    expect(
      /categoriesForType/.test(actionBody("bulkImportTransactionsAction")),
      "the CSV importer no longer re-checks category against type"
    ).toBe(true);
    expect(
      /categoriesForType/.test(actionBody("updateTransactionAction")),
      "the edit path no longer re-checks category against type"
    ).toBe(true);
    expect(
      /categoriesForType/.test(actionBody("addTransactionAction")),
      "the manual add path now cross-checks category against type — which is the right fix, but it means these comments need rewriting, not this assertion flipping"
    ).toBe(false);
  });

  it("the comments name a write path that really has no cross-check", () => {
    for (let i = 0; i < CATEGORY_DOCS.length; i++) {
      const text = prose(read(CATEGORY_DOCS[i]));
      const named = WRITE_PATHS.filter((a) => text.indexOf(a) > -1);
      expect(
        named.length,
        `${CATEGORY_DOCS[i]} says a category can arrive outside the constant but names no write path that admits one — the next reader goes looking in the wrong action`
      ).toBeGreaterThan(0);
      // At least one of the actions it names must be a path with no cross-check.
      // Naming the guarded ones TOO is fine and in fact useful — that is the
      // correction — but a comment whose only named culprit drops the row is the
      // defect being fixed here.
      const admit = named.filter((a) => !/categoriesForType/.test(actionBody(a)));
      expect(
        admit,
        `${CATEGORY_DOCS[i]} names only ${named.join(", ")}, every one of which checks category against type and drops the row — so it blames an action that cannot produce the condition it explains`
      ).not.toEqual([]);
    }
  });

  it("no longer attributes it to the CSV importer", () => {
    for (let i = 0; i < CATEGORY_DOCS.length; i++) {
      const text = prose(read(CATEGORY_DOCS[i]));
      const hit = /\bimport(?:er|ed)?\s+(?:accepts|admits|introduce[sd]?)\b/i.exec(text);
      expect(
        hit === null,
        `${CATEGORY_DOCS[i]} still credits the importer with it: "${hit ? hit[0] : ""}" — lib/actions/transactions.ts drops those rows`
      ).toBe(true);
    }
  });
});

/* ──────────────────── the half that lives in the callers ────────────────── */

/**
 * A roll-up with no caller is not a fix.
 *
 * The pure functions above prefer an aggregate and fall back to the array, so
 * they are correct under either wiring — which means nothing until the Server
 * Component actually fetches the aggregate and passes it down. That non-fix has
 * shipped in this repo six times (tests/lib/actions/reachability.test.ts), and
 * `getTransactionTotals` itself existed for a whole wave with no caller.
 *
 * Do not delete these to go green.
 */
describe("the callers fetch the roll-ups and pass them down", () => {
  const source = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

  /** Booleans, not `expect(code).toContain(…)`: a failing match on a long source
   *  prints the whole file into the runner's output. */
  const has = (code: string, needle: string | RegExp) =>
    typeof needle === "string" ? code.indexOf(needle) !== -1 : needle.test(code);

  it("/revenue fetches the income aggregates and hands RevenueClient a `rollups` prop", () => {
    const code = source("app", "(app)", "revenue", "page.tsx");
    expect(has(code, "getTransactionTotals"), "no all-time income aggregate").toBe(true);
    expect(has(code, "getTotalsByCategory"), "no per-category income aggregate").toBe(true);
    expect(has(code, /rollups=\{/), "the aggregates are fetched but not passed down").toBe(true);
  });

  it("/investments fetches the capital aggregates and hands them down", () => {
    const code = source("app", "(app)", "investments", "page.tsx");
    expect(has(code, "getTransactionTotals"), "no all-time investment aggregate").toBe(true);
    expect(has(code, "getContributionTotalsByUser"), "no per-founder aggregate").toBe(true);
    expect(has(code, /rollups=\{/), "the aggregates are fetched but not passed down").toBe(true);
  });

  it("/team fetches the per-person aggregate and hands it down", () => {
    const code = source("app", "(app)", "team", "page.tsx");
    expect(has(code, "getContributionTotalsByUser"), "no per-member aggregate").toBe(true);
    expect(has(code, /contributions=\{/), "the aggregate is fetched but not passed down").toBe(
      true
    );
  });

  it("/team stops fetching the row window it has no reader for", () => {
    const code = source("app", "(app)", "team", "page.tsx");
    // On the IMPORT, for the same reason as the chat case below: this page's
    // docstring names the old call on purpose, and a bare text match would read
    // that history as the bug.
    expect(
      has(
        code,
        /import\s*\{[^}]*\bgetTransactions\b[^}]*\}\s*from\s*"@\/lib\/queries\/transactions"/
      ),
      "/team renders no row list, so the 5,000-row-per-type window is up to 15,000 ledger rows — every amount, description, category and author name — in the RSC payload of every admin who opens the page, for nothing"
    ).toBe(false);
    expect(has(code, /transactions=\{/), "the dead prop is still handed to TeamClient").toBe(false);
  });

  it("the chat runway card is built from aggregates, not from the capped list", () => {
    const code = source("lib", "actions", "chat.ts");
    expect(has(code, "getTransactionTotals"), "the card has no aggregate source").toBe(true);
    expect(has(code, "getLedgerStart"), "the burn divisor still comes from the capped list").toBe(
      true
    );
    // The defect, spelled as it shipped: the card summed the row window. Matched
    // on the IMPORT rather than on a bare `getTransactions()`, because the
    // docstring above `runwayFigures` names the old call on purpose and a text
    // match would read that history as the bug.
    expect(
      has(
        code,
        /import\s*\{[^}]*\bgetTransactions\b[^}]*\}\s*from\s*"@\/lib\/queries\/transactions"/
      ),
      "the card still imports the 5,000-row-per-type list window"
    ).toBe(false);
  });
});
