import { ChartSkeleton, PageHeaderSkeleton, StatGridSkeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <PageHeaderSkeleton />
      <StatGridSkeleton count={4} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartSkeleton className="lg:col-span-2" />
        <ChartSkeleton />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartSkeleton className="h-64" />
        <ChartSkeleton className="h-64" />
      </div>
    </div>
  );
}
