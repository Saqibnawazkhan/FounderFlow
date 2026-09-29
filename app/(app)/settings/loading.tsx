import { PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  // Container width is PAIRED with the settled page's container
  // (app/(app)/settings/settings-client.tsx). A skeleton laid out to a different
  // width jumps sideways the instant data arrives, so the two are not free
  // to drift: tests/app/loading/skeleton-width.test.ts fails when they do.
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeaderSkeleton />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Skeleton className="h-64 rounded-2xl md:col-span-1" />
        <div className="space-y-4 md:col-span-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-11 rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
