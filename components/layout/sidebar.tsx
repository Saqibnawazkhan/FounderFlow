"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { useStore, useStoreHasHydrated } from "@/lib/store";
import { unreadNotificationCountAction } from "@/lib/actions/notifications";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { homeRouteForRole, isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";
import { FINANCE_GROUP, NAV_TREE, isNavGroup, type NavItem, type NavNode } from "@/lib/nav";

export function Sidebar() {
  // Mobile open/close lives in Zustand so the topbar burger can drive it
  // without prop-drilling. We close on any pathname change so navigating
  // through the menu auto-dismisses the overlay.
  const mobileOpen = useStore((s) => s.mobileNavOpen);
  const setMobileOpen = useStore((s) => s.setMobileNavOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = useStore((s) => s.toggleSidebarCollapsed);
  const pathname = usePathname();
  const financeOpen = useStore((s) => s.financeNavOpen);
  const setFinanceOpen = useStore((s) => s.setFinanceNavOpen);
  const currentUser = useStore((s) => s.currentUser);
  const companies = useStore((s) => s.companies);
  const currentCompany = useStore((s) => s.currentCompany);
  const t = useT();

  // Auto-close the mobile drawer when the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  // Is the current route one of the five surfaces inside the Finance group?
  // Prefix-matched so a future /expenses/123 still counts.
  const onFinanceRoute = FINANCE_GROUP.children.some(
    (c) => pathname === c.href || pathname.startsWith(c.href + "/")
  );

  // Force the group open on arrival at a finance route, so the active row is
  // never hidden inside a folded group. Keyed on the boolean, not the
  // pathname, so collapsing it by hand while already on /expenses sticks —
  // the effect won't re-fire until you leave the group and come back.
  useEffect(() => {
    if (onFinanceRoute) setFinanceOpen(true);
  }, [onFinanceRoute, setFinanceOpen]);

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

  // Just the unread count for the nav badge — the full notification list lives
  // in the topbar dropdown + /notifications page.
  //
  // perf-004. This used to call `listNotificationsAction()` and count the rows
  // client-side: up to 200 full notification rows (titles, message bodies,
  // links) plus a User lookup, twice a minute, in every open tab, to render one
  // integer. Ten seats with three tabs each came to ~3,600 requests and ~140MB
  // of egress an hour for a badge. `unreadNotificationCountAction` answers with
  // `{ count }` from a `count()` on the `(userId, read)` index instead.
  //
  // And it polls only while the tab is VISIBLE. There was no `document.hidden`
  // gate here — unlike the clock heartbeat in components/time/clock-widget.tsx —
  // so a tab left open on Friday kept polling all weekend. This is the app's
  // only background load, so that gate is also what keeps idle database
  // connections at zero. Coming back to the tab refetches immediately, so the
  // badge is never showing an hour-old number.
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const res = await unreadNotificationCountAction();
      if (!cancelled && res.success) {
        setUnreadCount(res.data.count);
      }
    }
    fetchCount();
    const id = setInterval(fetchCount, 30_000);
    // Re-focus: catch up now rather than waiting out the interval the hidden
    // tab was skipping.
    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) fetchCount();
    };
    // A push arriving while the app is open fires this — refresh the badge now
    // instead of waiting up to 30s for the next poll.
    const onPush = () => fetchCount();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("ff-notifications-changed", onPush);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("ff-notifications-changed", onPush);
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
  // A group whose children are ALL blocked drops out entirely rather than
  // rendering an empty "Finance" row — which is every finance child, for a
  // member. Pinned by a test in tests/lib/nav.test.ts.
  const visibleNodes: NavNode[] =
    hasHydrated && role === "member"
      ? NAV_TREE.flatMap((node) => {
          if (!isNavGroup(node)) return isMemberBlockedRoute(node.href) ? [] : [node];
          const children = node.children.filter((c) => !isMemberBlockedRoute(c.href));
          return children.length > 0 ? [{ ...node, children }] : [];
        })
      : NAV_TREE;
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
          // `start-0` + `border-e` pin the rail to the reading-start edge, so
          // Urdu gets the sidebar on the right with its divider facing the
          // content — the physical `left-0`/`border-r` this replaces left the
          // whole shell unmirrored (audit S20).
          "fixed start-0 top-0 z-modal flex h-[100dvh] w-64 flex-col border-e border-border bg-surface transition-[transform,width] duration-300",
          // Tailwind has no logical translate, so the drawer's off-screen
          // parking spot has to be flipped by hand: past the right edge in
          // RTL, not the left.
          //
          // Both are scoped `max-lg:` rather than paired with a `lg:` reset,
          // because the reset does NOT win. Tailwind emits `rtl:` AFTER the
          // breakpoint variants and `:where()` adds no specificity, so
          // `rtl:translate-x-full` would override `lg:translate-x-0` at every
          // width — sliding the DESKTOP sidebar off-screen in Urdu, where it
          // is supposed to be permanent. Confining both to below-lg means no
          // transform exists at desktop at all, so there is nothing to lose.
          mobileOpen ? "translate-x-0" : "max-lg:-translate-x-full max-lg:rtl:translate-x-full",
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
            {visibleNodes.map((node) =>
              isNavGroup(node) ? (
                collapsed ? (
                  // Icon rail: no room for a submenu, so the group row is a
                  // plain link to its primary destination. It reads as active
                  // for any route inside the group.
                  <NavRow
                    key={node.id}
                    href={node.href}
                    icon={node.icon}
                    label={t.nav[node.labelKey]}
                    active={onFinanceRoute}
                    collapsed
                    onNavigate={() => setMobileOpen(false)}
                  />
                ) : (
                  <div key={node.id}>
                    <button
                      type="button"
                      onClick={() => setFinanceOpen(!financeOpen)}
                      aria-expanded={financeOpen}
                      aria-controls={`nav-group-${node.id}`}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all",
                        // Only claim the active styling when the children are
                        // folded away — otherwise the real active child below
                        // would be competing with its own parent row.
                        onFinanceRoute && !financeOpen
                          ? "border border-primary/50 bg-primary/[0.14] text-fg shadow-[inset_2px_0_0_0_rgb(var(--primary))] rtl:shadow-[inset_-2px_0_0_0_rgb(var(--primary))]"
                          : "text-fg-muted hover:bg-surface-hover hover:text-fg"
                      )}
                    >
                      <node.icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          onFinanceRoute && !financeOpen && "text-primary-strong"
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex-1 text-start">{t.nav[node.labelKey]}</span>
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                          financeOpen && "rotate-180"
                        )}
                        aria-hidden="true"
                      />
                    </button>
                    {/* Rendered only when open: a height-animated collapse
                        would leave the links tabbable while visually hidden,
                        and `hidden` kills the animation anyway. */}
                    {financeOpen && (
                      <div id={`nav-group-${node.id}`} className="mt-1 space-y-1">
                        {node.children.map((child) => (
                          <NavRow
                            key={child.href}
                            href={child.href}
                            icon={child.icon}
                            label={t.nav[child.labelKey]}
                            active={pathname === child.href}
                            nested
                            onNavigate={() => setMobileOpen(false)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              ) : (
                <NavRow
                  key={node.href}
                  href={node.href}
                  icon={node.icon}
                  label={t.nav[node.labelKey]}
                  active={pathname === node.href}
                  collapsed={collapsed}
                  badge={node.href === "/notifications" ? unreadCount : 0}
                  onNavigate={() => setMobileOpen(false)}
                />
              )
            )}
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
          {/* These two are direction-of-travel icons, not decoration: the
              rail collapses toward its own edge, which is the right-hand side
              in RTL. `rtl:rotate-180` mirrors them so "collapse" never points
              at the content. The BrandMark above deliberately does NOT get
              this — a logo is an image, and mirroring it just renders it
              backwards. */}
          {collapsed ? (
            <ChevronsRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
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
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-forest text-sm font-semibold text-primary-fg">
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

/**
 * One nav destination. Shared by top-level rows, the folded Finance group's
 * rail link, and the group's children (`nested` indents them under the
 * parent row).
 */
function NavRow({
  href,
  icon: Icon,
  label,
  active,
  collapsed = false,
  nested = false,
  badge = 0,
  onNavigate,
}: {
  href: string;
  icon: NavItem["icon"];
  label: string;
  active: boolean;
  collapsed?: boolean;
  nested?: boolean;
  badge?: number;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-xl text-sm font-medium transition-all",
        collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5",
        // Indent + slightly quieter type so children read as subordinate to
        // the group row rather than as peers of the top-level destinations.
        nested && "py-2 ps-9 text-[13px]",
        active
          ? "border border-primary/50 bg-primary/[0.14] text-fg shadow-[inset_2px_0_0_0_rgb(var(--primary))] rtl:shadow-[inset_-2px_0_0_0_rgb(var(--primary))]"
          : "text-fg-muted hover:bg-surface-hover hover:text-fg"
      )}
    >
      <Icon
        className={cn("h-4 w-4 shrink-0", active && "text-primary-strong")}
        aria-hidden="true"
      />
      {!collapsed && (
        <>
          <span className="flex-1">{label}</span>
          {badge > 0 && (
            <span
              aria-label={`${badge} unread notifications`}
              className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white"
            >
              {badge}
            </span>
          )}
        </>
      )}
      {collapsed && badge > 0 && (
        <span
          aria-label={`${badge} unread notifications`}
          className="absolute -end-0.5 -top-0.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface"
        />
      )}
    </Link>
  );
}
