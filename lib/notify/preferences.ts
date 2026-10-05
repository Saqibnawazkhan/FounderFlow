/**
 * Delivery-preference resolution. Pure — no I/O — so the defaults and the
 * override logic are unit-testable without a database.
 *
 * A user with no stored row uses `DEFAULT_CHANNELS`. That is deliberate: it
 * means signup writes nothing, a new NotifyEvent ships without a backfill, and
 * the defaults can be retuned later without rewriting anyone's saved choices.
 * The cost is that "unset" and "set to exactly the default" are the same
 * state, which is fine — nothing needs to tell them apart.
 */

import { NOTIFY_EVENTS, type ChannelSet, type NotifyEvent } from "./events";

/**
 * What each event does when nobody has said otherwise.
 *
 * The interesting decisions are the `false`s:
 *
 *   • `transaction_logged` emails and pushes are OFF. It fires at every
 *     teammate on every expense, revenue and investment row — on a workspace
 *     logging a dozen expenses a day that is a dozen emails a day, each
 *     saying nothing actionable. In-app it is useful ambient awareness; in an
 *     inbox it is why people mute products. Gmail's free tier also caps at
 *     ~500 sends/day (lib/email/send.ts), which this event alone could eat.
 *
 *   • `task_completed` email is OFF. You get told in-app and by push that the
 *     thing you asked for is done; an email as well is one channel too many
 *     for something that needs no response.
 *
 *   • `chat_mention` and `dm` email are OFF — the whole of the chat-volume
 *     fix the owner asked for on 2026-10-05, stated as a default. A chat
 *     mention and a DM are both one person addressing one person, which is why
 *     they still push and why a mention still keeps its in-app row. What they
 *     are not is occasional: chat arrives at typing speed, so an email per
 *     message is hundreds of them for anyone in a busy channel, and the shared
 *     `DAILY_NOTIFICATION_EMAIL_BUDGET` would be gone before a budget alert
 *     could claim it. `mention` — the SAME gesture in a task or money comment —
 *     keeps its email, which is exactly why the two are separate events.
 *
 *     These two `false`s are belt and braces rather than the mechanism:
 *     `EVENT_DELIVERABLE_CHANNELS` leaves email out for both events and
 *     `notifyUsers` enforces it, so email cannot be delivered for them however
 *     this row reads. The default still says `false` so that a preference row
 *     written from it, and the matrix built from it, state the same thing the
 *     delivery path does.
 *
 * Everything else is directed at one person and worth interrupting for.
 *
 * NOTE ON `dm.inApp`: it reads `true` and no in-app row is ever written for a
 * direct message — both DM fan-outs pass `skipInApp`, and
 * `EVENT_DELIVERABLE_CHANNELS` leaves `inApp` out of the row. The default is
 * not the thing deciding that, and the settings page never renders the cell.
 * Kept `true` rather than flipped so that "the default for every event is to
 * keep a durable record" stays a rule with no exceptions to remember (the
 * test in tests/lib/notify/preferences.test.ts asserts exactly that), and so
 * the value is already right if DMs ever get their row back.
 */
export const DEFAULT_CHANNELS: Record<NotifyEvent, ChannelSet> = {
  mention: { inApp: true, email: true, push: true },
  chat_mention: { inApp: true, email: false, push: true },
  dm: { inApp: true, email: false, push: true },
  task_assigned: { inApp: true, email: true, push: true },
  task_completed: { inApp: true, email: false, push: true },
  project_supervisor: { inApp: true, email: true, push: true },
  budget_alert: { inApp: true, email: true, push: true },
  transaction_logged: { inApp: true, email: false, push: false },
  team_change: { inApp: true, email: true, push: true },
};

/** The stored shape, narrowed to what resolution needs. */
export type StoredPreference = {
  event: string;
  inApp: boolean;
  email: boolean;
  push: boolean;
};

/**
 * The channels to use for one person and one event. A stored row wins over
 * the default; an unknown event falls back to in-app only, so a row written
 * by a newer deploy can never silently start emailing on an older one.
 */
export function resolveChannels(
  event: string,
  stored: StoredPreference | null | undefined
): ChannelSet {
  if (stored) {
    return { inApp: stored.inApp, email: stored.email, push: stored.push };
  }
  const fallback = DEFAULT_CHANNELS[event as NotifyEvent];
  return fallback ?? { inApp: true, email: false, push: false };
}

/**
 * Split a recipient list into one list per channel.
 *
 * `stored` is every preference row loaded for these recipients — the caller
 * does a single query rather than one per person. Rows for other events are
 * ignored, so the caller can pass whatever it has.
 */
export function splitByChannel(
  event: string,
  userIds: string[],
  stored: (StoredPreference & { userId: string })[]
): Record<keyof ChannelSet, string[]> {
  const byUser = new Map<string, StoredPreference>();
  for (const row of stored) {
    if (row.event === event) byUser.set(row.userId, row);
  }

  const out = { inApp: [] as string[], email: [] as string[], push: [] as string[] };
  for (const userId of userIds) {
    const channels = resolveChannels(event, byUser.get(userId));
    if (channels.inApp) out.inApp.push(userId);
    if (channels.email) out.email.push(userId);
    if (channels.push) out.push.push(userId);
  }
  return out;
}

/**
 * The full matrix for one person, defaults filled in — what the settings page
 * renders. Always returns every event, in `NOTIFY_EVENTS` order, so the table
 * cannot develop holes.
 */
export function matrixFor(
  stored: StoredPreference[]
): { event: NotifyEvent; channels: ChannelSet }[] {
  const byEvent = new Map(stored.map((r) => [r.event, r]));
  return NOTIFY_EVENTS.map((event) => ({
    event,
    channels: resolveChannels(event, byEvent.get(event)),
  }));
}
