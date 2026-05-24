/**
 * /activities — Server Component. Fetches the activity log at request time
 * and hands it to the client component which owns search/filter state.
 *
 * Suspense boundary comes from app/(app)/activities/loading.tsx — Next.js
 * shows that skeleton while this async function awaits Prisma.
 */

import type { Metadata } from "next";
import { getActivities } from "@/lib/queries/activities";
import { PillBadge } from "@/components/landing/pill-badge";
import { ActivitiesClient } from "./activities-client";

export const metadata: Metadata = {
  title: "Activity",
  description: "A live timeline of every action your team takes, grouped by day.",
};

export default async function ActivitiesPage() {
  const activities = await getActivities();

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <PillBadge>Live feed</PillBadge>
        <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Activity
        </h1>
        <p className="mt-2 text-sm text-fg-muted md:text-base">
          A live timeline of everything happening in your company.
        </p>
      </header>
      <ActivitiesClient activities={activities} />
    </div>
  );
}
