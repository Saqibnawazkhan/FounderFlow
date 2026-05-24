/**
 * Zod schemas for /settings company info mutations. Admin + cofounder only —
 * gated in the action via canSeeFinances (the company info itself isn't
 * financial, but the edit privilege follows the same trust tier).
 */

import { z } from "zod";

// Curated list — covers what FounderFlow currently supports in
// formatCurrency() without falling back to the USD-formatted catch-all.
// Add to this list when we wire a new currency in lib/utils.ts.
export const SUPPORTED_CURRENCIES = ["PKR", "USD", "EUR", "GBP", "INR", "AED"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const UpdateCompanySchema = z.object({
  name: z.string().trim().min(1, "Company name is required").max(120, "Company name is too long"),
  industry: z.string().trim().min(1, "Industry is required").max(80, "Industry is too long"),
  currency: z.enum(SUPPORTED_CURRENCIES, {
    errorMap: () => ({ message: "Pick a supported currency" }),
  }),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
