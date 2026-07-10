/**
 * /revenue — Server Component. Money the business EARNS (sales, services,
 * subscriptions) — the third money flow alongside expenses (out) and
 * investments (founder/external capital in). Same fetch shape as the other
 * finance pages; the client filters to `type: "income"`.
 */

import type { Metadata } from "next";
import { getTransactions } from "@/lib/queries/transactions";
import { listProjectOptions } from "@/lib/queries/projects";
import { requireScopedSession } from "@/lib/queries/session";
import { RevenueClient } from "./revenue-client";

export const metadata: Metadata = {
  title: "Revenue",
  description: "Sales and earned income — money the business brings in, by category.",
};

export default async function RevenuePage() {
  const [session, transactions, projects] = await Promise.all([
    requireScopedSession(),
    getTransactions(),
    listProjectOptions(),
  ]);

  return (
    <RevenueClient
      transactions={transactions}
      projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      currentUserId={session.userId}
      currentUserRole={session.role}
    />
  );
}
