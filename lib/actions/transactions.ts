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
 *   7. An edit amends the row in place and records what the figure USED to be
 *      (money-016). See updateTransactionAction — a ledger whose only remedy for
 *      a typo is destroy-and-retype loses the row's id, its createdAt and its
 *      comment thread every time a customer fixes a number.
 */

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  EditTransactionSchema,
  ImportTransactionsSchema,
  NewTransactionSchema,
} from "@/lib/schemas/transaction";
import { limiters } from "@/lib/rate-limit";
import { checkBudgetThresholdAfterExpense } from "@/lib/budgets/check";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import {
  importDateWindow,
  splitDuplicateImportRows,
  storedLedgerRowKeys,
  type ImportCandidateRow,
} from "@/lib/transactions/import-dedupe";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { captureServerError } from "@/lib/sentry-server";
// money-001, persisted half: the three money figures below go into strings that
// are written once and read forever (and one of them is mailed), so they cannot
// be formatted with `toLocaleString()` — that resolves to the HOST's default
// locale and to a floating 0-3 decimal places. See lib/utils.ts.
import { formatAmountForMessage, formatUtcDay } from "@/lib/utils";
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
/**
 * The same noun with the article the edit prose needs — "an expense",
 * "a revenue entry", "an investment".
 *
 * It is NOT `` `a ${txnNoun(type)}` ``: that wrote "corrected a expense" and
 * "edited a investment" into `Activity.message`, a persisted column read forever,
 * so the typo outlived the correction it described. The article is derived from
 * the noun rather than typed per type, so a fourth noun cannot reintroduce it,
 * and "revenue" takes the count noun the three finance pages already use for the
 * row ("Delete this revenue entry?") because "a revenue" is not English. The add
 * and import paths need none of this — "added revenue of …", "imported 3
 * expenses" carry no article.
 */
function txnNounPhrase(type: string): string {
  const base = txnNoun(type);
  const noun = base === "revenue" ? "revenue entry" : base;
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}
function txnActivityType(type: string): "expense_added" | "revenue_added" | "investment_added" {
  return type === "expense"
    ? "expense_added"
    : type === "income"
      ? "revenue_added"
      : "investment_added";
}

/**
 * The categories a row of this `type` may carry. The server is the authority
 * here, never the client — shared by the CSV importer and the edit path so
 * "which set applies" cannot mean two different things in two actions.
 */
function categoriesForType(type: string): Set<string> {
  return new Set<string>(
    type === "expense"
      ? EXPENSE_CATEGORIES
      : type === "income"
        ? REVENUE_CATEGORIES
        : INVESTMENT_CATEGORIES
  );
}

/* ─────────────────────────────────────────────────────────────────────────── *
 * THERE IS NO LEDGER READ IN THIS FILE, AND THAT IS THE FIX.
 *
 * `listTransactionsAction()` used to live here: an `ActionResult<Transaction[]>`
 * over every row in the workspace, with no type filter, no date window and no
 * `take`. It was deleted (tasks-and-comments / reachability wave, 2026-09-29)
 * rather than wired, for three reasons:
 *
 *   1. NOTHING CALLED IT. It was the last name on
 *      tests/lib/actions/reachability.test.ts' unreachable list — no component,
 *      no page, no other action. Every finance surface reads
 *      `getTransactions()` from lib/queries/transactions.ts, which is the same
 *      data without the `"use server"` round trip.
 *   2. EVERY EXPORT OF A `"use server"` MODULE IS A PUBLIC POST ENDPOINT. So an
 *      unreached export is not inert: it is an unbounded, unwindowed dump of a
 *      company's entire ledger that anyone with a session could POST for, and
 *      that no page needed. Deleting it removes the endpoint, not just the
 *      function.
 *   3. IT HAD ALREADY DRIFTED. It shipped without the `deletedAt: null` filter
 *      every other Transaction read carries, so a tombstoned row came back from
 *      it — a read nobody renders is a read nobody notices going wrong. The
 *      tombstone property it was supposed to hold is now asserted against the
 *      read that IS rendered: see "hides tombstoned rows from the ledger read"
 *      in tests/lib/actions/soft-delete.test.ts, which drives
 *      `getTransactions()`.
 *
 * A new read belongs in lib/queries/transactions.ts (bounded per type, with the
 * roll-ups beside it), not here.
 * ─────────────────────────────────────────────────────────────────────────── */

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
        message: `${user.name} added ${noun} of ${formatAmountForMessage(
          amount,
          currency
        )} ${currency} for ${category}`,
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
        message: `${user.name} ${
          type === "expense" ? "logged" : "recorded"
        } ${formatAmountForMessage(amount, currency)} ${currency}`,
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
 * the client. Logs one summary activity.
 *
 * ## The batch can be tagged to a project (transactions-ledger-004)
 *
 * This action used to hardcode `projectId: null`, and `ImportTransactionsSchema`
 * had no `projectId` at all. Every `Budget` belongs to a project
 * (`Budget.projectId` is NOT NULL) and both budget readers deliberately count
 * untagged spend against no cap — `lib/budgets/check.ts` returns early for a
 * project-less expense, and `getBudgetsWithSpend` scopes its aggregate to the
 * projects that have budgets. So 100% of imported spend was outside 100% of
 * budget tracking: a customer who onboarded by importing their spend history,
 * which is exactly what the "Import CSV" button invites, saw every budget read
 * 0 spent and never got a single over-budget alert.
 *
 * The tag is verified against the caller's company and `deletedAt: null`, the
 * same check `addTransactionAction` runs for the same reason — every export of
 * a `"use server"` module is a public POST endpoint.
 *
 * ## Rows the ledger already holds are withheld, not inserted (transactions-ledger-008)
 *
 * `createMany` inserts whatever it is given, and nothing else could catch a
 * repeat: `Transaction`'s only unique key is `@@unique([ruleId, date])` and a
 * composite unique treats rows as distinct whenever a column is NULL, so every
 * imported row (`ruleId IS NULL`) sits outside it. Importing the same CSV twice
 * therefore doubled burn, revenue, budget spend and the runway denominator in
 * silence, with nothing marking the copies and no remedy but deleting rows one
 * at a time — and the trigger is a retry after an import that looked like it
 * failed, not carelessness.
 *
 * So every batch is now split against the ledger's existing rows (and against
 * itself) by `lib/transactions/import-dedupe.ts`. The duplicates are RETURNED
 * rather than dropped, as rows, so the modal can report them and offer "import
 * anyway" — two identical charges on one day are possible, and silently
 * destroying a real transaction is the same class of defect as silently
 * doubling one. `allowDuplicates` is that answer coming back, and it skips the
 * lookup entirely; it bypasses no other check.
 *
 * What this does NOT buy, stated plainly — two things:
 *
 *   • there is no import-batch id on `Transaction`, so a batch that is imported
 *     anyway still cannot be UNDONE as a unit. That needs a column, and
 *     therefore a migration;
 *   • a pre-003 row whose cell was numeric and day-first was stored with its
 *     month and day transposed (5 February for a cell meaning 2 June), and no
 *     comparison keyed on the date can match a date four months away. Those
 *     rows can still be re-imported and doubled. The clock-shift half of that
 *     legacy population IS caught — see `storedRowCandidateDays`.
 *
 * ## What it still deliberately does NOT do
 *
 * No per-row notification fan-out. Importing a year of history must not put a
 * hundred "New expense" rows in everyone's bell, their inbox and their lock
 * screen; the one summary activity row is the record.
 *
 * The budget threshold IS judged, which is a change from the original "no
 * threshold check on import" posture — that posture is what made the finding
 * above invisible rather than merely late. It is judged ONCE PER DISTINCT
 * CATEGORY after the batch commits, never per row (a 1,000-row import would
 * otherwise be 1,000 aggregates), and only for expense imports that carry a
 * project. `checkBudgetThresholdAfterExpense` sums the CURRENT calendar month
 * only, so genuinely historical rows still cross nothing; what fires is a cap
 * this month's imported spend really did exceed, at most once per threshold per
 * month per budget thanks to the sentinel, bounded by the ten expense
 * categories. Leaving it unjudged did not prevent that alert, it only deferred
 * it to the next hand-typed expense — which then attributes the crossing to the
 * wrong event.
 */
export async function bulkImportTransactionsAction(
  input: unknown
): Promise<ActionResult<{ imported: number; skipped: number; duplicates: ImportCandidateRow[] }>> {
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
  const { type, rows, projectId, allowDuplicates } = parsed.data;
  const { id: userId, companyId } = session.user;

  // Same verification as addTransactionAction, for the same reason: the id
  // arrives from the browser, so it has to be proved to belong to THIS company
  // and to a project that still exists before a thousand rows are filed against
  // it. deletedAt:null because an import modal left open while someone else
  // deleted the project would otherwise bury the batch in a ledger tab nobody
  // can open, while the project spend aggregate keeps counting it.
  if (projectId) {
    const project = await db.project.findFirst({
      where: { id: projectId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!project) return { success: false, error: "Project not found" };
  }

  // Category is validated server-side against the type's set. Unknown ones
  // are dropped (reported as skipped) rather than trusted from the client.
  const validCats = categoriesForType(type);
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
    // ── Which of these rows does the ledger already hold? ─────────────────
    // (transactions-ledger-008)
    //
    // Bounded three ways, so a file covering twelve days reads twelve days of
    // one ledger direction rather than the whole table:
    //
    //   • `type` — an expense cannot be a duplicate of a revenue row;
    //   • the batch's own date window, one day either side of it because a
    //     pre-003 row for a given day is not stored ON that UTC day (see
    //     `importDateWindow`);
    //   • the batch's DISTINCT amounts. `amount` is part of the key, so a row
    //     whose amount is not in this list cannot be a duplicate of anything
    //     here — the filter provably loses nothing, and it is what keeps a
    //     five-year onboarding import from pulling five years of ledger into
    //     memory. At most 1000 entries, which is the schema's own row cap. It
    //     bounds the read by the batch's amount footprint rather than by the
    //     window's row count: a ledger holding hundreds of rows at one of
    //     these amounts in this window is still a large read.
    //
    // `deletedAt: null` because a row the customer deleted on purpose must not
    // block re-importing it — the tombstone IS the statement that the ledger no
    // longer holds that line.
    //
    // Skipped entirely once the customer has answered "import anyway": the
    // question has been put to them and settled, so asking the database again
    // is a wasted read on the slowest path this action has.
    let fresh = accepted;
    let duplicates: typeof accepted = [];
    if (!allowDuplicates) {
      const span = importDateWindow(accepted);
      // Canonicalised at the column's own scale first, so 25000 and 25000.00
      // are one entry rather than two.
      const amountKeys = new Set<string>();
      for (const r of accepted) amountKeys.add(r.amount.toFixed(2));
      const existing = span
        ? await db.transaction.findMany({
            where: {
              companyId,
              type,
              deletedAt: null,
              date: { gte: span.gte, lt: span.lt },
              amount: { in: Array.from(amountKeys, (a) => new Prisma.Decimal(a)) },
            },
            select: { date: true, amount: true, category: true, description: true },
          })
        : [];
      const split = splitDuplicateImportRows(
        type,
        accepted,
        // `flatMap`, because a stored instant does not always name the day it
        // was written for: east of UTC a pre-003 row sits at 19:00Z on the day
        // before, so it is compared under both days. See `storedLedgerRowKeys`.
        existing.flatMap((t) =>
          storedLedgerRowKeys({
            type,
            date: t.date,
            // `.toFixed(2)` on the Decimal, so 25000 and 25000.00 reduce to one
            // key — 2 is the column's own scale and the row schema already
            // refuses anything finer.
            amount: t.amount.toFixed(2),
            category: t.category,
            description: t.description,
          })
        )
      );
      fresh = split.fresh;
      duplicates = split.duplicates;
    }

    // There is nothing new in the file. A SUCCESS with `imported: 0`, not an
    // error, because nothing went wrong — the modal turns this into "N rows
    // look like duplicates of entries you already have — import anyway?".
    // Returning BEFORE the transaction is what keeps an import that wrote
    // nothing from logging "imported 0 entries from CSV" into the feed.
    if (fresh.length === 0) {
      return { success: true, data: { imported: 0, skipped, duplicates } };
    }

    const total = fresh.reduce((s, r) => s + r.amount, 0);
    const result = await db.$transaction(async (tx) => {
      const created = await tx.transaction.createMany({
        data: fresh.map((r) => ({
          companyId,
          projectId: projectId ?? null,
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
          // Carry the tag so the project's own Activity tab shows the import
          // that moved its spend, exactly as the add and delete paths do.
          projectId: projectId ?? null,
          type: txnActivityType(type),
          // The withheld count rides along on the persisted message, because the
          // activity feed is where a suspected double import is diagnosed weeks
          // later — "imported 2 (1 skipped as a duplicate)" is the only durable
          // record that the file held more rows than the ledger took. Appended
          // only when there were any, so the ordinary message is unchanged.
          message:
            `${user.name} imported ${created.count} ${txnNoun(type)} ${
              created.count === 1 ? "entry" : "entries"
            } from CSV` +
            (duplicates.length > 0
              ? ` (${duplicates.length} skipped as ${
                  duplicates.length === 1 ? "a duplicate" : "duplicates"
                })`
              : ""),
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

    // One threshold pass per DISTINCT category, after the batch has committed —
    // see the docstring for why the import judges budgets at all and why it is
    // not per row. `Array.from(new Set(…))` rather than `[...new Set(…)]`:
    // tsconfig sets no `target`, so spreading a Set fails `npm run typecheck`
    // while passing vitest. Expenses only, and only with a project, because
    // every Budget belongs to one. Awaited but never allowed to fail the import
    // — the hook swallows and logs internally, same posture as the add, edit and
    // delete paths.
    if (type === "expense" && projectId) {
      const categories = Array.from(new Set(fresh.map((r) => r.category)));
      for (const category of categories) {
        await checkBudgetThresholdAfterExpense({ companyId, projectId, category });
      }
    }

    revalidatePath("/expenses");
    revalidatePath("/investments");
    revalidatePath("/revenue");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/activities");
    revalidatePath("/budgets");
    revalidatePath("/notifications");
    if (projectId) revalidatePath(`/projects/${projectId}`);

    return { success: true, data: { imported: result.count, skipped, duplicates } };
  } catch (e) {
    captureServerError(e, { action: "bulkImportTransactionsAction" });
    return { success: false, error: "Couldn't import right now. Try again." };
  }
}

/**
 * Correct a row that is already in the ledger (money-016).
 *
 * WHY THIS EXISTS. Until it did, `delete` was the only remedy for a mistyped
 * figure, and delete-then-retype is not an equivalent operation: the replacement
 * row has a new id, so the original's Comment thread is orphaned from it; a new
 * `createdAt`, so "when was this booked" becomes the day of the correction; and
 * the figure that was wrong survives nowhere a customer can read. Two separate
 * audit findings (money-002, money-009) produce wrong amounts, so correcting one
 * is a day-one operation, not an edge case.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   • It cannot change `type` or `projectId` — see `EditTransactionSchema` for
 *     why each of those is a different record rather than a typo.
 *   • It does NOT fan out notifications. The add path pings everyone who can see
 *     the money because a new ledger line is news; a correction to one is noise
 *     at the same volume, and the activity feed is the surface that records it.
 *     The budget threshold still re-runs below, so the one alert that IS
 *     actionable still fires.
 *   • It holds no optimistic-concurrency check. `Transaction` carries no
 *     `updatedAt`/version column, so two simultaneous editors are last-write-wins
 *     — the same posture as every other write in this file. Closing that needs a
 *     column (and therefore a migration), and the activity row at least records
 *     every value the figure passed through.
 */
export async function updateTransactionAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Not authorized" };
  }

  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = EditTransactionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid transaction" };
  }
  const { id, amount, category, description, date } = parsed.data;

  const txn = await db.transaction.findUnique({ where: { id } });
  // A tombstoned row reads as gone from every ledger, roll-up and export, so
  // editing one would bring a figure back through a side door — and the row it
  // came back as would not be the one the restore runbook expects.
  if (!txn || txn.deletedAt) return { success: false, error: "Transaction not found" };

  // Same two gates as delete, for the same reason: an edit moves money just as
  // effectively. The UI hides the control, the server is what enforces it.
  if (txn.companyId !== session.user.companyId) {
    return { success: false, error: "Not authorized" };
  }
  if (txn.addedBy !== session.user.id && session.user.role !== "admin") {
    return { success: false, error: "Not authorized" };
  }

  // The schema accepts any category this product knows; only the server knows
  // which set this ROW may use. Without this check an expense could be filed
  // under "Product Sales", where no budget and no spend breakdown counts it.
  if (!categoriesForType(txn.type).has(category)) {
    return { success: false, error: "Pick a valid category for this type" };
  }

  const previousAmount = txn.amount.toNumber();
  // `new Date(date)`, exactly as the add path does it — a date-only value from
  // `<input type="date">` parses to UTC midnight (money-007).
  const nextDate = new Date(date);
  const amountChanged = previousAmount !== amount;
  const categoryChanged = txn.category !== category;
  // The UTC DAY, not the stored instant. The form round-trips exactly the day it
  // showed — it fills from `editing.date.slice(0, 10)` and submits midnight of
  // that day — but the STORED value is not always midnight: the CSV importer
  // keeps whatever the bank wrote, and `new Date("6/1/2026")` is LOCAL midnight,
  // i.e. 05:00Z on a host west of UTC. Comparing instants therefore made every
  // such row report `date 2026-06-01 → 2026-06-01` whenever its amount was
  // corrected, and turned a save that changed nothing into an Activity row
  // claiming an edit that never happened. The UPDATE below still writes
  // `nextDate`, which puts the row on the canonical midnight for that day; every
  // reader buckets by UTC day, so the day the ledger shows does not move and
  // there is nothing for the trail to record.
  const previousDay = formatUtcDay(txn.date);
  const nextDay = formatUtcDay(nextDate);
  const dateChanged = previousDay !== nextDay;
  const descriptionChanged = txn.description !== description;

  // A save that changes nothing writes nothing. An audit trail padded with rows
  // that record no change is one nobody scrolls through, which costs exactly as
  // much as having none.
  if (!amountChanged && !categoryChanged && !dateChanged && !descriptionChanged) {
    return { success: true, data: undefined };
  }

  const me = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, company: { select: { currency: true } } },
  });
  if (!me) return { success: false, error: "User no longer exists" };
  const currency = me.company.currency;

  /** What changed, besides the amount — the message names it so the feed is
   *  readable without opening the row. ISO day rather than a formatted date:
   *  this string is written once and read forever, so it must not depend on the
   *  writer's locale (same argument as `formatAmountForMessage`). */
  const details: string[] = [];
  if (categoryChanged) details.push(`category ${txn.category} → ${category}`);
  if (dateChanged) details.push(`date ${previousDay} → ${nextDay}`);
  if (descriptionChanged) details.push("description");

  const nounPhrase = txnNounPhrase(txn.type);
  // Both figures carry the currency code, for the money-006 reason: this prose
  // is frozen on the day it is written. `activityDisplayMessage` re-renders the
  // NEW figure at read time when it can identify it unambiguously, and returns
  // the sentence byte-identical when it cannot (e.g. 11,000.00 → 1,000.00, where
  // one figure's text contains the other's) — stale formatting, never a wrong
  // number. The old amount is also in the metadata as a raw number.
  const message = amountChanged
    ? `${me.name} corrected ${nounPhrase} from ${formatAmountForMessage(
        previousAmount,
        currency
      )} ${currency} to ${formatAmountForMessage(amount, currency)} ${currency}` +
      (details.length > 0 ? ` (also: ${details.join(", ")})` : "")
    : `${me.name} edited ${nounPhrase} of ${formatAmountForMessage(
        amount,
        currency
      )} ${currency} — ${details.join(", ")}`;

  try {
    await db.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id },
        // The four correctable fields and nothing else. `createdAt` and
        // `deletedAt` are absent on purpose: an edit must not restamp when the row
        // was booked, and must not touch the Tier 3 tombstone.
        data: { amount, category, description, date: nextDate },
      });
      await tx.activity.create({
        data: {
          companyId: txn.companyId,
          projectId: txn.projectId,
          type: "transaction_edited",
          message,
          userId: me.id,
          userName: me.name,
          metadata: JSON.stringify({
            kind: "transaction",
            amount,
            // money-016, the durable half. The figure in `message` is prose; this
            // is the number a later reader can trust and re-render.
            previousAmount,
            category,
            currency,
          }),
        },
      });
    });
  } catch (e) {
    // There is exactly one correction the database itself refuses: `Transaction`
    // carries `@@unique([ruleId, date])` as the idempotency key for materialized
    // recurring spend (cron-003), so moving a rule-generated row onto another
    // occurrence's day collides. Hand-entered rows have a NULL `ruleId` and are
    // outside the constraint. Caught rather than left to throw, because an
    // unhandled rejection out of a server action reaches the person who typed
    // the date as a blank failure.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return {
        success: false,
        error: "This recurring entry already has a row on that date. Pick another date.",
      };
    }
    captureServerError(e, { action: "updateTransactionAction" });
    return { success: false, error: "Couldn't save that change. Try again." };
  }

  // finance-planning-005, from the edit side: BOTH categories have to be
  // re-judged when the row moves between them, because two months-to-date
  // changed. Correcting 5,000,000 down to 5,000 is also the case that has to
  // take an "over budget" alert back off — `decideRearm` in
  // lib/budgets/threshold.ts is what makes that possible, and this is the call
  // that reaches it. Awaited but never allowed to fail the edit (it swallows and
  // logs internally), same posture as the add and delete paths.
  if (txn.type === "expense") {
    const affected = categoryChanged ? [txn.category, category] : [category];
    for (const affectedCategory of affected) {
      await checkBudgetThresholdAfterExpense({
        companyId: txn.companyId,
        projectId: txn.projectId,
        category: affectedCategory,
      });
    }
  }

  revalidatePath("/expenses");
  revalidatePath("/investments");
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/activities");
  if (txn.type === "expense") {
    revalidatePath("/budgets");
    revalidatePath("/notifications");
  }
  if (txn.projectId) revalidatePath(`/projects/${txn.projectId}`);

  return { success: true, data: undefined };
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
  // timestamp (the restore runbook in CLAUDE.md reunites a workspace's rows by
  // `"companyId" = '<id>' AND "deletedAt" = '<exact t>'`, so a moved stamp
  // leaves the row out of the set its siblings come back with) and write a
  // second "deleted" activity row for one deletion. The runbook used a ±1s
  // BETWEEN window until data-integrity-005 corrected it on 2026-09-30; it is
  // now an exact match, because one transaction wrote one value.
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
        message: `${me.name} deleted a ${txn.type} of ${formatAmountForMessage(
          txn.amount.toNumber(),
          me.company.currency
        )} ${me.company.currency}`,
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

  // finance-planning-005. Deleting an expense changes the month-to-date figure the
  // budget alert was judged on, and until now nothing told the budget. So the
  // classic case — a founder fat-fingers 5,000,000 instead of 5,000, the 100%
  // alert emails and pushes to everyone who can see the project's money, they
  // delete the typo — left the month's sentinel set and the budget silent until
  // the 1st, however much the project really spent afterwards.
  //
  // The same hook the ADD path calls, for the same reason and with the same
  // failure posture: outside the transaction, and awaited but never allowed to
  // fail the delete (it swallows and logs internally). It now also RE-ARMS — see
  // `decideRearm` in lib/budgets/threshold.ts — so this call is what turns a
  // correction back into a working alert. Expenses only: an investment or revenue
  // row counts against no cap, and asking would be a wasted aggregate on the
  // busiest delete path.
  if (txn.type === "expense") {
    await checkBudgetThresholdAfterExpense({
      companyId: txn.companyId,
      projectId: txn.projectId,
      category: txn.category,
    });
  }

  revalidatePath("/expenses");
  revalidatePath("/investments");
  revalidatePath("/revenue");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
  revalidatePath("/activities");
  if (txn.projectId) revalidatePath(`/projects/${txn.projectId}`);

  return { success: true, data: undefined };
}
