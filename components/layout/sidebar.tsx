"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { useStore, useStoreHasHydrated } from "@/lib/store";
import { listNotificationsAction } from "@/lib/actions/notifications";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { homeRouteForRole, isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";
import { NAV_ITEMS } from "@/lib/nav";

export function Sidebar() {
  // Mobile open/close lives in Zustand so the topbar burger can drive it
  // without prop-drilling. We close on any pathname change so navigating
  // through the menu auto-dismisses the overlay.
  const mobileOpen = useStore((s) => s.mobileNavOpen);
  const setMobileOpen = useStore((s) => s.setMobileNavOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = useStore((s) => s.toggleSidebarCollapsed);
  const pathname = usePathname();
  const currentUser = useStore((s) => s.currentUser);
  const companies = useStore((s) => s.companies);
  const currentCompany = useStore((s) => s.currentCompany);
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

  // Prefer the real DB company (hydrated by CompanyHydrator) over the demo
  // seed array, so an authenticated user sees their actual workspace name
  // instead of "Your Company". Demo mode still falls back to the seed.
  const demoCompany = companies.find((c) => c.id === currentUser?.companyId);
  const companyName = currentCompany?.name ?? demoCompany?.name ?? "Your Company";
  const companyIndustry = currentCompany?.industry ?? demoCompany?.industry;

  // Hide finance-only nav items from members. The middleware enforces the
  // same rule on direct navigation, so this is purely a "don't tease them
  // with links they can't open" affordance.
  //
  // Gate on hydration: during the ~50ms before Zustand persist replays from
  // localStorage, `currentUser` is null and our role fallback is "member".
  // Without the hydration gate, an admin sees the member-restricted sidebar
  // for that window. We optimistically show ALL nav items until hydration
  // completes — middleware still blocks members from finance pages, so a
  // member who clicks a finance link mid-hydration just gets bounced.
  const hasHydrated = useStoreHasHydrated();
  const role: Role = (currentUser?.role as Role | undefined) ?? "member";
  const visibleNavItems =
    hasHydrated && role === "member"
      ? NAV_ITEMS.filter((item) => !isMemberBlockedRoute(item.href))
      : NAV_ITEMS;
  // Brand logo also routes to the role-appropriate home so members don't
  // hit a /dashboard bounce when they click the logo.
  const brandHref = homeRouteForRole(role);

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
        // Collapsed rail is desktop-only: mobile always uses the full-width
        // drawer overlay because a 64px thumbstrip on a phone is worse UX
        // than a proper burger menu.
        className={cn(
          "fixed left-0 top-0 z-modal flex h-[100dvh] w-64 flex-col border-r border-border bg-surface transition-[transform,width] duration-300",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
          collapsed && "lg:w-16"
        )}
      >
        {/* Brand */}
        <div
          className={cn(
            "flex h-16 items-center justify-between border-b border-border transition-[padding] duration-300",
            collapsed ? "px-2 lg:justify-center" : "px-5"
          )}
        >
          <Link
            href={brandHref}
            className="flex items-center gap-2"
            onClick={() => setMobileOpen(false)}
            aria-label="FounderFlow home"
          >
            <BrandMark className="h-9 w-9 shrink-0" />
            {!collapsed && (
              <div>
                <p className="text-sm font-bold">FounderFlow</p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                  {t.common.workspace}
                </p>
              </div>
            )}
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation menu"
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-hover lg:hidden",
              collapsed && "lg:hidden"
            )}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Company */}
        {!collapsed && (
          <div className="border-b border-border px-5 py-4">
            <div className="flex items-center gap-3 rounded-xl bg-bg p-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary font-bold text-primary-fg">
                {companyName[0] || "C"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{companyName}</p>
                <p className="truncate text-xs text-fg-muted">{companyIndustry}</p>
              </div>
            </div>
          </div>
        )}

        {/* Nav */}
        <nav
          aria-label="Main navigation"
          className={cn("scrollbar-thin flex-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}
        >
          <div className="space-y-1">
            {visibleNavItems.map((item) => {
              const active = pathname === item.href;
              const isNotifs = item.href === "/notifications";
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                  title={collapsed ? t.nav[item.labelKey] : undefined}
                  className={cn(
                    "relative flex items-center gap-3 rounded-xl text-sm font-medium transition-all",
                    collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5",
                    active
                      ? "border border-primary/50 bg-primary/[0.14] text-fg shadow-[inset_2px_0_0_0_rgb(var(--primary))]"
                      : "text-fg-muted hover:bg-surface-hover hover:text-fg"
                  )}
                >
                  <item.icon
                    className={cn("h-4 w-4 shrink-0", active && "text-primary-strong")}
                    aria-hidden="true"
                  />
                  {!collapsed && (
                    <>
                      <span className="flex-1">{t.nav[item.labelKey]}</span>
                      {isNotifs && unreadCount > 0 && (
                        <span
                          aria-label={`${unreadCount} unread notifications`}
                          className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white"
                        >
                          {unreadCount}
                        </span>
                      )}
                    </>
                  )}
                  {collapsed && isNotifs && unreadCount > 0 && (
                    <span
                      aria-label={`${unreadCount} unread notifications`}
                      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface"
                    />
                  )}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Desktop collapse toggle */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          className={cn(
            "mx-3 mb-2 hidden items-center gap-2 rounded-xl border border-border px-3 py-2 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg lg:flex",
            collapsed && "justify-center"
          )}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
              <span className="font-mono uppercase tracking-wider">Collapse</span>
            </>
          )}
        </button>

        {/* User */}
        <div className={cn("border-t border-border", collapsed ? "p-2" : "p-4")}>
          <Link
            href="/settings"
            className={cn(
              "flex items-center gap-3 rounded-xl transition hover:bg-surface-hover",
              collapsed ? "justify-center p-2" : "p-2"
            )}
            title={collapsed ? currentUser?.name : undefined}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan text-sm font-semibold text-primary-fg">
              {currentUser?.name?.[0] || "U"}
            </div>
            {!collapsed && (
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
            )}
          </Link>
        </div>
      </aside>
    </>
  );
}
