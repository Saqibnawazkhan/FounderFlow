/**
 * Zod schemas for the recurring-transaction surface. Shared between the
 * "Repeat" toggle on the transaction form, the /recurring management UI,
 * and createRecurringRuleAction.
 */

import { z } from "zod";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES } from "@/lib/types";

const allCategories = [...EXPENSE_CATEGORIES, ...INVESTMENT_CATEGORIES] as const;

/**
 * Discriminated on `frequency` so the matching day-field is required while
 * the other stays absent — keeps the form simpler (one field at a time) and
 * the materializer doesn't have to handle "monthly with dayOfWeek set" noise.
 */
const MonthlyRule = z.object({
  type: z.enum(["expense", "investment"]),
  amount: z
    .number({ invalid_type_error: "Amount must be a number" })
    .positive("Amount must be greater than 0")
    .max(1_000_000_000, "Amount is implausibly large"),
  category: z.string().refine((v) => (allCategories as readonly string[]).includes(v), {
    message: "Pick a valid category",
  }),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  frequency: z.literal("monthly"),
  dayOfMonth: z
    .number({ invalid_type_error: "Pick a day of the month" })
    .int()
    .min(1, "Day of month must be 1–31")
    .max(31, "Day of month must be 1–31"),
});

const WeeklyRule = z.object({
  type: z.enum(["expense", "investment"]),
  amount: z
    .number({ invalid_type_error: "Amount must be a number" })
    .positive("Amount must be greater than 0")
    .max(1_000_000_000, "Amount is implausibly large"),
  category: z.string().refine((v) => (allCategories as readonly string[]).includes(v), {
    message: "Pick a valid category",
  }),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  frequency: z.literal("weekly"),
  dayOfWeek: z
    .number({ invalid_type_error: "Pick a day of the week" })
    .int()
    .min(0, "Day of week must be 0 (Sun) – 6 (Sat)")
    .max(6, "Day of week must be 0 (Sun) – 6 (Sat)"),
});

export const NewRecurringRuleSchema = z.discriminatedUnion("frequency", [MonthlyRule, WeeklyRule]);

export type NewRecurringRuleInput = z.infer<typeof NewRecurringRuleSchema>;

export const ToggleRecurringRuleSchema = z.object({
  ruleId: z.string().min(1),
  active: z.boolean(),
});
