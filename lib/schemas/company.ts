/**
 * Zod schemas for /settings company info mutations. Admin + cofounder only —
 * gated in the action via canSeeFinances (the company info itself isn't
 * financial, but the edit privilege follows the same trust tier).
 */

import { z } from "zod";

// Currencies the app INTENDS to support. Kept for the future multi-currency
// rollout (F4), but NOT offered in the UI yet: `formatCurrency()` still
// renders PKR at every call site, so letting a workspace pick USD/EUR would
// display the wrong currency everywhere. Until F4 threads the company currency
// through all formatters, currency is locked to PKR (see below).
export const SUPPORTED_CURRENCIES = ["PKR", "USD", "EUR", "GBP", "INR", "AED"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const UpdateCompanySchema = z.object({
  name: z.string().trim().min(1, "Company name is required").max(120, "Company name is too long"),
  industry: z.string().trim().min(1, "Industry is required").max(80, "Industry is too long"),
  // v1: PKR only. A forged non-PKR value is rejected rather than silently
  // stored (which would mislabel the workspace's money given formatCurrency
  // ignores it today). The edit form submits it via a hidden field.
  currency: z.literal("PKR"),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
