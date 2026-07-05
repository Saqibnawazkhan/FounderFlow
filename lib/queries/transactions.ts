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

// Scale-safety ceiling on the unbounded read. Every finance page (dashboard,
// expenses, investments, reports) fetches through here and filters/aggregates
// client-side, so without a cap a high-volume workspace ships its entire
// transaction history in the RSC payload and full-scans the table on each load.
// 5000 most-recent rows covers years of a normal startup's activity and keeps
// the payload bounded. FOLLOW-UP (before real high-volume scale): push the
// date-window + type filter into SQL per page and do the dashboard/reports
// rollups as Prisma groupBy so nothing above this ceiling is silently dropped
// from analytics. Tracked in FaultsAudit.md (F-perf).
const MAX_TRANSACTIONS = 5000;

export async function getTransactions(): Promise<TransactionWithCount[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.transaction.findMany({
    // deletedAt:null so a tombstoned workspace's rows never render (and a
    // stale session in a soft-deleted workspace can't read them back).
    where: { companyId, deletedAt: null },
    orderBy: { date: "desc" },
    take: MAX_TRANSACTIONS,
    include: { _count: { select: { comments: true } } },
  });
  return rows.map((r) => toClient(r, r._count.comments));
}
