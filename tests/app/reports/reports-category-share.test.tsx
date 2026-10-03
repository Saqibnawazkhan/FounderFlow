// @vitest-environment jsdom
/**
 * money-012 — the "Expense categories" share column must never print "NaN%".
 *
 * WHAT WENT WRONG. The list renders whenever `categoryData.length > 0`, and
 * `categoryData` is built by bucketing the window's expense rows by category —
 * so a category exists as soon as one expense row does, whatever it is worth.
 * The share beside it was then `c.value / totalExpenses` with no zero guard,
 * while all three sibling call sites on the other finance pages
 * (revenue-client.tsx, investments-client.tsx, and the "% of capital" column in
 * `contributorRows` further down this same file) compute
 * `total > 0 ? part / total : 0`.
 *
 * When every expense in the window is worth 0, `totalExpenses` is 0 and the
 * division is 0/0 — and `Intl.NumberFormat(…, { style: "percent" })` formats
 * `NaN` as the literal string "NaN%". `formatPercent` (lib/format.ts) only
 * strips bidi marks and hard spaces on the way out, so it passes straight
 * through to the page a customer exports to investors.
 *
 * HOW A ZERO-VALUED EXPENSE ROW GETS THERE. `Transaction.amount` is
 * `Decimal(12, 2)` with no check constraint (prisma/schema.prisma:392), and
 * until money-002 the amount rule was `.positive()` alone — which accepts
 * 0.004, a value the column then rounds to 0.00 silently. The input route is
 * closed now (`isStorableMoneyScale` in lib/schemas/transaction.ts rejects it),
 * but nothing swept the rows that were already written, and no migration can
 * make the renderer safe for them. The guard is the fix.
 *
 * WHY "0%" AND NOT A HIDDEN LIST. The row is a real expense the customer
 * entered; its money value is printed beside the share and must stay visible.
 * Suppressing the whole breakdown because its denominator is zero would hide
 * data rather than describe it — 0% is the true share of a zero total.
 *
 * NO FAKE TIMERS, NO userEvent HERE. The three charts are `next/dynamic` with
 * `ssr: false`, so under jsdom they render their `Skeleton` and never pull a
 * recharts chunk; the assertions below read the first synchronous paint, which
 * is the same thing tests/app/reports/reports-currency-first-paint.test.tsx
 * does.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportsClient } from "@/app/(app)/reports/reports-client";
import type { Company, Transaction, User } from "@/lib/types";

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

/** The 15th of the current UTC month — comfortably inside the default "6m"
 *  window, whose edges are UTC month boundaries (money-007). */
function inWindowDate(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
}

let seq = 0;
function expenseTxn(category: string, amount: number): Transaction {
  seq += 1;
  const date = inWindowDate();
  return {
    id: `t${seq}`,
    companyId: "c1",
    type: "expense",
    amount,
    category,
    description: "",
    date,
    addedBy: "u1",
    addedByName: "Ayesha Khan",
    createdAt: date,
  } as Transaction;
}

/** The text of the `<li>` that carries one category's money value and share. */
function categoryRowText(category: string): string {
  const row = screen.getByText(category).closest("li");
  expect(row, `no category row rendered for ${category}`).not.toBeNull();
  return row?.textContent ?? "";
}

describe("Expense categories share (money-012)", () => {
  it("prints 0%, not NaN%, when the window's only expense is worth zero", () => {
    render(
      <ReportsClient
        transactions={[expenseTxn("Infrastructure", 0)]}
        users={users}
        company={company}
      />
    );

    const row = categoryRowText("Infrastructure");
    expect(row).not.toContain("NaN");
    expect(row).toContain("0%");
  });

  it("leaves no NaN anywhere on the page for an all-zero expense window", () => {
    render(
      <ReportsClient
        transactions={[expenseTxn("Infrastructure", 0), expenseTxn("Salaries", 0)]}
        users={users}
        company={company}
      />
    );

    expect(document.body.textContent ?? "").not.toContain("NaN");
    expect(categoryRowText("Infrastructure")).toContain("0%");
    expect(categoryRowText("Salaries")).toContain("0%");
  });

  it("still apportions correctly when the total is non-zero — the guard is not a shortcut", () => {
    render(
      <ReportsClient
        transactions={[expenseTxn("Infrastructure", 750), expenseTxn("Salaries", 250)]}
        users={users}
        company={company}
      />
    );

    expect(categoryRowText("Infrastructure")).toContain("75%");
    expect(categoryRowText("Salaries")).toContain("25%");
  });

  it("gives a zero-valued category 0% while a sibling with real spend keeps its full share", () => {
    render(
      <ReportsClient
        transactions={[expenseTxn("Infrastructure", 400), expenseTxn("Salaries", 0)]}
        users={users}
        company={company}
      />
    );

    expect(categoryRowText("Infrastructure")).toContain("100%");
    expect(categoryRowText("Salaries")).toContain("0%");
    expect(document.body.textContent ?? "").not.toContain("NaN");
  });
});
