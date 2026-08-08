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

// Currency is chosen once at workspace creation (signup) and is not edited
// afterwards, so it isn't part of the company-info update.
export const UpdateCompanySchema = z.object({
  name: z.string().trim().min(1, "Company name is required").max(120, "Company name is too long"),
  industry: z.string().trim().min(1, "Industry is required").max(80, "Industry is too long"),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
