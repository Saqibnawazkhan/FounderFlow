/**
 * The single path by which a notification reaches a person.
 *
 * Before this existed there were ten independent `notification.create` /
 * `createMany` call sites, each assembling the row by hand. That is why
 * FaultsAudit S9 (a notification-preferences matrix) stayed deferred: a
 * preference that is not *enforced* is decoration, and enforcing it meant
 * editing ten places and hoping the eleventh never gets written. Routing every
 * fan-out through here gives preferences, push and email exactly one place to
 * live.
 *
 * `tests/lib/notify/fan-out-sites.test.ts` fails the build if a module ever
 * writes a notification directly again.
 *
 * Push used to be fired by a Prisma `$extends` hook in lib/db.ts, on the
 * theory that any notification write should deliver one. That could not honour
 * a per-event push preference — the hook sees a row, not the event that caused
 * it — so delivery moved here, where the event and the preferences are both in
 * hand. The hook is gone; this is now the only place push is raised from.
 */

import { db } from "@/lib/db";
import { splitByChannel } from "@/lib/notify/preferences";
import { fireNotificationEmails } from "@/lib/notify/email";
import type { NotifyCategory, NotifyEvent, NotifyTone } from "@/lib/notify/events";

export { NOTIFY_EVENTS } from "@/lib/notify/events";
export type { NotifyEvent, NotifyTone, NotifyCategory } from "@/lib/notify/events";

/**
 * Fire-and-forget push. The lazy import breaks the notify → push → db cycle,
 * and a failure here must never surface to the action that wrote the row: the
 * durable Notification is the source of truth, a push is best-effort.
 */
function firePush(
  userIds: string[],
  payload: { title: string; message: string; link?: string | null; category?: string | null }
): void {
  if (userIds.length === 0) return;
  import("@/lib/push/notify")
    .then((m) => m.pushForNotificationRows(userIds.map((userId) => ({ userId, ...payload }))))
    .catch(() => {});
}

export type NotifyInput = {
  event: NotifyEvent;
  /** Recipients. Deduplicated; empty ids and `exclude` are dropped. */
  userIds: string[];
  companyId: string;
  title: string;
  message: string;
  category: NotifyCategory;
  tone?: NotifyTone;
  link?: string;
  /**
   * Project scope. `lib/queries/notifications.ts` uses it to strip finance
   * pings from members unless they are attached to that project, so pass it
   * wherever the notification is about a project.
   */
  projectId?: string | null;
  /**
   * Usually the actor. Nobody should be notified about their own action, and
   * every call site used to hand-roll this check — several with subtly
   * different conditions.
   */
  exclude?: string | string[] | null;
  /**
   * The caller's transaction client, when the notification must land or roll
   * back with the rest of the write. Omit to write on the base client, which
   * is what you want for fan-out that is recoverable on its own (a missing
   * mention ping is survivable; a missing comment is not).
   *
   * Typed structurally, matching `logProjectActivity`'s `Pick<typeof db, …>`,
   * so both `db` and a `$transaction` callback's `tx` satisfy it.
   */
  tx?: Pick<typeof db, "notification" | "notificationPreference" | "user">;
};

/**
 * Deliver one event to a set of people, on whichever channels each of them
 * still has switched on.
 *
 * Returns how many in-app rows were actually written — callers surface that
 * honestly rather than claiming a ping they did not send (see
 * `createCommentAction`'s toast). Someone who has muted in-app for this event
 * is not counted, which is correct: they were not notified.
 */
export async function notifyUsers(input: NotifyInput): Promise<{ notified: number }> {
  const excluded = new Set(
    input.exclude == null ? [] : Array.isArray(input.exclude) ? input.exclude : [input.exclude]
  );

  const recipients = Array.from(new Set(input.userIds)).filter((id) => id && !excluded.has(id));
  if (recipients.length === 0) return { notified: 0 };

  const client = input.tx ?? db;

  // One query for everyone's preferences, not one per recipient. Absent rows
  // fall back to DEFAULT_CHANNELS inside splitByChannel.
  const stored = await client.notificationPreference.findMany({
    where: { userId: { in: recipients }, event: input.event },
    select: { userId: true, event: true, inApp: true, email: true, push: true },
  });

  const channels = splitByChannel(input.event, recipients, stored);

  // Nothing is going anywhere on any channel — don't spend a round trip
  // resolving people we are not about to deliver to.
  if (channels.inApp.length + channels.push.length + channels.email.length === 0) {
    return { notified: 0 };
  }

  // THE TOMBSTONE FILTER, FOR EVERY CHANNEL (data-integrity-004).
  //
  // This used to sit on the EMAIL branch alone, with a comment explaining that a
  // soft-deleted user must not keep receiving mail — while the in-app
  // `createMany` directly below wrote a row for whoever it was handed, and
  // `firePush` delivered to their phone. Recipient lists legitimately contain
  // people who have since been deactivated: a departed teammate is still
  // `Task.assignedTo` and still named in stored `mentions`, so call sites can and
  // do pass their id.
  //
  // What that cost: a removed employee's phone kept buzzing with "New expense —
  // Ahmed logged 2,500,000 PKR" from a workspace they had lost access to — a push
  // payload carries the title and body verbatim, outside the app, where no
  // session check applies — and their Notification rows piled up for ever, ready
  // to flood back if the account was ever reactivated.
  //
  // Resolved ONCE, here, so no channel can be added later that forgets: the same
  // read that filters the tombstones also supplies the email addresses. The
  // delivery boundary (`sendPushToUsers`) filters again on its own, deliberately.
  const live = await client.user.findMany({
    where: { id: { in: recipients }, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  if (live.length === 0) return { notified: 0 };
  const liveIds = new Set(live.map((u) => u.id));
  const inAppTo = channels.inApp.filter((id) => liveIds.has(id));
  const pushTo = channels.push.filter((id) => liveIds.has(id));
  const emailTo = live.filter((u) => channels.email.indexOf(u.id) !== -1);

  let notified = 0;
  if (inAppTo.length > 0) {
    const { count } = await client.notification.createMany({
      data: inAppTo.map((userId) => ({
        userId,
        companyId: input.companyId,
        projectId: input.projectId ?? null,
        title: input.title,
        message: input.message,
        type: input.tone ?? "info",
        category: input.category,
        link: input.link ?? null,
      })),
    });
    notified = count;
  }

  firePush(pushTo, {
    title: input.title,
    message: input.message,
    link: input.link ?? null,
    category: input.category,
  });

  if (emailTo.length > 0) {
    // Addresses are not on the input — the call sites have user ids, not
    // mailboxes — so they come from the same live-recipient read above.
    fireNotificationEmails({
      event: input.event,
      recipients: emailTo,
      title: input.title,
      message: input.message,
      link: input.link ?? null,
    });
  }

  return { notified };
}
