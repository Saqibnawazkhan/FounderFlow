/**
 * Zod schemas for /settings company info mutations. Admin + cofounder only —
 * gated in the action via canSeeFinances (the company info itself isn't
 * financial, but the edit privilege follows the same trust tier).
 */

import { z } from "zod";

// Currencies a workspace can pick from. Live since the F4 multi-currency
// rollout: the choice is made at signup (`lib/schemas/auth.ts`), stored on
// `Company.currency`, and threaded to every formatter through the
// `useMoney`/`useCurrency` hooks in `lib/hooks/useMoney.ts`.
export const SUPPORTED_CURRENCIES = ["PKR", "USD", "EUR", "GBP", "INR", "AED"] as const;

// Currency is chosen once at workspace creation (signup) and is not edited
// afterwards, so it isn't part of the company-info update.
export const UpdateCompanySchema = z.object({
  name: z.string().trim().min(1, "Company name is required").max(120, "Company name is too long"),
  industry: z.string().trim().min(1, "Industry is required").max(80, "Industry is too long"),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
