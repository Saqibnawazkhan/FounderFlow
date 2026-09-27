/**
 * Central list of primary app destinations. Shared by the sidebar (renders as
 * a permanent nav rail) and the command palette (fuzzy-searchable jump list).
 *
 * Keep `NAV_ITEMS` the single source of truth — adding a route in one place
 * and not the other is how "Cmd-K can't find X" bugs happen.
 *
 * Two shapes, one list:
 *   • `NAV_ITEMS` — flat. What the command palette searches, and what the
 *     member route filter runs over. Every destination appears here.
 *   • `NAV_TREE` — the same items, with the five finance surfaces folded into
 *     one collapsible group so the sidebar shows 11 rows instead of 15. Built
 *     BY LOOKUP from NAV_ITEMS (see `item()`), so the two cannot drift: a
 *     typo'd href throws at module load, and a unit test pins that every flat
 *     item appears in the tree exactly once.
 *
 * The grouping is presentational only. Routes, permissions and the palette are
 * untouched — searching "budgets" in Cmd-K still jumps straight there.
 */
import {
  BarChart3,
  Bell,
  Briefcase,
  CheckSquare,
  Clock,
  Coins,
  LayoutDashboard,
  MessageSquare,
  Repeat,
  Settings,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
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
  { href: "/chat", icon: MessageSquare, labelKey: "chat" },
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

/**
 * A collapsible group of destinations. Rendered as one sidebar row that
 * expands; in the icon-only rail (no room for a submenu) the row links
 * straight to `href` instead.
 */
export type NavGroup = {
  id: string;
  icon: typeof LayoutDashboard;
  labelKey: keyof Strings["nav"];
  /** Where the group row goes when there's no room to expand. */
  href: string;
  children: NavItem[];
};

export type NavNode = NavItem | NavGroup;

export function isNavGroup(node: NavNode): node is NavGroup {
  return "children" in node;
}

/** Look a flat item up by href. Throws at module load on a typo. */
function item(href: string): NavItem {
  const found = NAV_ITEMS.find((i) => i.href === href);
  if (!found) throw new Error(`NAV_TREE references unknown href: ${href}`);
  return found;
}

/**
 * The five money surfaces, folded into one row. All of them are in
 * MEMBER_BLOCKED_ROUTES, so for a member the whole group filters away
 * together and no empty "Finance" row is left behind — pinned by a test.
 */
export const FINANCE_GROUP: NavGroup = {
  id: "finance",
  icon: Wallet,
  labelKey: "finance",
  // Expenses is the most-used of the five and the rail has no submenu.
  href: "/expenses",
  children: [
    item("/expenses"),
    item("/revenue"),
    item("/investments"),
    item("/recurring"),
    item("/budgets"),
  ],
};

/** Sidebar shape: same destinations, finance collapsed into one row. */
export const NAV_TREE: NavNode[] = [
  item("/dashboard"),
  // Chat sits above Finance: it's a primary daily surface, open to every
  // role (sensitivity is per-channel membership, not company role).
  item("/chat"),
  FINANCE_GROUP,
  item("/projects"),
  item("/tasks"),
  item("/time"),
  item("/activities"),
  item("/team"),
  item("/reports"),
  item("/notifications"),
  item("/settings"),
];
