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
 *
 * IT RETURNS A REPORT, and that is new. It used to return `Promise<void>`,
 * which is right for the notification path — fire-and-forget, nothing to decide
 * on the way back — but it made the function unusable for the one caller that
 * has to state out loud what happened: the hand-fired announcement broadcast
 * (app/api/cron/announce-broadcast/route.ts). That caller's whole value is an
 * honest tally, and the alternative was a SECOND sender beside this one, which
 * would have duplicated the tombstone filter above and so duplicated the bug it
 * closes. The report is purely additive: every existing behaviour is unchanged,
 * it still never throws, and lib/push/notify.ts ignores the value exactly as
 * before.
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

/**
 * What one `sendPushToUsers` call actually did.
 *
 * `configured: false` is the field that matters most. With no VAPID keys set,
 * every send no-ops SILENTLY — and VAPID appears nowhere in
 * `scripts/vercel-build.mjs`, so nothing in the deploy path requires the keys
 * or warns about their absence. Without this flag the only distinguishable
 * outcome of "push is not set up at all" is "nobody had a device", which is
 * what lets a broadcast report success having left the building zero times.
 */
export type PushSendReport = {
  /** Both VAPID keys were present, so a send was possible at all. */
  configured: boolean;
  /** Device rows loaded — i.e. after the tombstone filter. */
  subscriptions: number;
  /** Distinct users among those rows. */
  users: number;
  /** Devices the push service accepted. */
  succeeded: number;
  /** Devices it rejected, for any reason — INCLUDING the pruned ones below. */
  failed: number;
  /** Rows deleted because the service answered 404/410. A subset of `failed`. */
  pruned: number;
};

function emptyReport(configured: boolean): PushSendReport {
  return { configured, subscriptions: 0, users: 0, succeeded: 0, failed: 0, pruned: 0 };
}

export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload
): Promise<PushSendReport> {
  if (!isPushConfigured()) return emptyReport(false);
  if (userIds.length === 0) return emptyReport(true);
  // Mutated by the per-device handlers below. A shared counter rather than a
  // reduce over results, because those handlers each swallow their own error
  // (deliberately — see the catch) and so have nothing to return.
  const report = emptyReport(true);
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
    report.subscriptions = subs.length;
    report.users = new Set(subs.map((s) => s.userId)).size;
    if (subs.length === 0) return report;

    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body
          );
          report.succeeded += 1;
        } catch (err) {
          report.failed += 1;
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410 = the browser dropped this subscription; delete it so we
          // stop trying. Anything else is transient/unexpected — log it.
          if (status === 404 || status === 410) {
            await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
            report.pruned += 1;
          } else {
            captureServerError(err, { action: "sendPush", extra: { userId: s.userId, status } });
          }
        }
      })
    );
  } catch (e) {
    captureServerError(e, { action: "sendPushToUsers" });
  }
  return report;
}
