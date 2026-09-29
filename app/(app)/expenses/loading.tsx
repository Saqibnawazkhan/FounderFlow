import { PageHeaderSkeleton, StatGridSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function ExpensesLoading() {
  // Container width is PAIRED with the settled page's container
  // (app/(app)/expenses/expenses-client.tsx). A skeleton laid out to a different
  // width jumps sideways the instant data arrives, so the two are not free
  // to drift: tests/app/loading/skeleton-width.test.ts fails when they do.
  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <PageHeaderSkeleton withCta />
      <StatGridSkeleton count={3} />
      <TableSkeleton rows={8} />
    </div>
  );
}
