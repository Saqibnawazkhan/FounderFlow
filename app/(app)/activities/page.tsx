/**
 * /activities — Server Component. Fetches the activity log at request time
 * and hands it to the client component which owns search/filter state.
 *
 * Suspense boundary comes from app/(app)/activities/loading.tsx — Next.js
 * shows that skeleton while this async function awaits Prisma.
 */

import type { Metadata } from "next";
import { getActivitiesPage } from "@/lib/queries/activities";
import { getCompanyUsers } from "@/lib/queries/users";
import { PillBadge } from "@/components/landing/pill-badge";
import { ActivitiesClient } from "./activities-client";

export const metadata: Metadata = {
  title: "Activity",
  description: "A live timeline of every action your team takes, grouped by day.",
};

type SearchParams = { user?: string };

export default async function ActivitiesPage({ searchParams }: { searchParams: SearchParams }) {
  const userFilter = searchParams.user ?? null;
  const [page, users] = await Promise.all([
    getActivitiesPage({ userId: userFilter }),
    getCompanyUsers(),
  ]);

  // Guard: a stale ?user= for someone no longer on the roster falls back to
  // "all" in the UI so the select never shows a phantom selection.
  const activeUserId = userFilter && users.some((u) => u.id === userFilter) ? userFilter : "all";

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
      <ActivitiesClient
        initialActivities={page.items}
        initialCursor={page.nextCursor}
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        activeUserId={activeUserId}
      />
    </div>
  );
}
