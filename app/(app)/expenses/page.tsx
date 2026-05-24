/**
 * /expenses — Server Component. Fetches all transactions (client filters
 * down to type === "expense") and the session so the per-row delete button
 * knows whether to show.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { requireScopedSession } from "@/lib/queries/session";
import { ExpensesClient } from "./expenses-client";

export const metadata: Metadata = {
  title: "Expenses",
  description: "Track every PKR going out of your company by category and contributor.",
};

export default async function ExpensesPage() {
  const [session, transactions] = await Promise.all([requireScopedSession(), getTransactions()]);

  return (
    <ExpensesClient
      transactions={transactions}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
