/**
 * /reports — Server Component. Fetches transactions + users + company in
 * parallel; the client component owns the period filter + PDF/Excel export.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { getTransactions } from "@/lib/queries/transactions";
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

  const [transactions, users, company] = await Promise.all([
    getTransactions(),
    getCompanyUsers(),
    getCurrentCompany(),
  ]);

  return <ReportsClient transactions={transactions} users={users} company={company} />;
}
