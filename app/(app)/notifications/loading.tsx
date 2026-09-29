import { PageHeaderSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function NotificationsLoading() {
  // Container width is PAIRED with the settled page's container
  // (app/(app)/notifications/notifications-client.tsx). A skeleton laid out to a different
  // width jumps sideways the instant data arrives, so the two are not free
  // to drift: tests/app/loading/skeleton-width.test.ts fails when they do.
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <PageHeaderSkeleton withCta />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-start gap-3 rounded-2xl border border-border bg-surface p-4"
          >
            <Skeleton className="mt-2 h-2 w-2 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="h-7 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
