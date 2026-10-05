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
import { EVENT_DELIVERABLE_CHANNELS } from "@/lib/notify/events";
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
  /**
   * Refuse the in-app row for this call, whatever each recipient's preference
   * says. Push and email are untouched.
   *
   * For the ONE case where a surface owns its own unread signal and a
   * notification row would be a duplicate of it: a direct message. A DM used to
   * write a row that sat under the bell, next to budget alerts and task
   * assignments, while the word "Chat" in the sidebar showed nothing — so the
   * app's most conversational event was announced in its least conversational
   * place, and there was no way to tell "I have unread messages" from "someone
   * changed a role" without opening both. The Chat row's badge replaced it.
   *
   * NOT used for chat @mentions, which still write their row. The badge counts
   * messages and cannot say that one of them named you, so for the event that
   * names a person the durable row is the only surface that carries the fact.
   *
   * NOT a preference and not a default, so it cannot silently swallow anyone
   * else's notifications: it is per-call, and `EVENT_DELIVERABLE_CHANNELS` in
   * lib/notify/events.ts records which events are affected so the preferences
   * matrix cannot go on offering a switch for a row that is never written.
   *
   * Push and email deliberately survive THE FLAG. "Don't put it in my
   * notification list" and "don't tell me a teammate messaged me while I was
   * away" are different requests, and the second one already has a control:
   * mute the channel, or turn the event off in settings.
   *
   * For a DM that now leaves push alone, because email stopped being
   * deliverable for chat at all (the owner's volume report of 2026-10-05 —
   * `EVENT_DELIVERABLE_CHANNELS`, one layer above this flag). The two
   * suppressions are independent and happen to meet on `dm`: this one is per
   * call, that one is per event, and neither implies the other.
   */
  skipInApp?: boolean;
};

/**
 * Deliver one event to a set of people, on whichever channels each of them
 * still has switched on.
 *
 * Returns how many in-app rows were actually written — callers surface that
 * honestly rather than claiming a ping they did not send (see
 * `createCommentAction`'s toast). Someone who has muted in-app for this event
 * is not counted, which is correct: they were not notified.
 *
 * ALSO RETURNS `dispatched`: how many distinct live people this call SENT
 * something to, on any of the three channels. `notified` cannot answer that,
 * and a caller that suppresses the in-app row (`skipInApp`) would otherwise
 * have to report "pinged 0" over a message that went out to everyone by push.
 * The two are deliberately separate numbers rather than one redefined one:
 * every existing caller means "in-app rows written" by `notified`, and quietly
 * widening it would make each of those claims say something it was not written
 * to say.
 *
 * IT IS DISPATCH, NOT DELIVERY, and the name says so on purpose. Its in-app
 * share is real — those rows are written before this returns. Push and email
 * are not: `firePush` and `fireNotificationEmails` are both fire-and-forget
 * behind a dynamic import, so a recipient who has push on but no subscribed
 * device, or whose mail falls outside the daily budget, still counts here.
 * Synchronously, dispatch is the strongest fact this function has. An earlier
 * draft called it `reached`, which promises a delivery receipt nothing in this
 * path can produce.
 */
export async function notifyUsers(
  input: NotifyInput
): Promise<{ notified: number; dispatched: number }> {
  const excluded = new Set(
    input.exclude == null ? [] : Array.isArray(input.exclude) ? input.exclude : [input.exclude]
  );

  const recipients = Array.from(new Set(input.userIds)).filter((id) => id && !excluded.has(id));
  if (recipients.length === 0) return { notified: 0, dispatched: 0 };

  const client = input.tx ?? db;

  // One query for everyone's preferences, not one per recipient. Absent rows
  // fall back to DEFAULT_CHANNELS inside splitByChannel.
  const stored = await client.notificationPreference.findMany({
    where: { userId: { in: recipients }, event: input.event },
    select: { userId: true, event: true, inApp: true, email: true, push: true },
  });

  const resolved = splitByChannel(input.event, recipients, stored);

  // THE DELIVERABLE-CHANNEL RULE, ENFORCED RATHER THAN DESCRIBED.
  //
  // `EVENT_DELIVERABLE_CHANNELS` says which channels an event can be delivered
  // on at all — chat is not emailed, a DM writes no in-app row — and until the
  // chat-email fix it was read by the SETTINGS PAGE AND NOTHING ELSE. That made
  // it a comment with a type annotation: the matrix rendered a dash where the
  // checkbox would be, and the fan-out went on honouring whatever
  // `splitByChannel` resolved. A `NotificationPreference` row with `email: true`
  // for `chat_mention` would still have emailed, and
  // `updateNotificationPreferenceAction` accepts any (event, channel) pair in
  // NOTIFY_EVENTS × NOTIFY_CHANNELS, so that row is one hand-made request away
  // — as is a stale row left behind by any future change to this map.
  //
  // Intersecting here means the map is the single statement of the rule and
  // delivery cannot disagree with the UI. It is a no-op for every event whose
  // row is all three channels, which is every event but chat's two.
  const deliverable = EVENT_DELIVERABLE_CHANNELS[input.event];
  const offered = {
    inApp: deliverable.indexOf("inApp") === -1 ? [] : resolved.inApp,
    email: deliverable.indexOf("email") === -1 ? [] : resolved.email,
    push: deliverable.indexOf("push") === -1 ? [] : resolved.push,
  };

  // `skipInApp` is applied HERE, before the reachability test below, so the
  // suppression is expressed once and every later step agrees with it: someone
  // whose only enabled channel is in-app now correctly counts as unreachable,
  // the finance filter and the tombstone read are not spent on them, and
  // `notified` comes out 0 because no row was written rather than because one
  // was discarded.
  //
  // It stays a separate mechanism from the map above, and the two overlap on
  // `dm` deliberately. The map is a standing property of the EVENT; `skipInApp`
  // is a decision one CALL makes, and the structural test derives the map from
  // those calls (tests/lib/notify/fan-out-sites.test.ts) — so dropping the flag
  // because the map now covers the same case would delete the evidence the map
  // is checked against.
  const channels = input.skipInApp ? { ...offered, inApp: [] } : offered;

  // Everyone some channel would actually reach. Nothing is going anywhere when
  // this is empty, so don't spend a round trip — and don't ask the finance rule
  // below about people who muted every channel either.
  const reachable = recipients.filter(
    (id) =>
      channels.inApp.indexOf(id) !== -1 ||
      channels.push.indexOf(id) !== -1 ||
      channels.email.indexOf(id) !== -1
  );
  if (reachable.length === 0) return { notified: 0, dispatched: 0 };

  // THE FINANCE ENTITLEMENT FILTER (sec-005).
  //
  // Members never see finance pages — audit-flow #1 in CLAUDE.md — and
  // `visibleNotifications` enforces that when a notification is READ. Read-time
  // is the last line and for two of the three channels it is no line at all:
  // this function writes the in-app row, fires push and sends email before any
  // reader calls any filter. `addTransactionAction` fans `transaction_logged` at
  // every other member of the company with `message: "<name> logged 2,500,000
  // PKR"`, and when the expense carries a projectId the link is `/projects/<id>`,
  // which is not a member-blocked route — so a member with that event's push or
  // email switched on received the figure on their lock screen and in their
  // inbox, outside the app, where nothing downstream can reach it.
  //
  // Narrowing the RECIPIENT LIST is the only place that covers all three
  // channels at once. The rule itself lives in lib/queries/notifications beside
  // the read-time filter it has to agree with (a second copy is how the two
  // would drift) and is unit-tested there; what is asserted here is the wiring.
  //
  // IMPORTED LAZILY, like `firePush` above and for the same kind of reason: that
  // module reaches `requireScopedSession`, and therefore next-auth, which has no
  // business in the static graph of every server action that sends a
  // notification. The cost is paid on finance events only.
  //
  // It reads the base client rather than `input.tx`: `NotifyInput.tx` is typed
  // `Pick<typeof db, "notification" | "notificationPreference" | "user">` and has
  // no `project` delegate, and the rows the rule reads (the roster, and the
  // project's supervisor) are rows no finance caller's transaction writes —
  // `addTransactionAction` creates a Transaction, an Activity and the
  // notifications, and `checkBudgetThresholdAfterExpense` reads. A plain SELECT
  // on another connection does not block on their uncommitted writes either. If a
  // future finance event ever fires from a transaction that CREATES the project
  // it is scoped to, this read will not see it and the supervisor would be
  // dropped — fail-closed, but it would need `project` on the tx type to fix.
  let allowed = reachable;
  if (input.category === "finance") {
    const { financeRecipients } = await import("@/lib/queries/notifications");
    allowed = await financeRecipients(reachable, {
      companyId: input.companyId,
      // Explicitly null, never undefined: an unscoped money ping is a
      // company-wide one, and the rule refuses those for a member. `undefined`
      // would read as "no opinion" to anything stricter added later.
      projectId: input.projectId ?? null,
    });
    if (allowed.length === 0) return { notified: 0, dispatched: 0 };
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
    where: { id: { in: allowed }, deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  if (live.length === 0) return { notified: 0, dispatched: 0 };
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

  // Distinct PEOPLE, not deliveries: someone with in-app, push and email all on
  // is one person dispatched, not three. Built with a Set rather than a spread of
  // one — this repo's tsconfig sets `lib` but no `target`, so `[...aSet]` is a
  // typecheck error that vitest's esbuild transpile does not reproduce.
  const dispatchedIds = new Set<string>(inAppTo);
  for (const id of pushTo) dispatchedIds.add(id);
  for (const u of emailTo) dispatchedIds.add(u.id);

  return { notified, dispatched: dispatchedIds.size };
}
