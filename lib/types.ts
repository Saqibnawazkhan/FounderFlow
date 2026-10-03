export type UserRole = "admin" | "cofounder" | "member";

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  avatar?: string;
  companyId: string;
  createdAt: string;
}

export interface Company {
  id: string;
  name: string;
  industry: string;
  currency: string;
  createdAt: string;
  ownerId: string;
}

/** A still-unused invite shown in the roster's pending-invites panel (X7). */
export interface PendingInvite {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

/** A soft-deleted teammate shown in the roster's deactivated panel (X8). */
export interface DeactivatedUser {
  id: string;
  name: string;
  email: string;
  role: string;
  deactivatedAt: string;
}

export type TransactionType = "expense" | "investment" | "income";

export interface Transaction {
  id: string;
  companyId: string;
  type: TransactionType;
  amount: number;
  category: string;
  description: string;
  date: string;
  addedBy: string;
  addedByName: string;
  createdAt: string;
}

export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
  id: string;
  companyId: string;
  // projectId is required after the add_projects migration. Pre-projects
  // rows were back-filled to a per-company "General" project.
  projectId: string;
  projectName?: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: string;
  assignedToName: string;
  assignedBy: string;
  assignedByName: string;
  deadline: string;
  createdAt: string;
  completedAt?: string;
  // Manual sort key for kanban reorder (smaller = higher in the column).
  order: number;
}

export type ActivityType =
  | "expense_added"
  | "investment_added"
  | "revenue_added"
  | "task_assigned"
  | "task_completed"
  | "task_updated"
  | "user_joined"
  | "user_removed"
  | "user_role_changed"
  | "company_created"
  | "transaction_deleted"
  // money-016. A ledger line can now be CORRECTED rather than only destroyed,
  // and an edit that left no trace would be the worse half of that trade: the
  // row's figure is what every roll-up sums. The activity row carries the old
  // and the new amount (see `previousAmount` below).
  | "transaction_edited"
  | "task_deleted"
  | "task_created"
  | "project_created"
  | "project_updated"
  | "project_archived"
  | "project_supervisor_changed"
  // Channel lifecycle only. There is deliberately NO activity per message —
  // one row per message would drown /activities, which members cannot see
  // anyway. See lib/actions/chat.ts.
  | "channel_created"
  | "channel_archived"
  // sec-020. Security events, written by lib/activity/security-log.ts. The
  // workspace already recorded what people did to each OTHER (roles, invites,
  // deactivations) and nothing about what they did to an ACCOUNT or to the data
  // in bulk, so "when did my email change?" and "did someone export our books?"
  // had no data to answer from. There is deliberately no `session_revoked`:
  // `bumpSessionVersion` has no caller yet (the "log out all devices" control
  // was never built), and a type nothing writes is this repo's other recurring
  // defect rather than coverage.
  | "workspace_exported"
  | "email_changed"
  | "password_changed";

/**
 * The JSON blob on `Activity.metadata`, parsed and cast (never validated — it
 * is a text column).
 *
 * `currency` on the transaction variant is money-006. `Activity.message` is
 * prose written once and read forever, so whatever figure and whatever currency
 * label the writer interpolated is frozen into a customer's history and no later
 * code change repairs it. Carrying the RAW amount and the code it was written in
 * lets a reader format at read time instead — see lib/activity/message.ts, which
 * is the reader, and lib/actions/transactions.ts:212, which is the writer.
 *
 * It is optional because rows written before 2026-09-28 do not have it, and
 * those rows must keep parsing. `recurring` / `description` / `dueDate` are the
 * extra keys the recurring writers have always put here; declaring them stops
 * the next reader believing the blob is narrower than it is.
 */
export type ActivityMetadata =
  | {
      kind: "transaction";
      amount: number;
      category: string;
      /** ISO 4217 code the amount was RECORDED in. Absent on legacy rows. */
      currency?: string;
      /**
       * money-016, on a `transaction_edited` row only: the amount the row held
       * BEFORE the correction, in the same `currency` as `amount`.
       *
       * It is the structured half of the audit trail, and it exists for the same
       * reason `currency` does — `message` is prose frozen on the day it was
       * written, so the figure a reader can trust has to be a number in the
       * metadata. Absent on every other row type.
       */
      previousAmount?: number;
      description?: string;
      recurring?: boolean;
      dueDate?: string;
    }
  | { kind: "task"; taskId: string; title: string }
  | { kind: "user"; invitedUser?: string; role?: UserRole; previousRole?: UserRole }
  | { kind: "project"; projectId: string; projectName: string }
  | { kind: "none" };

export interface Activity {
  id: string;
  companyId: string;
  type: ActivityType;
  message: string;
  userId: string;
  userName: string;
  metadata?: ActivityMetadata;
  createdAt: string;
}

export type NotificationCategory = "task" | "finance" | "team" | "system";

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  task: "Tasks",
  finance: "Finance",
  team: "Team",
  system: "System",
};

export interface Notification {
  id: string;
  userId: string;
  companyId: string;
  title: string;
  message: string;
  type: "info" | "success" | "warning" | "danger";
  category: NotificationCategory;
  read: boolean;
  link?: string;
  createdAt: string;
}

export const EXPENSE_CATEGORIES = [
  "Office Rent",
  "Salaries",
  "Marketing",
  "Software",
  "Equipment",
  "Travel",
  "Utilities",
  "Legal & Accounting",
  "Food & Beverages",
  "Miscellaneous",
];

export const INVESTMENT_CATEGORIES = [
  "Seed Capital",
  "Personal Investment",
  "Revenue Reinvestment",
  "Loan",
  "External Investor",
  "Grant",
];

// Sales / earned revenue — money the business EARNS, distinct from investment
// capital. A third transaction `type: "income"` uses these so a real sale is
// never mis-booked as founder capital (which would inflate the cap table).
export const REVENUE_CATEGORIES = [
  "Product Sales",
  "Service Revenue",
  "Subscriptions",
  "Consulting",
  "Licensing",
  "Interest & Other",
];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin Founder",
  cofounder: "Co-Founder",
  member: "Team Member",
};
