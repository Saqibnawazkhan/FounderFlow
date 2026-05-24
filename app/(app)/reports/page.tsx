/**
 * /reports — Server Component. Fetches transactions + users + company in
 * parallel; the client component owns the period filter + PDF/Excel export.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { getCurrentCompany } from "@/lib/queries/company";
import { ReportsClient } from "./reports-client";

export const metadata: Metadata = {
  title: "Reports",
  description: "Deep-dive analytics with investor-ready PDF and Excel exports.",
};

export default async function ReportsPage() {
  const [transactions, users, company] = await Promise.all([
    getTransactions(),
    getCompanyUsers(),
    getCurrentCompany(),
  ]);

  return <ReportsClient transactions={transactions} users={users} company={company} />;
}
