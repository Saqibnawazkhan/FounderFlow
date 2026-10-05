/**
 * Zod schemas for budget mutations.
 */

import { z } from "zod";
import { EXPENSE_CATEGORIES } from "@/lib/types";
import { isStorableMoneyScale } from "@/lib/format";

/**
 * The monthly-cap rule, shared by the create and the update path (money-002).
 *
 * `.positive().max(1e9)` was the whole of it, which left the SCALE to Postgres —
 * and `Budget.monthlyLimit` is a `Decimal(12, 2)` column, which rounds to scale
 * without erroring. So a cap typed as 1234.567 was stored as 1234.57, and a
 * sub-half-cent cap (0.004, which passes `.positive()`) was stored as 0.00: a
 * budget whose limit is zero, over budget on the first rupee spent, firing an
 * 80%/100% alert nobody can explain — with nothing on screen saying the number
 * had been changed.
 *
 * We REJECT rather than round, for the same reason as the transaction path:
 * rounding is precisely what the column already does, and the defect is that it
 * is silent. Rejecting puts the number back in front of the person who typed it
 * (`react-hook-form` renders the message under the field in
 * app/(app)/budgets/budgets-client.tsx, which uses `NewBudgetSchema` itself as
 * its resolver, so there is no mirror here to keep in step).
 *
 * ONE field for every path that accepts a cap — the create form, the update
 * action and the edit-a-cap form's resolver below — so a correction cannot be
 * the looser path. The
 * `v * 100` integer check the audit originally suggested was deliberately
 * declined on the transaction path because it loses precision and refuses large
 * legitimate amounts; `isStorableMoneyScale` (lib/format.ts, next to
 * `STORED_MONEY_SCALE`, which is tied to the column's own scale) is the shape
 * this repo uses.
 */
const monthlyLimitField = z
  .number({ invalid_type_error: "Amount must be a number" })
  .positive("Limit must be greater than 0")
  .max(1_000_000_000, "Limit is implausibly large")
  .refine(isStorableMoneyScale, "Limit can have at most 2 decimal places");

export const NewBudgetSchema = z.object({
  // Required since add_projects migration — budgets live inside a project.
  // "General" project is the catch-all for cross-cutting caps.
  projectId: z.string().min(1, "Pick a project"),
  category: z.string().refine((v) => (EXPENSE_CATEGORIES as readonly string[]).includes(v), {
    message: "Pick a valid expense category",
  }),
  monthlyLimit: monthlyLimitField,
});

export type NewBudgetInput = z.infer<typeof NewBudgetSchema>;

export const UpdateBudgetSchema = z.object({
  budgetId: z.string().min(1),
  monthlyLimit: monthlyLimitField.optional(),
  active: z.boolean().optional(),
});

/**
 * The resolver for the edit-a-cap form on /budgets (finance-planning-006).
 *
 * `UpdateBudgetSchema` is the wire shape — a budget id plus whichever fields are
 * being changed — which is not a form's shape: the form holds one required
 * number and the id comes from the card, not from an input. So this is picked
 * off `NewBudgetSchema` rather than redeclared, which is what guarantees the cap
 * typed into the edit modal passes exactly the rule the create form and the
 * action enforce. A redeclared `z.number().positive()` here would be a second
 * copy of the money-002 rule and the obvious place for the two to drift.
 */
export const EditBudgetLimitSchema = NewBudgetSchema.pick({ monthlyLimit: true });

export type EditBudgetLimitInput = z.infer<typeof EditBudgetLimitSchema>;
