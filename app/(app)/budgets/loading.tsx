import { PageHeaderSkeleton, StatGridSkeleton, CardGridSkeleton } from "@/components/ui/skeleton";

export default function BudgetsLoading() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <PageHeaderSkeleton withCta />
      <StatGridSkeleton count={3} />
      <CardGridSkeleton rows={2} cols={2} />
    </div>
  );
}
