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

export type TransactionType = "expense" | "investment";

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
  | "task_assigned"
  | "task_completed"
  | "task_updated"
  | "user_joined"
  | "user_removed"
  | "user_role_changed"
  | "company_created"
  | "transaction_deleted"
  | "task_deleted"
  | "task_created"
  | "project_created"
  | "project_updated"
  | "project_archived"
  | "project_supervisor_changed";

export type ActivityMetadata =
  | { kind: "transaction"; amount: number; category: string }
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

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin Founder",
  cofounder: "Co-Founder",
  member: "Team Member",
};

export const ROLE_COLORS: Record<UserRole, string> = {
  admin: "bg-gradient-to-r from-amber-500 to-orange-500",
  cofounder: "bg-gradient-to-r from-brand-500 to-accent-500",
  member: "bg-gradient-to-r from-emerald-500 to-teal-500",
};
