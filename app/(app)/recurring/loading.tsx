import { PageHeaderSkeleton, TableSkeleton } from "@/components/ui/skeleton";

export default function RecurringLoading() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <PageHeaderSkeleton withCta />
      <TableSkeleton rows={6} />
    </div>
  );
}
