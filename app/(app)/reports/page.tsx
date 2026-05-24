/**
 * /reports — Server Component. Fetches transactions + users + company in
 * parallel; the client component owns the period filter + PDF/Excel export.
 */

import { getTransactions } from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { getCurrentCompany } from "@/lib/queries/company";
import { ReportsClient } from "./reports-client";

export default async function ReportsPage() {
  const [transactions, users, company] = await Promise.all([
    getTransactions(),
    getCompanyUsers(),
    getCurrentCompany(),
  ]);

  return <ReportsClient transactions={transactions} users={users} company={company} />;
}
