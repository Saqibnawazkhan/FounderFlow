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

export const ImportTransactionsSchema = z.object({
  type: z.enum(["expense", "investment", "income"]),
  rows: z
    .array(ImportTransactionRowSchema)
    .min(1, "Nothing to import")
    .max(1000, "Import at most 1000 rows at a time"),
});
