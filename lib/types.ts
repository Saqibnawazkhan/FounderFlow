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
  | "task_deleted";

export type ActivityMetadata =
  | { kind: "transaction"; amount: number; category: string }
  | { kind: "task"; taskId: string; title: string }
  | { kind: "user"; invitedUser?: string; role?: UserRole; previousRole?: UserRole }
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

export interface Notification {
  id: string;
  userId: string;
  companyId: string;
  title: string;
  message: string;
  type: "info" | "success" | "warning" | "danger";
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
