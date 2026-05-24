/**
 * Skeleton — pulsing placeholder primitives used by every loading.tsx.
 *
 * Server-renderable (no hooks, no client state) so loading.tsx files can stay
 * server components and stream during navigation. Animations use Tailwind's
 * built-in `animate-pulse` which becomes a no-op under
 * `prefers-reduced-motion: reduce` via the globals.css override.
 */

import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-surface-hover/60", className)}
    />
  );
}

/**
 * Header used at the top of nearly every dashboard route — pill badge + big
 * title + supporting line + an optional CTA button on the right.
 */
export function PageHeaderSkeleton({ withCta = false }: { withCta?: boolean }) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="space-y-3">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-10 w-64 md:h-12 md:w-80" />
        <Skeleton className="h-4 w-48" />
      </div>
      {withCta && <Skeleton className="h-11 w-36 rounded-full" />}
    </header>
  );
}

/** Mirrors <DashboardStat> shape so the swap is visually steady. */
export function StatCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-surface p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <Skeleton className="mt-4 h-9 w-32" />
      <Skeleton className="mt-2 h-3 w-40" />
    </div>
  );
}

export function StatGridSkeleton({ count = 4 }: { count?: 3 | 4 }) {
  const cols = count === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4";
  return (
    <div className={cn("grid grid-cols-1 gap-4", cols)}>
      {Array.from({ length: count }).map((_, i) => (
        <StatCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-4 border-b border-border p-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-20" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4">
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardGridSkeleton({
  rows = 3,
  cols = 2,
  cardHeight = "h-44",
}: {
  rows?: number;
  cols?: 1 | 2 | 3;
  cardHeight?: string;
}) {
  const gridCols =
    cols === 1 ? "" : cols === 2 ? "md:grid-cols-2" : "md:grid-cols-2 lg:grid-cols-3";
  return (
    <div className={cn("grid grid-cols-1 gap-4", gridCols)}>
      {Array.from({ length: rows * cols }).map((_, i) => (
        <Skeleton key={i} className={cn(cardHeight, "rounded-2xl")} />
      ))}
    </div>
  );
}

/** Big rectangle for chart blocks. */
export function ChartSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-72 w-full rounded-2xl", className)} />;
}
