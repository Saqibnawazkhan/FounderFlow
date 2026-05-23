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
  date: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date")
    .refine((v) => new Date(v) <= new Date(), "Date can't be in the future"),
});

export type NewTransactionInput = z.infer<typeof NewTransactionSchema>;
