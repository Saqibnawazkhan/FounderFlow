"use server";

/**
 * Activity server actions. Reads only — every write is a side effect of a
 * transaction/task/team server action (so the feed stays atomic with the
 * thing it describes).
 */

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getActivitiesPage, type ActivityPage } from "@/lib/queries/activities";
import { captureServerError } from "@/lib/sentry-server";
import type { Activity, ActivityType, ActivityMetadata } from "@/lib/types";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

function toClient(a: {
  id: string;
  companyId: string;
  type: string;
  message: string;
  userId: string;
  userName: string;
  metadata: string | null;
  createdAt: Date;
}): Activity {
  let parsedMeta: ActivityMetadata | undefined;
  if (a.metadata) {
    try {
      parsedMeta = JSON.parse(a.metadata) as ActivityMetadata;
    } catch {
      parsedMeta = undefined;
    }
  }
  return {
    id: a.id,
    companyId: a.companyId,
    type: a.type as ActivityType,
    message: a.message,
    userId: a.userId,
    userName: a.userName,
    metadata: parsedMeta,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listActivitiesAction(): Promise<ActionResult<Activity[]>> {
  const session = await auth();
  if (!session?.user?.companyId) return { success: false, error: "Not authenticated" };

  const rows = await db.activity.findMany({
    where: { companyId: session.user.companyId },
    orderBy: { createdAt: "desc" },
    take: 500, // cap unbounded growth (closes audit flaw #23 for reads)
  });
  return { success: true, data: rows.map(toClient) };
}

/**
 * Client-callable next-page fetch for the /activities "Load more" button
 * (X5) and the per-user filter (X6). Delegates to the cursor query, which
 * enforces auth + company scope.
 */
export async function loadMoreActivitiesAction(input: {
  cursor: string | null;
  userId: string | null;
}): Promise<ActionResult<ActivityPage>> {
  try {
    const page = await getActivitiesPage({ cursor: input.cursor, userId: input.userId });
    return { success: true, data: page };
  } catch (e) {
    captureServerError(e, { action: "loadMoreActivitiesAction" });
    return { success: false, error: "Couldn't load more activity right now." };
  }
}
