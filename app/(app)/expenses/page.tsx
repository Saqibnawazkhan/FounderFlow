/**
 * /expenses — Server Component. Fetches all transactions (client filters
 * down to type === "expense") and the session so the per-row delete button
 * knows whether to show.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { getCompanyUsers } from "@/lib/queries/users";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { ExpensesClient } from "./expenses-client";

export const metadata: Metadata = {
  title: "Expenses",
  description: "Track every PKR going out of your company by category and contributor.",
};

export default async function ExpensesPage() {
  const [session, transactions, users, projects] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    getCompanyUsers(),
    listProjectOptions(),
  ]);

  return (
    <ExpensesClient
      transactions={transactions}
      users={users}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
