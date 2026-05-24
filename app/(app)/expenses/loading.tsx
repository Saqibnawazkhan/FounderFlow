import { PageHeaderSkeleton, StatGridSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function ExpensesLoading() {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8">
      <PageHeaderSkeleton withCta />
      <StatGridSkeleton count={3} />
      <TableSkeleton rows={8} />
    </div>
  );
}
