/**
 * /expenses — Server Component. Fetches all transactions (client filters
 * down to type === "expense") and the session so the per-row delete button
 * knows whether to show.
 */

import type { Metadata } from "next";
import {
  getExpenseTotalsByCategory,
  getMonthToDateExpense,
  getTransactionTotals,
  getTransactions,
} from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { ExpensesClient } from "./expenses-client";

export const metadata: Metadata = {
  title: "Expenses",
  // No currency in the copy: `Company.currency` is a per-workspace setting, so a
  // USD workspace used to read "Track every PKR going out" above a table of
  // dollars — in its tab description, its bookmarks and every link preview of
  // this page. Every other in-app page was already neutral
  // (tests/app/page-metadata-currency.test.ts keeps them all that way).
  description: "Track every expense leaving your company, by category and contributor.",
};

export default async function ExpensesPage() {
  const now = new Date();
  const [session, transactions, users, projects, totals, monthToDate, categories] =
    await Promise.all([
      requireScopedSession(),
      getTransactions(),
      getCompanyUsers(),
      listProjectOptions(),
      // money-008. This also repairs an average whose numerator and denominator
      // came from different populations: "Avg / transaction" was the capped
      // total over `expenses.length`, while the roll-up carries its own
      // uncapped count.
      getTransactionTotals(),
      getMonthToDateExpense(now),
      getExpenseTotalsByCategory(),
    ]);

  return (
    <ExpensesClient
      transactions={transactions}
      rollups={{
        expense: totals.byType.expense,
        monthToDateExpense: monthToDate,
        categories,
      }}
      users={users}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
