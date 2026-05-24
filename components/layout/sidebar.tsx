"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart3,
  Bell,
  CheckSquare,
  Clock,
  FileText,
  Home,
  LayoutDashboard,
  Repeat,
  Settings,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { listNotificationsAction } from "@/lib/actions/notifications";
import { useT } from "@/lib/i18n/use-t";
import type { Strings } from "@/lib/i18n/strings";
import { cn } from "@/lib/utils";

// nav items pair href + icon + a function that returns the localized label.
// We deliberately don't bake the strings in at module scope — that'd
// freeze them at English on first render.
const navItems: {
  href: string;
  icon: typeof LayoutDashboard;
  labelKey: keyof Strings["nav"];
}[] = [
  { href: "/dashboard", icon: LayoutDashboard, labelKey: "dashboard" },
  { href: "/expenses", icon: TrendingDown, labelKey: "expenses" },
  { href: "/investments", icon: TrendingUp, labelKey: "investments" },
  { href: "/recurring", icon: Repeat, labelKey: "recurring" },
  { href: "/budgets", icon: Target, labelKey: "budgets" },
  { href: "/tasks", icon: CheckSquare, labelKey: "tasks" },
  { href: "/time", icon: Clock, labelKey: "time" },
  { href: "/activities", icon: Zap, labelKey: "activity" },
  { href: "/team", icon: Users, labelKey: "team" },
  { href: "/reports", icon: BarChart3, labelKey: "reports" },
  { href: "/notifications", icon: Bell, labelKey: "notifications" },
  { href: "/settings", icon: Settings, labelKey: "settings" },
];

export function Sidebar() {
  // Mobile open/close lives in Zustand so the topbar burger can drive it
  // without prop-drilling. We close on any pathname change so navigating
  // through the menu auto-dismisses the overlay.
  const mobileOpen = useStore((s) => s.mobileNavOpen);
  const setMobileOpen = useStore((s) => s.setMobileNavOpen);
  const pathname = usePathname();
  const currentUser = useStore((s) => s.currentUser);
  const companies = useStore((s) => s.companies);
  const t = useT();

  // Auto-close the mobile drawer when the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  // Lock body scroll while the drawer is open (mobile only).
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [mobileOpen]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [mobileOpen, setMobileOpen]);

  // Just the unread count for the nav badge — full notification list lives
  // in the topbar dropdown + /notifications page. Re-fetch every 30s so the
  // badge stays roughly current; could upgrade to Supabase realtime later.
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      const res = await listNotificationsAction();
      if (!cancelled && res.success) {
        setUnreadCount(res.data.filter((n) => !n.read).length);
      }
    }
    fetchCount();
    const id = setInterval(fetchCount, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const company = companies.find((c) => c.id === currentUser?.companyId);

  return (
    <>
      {/* Mobile overlay — burger now lives in the topbar */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-overlay bg-bg/70 backdrop-blur-sm lg:hidden"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside
        aria-label="Primary"
        className={cn(
          "fixed left-0 top-0 z-modal flex h-screen w-64 flex-col border-r border-border bg-surface transition-transform duration-300",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Brand */}
        <div className="flex h-16 items-center justify-between border-b border-border px-5">
          <Link
            href="/dashboard"
            className="flex items-center gap-2"
            onClick={() => setMobileOpen(false)}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary shadow-glow">
              <Sparkles className="h-5 w-5 text-primary-fg" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-bold">FounderFlow</p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                {t.common.workspace}
              </p>
            </div>
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation menu"
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-hover lg:hidden"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Company */}
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-3 rounded-xl bg-bg p-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary font-bold text-primary-fg">
              {company?.name?.[0] || "C"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{company?.name || "Your Company"}</p>
              <p className="truncate text-xs text-fg-muted">{company?.industry}</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav
          aria-label="Main navigation"
          className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4"
        >
          <div className="space-y-1">
            {navItems.map((item) => {
              const active = pathname === item.href;
              const isNotifs = item.href === "/notifications";
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
                    active
                      ? "border border-primary/30 bg-primary/10 text-fg"
                      : "text-fg-muted hover:bg-surface-hover hover:text-fg"
                  )}
                >
                  {active && (
                    <motion.div
                      layoutId="sidebar-active"
                      className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-primary"
                      transition={{ duration: 0.2 }}
                    />
                  )}
                  <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{t.nav[item.labelKey]}</span>
                  {isNotifs && unreadCount > 0 && (
                    <span
                      aria-label={`${unreadCount} unread notifications`}
                      className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white"
                    >
                      {unreadCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* User */}
        <div className="border-t border-border p-4">
          <Link
            href="/settings"
            className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-surface-hover"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan text-sm font-semibold text-primary-fg">
              {currentUser?.name?.[0] || "U"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{currentUser?.name}</p>
              <p className="truncate text-xs capitalize text-fg-muted">
                {currentUser?.role === "admin"
                  ? "Admin Founder"
                  : currentUser?.role === "cofounder"
                    ? "Co-Founder"
                    : "Team Member"}
              </p>
            </div>
          </Link>
        </div>
      </aside>
    </>
  );
}
