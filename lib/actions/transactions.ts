"use server";

/**
 * Transaction server actions. Replaces the localStorage-backed Zustand
 * mutations with real Prisma writes scoped to the signed-in user's company
 * (closes audit flaw #5 for transactions: writes are now authoritative on
 * the server with permission checks the client can't bypass).
 *
 * Every action:
 *   1. Reads the session via auth() — refuses anonymous callers
 *   2. zod-parses the input
 *   3. Scopes the query to session.user.companyId so users physically can't
 *      read or mutate another company's data even if they craft a request
 *      by hand
 *   4. Atomically writes the transaction + activity log + notifications in
 *      one Prisma $transaction so we never leave the activity feed lying
 *   5. revalidatePath(s) so any RSC consumers re-render with fresh data
 */

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewTransactionSchema } from "@/lib/schemas/transaction";
import { limiters } from "@/lib/rate-limit";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import type { Transaction } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

/** Plain serializable shape returned to client components. Amount is
 *  Prisma.Decimal on the way in (BUGS.md P0-4) and needs `.toNumber()` for
 *  JSON transport across the RSC boundary. */
function toClient(t: {
  id: string;
  companyId: string;
  type: string;
  amount: Prisma.Decimal;
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
    amount: t.amount.toNumber(),
    category: t.category,
    description: t.description,
    date: t.date.toISOString(),
    addedBy: t.addedBy,
    addedByName: t.addedByName,
    createdAt: t.createdAt.toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reads                                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function listTransactionsAction(): Promise<ActionResult<Transaction[]>> {
  const session = await auth();
  if (!session?.user?.companyId) return { success: false, error: "Not authenticated" };
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  const rows = await db.transaction.findMany({
    where: { companyId: session.user.companyId },
    orderBy: { date: "desc" },
  });

  return { success: true, data: rows.map(toClient) };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Writes                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function addTransactionAction(input: unknown): Promise<ActionResult<Transaction>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  // Spam guard: 60 writes/user/min covers any plausible human, blocks scripted abuse.
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = NewTransactionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid transaction",
    };
  }
  const { type, amount, category, description, date, projectId } = parsed.data;
  const { id: userId, companyId } = session.user;

  // If a projectId was supplied, verify it belongs to this company. We
  // accept the tag from anyone who can see finances — the project's own
  // budgets enforce who's spending on it. A null projectId is the legacy
  // "company-global" spend path.
  if (projectId) {
    const project = await db.project.findFirst({
      where: { id: projectId, companyId },
      select: { id: true },
    });
    if (!project) return { success: false, error: "Project not found" };
  }

  // Authoritative user lookup so the denormalized addedByName is never stale.
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { success: false, error: "User no longer exists" };

  // One Prisma transaction so the txn + activity + notifications either all
  // land or none do — keeps the activity feed consistent with the ledger.
  const created = await db.$transaction(async (tx) => {
    const txn = await tx.transaction.create({
      data: {
        companyId,
        projectId: projectId ?? null,
        type,
        amount,
        category,
        description,
        date: new Date(date),
        addedBy: userId,
        addedByName: user.name,
      },
    });

    const isExpense = type === "expense";
    await tx.activity.create({
      data: {
        companyId,
        projectId: projectId ?? null,
        type: isExpense ? "expense_added" : "investment_added",
        message: `${user.name} added ${isExpense ? "expense" : "investment"} of ${amount.toLocaleString()} PKR for ${category}`,
        userId,
        userName: user.name,
        metadata: JSON.stringify({ kind: "transaction", amount, category }),
      },
    });

    // Notify every other member of the company (skip the actor themselves).
    const others = await tx.user.findMany({
      where: { companyId, NOT: { id: userId } },
      select: { id: true },
    });
    if (others.length > 0) {
      await tx.notification.createMany({
        data: others.map((o) => ({
          userId: o.id,
          companyId,
          // Stamp the projectId on each notification so the member-side
          // filter in lib/queries/notifications can strip these for members
          // unless the project is one they're attached to.
          projectId: projectId ?? null,
          title: isExpense ? "New expense" : "New investment",
          message: `${user.name} ${isExpense ? "logged" : "added"} ${amount.toLocaleString()} PKR`,
          type: isExpense ? "warning" : "success",
          category: "finance",
          link: projectId ? `/projects/${projectId}` : isExpense ? "/expenses" : "/investments",
        })),
      });
    }

    return txn;
  });

  // Re-render any RSC paths that depend on this data.
  revalidatePath("/expenses");
  revalidatePath("/investments");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/activities");
  if (projectId) revalidatePath(`/projects/${projectId}`);

  // Budget threshold check fires only for expenses (investments don't count
  // against caps). Per-project now — pass the projectId in so the threshold
  // only sums this project's transactions against this project's budgets.
  if (type === "expense") {
    await checkBudgetThresholdAfterExpense({ companyId, projectId: projectId ?? null, category });
    revalidatePath("/budgets");
    revalidatePath("/notifications");
  }

  return { success: true, data: toClient(created) };
}

export async function deleteTransactionAction(id: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  const txn = await db.transaction.findUnique({ where: { id } });
  if (!txn) return { success: false, error: "Transaction not found" };

  // Cross-company access guard. The client UI also hides this button for
  // non-owners, but server is the only place that enforces it.
  if (txn.companyId !== session.user.companyId) {
    return { success: false, error: "Not authorized" };
  }
  // Only the creator or an admin can delete.
  if (txn.addedBy !== session.user.id && session.user.role !== "admin") {
    return { success: false, error: "Not authorized" };
  }

  const me = await db.user.findUnique({ where: { id: session.user.id } });
  if (!me) return { success: false, error: "User no longer exists" };

  await db.$transaction(async (tx) => {
    await tx.transaction.delete({ where: { id } });
    await tx.activity.create({
      data: {
        companyId: txn.companyId,
        // Carry the project tag forward so the per-project Activity tab
        // shows the deletion. Null for legacy / company-global transactions
        // — those still surface in the global activity feed.
        projectId: txn.projectId,
        type: "transaction_deleted",
        message: `${me.name} deleted a ${txn.type} of ${txn.amount.toLocaleString()} PKR`,
        userId: me.id,
        userName: me.name,
        metadata: JSON.stringify({
          kind: "transaction",
          amount: txn.amount,
          category: txn.category,
        }),
      },
    });
  });

  revalidatePath("/expenses");
  revalidatePath("/investments");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/activities");
  if (txn.projectId) revalidatePath(`/projects/${txn.projectId}`);

  return { success: true, data: undefined };
}
