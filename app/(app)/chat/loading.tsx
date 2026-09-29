/**
 * Streaming fallback for /chat.
 *
 * WHY THE SHAPE DIFFERS FROM THE OTHER ROUTES' loading.tsx: those mirror a
 * padded document (PageHeaderSkeleton + cards). Chat is a full-bleed,
 * viewport-locked column, so the skeleton mirrors *that* — a channel rail, a
 * message list, a composer bar — to avoid a layout jump when the real
 * surface swaps in.
 */

import { Skeleton } from "@/components/ui/skeleton";

export default function ChatLoading() {
  return (
    <div className="flex h-full">
      {/* Channel rail — hidden on phones, same as the real surface will be. */}
      <div className="hidden w-64 shrink-0 flex-col gap-2 border-e border-border p-4 md:flex">
        <Skeleton className="mb-2 h-5 w-24" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-xl" />
        ))}
      </div>
      {/* Conversation column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4">
          <Skeleton className="h-8 w-8 rounded-xl" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex-1 space-y-4 overflow-hidden p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className={i % 2 === 0 ? "h-4 w-3/5" : "h-4 w-4/5"} />
              </div>
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t border-border p-4">
          <Skeleton className="h-12 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
