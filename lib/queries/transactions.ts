/**
 * Read-side queries for transactions. Mirrors lib/actions/transactions.ts
 * `listTransactionsAction` but for direct calls from async server components
 * — no ActionResult wrapper, no `"use server"` round-trip, just data.
 *
 * Writes still live in lib/actions/transactions.ts (server actions).
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Transaction } from "@/lib/types";

function toClient(t: {
  id: string;
  companyId: string;
  type: string;
  amount: number;
  category: string;
  description: string;
  date: Date;
  addedBy: string;
  addedByName: string;
  createdAt: Date;
}): Transaction {
  return {
    id: t.id,
    companyId: t.companyId,
    type: t.type as "expense" | "investment",
    amount: t.amount,
    category: t.category,
    description: t.description,
    date: t.date.toISOString(),
    addedBy: t.addedBy,
    addedByName: t.addedByName,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function getTransactions(): Promise<Transaction[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.transaction.findMany({
    where: { companyId },
    orderBy: { date: "desc" },
  });
  return rows.map(toClient);
}
