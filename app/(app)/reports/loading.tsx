import { ChartSkeleton, Skeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function ReportsLoading() {
  // Container width is PAIRED with the settled page's container
  // (app/(app)/reports/reports-client.tsx). A skeleton laid out to a different
  // width jumps sideways the instant data arrives, so the two are not free
  // to drift: tests/app/loading/skeleton-width.test.ts fails when they do.
  //
  // rep-012: the SECTION SHAPES are paired too, and for the same reason. This
  // used to paint a `StatGridSkeleton count={4}` above a 2:1 chart grid — four
  // KPI cards the settled page does not have anywhere, implying numbers it never
  // shows, followed by a reflow of the whole column when the real sections
  // arrived. /reports is one full-width chart (cash flow), then a 1:1 pair
  // (category mix, contributions), then the founder-wise breakdown table, and
  // that is what this mirrors. tests/app/reports/reports-loading-shape.test.tsx
  // asserts both sides, so adding stat cards to either file fails there.
  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-10 w-64 md:h-12 md:w-80" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-28 rounded-full" />
          <Skeleton className="h-10 w-28 rounded-full" />
        </div>
      </div>
      {/* The period picker — a single pill group, as on the settled page. */}
      <Skeleton className="h-10 w-64 rounded-full" />
      {/* Cash flow: full width. */}
      <ChartSkeleton />
      {/* Spend mix + team contributions: equal halves. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
      {/* Founder-wise breakdown. Five rows is the demo roster's order of
          magnitude; the exact count cannot be known before the fetch. */}
      <TableSkeleton rows={5} />
    </div>
  );
}
