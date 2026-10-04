/**
 * /investments — Server Component. Same pattern as /expenses: the row window for
 * the table, plus the unbounded roll-ups for every figure
 * (transactions-ledger-001). We also fetch the user list so the
 * founder-contribution breakdown can show role labels without a second
 * client-side fetch.
 */

import type { Metadata } from "next";
import {
  getContributionTotalsByUser,
  getTransactionTotals,
  getTransactions,
} from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { getCurrentCompany } from "@/lib/queries/company";
import { InvestmentsClient } from "./investments-client";

export const metadata: Metadata = {
  title: "Investments",
  description: "Capital injected by founders and outside investors, broken down by contributor.",
};

export default async function InvestmentsPage() {
  const [session, transactions, users, projects, totals, contributions, company] =
    await Promise.all([
      requireScopedSession(),
      getTransactions(),
      getCompanyUsers(),
      listProjectOptions(),
      // transactions-ledger-001. `transactions` is a LIST window capped at 5,000
      // rows per type, and the rows a ceiling drops are the OLDEST — which on
      // this page means the seed round. So "Total raised" and the per-founder
      // bars both need aggregates, and the per-person one is the figure most
      // likely to be wrong: a founder who invested early and then stopped
      // vanishes from the breakdown altogether.
      getTransactionTotals(),
      getContributionTotalsByUser(),
      // transactions-ledger-006. `Company.currency` on the first paint, for the
      // figures AND for the "Amount (…)" label on the add/edit form — both read
      // it from the Zustand store before this, which CompanyHydrator fills over
      // a two-hop async chain, so a non-PKR workspace saw rupees until a
      // server-action round-trip returned.
      getCurrentCompany(),
    ]);

  return (
    <InvestmentsClient
      transactions={transactions}
      rollups={{ investment: totals.byType.investment, contributions }}
      users={users}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      currentUserId={session.userId}
      currentUserRole={session.role}
      currency={company.currency}
    />
  );
}
