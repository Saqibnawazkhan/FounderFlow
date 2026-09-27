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
