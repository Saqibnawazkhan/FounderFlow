/**
 * Read-side queries for activities. Activities are write-only side effects
 * of other server actions — there's no Activity write API on its own.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Activity, ActivityType, ActivityMetadata } from "@/lib/types";

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

export async function getActivities(limit = 500): Promise<Activity[]> {
  const { companyId } = await requireScopedSession();
  const rows = await db.activity.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: limit, // caps unbounded growth (audit flaw #23)
  });
  return rows.map(toClient);
}

export interface ActivityPage {
  items: Activity[];
  nextCursor: string | null;
}

/**
 * Cursor-paginated activity feed (X5). Returns `take` items plus a
 * `nextCursor` (the id to pass back for the following page, or null at the
 * end). Optionally filtered to a single actor (X6). Ordering carries an id
 * tiebreaker so same-millisecond rows page deterministically.
 */
export async function getActivitiesPage(opts?: {
  cursor?: string | null;
  take?: number;
  userId?: string | null;
}): Promise<ActivityPage> {
  const { companyId } = await requireScopedSession();
  const take = Math.min(Math.max(opts?.take ?? 40, 1), 100);
  const rows = await db.activity.findMany({
    where: { companyId, ...(opts?.userId ? { userId: opts.userId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1, // fetch one extra to detect whether more remain
    ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(toClient),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
