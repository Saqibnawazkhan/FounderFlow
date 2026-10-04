/**
 * /revenue — Server Component. Money the business EARNS (sales, services,
 * subscriptions) — the third money flow alongside expenses (out) and
 * investments (founder/external capital in). Same fetch shape as the other
 * finance pages: the row window for the table, plus the unbounded roll-ups for
 * every figure (transactions-ledger-001). The client filters the rows to
 * `type: "income"`.
 */

import type { Metadata } from "next";
import {
  getTotalsByCategory,
  getTransactionTotals,
  getTransactions,
} from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { getCurrentCompany } from "@/lib/queries/company";
import { RevenueClient } from "./revenue-client";

export const metadata: Metadata = {
  title: "Revenue",
  description: "Sales and earned income — money the business brings in, by category.",
};

export default async function RevenuePage() {
  const [session, transactions, users, projects, totals, categories, company] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    // The roster the comment threads resolve @-mentions against
    // (transactions-ledger-016). /expenses and /investments already fetched it;
    // this page had none, so a thread opened here would have offered
    // autocomplete over an empty list and pinged nobody.
    getCompanyUsers(),
    listProjectOptions(),
    // transactions-ledger-001. `transactions` is a LIST window capped at 5,000
    // rows per type; summing it understated "Total revenue", "Avg / entry" and
    // every category bar past that ceiling, and the rows a ceiling drops are the
    // oldest. These two aggregates have no ceiling at all.
    getTransactionTotals(),
    getTotalsByCategory("income"),
    // transactions-ledger-006. `Company.currency` on the first paint, for the
    // figures AND for the "Amount (…)" label on the add/edit form — both read it
    // from the Zustand store before this, which CompanyHydrator fills over a
    // two-hop async chain, so a non-PKR workspace saw rupees until a
    // server-action round-trip returned.
    getCurrentCompany(),
  ]);

  return (
    <RevenueClient
      transactions={transactions}
      rollups={{ income: totals.byType.income, categories }}
      users={users}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      currentUserId={session.userId}
      currentUserRole={session.role}
      currency={company.currency}
    />
  );
}
