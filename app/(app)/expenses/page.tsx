/**
 * /expenses — Server Component. Fetches all transactions (client filters
 * down to type === "expense") and the session so the per-row delete button
 * knows whether to show.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { requireScopedSession } from "@/lib/queries/session";
import { ExpensesClient } from "./expenses-client";

export const metadata: Metadata = {
  title: "Expenses",
  description: "Track every PKR going out of your company by category and contributor.",
};

export default async function ExpensesPage() {
  const [session, transactions, users] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    getCompanyUsers(),
  ]);

  return (
    <ExpensesClient
      transactions={transactions}
      users={users}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
