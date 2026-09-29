import { PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function ActivitiesLoading() {
  // Container width is PAIRED with the settled page's container
  // (app/(app)/activities/page.tsx). A skeleton laid out to a different
  // width jumps sideways the instant data arrives, so the two are not free
  // to drift: tests/app/loading/skeleton-width.test.ts fails when they do.
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <PageHeaderSkeleton />
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-start gap-4 rounded-2xl border border-border bg-surface p-4"
          >
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
