"use server";

/**
 * Activity server actions. Reads only — every write is a side effect of a
 * transaction/task/team server action (so the feed stays atomic with the
 * thing it describes).
 */

import { getActivitiesPage, type ActivityPage } from "@/lib/queries/activities";
import { captureServerError } from "@/lib/sentry-server";

import type { ActionResult } from "@/lib/actions/types";

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
