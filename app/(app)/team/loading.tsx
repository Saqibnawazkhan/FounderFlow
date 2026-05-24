import { CardGridSkeleton, PageHeaderSkeleton, StatGridSkeleton } from "@/components/ui/skeleton";

export default function TeamLoading() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-8">
      <PageHeaderSkeleton withCta />
      <StatGridSkeleton count={3} />
      <CardGridSkeleton rows={2} cols={2} cardHeight="h-56" />
    </div>
  );
}
