import { ChartSkeleton, Skeleton, StatGridSkeleton } from "@/components/ui/skeleton";

export default function ReportsLoading() {
  // Container width is PAIRED with the settled page's container
  // (app/(app)/reports/reports-client.tsx). A skeleton laid out to a different
  // width jumps sideways the instant data arrives, so the two are not free
  // to drift: tests/app/loading/skeleton-width.test.ts fails when they do.
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
      <Skeleton className="h-10 w-64 rounded-full" />
      <StatGridSkeleton count={4} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartSkeleton className="lg:col-span-2" />
        <ChartSkeleton />
      </div>
    </div>
  );
}
