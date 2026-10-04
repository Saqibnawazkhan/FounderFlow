/**
 * /reports — Server Component. Fetches transactions + users + company in
 * parallel; the client component owns the period filter + PDF/Excel export.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { getTransactionTotals, getTransactions } from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { getCurrentCompany } from "@/lib/queries/company";
import { ReportsClient } from "./reports-client";

export const metadata: Metadata = {
  title: "Reports",
  description: "Deep-dive analytics with investor-ready PDF and Excel exports.",
};

export default async function ReportsPage() {
  // Belt + braces defense: middleware already blocks /reports for members,
  // but we re-check inside the RSC too. Audit row F13 flagged the client-
  // side buttons for skipping the role check — hardening at the RSC layer
  // covers both the button-render and export-action code paths in one go.
  const session = await auth();
  const role = (session?.user?.role as Role | undefined) ?? "member";
  if (!canSeeFinances(role)) notFound();

  const [transactions, users, company, totals] = await Promise.all([
    getTransactions(),
    getCompanyUsers(),
    getCurrentCompany(),
    // money-008: the export row labelled "Cash balance (all time)" was the net
    // of the CAPPED list, so on a large workspace an investor-facing document
    // stated the balance of the most recent 5,000 rows per type and silently
    // omitted the seed investment. Everything else on this page is scoped by
    // the client's period filter; this is the one all-time figure.
    //
    // RES-001: the SAME roll-up also carries the uncapped row count per type,
    // which is what lets the client say "showing N of M" when the ceiling cut
    // rows the selected period could contain. No extra query, one more prop.
    getTransactionTotals(),
  ]);

  return (
    <ReportsClient
      transactions={transactions}
      users={users}
      company={company}
      allTimeBalance={totals.balance}
      ledgerCounts={{
        expense: totals.byType.expense.count,
        income: totals.byType.income.count,
        investment: totals.byType.investment.count,
      }}
    />
  );
}
