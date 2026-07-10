/**
 * Central list of primary app destinations. Shared by the sidebar (renders as
 * a permanent nav rail) and the command palette (fuzzy-searchable jump list).
 *
 * Keep this the single source of truth — adding a route in one place and not
 * the other is how "Cmd-K can't find X" bugs happen.
 */
import {
  BarChart3,
  Bell,
  Briefcase,
  CheckSquare,
  Clock,
  Coins,
  LayoutDashboard,
  Repeat,
  Settings,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import type { Strings } from "@/lib/i18n/strings";

export type NavItem = {
  href: string;
  icon: typeof LayoutDashboard;
  labelKey: keyof Strings["nav"];
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", icon: LayoutDashboard, labelKey: "dashboard" },
  { href: "/expenses", icon: TrendingDown, labelKey: "expenses" },
  { href: "/investments", icon: TrendingUp, labelKey: "investments" },
  { href: "/revenue", icon: Coins, labelKey: "revenue" },
  { href: "/recurring", icon: Repeat, labelKey: "recurring" },
  { href: "/budgets", icon: Target, labelKey: "budgets" },
  { href: "/projects", icon: Briefcase, labelKey: "projects" },
  { href: "/tasks", icon: CheckSquare, labelKey: "tasks" },
  { href: "/time", icon: Clock, labelKey: "time" },
  { href: "/activities", icon: Zap, labelKey: "activity" },
  { href: "/team", icon: Users, labelKey: "team" },
  { href: "/reports", icon: BarChart3, labelKey: "reports" },
  { href: "/notifications", icon: Bell, labelKey: "notifications" },
  { href: "/settings", icon: Settings, labelKey: "settings" },
];
