/**
 * The notification event vocabulary.
 *
 * Its own module so `fan-out.ts` and `preferences.ts` can both depend on it
 * without importing each other.
 */

/**
 * What happened, from the recipient's point of view. These are the rows the
 * preferences matrix offers, so they are grouped to be meaningful to a person
 * rather than mirroring the call sites one-for-one — the three team events
 * (role changed, reactivated, welcomed) are one switch, not three.
 *
 * Order is the render order of that matrix, so it is grouped too: the three
 * "a person addressed me by name and is waiting" events lead, and a matrix
 * that scattered those between task and money rows would make the switches
 * people actually look for the hardest to find.
 *
 * `mention` AND `chat_mention` ARE TWO EVENTS ON PURPOSE, and the split is the
 * whole of what makes the chat-volume fix safe. Both start the same way —
 * someone typed your @handle — but they arrive at completely different rates
 * and therefore want completely different channels. A task or transaction
 * comment is an occasional, considered thing, and an email about it is the
 * point of the feature. A chat mention arrives as fast as people type, so an
 * email per mention is how a teammate in a busy channel collects hundreds of
 * them in an afternoon (reported by the owner, 2026-10-05) and how the shared
 * `DAILY_NOTIFICATION_EMAIL_BUDGET` gets spent before any budget alert or task
 * assignment can claim it.
 *
 * One event could not express that: the channels are a property OF THE EVENT,
 * so a single `mention` row means the preference that quietens chat also
 * quietens the comment mention nobody complained about. Two events keep one
 * switch per thing a person would actually want to decide separately, and the
 * fan-out is already keyed on the event, so nothing else in the path needed to
 * learn a new concept. `tests/lib/notify/fan-out-sites.test.ts` holds the two
 * apart at their call sites; `tests/lib/notify/chat-email-silence.test.ts`
 * drives both actions end to end.
 */
export const NOTIFY_EVENTS = [
  "mention",
  "chat_mention",
  "dm",
  "task_assigned",
  "task_completed",
  "project_supervisor",
  "budget_alert",
  "transaction_logged",
  "team_change",
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Visual tone, stored as `Notification.type`. */
export type NotifyTone = "info" | "success" | "warning" | "danger";

/** Topic bucket, stored as `Notification.category` — drives the /notifications filter. */
export type NotifyCategory = "task" | "finance" | "team" | "system";

/** The three ways a notification can reach someone. */
export const NOTIFY_CHANNELS = ["inApp", "email", "push"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export type ChannelSet = Record<NotifyChannel, boolean>;

/** Copy for the settings matrix and for notification email. Kept beside the
 *  union so adding an event without labelling it is a type error rather than a
 *  blank table row (or a button reading "undefined" in someone's inbox). */
export const EVENT_COPY: Record<
  NotifyEvent,
  { label: string; description: string; actionLabel: string }
> = {
  mention: {
    label: "Mentions in comments",
    description: "Someone @mentions you in a comment on a task or a money row.",
    actionLabel: "Read the comment",
  },
  chat_mention: {
    label: "Mentions in chat",
    description: "Someone @mentions you in a channel or a direct message.",
    // Carried for the same reason every other row carries one — the type
    // demands it and a future deploy could make email deliverable again — but
    // it is UNUSED today: `actionLabel` is only read by
    // lib/notify/email.ts, and email is not a deliverable channel for this
    // event (see EVENT_DELIVERABLE_CHANNELS below). It is kept true rather
    // than left as a placeholder, because a placeholder is what ends up in
    // somebody's inbox the day the rule changes.
    actionLabel: "Open the message",
  },
  dm: {
    label: "Direct messages",
    description: "A teammate sends you a direct message.",
    actionLabel: "Open the conversation",
  },
  task_assigned: {
    label: "Tasks assigned to me",
    description: "A teammate assigns you a task.",
    actionLabel: "Open the task",
  },
  task_completed: {
    label: "Tasks I created are finished",
    description: "Someone completes a task you assigned.",
    actionLabel: "See the task",
  },
  project_supervisor: {
    label: "Made a project supervisor",
    description: "You're put in charge of a project.",
    actionLabel: "Open the project",
  },
  budget_alert: {
    label: "Budget warnings",
    description: "A budget on your project crosses its warning or limit.",
    actionLabel: "Review the budget",
  },
  transaction_logged: {
    label: "Money logged",
    description: "A teammate records an expense, revenue or investment.",
    actionLabel: "Open finances",
  },
  team_change: {
    label: "Account and team changes",
    description: "Your role changes, or your access is restored.",
    actionLabel: "Go to the workspace",
  },
};

/**
 * Which of the three channels an event can ACTUALLY be delivered on.
 *
 * Exists because "every event × every channel" stopped being true, and it is
 * READ BY TWO PLACES, which is the thing to know before editing it:
 *
 *   1. `notifyUsers` (lib/notify/fan-out.ts) intersects every resolved
 *      recipient list with the row for that event, so a channel left out here
 *      cannot be delivered on at all — not by a default, not by a stored
 *      preference row, not by a caller who forgets a flag.
 *   2. The preferences matrix (components/settings/notification-matrix.tsx)
 *      renders a dash instead of a checkbox for the channels left out, with
 *      `EVENT_CHANNEL_NOTE` below as the explanation.
 *
 * It used to be read only by (2). That made it a description of behaviour
 * rather than the behaviour itself: a `NotificationPreference` row saying
 * `email: true` for a channel the UI never offers was still honoured by the
 * fan-out, and `updateNotificationPreferenceAction` accepts any (event,
 * channel) pair in NOTIFY_EVENTS × NOTIFY_CHANNELS, so one hand-made request
 * could re-open a channel the product had decided against. Enforcing it at the
 * one place delivery happens is what makes the two agree by construction.
 *
 * TWO DIFFERENT REASONS a channel is missing below, and they are worth keeping
 * straight because they fail in opposite directions:
 *
 *   • THE SURFACE OWNS THE SIGNAL. The DM fan-outs pass `skipInApp`, so no
 *     in-app row is ever written for a direct message — its unread signal is
 *     the badge on the sidebar's Chat row. Without this map the matrix would go
 *     on rendering an "In app" checkbox for direct messages: a control that
 *     saves happily, reads back correctly, and governs nothing. This codebase
 *     has shipped that shape of defect often enough to name it.
 *
 *   • VOLUME. Chat is not emailed, at all. Every chat message is a potential
 *     notification and people type as fast as they think, so email there is
 *     hundreds of messages in an inbox and a drained
 *     `DAILY_NOTIFICATION_EMAIL_BUDGET` for everybody else's alerts. That is
 *     why `chat_mention` exists as an event separate from `mention`: comments
 *     keep their email, chat loses it, and no single switch has to mean both.
 *
 * `chat_mention` keeps its IN-APP row, and that is not an oversight either. A
 * badge counts messages; it cannot say that one of them named you. So the
 * durable row is the only surface carrying "you were addressed", and the switch
 * for it stays honest because the one site that raises the event honours it.
 *
 * `tests/lib/notify/fan-out-sites.test.ts` derives the in-app truth from the
 * call sites and fails if this map disagrees, so it cannot rot into decoration.
 */
export const EVENT_DELIVERABLE_CHANNELS: Record<NotifyEvent, readonly NotifyChannel[]> = {
  mention: NOTIFY_CHANNELS,
  chat_mention: ["inApp", "push"],
  dm: ["push"],
  task_assigned: NOTIFY_CHANNELS,
  task_completed: NOTIFY_CHANNELS,
  project_supervisor: NOTIFY_CHANNELS,
  budget_alert: NOTIFY_CHANNELS,
  transaction_logged: NOTIFY_CHANNELS,
  team_change: NOTIFY_CHANNELS,
};

/**
 * Why a channel is unavailable, in the words of the person reading the
 * settings page. Shown in the cell where the checkbox would have been, because
 * a blank cell reads as a rendering bug.
 *
 * ONE STRING PER EVENT, not per cell, so a row missing two channels needs a
 * sentence that covers both — `dm` is now that case. An event that appears in
 * `EVENT_DELIVERABLE_CHANNELS` with a channel missing and has no entry here is
 * a defect, and `tests/lib/notify/preferences.test.ts` fails on it.
 */
export const EVENT_CHANNEL_NOTE: Partial<Record<NotifyEvent, string>> = {
  chat_mention:
    "Chat is never emailed — a busy channel would fill your inbox. A mention reaches you in your notifications, and as a push if you've allowed them.",
  dm: "Direct messages appear on the Chat badge in the sidebar rather than in your notifications, and chat is never emailed. Push is the only interruption they make.",
};
