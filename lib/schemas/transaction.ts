/**
 * Zod schema for transaction input. Source of truth at the trust boundary:
 * - The client form uses it to gate the submit button
 * - The server action calls .safeParse on whatever the browser sent and
 *   refuses anything that doesn't pass
 *
 * Categories use the union from lib/types.ts so adding a new expense category
 * means one edit there, not two.
 */

import { z } from "zod";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES, REVENUE_CATEGORIES } from "@/lib/types";
import { isStorableMoneyScale } from "@/lib/format";

const allCategories = [
  ...EXPENSE_CATEGORIES,
  ...INVESTMENT_CATEGORIES,
  ...REVENUE_CATEGORIES,
] as const;

/**
 * The most rows one CSV import call may carry — and therefore the size the
 * importer chunks a larger file into (transactions-ledger-010). Exported so the
 * client's chunk size and the server's cap cannot drift apart; see
 * lib/transactions/import-batches.ts for why a drift would be this finding
 * again.
 */
export const IMPORT_MAX_ROWS_PER_BATCH = 1000;

/**
 * The amount rule, shared by the manual form and the CSV importer (money-002).
 *
 * `.positive().max(1e9)` was the whole of it, which left the SCALE to Postgres —
 * and a `numeric(12,2)` column rounds to scale without erroring. So 1234.567
 * was stored as 1234.57, and 0.004, which passes `.positive()`, was stored as
 * 0.00: a transaction that appears in the row count and contributes nothing to
 * any total, with nothing on screen saying it had been changed.
 *
 * We reject rather than round. Rounding is precisely what the column already
 * does; the defect is that it is silent. Rejecting puts the number back in front
 * of the person who typed it — `react-hook-form` renders this message under the
 * amount field, and the importer reports the offending row.
 *
 * `isStorableMoneyScale` lives in lib/format.ts next to `STORED_MONEY_SCALE`,
 * which is tied to the column's own scale, so display, storage and validation
 * cannot drift apart into three different numbers.
 */
const amountField = z
  .number({ invalid_type_error: "Amount must be a number" })
  .positive("Amount must be greater than 0")
  .max(1_000_000_000, "Amount is implausibly large")
  .refine(isStorableMoneyScale, "Amount can have at most 2 decimal places");

/**
 * The ledger date rule, shared by the manual form, the CSV importer and the
 * edit path. `Transaction.date` is a DATE-ONLY value stored at UTC midnight
 * (money-007), and a correction must not be the one path where a future date or
 * an unparseable string gets in — so the three schemas below hold one copy of
 * the rule rather than three that can drift.
 */
const dateField = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
  .refine((v) => new Date(v) <= new Date(), "Date can't be in the future");

/** Any category this product knows, for either ledger direction. Which SET a
 *  given row may use depends on its `type`, and that is checked server-side —
 *  see `bulkImportTransactionsAction` and `updateTransactionAction`. */
const categoryField = z.string().refine((v) => (allCategories as readonly string[]).includes(v), {
  message: "Pick a valid category",
});

export const NewTransactionSchema = z.object({
  type: z.enum(["expense", "investment", "income"]),
  amount: amountField,
  category: categoryField,
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  // Optional project tag — when set, the threshold check sums only this
  // project's transactions against this project's budgets. Empty string
  // coerces to undefined so a "no project" select option round-trips
  // cleanly to a SQL NULL.
  projectId: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  date: dateField,
});

export type NewTransactionInput = z.infer<typeof NewTransactionSchema>;

/**
 * Correcting a row that is already in the ledger (money-016).
 *
 * The four fields a customer can actually get wrong, and nothing else:
 *
 *  • `type` is absent on purpose. Changing it would move a row between
 *    /expenses, /revenue and /investments — i.e. between money-out and money-in
 *    — and every roll-up, budget and chart buckets on it. That is not a typo
 *    correction, it is a different record; delete and re-file.
 *  • `projectId` is absent for a narrower reason: `Transaction` as it crosses
 *    the RSC boundary (lib/types.ts) does not carry it, so an edit form cannot
 *    show the current tag. A field that renders "none" over a real value and
 *    then submits it would silently untag spend from a project's budget, which
 *    is money-016's own failure mode wearing a different hat. Re-tagging needs
 *    the column on the client first.
 *
 * `amount`, `category` and `date` reuse the add path's rules verbatim, so the
 * correction path cannot be looser than the path that created the row.
 */
export const EditTransactionSchema = z.object({
  id: z.string().min(1, "Missing transaction id"),
  amount: amountField,
  category: categoryField,
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  date: dateField,
});

export type EditTransactionInput = z.infer<typeof EditTransactionSchema>;

/**
 * CSV import (F2). One parsed row from the importer. The action re-validates
 * the category against the chosen type's category set (the client can't be
 * trusted to have done so), so `category` is just a bounded string here.
 * Rows that fail are skipped + reported, never inserted.
 */
export const ImportTransactionRowSchema = z.object({
  amount: amountField,
  category: z.string().trim().min(1, "Category is required").max(100),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  date: dateField,
});

/**
 * One import batch: the ledger direction, an optional project tag for the whole
 * batch, and the rows.
 *
 * `projectId` is per-BATCH rather than per-row, and it is the field that makes
 * imported spend visible to budgets at all (transactions-ledger-004). It used to
 * be absent, and the action hardcoded `projectId: null`, so every imported row
 * was untagged — and `Budget.projectId` is NOT NULL while
 * lib/queries/budgets.ts deliberately counts untagged spend against no cap, so
 * 100% of imported spend sat outside 100% of budget tracking. A customer who
 * onboarded by importing their history saw every budget read 0 spent.
 *
 * Per-batch because a CSV has no project column to read one from, and inventing
 * a header for it would mean guessing a project NAME and resolving it to an id
 * row by row — a bad trade against one picker in the modal. Same `""` →
 * `undefined` transform as `NewTransactionSchema` so a "no project" <select>
 * option round-trips to a SQL NULL; the action verifies the id against the
 * caller's company before it is written.
 *
 * `allowDuplicates` is the customer's answer to "N of these look like entries
 * you already have — import anyway?" (transactions-ledger-008). It defaults to
 * FALSE and the default is the whole point: an import that forgets to send the
 * flag must not mean "yes, double the ledger". The action only uses it to skip
 * withholding rows it has already reported once — it is never a way to bypass
 * any other check, every row still goes through `ImportTransactionRowSchema`
 * and the server-side category and project verification.
 *
 * `rows` is capped PER CALL, not per file (transactions-ledger-010). A larger
 * export used to be refused in full — one zod failure, zero inserts, after the
 * customer had picked the file and pressed Import — because the importer sent
 * every valid row in one call. It now chunks at exactly
 * `IMPORT_MAX_ROWS_PER_BATCH`, which is why that number is a shared constant
 * rather than a literal here: a client chunking at a different number would
 * reproduce the finding with the rejection moved one step earlier. See
 * lib/transactions/import-batches.ts.
 */
export const ImportTransactionsSchema = z.object({
  type: z.enum(["expense", "investment", "income"]),
  projectId: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  allowDuplicates: z.boolean().default(false),
  rows: z
    .array(ImportTransactionRowSchema)
    .min(1, "Nothing to import")
    .max(IMPORT_MAX_ROWS_PER_BATCH, `Import at most ${IMPORT_MAX_ROWS_PER_BATCH} rows at a time`),
});
