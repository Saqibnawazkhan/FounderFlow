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
