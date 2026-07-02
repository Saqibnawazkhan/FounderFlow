/**
 * Read-side queries for transactions. Mirrors lib/actions/transactions.ts
 * `listTransactionsAction` but for direct calls from async server components
 * — no ActionResult wrapper, no `"use server"` round-trip, just data.
 *
 * Writes still live in lib/actions/transactions.ts (server actions).
 */

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Transaction } from "@/lib/types";

export type TransactionWithCount = Transaction & { commentCount: number };

function toClient(
  t: {
    id: string;
    companyId: string;
    type: string;
    // Prisma.Decimal on read (P0-4). RSC/client boundary needs a plain
    // number for JSON serialization, so we convert here.
    amount: Prisma.Decimal;
    category: string;
    description: string;
    date: Date;
    addedBy: string;
    addedByName: string;
    createdAt: Date;
  },
  commentCount = 0
): TransactionWithCount {
  return {
    id: t.id,
    companyId: t.companyId,
    type: t.type as "expense" | "investment",
    amount: t.amount.toNumber(),
    category: t.category,
    description: t.description,
    date: t.date.toISOString(),
    addedBy: t.addedBy,
    addedByName: t.addedByName,
    createdAt: t.createdAt.toISOString(),
    commentCount,
  };
}

export async function getTransactions(): Promise<TransactionWithCount[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.transaction.findMany({
    where: { companyId },
    orderBy: { date: "desc" },
    include: { _count: { select: { comments: true } } },
  });
  return rows.map((r) => toClient(r, r._count.comments));
}
