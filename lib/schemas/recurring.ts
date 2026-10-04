/**
 * Zod schemas for the recurring-transaction surface. Shared between the
 * /recurring management UI — which resolves its form against the flat mirror in
 * app/(app)/recurring/recurring-client.tsx and imports this file's `amount`
 * field into it — and `createRecurringRuleAction`, which parses whatever the
 * browser sent.
 *
 * (The header used to name a "Repeat" toggle on the transaction form as a third
 * consumer. There is no such control: `components/transactions/transaction-form.tsx`
 * contains no reference to recurrence, and `createRecurringRuleAction` has
 * exactly one caller in the product, the New-rule modal on /recurring.)
 */

import { z } from "zod";
import { EXPENSE_CATEGORIES, INVESTMENT_CATEGORIES } from "@/lib/types";
import { isStorableMoneyScale } from "@/lib/format";

const allCategories = [...EXPENSE_CATEGORIES, ...INVESTMENT_CATEGORIES] as const;

/**
 * The amount rule for a recurring rule (money-002).
 *
 * `.positive().max(1e9)` was the whole of it, which left the SCALE to Postgres —
 * and `RecurringRule.amount` is a `Decimal(12, 2)` column, which rounds to scale
 * without erroring. A rule typed as 0.004 therefore created a rule AND a seed
 * expense that both stored 0.00, and then went on re-posting 0.00 on every cron
 * run for as long as the rule lived: rows that count in "N txns" and contribute
 * nothing to any total, with nothing on screen saying the number had been
 * changed.
 *
 * We REJECT rather than round — rounding is what the column already does, and
 * the defect is that it is silent. Same `isStorableMoneyScale` as
 * lib/schemas/transaction.ts, so storage, display and validation cannot drift
 * into three different numbers. (The `v * 100` integer check the audit
 * originally suggested was declined there because it loses precision and refuses
 * large legitimate amounts; it is declined here for the same reason.)
 *
 * EXPORTED because app/(app)/recurring/recurring-client.tsx has to keep a FLAT
 * mirror of the union below for react-hook-form (both day fields stay
 * registered), and a mirror missing this rule is the one place a 0.004 rule
 * could still be typed and submitted. The mirror imports this field rather than
 * restating it.
 */
export const recurringAmountField = z
  .number({ invalid_type_error: "Amount must be a number" })
  .positive("Amount must be greater than 0")
  .max(1_000_000_000, "Amount is implausibly large")
  .refine(isStorableMoneyScale, "Amount can have at most 2 decimal places");

/**
 * The optional project tag (money-005).
 *
 * Every Budget in this product belongs to a Project, and
 * `checkBudgetThresholdAfterExpense` returns early the instant `projectId` is
 * null (lib/budgets/check.ts) — so an UNTAGGED rule can never trip an 80%/100%
 * alert, however much it posts. `RecurringRule.projectId`, the action, the
 * materializer and the activity row all carried the tag already; this union did
 * not declare it, and a plain `z.object` strips what it does not declare, so
 * `createRecurringRuleAction` had to re-parse the raw input for the tag on its
 * own (lib/actions/recurring.ts:53) and said in a comment that the union is the
 * tag's proper home. It is now declared here; that second parse is harmless and
 * still the one the action reads.
 *
 * OPTIONAL and it must stay optional: the column is `String?` and an untagged
 * rule is the legal, company-global spend path that predates projects.
 *
 * `""` and `null` both mean "no project" — a "no project" <select> option sends
 * one of them — and both coerce to `undefined` so the value round-trips to a SQL
 * NULL. Same transform as `NewTransactionSchema`.
 *
 * NOTE for any caller building this payload by hand: send `undefined`, not `""`.
 * The action's own tag parse (above) is `.trim().min(1).nullish()` against the
 * RAW input, so a literal `""` is refused as "Invalid project" before this
 * transform is ever reached.
 */
const recurringProjectIdField = z
  .string()
  .nullish()
  .transform((v) => (v && v.length > 0 ? v : undefined));

/**
 * Discriminated on `frequency` so the matching day-field is required while
 * the other stays absent — keeps the form simpler (one field at a time) and
 * the materializer doesn't have to handle "monthly with dayOfWeek set" noise.
 */
const MonthlyRule = z.object({
  type: z.enum(["expense", "investment"]),
  amount: recurringAmountField,
  category: z.string().refine((v) => (allCategories as readonly string[]).includes(v), {
    message: "Pick a valid category",
  }),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  projectId: recurringProjectIdField,
  frequency: z.literal("monthly"),
  dayOfMonth: z
    .number({ invalid_type_error: "Pick a day of the month" })
    .int()
    .min(1, "Day of month must be 1–31")
    .max(31, "Day of month must be 1–31"),
});

const WeeklyRule = z.object({
  type: z.enum(["expense", "investment"]),
  amount: recurringAmountField,
  category: z.string().refine((v) => (allCategories as readonly string[]).includes(v), {
    message: "Pick a valid category",
  }),
  description: z.string().trim().max(500, "Description must be 500 chars or less"),
  projectId: recurringProjectIdField,
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
