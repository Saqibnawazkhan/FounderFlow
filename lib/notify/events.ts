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
 * Order is the render order of that matrix, so it is grouped too: `mention`
 * and `dm` lead because both mean "a person addressed me by name and is
 * waiting", and a matrix that scattered those between task and money rows
 * would make the two switches people actually look for the hardest to find.
 */
export const NOTIFY_EVENTS = [
  "mention",
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
    label: "Mentions",
    description: "Someone @mentions you in a comment.",
    actionLabel: "Read the comment",
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
 * Exists because "every event × every channel" stopped being true. The DM
 * fan-out passes `skipInApp` (lib/notify/fan-out.ts), so no in-app row is ever
 * written for a direct message — its unread signal is the badge on the
 * sidebar's Chat row instead. Without this map the preferences matrix would go
 * on rendering an "In app" checkbox for direct messages: a control that saves
 * happily, reads back correctly, and governs nothing. This codebase has shipped
 * that shape of defect often enough to name it.
 *
 * `mention` keeps all three, and not as an oversight. A badge counts messages;
 * it cannot say that one of them named you. So an @mention still writes its
 * row — in chat as well as in task and transaction comments — and the switch
 * for it stays honest because every source of the event still honours it.
 *
 * `tests/lib/notify/fan-out-sites.test.ts` derives the truth from the call
 * sites and fails if this map disagrees, so it cannot rot into decoration.
 */
export const EVENT_DELIVERABLE_CHANNELS: Record<NotifyEvent, readonly NotifyChannel[]> = {
  mention: NOTIFY_CHANNELS,
  dm: ["email", "push"],
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
 */
export const EVENT_CHANNEL_NOTE: Partial<Record<NotifyEvent, string>> = {
  dm: "Direct messages appear on the Chat badge in the sidebar, not in your notifications.",
};
