/**
 * Read side of the notification-preferences matrix.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { matrixFor } from "@/lib/notify/preferences";
import type { ChannelSet, NotifyEvent } from "@/lib/notify/events";

export type NotificationMatrixRow = { event: NotifyEvent; channels: ChannelSet };

/**
 * Every event with its resolved channels, in declaration order.
 *
 * Someone who has never opened this page has no stored rows at all, so the
 * matrix is built from `DEFAULT_CHANNELS` — `matrixFor` fills the gaps, which
 * is why this can never render a partial table.
 */
export async function getMyNotificationMatrix(): Promise<NotificationMatrixRow[]> {
  const { userId } = await requireScopedSession();
  const stored = await db.notificationPreference.findMany({
    where: { userId },
    select: { event: true, inApp: true, email: true, push: true },
  });
  return matrixFor(stored);
}
