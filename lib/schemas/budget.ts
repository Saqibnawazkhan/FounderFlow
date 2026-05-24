/**
 * Zod schemas for budget mutations.
 */

import { z } from "zod";
import { EXPENSE_CATEGORIES } from "@/lib/types";

export const NewBudgetSchema = z.object({
  category: z.string().refine((v) => (EXPENSE_CATEGORIES as readonly string[]).includes(v), {
    message: "Pick a valid expense category",
  }),
  monthlyLimit: z
    .number({ invalid_type_error: "Amount must be a number" })
    .positive("Limit must be greater than 0")
    .max(1_000_000_000, "Limit is implausibly large"),
});

export type NewBudgetInput = z.infer<typeof NewBudgetSchema>;

export const UpdateBudgetSchema = z.object({
  budgetId: z.string().min(1),
  monthlyLimit: z
    .number({ invalid_type_error: "Amount must be a number" })
    .positive("Limit must be greater than 0")
    .max(1_000_000_000, "Limit is implausibly large")
    .optional(),
  active: z.boolean().optional(),
});

export type UpdateBudgetInput = z.infer<typeof UpdateBudgetSchema>;
