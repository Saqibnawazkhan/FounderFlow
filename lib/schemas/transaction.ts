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
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES } from "@/lib/types";

const allCategories = [...EXPENSE_CATEGORIES, ...INVESTMENT_CATEGORIES] as const;

export const NewTransactionSchema = z.object({
  type: z.enum(["expense", "investment"]),
  amount: z
    .number({ invalid_type_error: "Amount must be a number" })
    .positive("Amount must be greater than 0")
    .max(1_000_000_000, "Amount is implausibly large"),
  category: z.string().refine((v) => (allCategories as readonly string[]).includes(v), {
    message: "Pick a valid category",
  }),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  // Optional project tag — when set, the threshold check sums only this
  // project's transactions against this project's budgets. Empty string
  // coerces to undefined so a "no project" select option round-trips
  // cleanly to a SQL NULL.
  projectId: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  date: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .refine((v) => new Date(v) <= new Date(), "Date can't be in the future"),
});

export type NewTransactionInput = z.infer<typeof NewTransactionSchema>;

/**
 * CSV import (F2). One parsed row from the importer. The action re-validates
 * the category against the chosen type's category set (the client can't be
 * trusted to have done so), so `category` is just a bounded string here.
 * Rows that fail are skipped + reported, never inserted.
 */
export const ImportTransactionRowSchema = z.object({
  amount: z
    .number({ invalid_type_error: "Amount must be a number" })
    .positive("Amount must be greater than 0")
    .max(1_000_000_000, "Amount is implausibly large"),
  category: z.string().trim().min(1, "Category is required").max(100),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  date: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .refine((v) => new Date(v) <= new Date(), "Date can't be in the future"),
});

export const ImportTransactionsSchema = z.object({
  type: z.enum(["expense", "investment"]),
  rows: z
    .array(ImportTransactionRowSchema)
    .min(1, "Nothing to import")
    .max(1000, "Import at most 1000 rows at a time"),
});

export type ImportTransactionsInput = z.infer<typeof ImportTransactionsSchema>;
