/**
 * Server-side Web Push delivery.
 *
 * `sendPushToUsers` fans a payload out to every stored device of the given
 * users, and prunes any subscription the push service reports as gone (404 /
 * 410). It never throws — push is best-effort telemetry-grade delivery layered
 * on top of the durable Notification rows, so a failed send must never break
 * the action that created the notification.
 *
 * It is also the chokepoint that enforces "a deactivated teammate receives
 * nothing": the subscription query joins on `user: { deletedAt: null }`. See the
 * comment on that filter — it is a security boundary, not a tidiness filter.
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
      where: {
        userId: { in: Array.from(new Set(userIds)) },
        // TOMBSTONE FILTER — the last line of defence for data-integrity-004.
        //
        // Three things compose into a leak without it. (1) Nothing prunes
        // PushSubscription when a teammate is deactivated: removeUserAction
        // writes only User.deletedAt, and PushSubscription has no tombstone of
        // its own. (2) The purge cron deliberately has NO individual-user stage
        // (see its header), so those device rows live forever in a live
        // workspace. (3) Recipient lists upstream have historically forgotten
        // the filter — lib/notify/fan-out.ts applied it on the EMAIL branch
        // alone, and the in-app write and the push two statements away from it
        // did not. That is now resolved once, up front, for all three channels
        // (data-integrity-004), which makes this filter the second of two rather
        // than the only one. It stays: it is the boundary a caller added later
        // cannot route around, and `sendPushToUsers` is reachable from
        // lib/push/notify.ts without going through the fan-out at all.
        //
        // So a removed employee's phone kept buzzing with "New expense — 2,500,000"
        // from a workspace they had lost access to: confidential finance data
        // leaving the tenant after revocation, and the exact question a customer
        // asks ("does removing someone actually remove them?"). Filtering HERE
        // closes it wherever the recipient id originates, including callers
        // added later that forget — which is the whole reason it belongs at the
        // delivery boundary and not only at each call site.
        user: { deletedAt: null },
      },
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
