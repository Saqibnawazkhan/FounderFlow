/**
 * The dashboard's two window sizes, in a module WITHOUT `"use client"`.
 *
 * ── WHY THEY LIVE HERE AND NOT IN dashboard-client.tsx ─────────────────────
 *
 * Both numbers are needed on both sides of the RSC boundary: `page.tsx` fetches
 * the aggregates (`getTransactionTotals({ from: utcMonthsAgo(now, BURN_WINDOW_MONTHS) })`,
 * `getMonthlyTotals(CASH_FLOW_MONTHS, now)`) and `dashboard-client.tsx` divides
 * by / iterates over the same numbers so the card and the query agree.
 *
 * They used to be exported from `dashboard-client.tsx`, which declares
 * `"use client"`, and `page.tsx` imported them from there. **That crashed the
 * dashboard.** React turns every export of a client module into a
 * client-reference proxy, so what the Server Component received was not `3` but
 * `{}` — measured in the running app:
 *
 *   BURN_WINDOW_MONTHS = {}  typeof object
 *   utcMonthsAgo(now, BURN_WINDOW_MONTHS) = Invalid Date
 *
 * and the Invalid Date reached Prisma:
 *
 *   Invalid `prisma.transaction.groupBy()` invocation:
 *     where: { companyId: …, date: { gte: new Date("Invalid Date") } }
 *   Invalid value for argument `gte`: Provided Date object is invalid.
 *
 * `tsc` sees a `const 3` and is happy, so nothing but a running browser or the
 * structural guard in tests/app/dashboard/client-boundary.test.ts catches it.
 * A plain module is importable from both sides and cannot be proxied.
 *
 * Do not add `"use client"` to this file, and do not move these constants back
 * into a component module.
 */

/**
 * Months in the rolling burn window behind the runway figure.
 *
 * RE-EXPORTED, not defined here: `lib/finance/runway.ts` owns the number,
 * because it both sums the window (`burnWindowStart`) and caps the divisor
 * (`burnMonthsCovered`), and a second copy here is a second thing to forget
 * (money-017). This file's job is only to make the value importable from a
 * Server Component — which it still is, since lib/finance/runway.ts is a plain
 * module with no `"use client"` either.
 */
export { BURN_WINDOW_MONTHS } from "@/lib/finance/runway";

/** Buckets on the cash-flow chart. */
export const CASH_FLOW_MONTHS = 6;
