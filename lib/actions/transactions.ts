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
 *   6. Deletes write the Tier 3 `deletedAt` tombstone — they do NOT hard-delete.
 *      See deleteTransactionAction; every read in this file and in
 *      lib/queries/ filters `deletedAt: null`, which is what makes that safe.
 */

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ImportTransactionsSchema, NewTransactionSchema } from "@/lib/schemas/transaction";
import { limiters } from "@/lib/rate-limit";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { captureServerError } from "@/lib/sentry-server";
import {
  EXPENSE_CATEGORIES,
  INVESTMENT_CATEGORIES,
  REVENUE_CATEGORIES,
  type Transaction,
  type TransactionType,
} from "@/lib/types";

import type { ActionResult } from "@/lib/actions/types";
import { notifyUsers } from "@/lib/notify/fan-out";

/** Plain serializable shape returned to client components. Amount is
 *  Prisma.Decimal on the way in (FaultsAudit.md P0-4) and needs `.toNumber()` for
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
    type: t.type as TransactionType,
    amount: t.amount.toNumber(),
    category: t.category,
    description: t.description,
    date: t.date.toISOString(),
    addedBy: t.addedBy,
    addedByName: t.addedByName,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Human noun + activity type for a transaction kind — shared by add + import. */
function txnNoun(type: string): string {
  return type === "expense" ? "expense" : type === "income" ? "revenue" : "investment";
}
function txnActivityType(type: string): "expense_added" | "revenue_added" | "investment_added" {
  return type === "expense"
    ? "expense_added"
    : type === "income"
      ? "revenue_added"
      : "investment_added";
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
    // deletedAt:null is the Tier 3 tombstone filter. It was missing here while
    // every OTHER Transaction read had it (lib/queries/transactions.ts,
    // budgets, projects, search, export) — harmless only for as long as
    // deleteTransactionAction hard-deleted. Now that a delete writes the
    // sentinel, an unfiltered list is the worst of both worlds: the user
    // deletes a row, still sees it, and deletes it again.
    where: { companyId: session.user.companyId, deletedAt: null },
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
      // deletedAt:null, or a stale expense modal files spend against a project
      // that was deleted while the form was open. Transaction.projectId is
      // SetNull rather than Restrict, so this never jams the purge the way the
      // Task/Budget equivalent does — but the row lands in a ledger tab nobody
      // can open, and it is counted by the project spend aggregate for a
      // project that no longer exists anywhere else in the product.
      where: { id: projectId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!project) return { success: false, error: "Project not found" };
  }

  // Authoritative user lookup so the denormalized addedByName is never stale.
  // The workspace CURRENCY rides along on the same query: every string this
  // action persists quotes a figure, and those strings are written once and
  // read forever, so "PKR" hardcoded into them (money-006) mislabels a USD
  // workspace's history permanently. Company.currency is the one authority —
  // read through the actor's company because the session's companyId is what
  // every other write here is scoped to anyway.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, company: { select: { currency: true } } },
  });
  if (!user) return { success: false, error: "User no longer exists" };
  const currency = user.company.currency;

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

    const noun = txnNoun(type);
    await tx.activity.create({
      data: {
        companyId,
        projectId: projectId ?? null,
        type: txnActivityType(type),
        message: `${user.name} added ${noun} of ${amount.toLocaleString()} ${currency} for ${category}`,
        userId,
        userName: user.name,
        // money-006, the durable half: the `message` above is prose written
        // once and read forever, so it can only ever be as right as the
        // currency was on the day it was written. Carrying the raw amount AND
        // its currency code in the metadata means a renderer can format the
        // figure at read time and a later currency switch cannot relabel
        // history. Additive: `ActivityMetadata` (lib/types.ts) does not declare
        // `currency` yet, so nothing reads it — but rows written from today
        // carry it, and a follow-up that widens the type has data to work with
        // instead of a backfill it cannot perform.
        metadata: JSON.stringify({ kind: "transaction", amount, category, currency }),
      },
    });

    // Notify every other LIVE member of the company (skip the actor
    // themselves). deletedAt:null is not cosmetic here: a deactivated
    // teammate's PushSubscription rows are never pruned and the purge cron has
    // no individual-user stage, so without this filter their phone keeps
    // receiving "New expense — 2,500,000" from a workspace they were removed
    // from (data-integrity-004). lib/push/send.ts now filters the same way, so
    // this is belt and braces for the in-app rows, which otherwise pile up and
    // all flood back if the account is ever reactivated.
    const others = await tx.user.findMany({
      where: { companyId, deletedAt: null, NOT: { id: userId } },
      select: { id: true },
    });
    if (others.length > 0) {
      const link = projectId
        ? `/projects/${projectId}`
        : type === "expense"
          ? "/expenses"
          : type === "income"
            ? "/revenue"
            : "/investments";
      await notifyUsers({
        event: "transaction_logged",
        userIds: others.map((o) => o.id),
        companyId,
        // Stamp the projectId so the member-side filter in
        // lib/queries/notifications can strip these for members unless the
        // project is one they're attached to.
        projectId: projectId ?? null,
        title: `New ${noun}`,
        // This body leaves the app verbatim — email subject line AND lock-screen
        // push (lib/notify/fan-out.ts), so a wrong currency code here is read
        // by someone who cannot click through to check.
        message: `${user.name} ${type === "expense" ? "logged" : "recorded"} ${amount.toLocaleString()} ${currency}`,
        // Expenses read as a caution (cash out); money-in is a success.
        tone: type === "expense" ? "warning" : "success",
        category: "finance",
        link,
        tx,
      });
    }

    return txn;
  });

  // Re-render any RSC paths that depend on this data.
  revalidatePath("/expenses");
  revalidatePath("/investments");
  revalidatePath("/revenue");
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

/**
 * CSV import (F2). Bulk-inserts a batch of parsed rows for the current user.
 * Rows whose category isn't a recognised one for the chosen type are dropped
 * and counted in `skipped` — the server is the authority on categories, never
 * the client. Deliberately does NOT fan out per-row notifications or run the
 * budget-threshold check: importing historical data shouldn't ping the whole
 * team or fire "over budget" alerts retroactively. Logs one summary activity.
 */
export async function bulkImportTransactionsAction(
  input: unknown
): Promise<ActionResult<{ imported: number; skipped: number }>> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = ImportTransactionsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid import" };
  }
  const { type, rows } = parsed.data;
  const { id: userId, companyId } = session.user;

  // Category is validated server-side against the type's set. Unknown ones
  // are dropped (reported as skipped) rather than trusted from the client.
  const validCats = new Set<string>(
    type === "expense"
      ? EXPENSE_CATEGORIES
      : type === "income"
        ? REVENUE_CATEGORIES
        : INVESTMENT_CATEGORIES
  );
  const accepted = rows.filter((r) => validCats.has(r.category));
  const skipped = rows.length - accepted.length;
  if (accepted.length === 0) {
    return { success: false, error: "No rows had a valid category for this type." };
  }

  // `select` narrows to what is used, and pulls the workspace currency along for
  // the metadata below — the summary MESSAGE quotes no figure, so there is no
  // money-006 mislabelling here, but the metadata carries an `amount` and a bare
  // amount with no code is the same hazard one step later.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, company: { select: { currency: true } } },
  });
  if (!user) return { success: false, error: "User no longer exists" };

  try {
    const total = accepted.reduce((s, r) => s + r.amount, 0);
    const result = await db.$transaction(async (tx) => {
      const created = await tx.transaction.createMany({
        data: accepted.map((r) => ({
          companyId,
          projectId: null,
          type,
          amount: new Prisma.Decimal(r.amount),
          category: r.category,
          description: r.description,
          date: new Date(r.date),
          addedBy: userId,
          addedByName: user.name,
        })),
      });
      await tx.activity.create({
        data: {
          companyId,
          type: txnActivityType(type),
          message: `${user.name} imported ${created.count} ${txnNoun(type)} ${
            created.count === 1 ? "entry" : "entries"
          } from CSV`,
          userId,
          userName: user.name,
          metadata: JSON.stringify({
            kind: "transaction",
            amount: total,
            category: "CSV import",
            currency: user.company.currency,
          }),
        },
      });
      return created;
    });

    // Tier 3 canary — an import that lands thousands of rows should be visible.
    warnBulkMutation(result.count, {
      action: "bulkImportTransactions",
      userId,
      companyId,
      extra: { type },
    });

    revalidatePath("/expenses");
    revalidatePath("/investments");
    revalidatePath("/revenue");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/activities");
    revalidatePath("/budgets");

    return { success: true, data: { imported: result.count, skipped } };
  } catch (e) {
    captureServerError(e, { action: "bulkImportTransactionsAction" });
    return { success: false, error: "Couldn't import right now. Try again." };
  }
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
  // Already tombstoned reads as gone. Re-deleting would move the sentinel
  // timestamp (the restore runbook in CLAUDE.md reunites a set of rows with a
  // BETWEEN around it) and write a second "deleted" activity row for one
  // deletion.
  if (!txn || txn.deletedAt) return { success: false, error: "Transaction not found" };

  // Cross-company access guard. The client UI also hides this button for
  // non-owners, but server is the only place that enforces it.
  if (txn.companyId !== session.user.companyId) {
    return { success: false, error: "Not authorized" };
  }
  // Only the creator or an admin can delete.
  if (txn.addedBy !== session.user.id && session.user.role !== "admin") {
    return { success: false, error: "Not authorized" };
  }

  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, company: { select: { currency: true } } },
  });
  if (!me) return { success: false, error: "User no longer exists" };

  await db.$transaction(async (tx) => {
    // TIER 3 SOFT DELETE, not a hard delete (data-integrity-001).
    //
    // This line used to be `tx.transaction.delete`, which made the recovery
    // window CLAUDE.md, prisma/schema.prisma and the add_soft_delete migration
    // all advertise ("the row survives until the nightly cron hard-deletes it
    // 90 days later") true only for whole-workspace deletion. A founder who
    // mis-clicked the trash icon on a 2,500,000 expense had destroyed a ledger
    // line, and support would have reached for the published one-UPDATE restore
    // and found no row. Now:
    //   • recovery is `UPDATE "Transaction" SET "deletedAt" = NULL WHERE id=…`
    //   • the row's Comment thread survives too — Comment.transactionId is
    //     onDelete: Cascade and Comment has no tombstone of its own, so the
    //     hard delete took the conversation with it
    //   • every read already filters deletedAt:null (ledger, dashboard, budget
    //     threshold sums, project spend, search, export), so the row leaves the
    //     product and the MONEY MATH the instant this lands — verified call site
    //     by call site, because a tombstone that a SUM still counts would be a
    //     far worse bug than the one being fixed
    //
    // ONE THING THIS DOES NOT YET BUY, stated plainly so nobody reads the
    // tombstone as a full retention story: /api/cron/purge-soft-deleted has two
    // scopes only — overdue whole workspaces, and individually deleted EMPTY
    // projects. There is no stage that hard-deletes an individually tombstoned
    // Transaction / Task / Budget in a still-LIVE workspace, so these rows are
    // now recoverable forever rather than for 90 days. That is the safe
    // direction to be wrong in, and it is a follow-up on the cron (a third
    // scope, no schema change), not a reason to keep destroying ledger lines.
    // Workspace erasure still removes them: purgeCompany deletes by companyId
    // regardless of deletedAt.
    await tx.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
    await tx.activity.create({
      data: {
        companyId: txn.companyId,
        // Carry the project tag forward so the per-project Activity tab
        // shows the deletion. Null for legacy / company-global transactions
        // — those still surface in the global activity feed.
        projectId: txn.projectId,
        type: "transaction_deleted",
        message: `${me.name} deleted a ${txn.type} of ${txn.amount.toLocaleString()} ${me.company.currency}`,
        userId: me.id,
        userName: me.name,
        metadata: JSON.stringify({
          kind: "transaction",
          amount: txn.amount,
          category: txn.category,
          // See addTransactionAction for why the code travels with the figure.
          currency: me.company.currency,
        }),
      },
    });
  });

  revalidatePath("/expenses");
  revalidatePath("/investments");
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/activities");
  if (txn.projectId) revalidatePath(`/projects/${txn.projectId}`);

  return { success: true, data: undefined };
}
