/**
 * /expenses — Server Component. Fetches all transactions (client filters
 * down to type === "expense") and the session so the per-row delete button
 * knows whether to show.
 */

import { getTransactions } from "@/lib/queries/transactions";
import { requireScopedSession } from "@/lib/queries/session";
import { ExpensesClient } from "./expenses-client";

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
