import { PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function TasksLoading() {
  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <PageHeaderSkeleton withCta />
      {/* Filter pills + view toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-9 w-72 rounded-full" />
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>
      {/* 3-column kanban — 3 cards per column */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, col) => (
          <div key={col} className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-6 rounded-full" />
            </div>
            {Array.from({ length: 3 }).map((__, i) => (
              <Skeleton key={i} className="h-36 rounded-xl" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
