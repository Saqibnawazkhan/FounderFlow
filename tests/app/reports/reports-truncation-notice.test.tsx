// @vitest-environment jsdom
/**
 * RES-001 — /reports must not hand an investor a total it quietly cut short.
 *
 * WHAT IS WRONG. `getTransactions()` is a LIST window: at most
 * `MAX_TRANSACTIONS_PER_TYPE` (5,000) rows PER TYPE, and the rows a ceiling
 * drops are the OLDEST. /reports reduces that array for every figure it shows —
 * `summaryFigures`' four in-period rows, the category mix, the per-contributor
 * bars and the Founder-wise table — and both exporters map over the same
 * numbers. transactions-ledger-001 moved the six sibling consumers (/revenue,
 * /investments, /team, /expenses, /dashboard and the chat runway card) onto
 * unbounded SQL roll-ups, and gave the three ledger clients
 * `LedgerTruncationNotice`. /reports got neither, because its window comes from
 * a CLIENT-side period picker and a correct aggregate would need a server round
 * trip per window.
 *
 * WHY THE DISCLOSURE IS THE CONTRACT THIS FILE PINS, rather than the aggregate.
 * Even a perfect per-window roll-up would leave this page's "Transaction
 * History" table — the rows in the PDF and in the .xlsx — built from the same
 * capped array, so the document would then carry a correct summary above an
 * incomplete list and need to say so anyway. A page that admits its window is
 * short is correct; a page that silently understates a figure a customer emails
 * to an investor is not. So: when the ceiling has dropped rows that the selected
 * period could contain, /reports says so ON SCREEN and IN BOTH EXPORTS.
 *
 * WHY IT IS NOT `LedgerTruncationNotice` VERBATIM. That component ends "every
 * figure above counts all N", which is TRUE on the three ledger clients and
 * FALSE here — it would be a false statement printed in the exact place this
 * finding says a false statement is most expensive.
 *
 * WHY "COULD CONTAIN" AND NOT "ALWAYS". Dropped rows are older than the oldest
 * row the page received, so a period that opens AFTER that row cannot be missing
 * any of them, and announcing a shortfall there would be the furniture the
 * rep-009 clamp notice deliberately avoids (it sets `requestedStart` only when
 * it really narrowed something). Same discipline, same reason.
 *
 * Run as:
 *   npx cross-env TZ=America/Bogota npx vitest run tests/app/reports/reports-truncation-notice.test.tsx
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/harness/source-scan";

/*
 * The three charts are stubbed — a FLAKE FIX, copied from
 * tests/app/reports/reports-clamp-notice.test.tsx for the same reason: each one
 * is pulled through `next/dynamic` with `ssr:false`, so mounting the component
 * starts three async chunk loads that resolve into recharts and race whatever
 * the test does next. This file asserts on a STATUS MESSAGE; the charts carry
 * none of it.
 */
vi.mock("@/app/(app)/reports/reports-charts", () => ({
  CashFlowBarChart: () => null,
  CategoriesPieChart: () => null,
  FoundersHorizontalBar: () => null,
}));
import { render, screen } from "@testing-library/react";
import {
  ReportsClient,
  reportTruncation,
  type ReportWindow,
} from "@/app/(app)/reports/reports-client";
import type { Company, Transaction, User } from "@/lib/types";

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8");
}

/** Source with comments stripped, so these assertions read code and not prose
 *  — the same approximation tests/app/reports/export-formula-injection.test.ts
 *  uses, and for the same reason: the surrounding comments discuss these names
 *  constantly. */
// The scanner is imported, not declared here. tests/lib/harness/source-scan.ts
// owns it, and tests/lib/harness/source-scan.test.ts fails on any file keeping
// a private copy: audit rows A40 and A49 were both silent-failure bugs living
// in exactly such a copy.
//
// AND IT IS `stripComments`, NOT `codeOnly`. The local helper this replaced was
// NAMED codeOnly while implementing stripComments — a pair of regexes that
// blanked comments and left string literals alone. The shared `codeOnly` blanks
// string CONTENTS too, deliberately, so that an action named inside a telemetry
// string is not mistaken for a caller. That is the opposite of what this file
// needs: every assertion below hunts for a string literal in the exporters
// (`doc.text("Financial Summary"`, the notice LABEL itself), so blanking
// strings makes both the anchor and the needle disappear. Swapping the name in
// without reading the semantics turned two assertions red, which is how the
// difference was found.

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: `t-${Math.random()}`,
    companyId: "c1",
    type: "expense",
    amount: 1000,
    category: "Software",
    description: "row",
    date: "2026-09-15T00:00:00.000Z",
    addedBy: "u1",
    addedByName: "Ayesha Khan",
    createdAt: "2026-09-15T00:00:00.000Z",
    ...over,
  } as Transaction;
}

/** A half-open UTC window, written out rather than built by `reportWindow`, so
 *  these cases state the period they mean. */
function window(start: string, endExclusive: string): ReportWindow {
  return { start: new Date(start), endExclusive: new Date(endExclusive) };
}

const JUL_TO_OCT = window("2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");

/* ───────────────────── the decision, as a pure function ──────────────────── */

describe("RES-001 — does the read ceiling reach into the selected period?", () => {
  it("says nothing when the page was given no uncapped counts to compare against", () => {
    // /reports' prop is optional, like /expenses' `rollups`. A notice that
    // guessed at a denominator it had not been given would be worse than none.
    expect(
      reportTruncation({
        transactions: [txn(), txn({ type: "income" })],
        window: JUL_TO_OCT,
      })
    ).toBeNull();
  });

  it("says nothing while the page holds every row the ledger has", () => {
    // Which is every workspace this product has today: no banner, no furniture.
    expect(
      reportTruncation({
        transactions: [txn(), txn(), txn({ type: "income" })],
        counts: { expense: 2, income: 1, investment: 0 },
        window: JUL_TO_OCT,
      })
    ).toBeNull();
  });

  it("speaks when the period reaches back into the rows the ceiling dropped", () => {
    // 6,000 expenses in the ledger, 2 on the page, and the oldest row the page
    // received is dated INSIDE the window — so the 5,998 older ones can be
    // in-period, and every figure on the page is reduced from the 2.
    const t = reportTruncation({
      transactions: [
        txn({ date: "2026-09-15T00:00:00.000Z" }),
        txn({ date: "2026-09-20T00:00:00.000Z" }),
      ],
      counts: { expense: 6000, income: 0, investment: 0 },
      window: JUL_TO_OCT,
    });
    expect(t).toEqual({ shown: 2, total: 6000, hidden: 5998 });
  });

  it("stays silent when every dropped row is older than the period opens", () => {
    // The oldest row the page received is dated 2026-01-10, and a ceiling drops
    // the OLDEST rows — so nothing it dropped can fall inside a window that
    // opens in July. The figures for THIS period are complete.
    expect(
      reportTruncation({
        transactions: [
          txn({ date: "2026-01-10T00:00:00.000Z" }),
          txn({ date: "2026-08-02T00:00:00.000Z" }),
        ],
        counts: { expense: 6000, income: 0, investment: 0 },
        window: JUL_TO_OCT,
      })
    ).toBeNull();
  });

  it("judges each type on its own ceiling", () => {
    // The ceiling is PER TYPE. A full income window is not excused by an expense
    // window with room to spare, and the figure it understates ("Revenue (in
    // period)") is its own row in the investor summary.
    const t = reportTruncation({
      transactions: [
        txn({ date: "2026-01-10T00:00:00.000Z" }),
        txn({ type: "income", date: "2026-09-01T00:00:00.000Z" }),
      ],
      counts: { expense: 1, income: 6000, investment: 0 },
      window: JUL_TO_OCT,
    });
    expect(t).toEqual({ shown: 2, total: 6001, hidden: 5999 });
  });

  it("never reports a negative remainder", () => {
    // The roll-up and the row read are two queries; a delete landing between
    // them can legitimately make the count the smaller number. "-3 oldest rows
    // are missing" is a bug report, not a disclosure.
    expect(
      reportTruncation({
        transactions: [txn(), txn(), txn()],
        counts: { expense: 1, income: 0, investment: 0 },
        window: JUL_TO_OCT,
      })
    ).toBeNull();
  });
});

/* ──────────────────────── the half that the customer sees ────────────────── */

const company: Company = {
  id: "c1",
  name: "Nimbus Labs",
  industry: "SaaS",
  currency: "USD",
  createdAt: "2026-01-01T00:00:00.000Z",
  ownerId: "u1",
};

const users: User[] = [
  {
    id: "u1",
    name: "Ayesha Khan",
    email: "ayesha@nimbus.test",
    role: "admin",
    companyId: "c1",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as User,
];

/** Mid-month, this month, so the default "6 months" window contains it. */
function thisMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
}

describe("RES-001 — /reports says so on screen", () => {
  it("tells the reader the page is short of the ledger", () => {
    // A decision function nobody renders is this repo's signature defect, and
    // the whole point of this finding is that the customer gets NO indication.
    render(
      <ReportsClient
        transactions={[txn({ date: thisMonthIso() }), txn({ date: thisMonthIso() })]}
        users={users}
        company={company}
        ledgerCounts={{ expense: 6000, income: 0, investment: 0 }}
      />
    );
    const notice = screen.getByRole("status");
    const said = notice.textContent ?? "";
    expect(said).toMatch(/oldest/i);
    expect(said).toMatch(/understate|not read|short/i);
    // The two numbers it compares, both of which the page already holds.
    expect(said).toMatch(/6,000|6000/);
  });

  it("stays silent for a workspace below the ceiling", () => {
    // Every workspace today. A warning that is always on screen is furniture,
    // and the ordinary report must not carry an apology.
    render(
      <ReportsClient
        transactions={[txn({ date: thisMonthIso() }), txn({ date: thisMonthIso() })]}
        users={users}
        company={company}
        ledgerCounts={{ expense: 2, income: 0, investment: 0 }}
      />
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays silent when the Server Component passes no counts", () => {
    render(
      <ReportsClient
        transactions={[txn({ date: thisMonthIso() })]}
        users={users}
        company={company}
      />
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

/* ──────────────── the half that travels: the two exports ─────────────────── */

/**
 * The PDF and the .xlsx are the artefacts this finding is about — "the surface a
 * customer exports and sends to investors", where an understated total travels
 * furthest from the person who could notice it. A notice on a screen the sender
 * has already left does not reach the reader of the document.
 *
 * Asserted statically because both exporters build their summary table inline
 * against `jspdf-autotable` / SheetJS, which a unit test cannot reach without
 * extracting two more functions; the same reasoning and the same technique as
 * the `aoa_to_sheet` sweep in
 * tests/app/reports/export-formula-injection.test.ts. Keyed on the ROW LABEL a
 * reader sees rather than on a variable name, so a rename cannot quietly turn
 * this green over an export that no longer discloses anything.
 */
describe("RES-001 — the disclosure travels with the export", () => {
  const CODE = stripComments(source("app", "(app)", "reports", "reports-client.tsx"));
  const LABEL = "Ledger coverage";

  it("the PDF's Financial Summary carries it", () => {
    const from = CODE.indexOf('doc.text("Financial Summary"');
    const to = CODE.indexOf("const lastY");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(
      CODE.slice(from, to),
      "the PDF's summary table discloses nothing about the read ceiling, so an investor reads a short total as a complete one"
    ).toContain(LABEL);
  });

  it("the Excel Summary sheet carries it", () => {
    const from = CODE.indexOf("const summarySheet");
    const to = CODE.indexOf("const txnData");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(
      CODE.slice(from, to),
      "the .xlsx Summary sheet discloses nothing about the read ceiling"
    ).toContain(LABEL);
  });

  it("neither export states it unconditionally", () => {
    // It is one sentence per artefact, derived from the same decision the screen
    // uses — not a standing disclaimer on every report a customer sends out.
    expect(CODE).toMatch(/coverageNote\s*\?/);
  });
});

/* ───────────────────────── and the Server Component ──────────────────────── */

/**
 * The uncapped per-type counts come from `getTransactionTotals().byType`, which
 * app/(app)/reports/page.tsx ALREADY fetches for the all-time balance row
 * (money-008) — so this costs no extra query, only a prop. Pinned from the
 * caller side like the `allTimeBalance` case in
 * tests/app/reports/reports-period.test.ts: deleting this to go green is how
 * `getTransactionTotals` came to exist for a whole wave with no caller.
 */
describe("RES-001 — /reports' Server Component supplies the counts", () => {
  it("passes ledgerCounts from the roll-up it already has", () => {
    const code = source("app", "(app)", "reports", "page.tsx");
    expect(code).toContain("getTransactionTotals");
    expect(code).toMatch(/ledgerCounts=\{/);
    expect(code).toMatch(/byType\.expense\.count/);
  });
});
