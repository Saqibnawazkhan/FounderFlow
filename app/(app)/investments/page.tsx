/**
 * /investments — Server Component. Same pattern as /expenses; we also fetch
 * the user list so the founder-contribution breakdown can show role labels
 * without a second client-side fetch.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { InvestmentsClient } from "./investments-client";

export const metadata: Metadata = {
  title: "Investments",
  description: "Capital injected by founders and outside investors, broken down by contributor.",
};

export default async function InvestmentsPage() {
  const [session, transactions, users] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    getCompanyUsers(),
  ]);

  return (
    <InvestmentsClient
      transactions={transactions}
      users={users}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
