/**
 * Server-side Web Push delivery.
 *
 * `sendPushToUsers` fans a payload out to every stored device of the given
 * users, and prunes any subscription the push service reports as gone (404 /
 * 410). It never throws — push is best-effort telemetry-grade delivery layered
 * on top of the durable Notification rows, so a failed send must never break
 * the action that created the notification.
 */

import { db } from "@/lib/db";
import { webpush, isPushConfigured } from "@/lib/push/config";
import { captureServerError } from "@/lib/sentry-server";

export type PushPayload = {
  title: string;
  body: string;
  /** In-app path to open when the notification is clicked. */
  url?: string;
  /** Collapse key so repeat pings replace rather than stack. */
  tag?: string;
};

export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  if (!isPushConfigured() || userIds.length === 0) return;
  try {
    const subs = await db.pushSubscription.findMany({
      where: { userId: { in: Array.from(new Set(userIds)) } },
    });
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410 = the browser dropped this subscription; delete it so we
          // stop trying. Anything else is transient/unexpected — log it.
          if (status === 404 || status === 410) {
            await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          } else {
            captureServerError(err, { action: "sendPush", extra: { userId: s.userId, status } });
          }
        }
      })
    );
  } catch (e) {
    captureServerError(e, { action: "sendPushToUsers" });
  }
}
