/**
 * Streaming fallback for /revenue.
 *
 * WHY THIS FILE EXISTS (audit resp-005): /revenue was the one route under
 * app/(app) with no `loading.tsx` at all, so it had no Suspense boundary of
 * its own — the whole page waited on `getTransactions()` + `listProjectOptions()`
 * with nothing painted, while its two siblings on the same money flow
 * (/expenses, /investments) streamed a skeleton immediately. The shape is
 * deliberately identical to those two because the settled surfaces are:
 * header + CTA pair, three stat cards, transaction table.
 *
 * The `max-w` here is not free to drift from revenue-client.tsx's container —
 * tests/app/loading/skeleton-width.test.ts pairs the two files and fails if
 * they name different width tokens.
 */

import { PageHeaderSkeleton, StatGridSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function RevenueLoading() {
  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <PageHeaderSkeleton withCta />
      <StatGridSkeleton count={3} />
      <TableSkeleton rows={8} />
    </div>
  );
}
