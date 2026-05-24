/**
 * Read-side queries for notifications. Per-USER, not per-company — the bell
 * dropdown is private. Mutations (markRead, markAllRead, clear) stay in
 * lib/actions/notifications.ts.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Notification } from "@/lib/types";

function toClient(n: {
  id: string;
  userId: string;
  companyId: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  link: string | null;
  createdAt: Date;
}): Notification {
  return {
    id: n.id,
    userId: n.userId,
    companyId: n.companyId,
    title: n.title,
    message: n.message,
    type: n.type as Notification["type"],
    read: n.read,
    link: n.link ?? undefined,
    createdAt: n.createdAt.toISOString(),
  };
}

export async function getNotifications(limit = 200): Promise<Notification[]> {
  const { userId } = await requireScopedSession();
  const rows = await db.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toClient);
}
