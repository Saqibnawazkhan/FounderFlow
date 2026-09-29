"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bell,
  ChevronDown,
  Languages,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  User,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { SUPPORTED_LOCALES, type Locale } from "@/lib/i18n/strings";
import { logoutAction } from "@/lib/actions/auth";
import { updateAppearanceAction } from "@/lib/actions/appearance";
import {
  listNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/actions/notifications";
import { formatRelativeTime, cn } from "@/lib/utils";
import toast from "react-hot-toast";
import type { Notification } from "@/lib/types";
import { useT } from "@/lib/i18n/use-t";
import { ClockWidget } from "@/components/time/clock-widget";
import { homeRouteForRole, type Role } from "@/lib/auth/role-gates";
import { CommandPalette } from "@/components/layout/command-palette";

export function Topbar() {
  const currentUser = useStore((s) => s.currentUser);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const logout = useStore((s) => s.logout);
  const setMobileNavOpen = useStore((s) => s.setMobileNavOpen);
  // Toggle the UI locale. With only two supported locales today (en, ur),
  // flipping between them from the topbar is the fastest UX. If we add a
  // third we'd upgrade this to a small dropdown — until then a single
  // button keeps the chrome tight.
  function toggleLocale() {
    const next: Locale = locale === "en" ? "ur" : "en";
    setLocale(next);
    // S6: keep the DB in sync so the quick toggle also follows the user
    // across devices, matching the settings controls.
    void updateAppearanceAction({ locale: next });
  }
  function handleToggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    toggleTheme();
    void updateAppearanceAction({ theme: next });
  }
  const nextLocaleLabel = SUPPORTED_LOCALES.find((l) => l.code !== locale)?.label ?? "English";
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notifVersion, setNotifVersion] = useState(0);
  const refreshNotifs = useCallback(() => setNotifVersion((v) => v + 1), []);
  const t = useT();

  // Poll on mount; bumping notifVersion re-fetches after a markRead. Could
  // upgrade to SSE/realtime in a future phase (Supabase has channels).
  useEffect(() => {
    let cancelled = false;
    listNotificationsAction().then((res) => {
      if (cancelled) return;
      if (res.success) setNotifications(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [notifVersion]);

  async function markRead(id: string) {
    const res = await markNotificationReadAction(id);
    if (res.success) refreshNotifs();
  }

  async function markAllRead() {
    const res = await markAllNotificationsReadAction();
    if (res.success) refreshNotifs();
  }

  const unreadCount = notifications.filter((n) => !n.read).length;

  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K / Ctrl-K opens the command palette. Only fires when not typing in an
  // editable target so the shortcut doesn't hijack keystrokes inside forms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const notifRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  // a11y-007: Escape has to hand focus back to the control the panel came from,
  // so each trigger needs a ref of its own (the wrapper refs above are for
  // outside-click detection and contain the panel too).
  const notifButtonRef = useRef<HTMLButtonElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);

  // a11y-007: these two panels are DISCLOSURES, not ARIA menus — see the long
  // comment on the notifications panel below. A disclosure's trigger points at
  // the region it reveals, so both need stable ids.
  const NOTIF_PANEL_ID = "topbar-notifications-panel";
  const PROFILE_PANEL_ID = "topbar-account-panel";

  // Only ever one panel open at a time. The outside-`mousedown` handler already
  // achieved this for pointer users; a keyboard user pressing Enter on the
  // second trigger fires no mousedown, so both used to open at once — they
  // overlap visually, and Escape then has two triggers to choose between.
  function openOnly(which: "notif" | "profile" | null) {
    setNotifOpen(which === "notif");
    setProfileOpen(which === "profile");
  }

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    function escHandler(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // This listener is document-level, so it sees every Escape on the page.
      // Guarding on "is this panel actually open" matters twice over: it stops
      // us re-rendering for an Escape meant for someone else, and — since we
      // now restore focus — it stops us teleporting focus out of whatever the
      // user was really using.
      //
      // Focus only returns to the trigger when focus was INSIDE the disclosure.
      // Tabbing out of an open panel is legal (it is not a modal); closing it
      // from out there must not drag the user backwards to the topbar.
      const active = document.activeElement;
      if (notifOpen) {
        const wasInside = notifRef.current?.contains(active) ?? false;
        setNotifOpen(false);
        if (wasInside) notifButtonRef.current?.focus();
      }
      if (profileOpen) {
        const wasInside = profileRef.current?.contains(active) ?? false;
        setProfileOpen(false);
        if (wasInside) profileButtonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [notifOpen, profileOpen]);

  async function handleLogout() {
    // Server action clears the Auth.js cookie. Only clear local Zustand
    // when the server actually signed us out — otherwise we'd leave the
    // user looking logged out while a valid session cookie still rides.
    const res = await logoutAction();
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    logout();
    toast.success(t.topbar.signedOutToast);
    // Full nav so middleware sees the cleared cookie immediately.
    window.location.href = "/login";
  }

  return (
    <header className="sticky top-0 z-sticky h-16 border-b border-border bg-surface/80 backdrop-blur-xl">
      <div className="flex h-full items-center gap-2 px-4 md:px-6 lg:px-8">
        {/* Mobile burger — opens the sidebar drawer. Hidden once the sidebar
            becomes permanent at lg breakpoint. */}
        <button
          onClick={() => setMobileNavOpen(true)}
          aria-label={t.topbar.openMenu}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-bg text-fg-muted transition hover:bg-surface-hover hover:text-fg lg:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>

        {/* Brand on the smallest screens only — once search shows at sm+
            we have less room and the burger is already an anchor home.
            Routed per role so a member doesn't land on /dashboard then bounce. */}
        <Link
          href={homeRouteForRole((currentUser?.role as Role | undefined) ?? "member")}
          className="flex items-center gap-2 sm:hidden"
        >
          <span className="text-sm font-bold tracking-tight">FounderFlow</span>
        </Link>

        {/* Search — collapses on very small screens to leave room for actions.
            The visible input is a button that opens the CommandPalette; the
            actual text field lives inside the palette so focus + shortcuts
            behave predictably on all viewports. */}
        <div className="hidden max-w-md flex-1 sm:block">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={t.common.search}
            className="flex w-full items-center gap-3 rounded-xl border border-transparent bg-bg px-3 py-2 text-sm text-fg-muted transition-all hover:border-primary/20 hover:bg-surface focus:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-start">{t.common.search}</span>
            <kbd className="hidden items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider md:inline-flex">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Spacer pushes right-side actions to the end when search is hidden */}
        <div className="flex-1 sm:hidden" />

        <div className="flex items-center gap-1 sm:gap-2">
          <ClockWidget />

          <button
            onClick={toggleLocale}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted transition hover:bg-surface-hover"
            aria-label={`Switch language — currently ${locale === "en" ? "English" : "اردو"}, switch to ${nextLocaleLabel}`}
            title={`Switch to ${nextLocaleLabel}`}
          >
            <Languages className="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            onClick={handleToggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted transition hover:bg-surface-hover"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            <AnimatePresence mode="wait">
              {theme === "dark" ? (
                <motion.div
                  key="sun"
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: 90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Sun className="h-4 w-4" aria-hidden="true" />
                </motion.div>
              ) : (
                <motion.div
                  key="moon"
                  initial={{ rotate: 90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  exit={{ rotate: -90, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <Moon className="h-4 w-4" aria-hidden="true" />
                </motion.div>
              )}
            </AnimatePresence>
          </button>

          {/* Notifications */}
          <div ref={notifRef} className="relative">
            <button
              ref={notifButtonRef}
              onClick={() => openOnly(notifOpen ? null : "notif")}
              aria-label={
                unreadCount > 0
                  ? `${t.topbar.notificationsLabel}, ${unreadCount}`
                  : t.topbar.notificationsLabel
              }
              aria-expanded={notifOpen}
              // No `aria-haspopup`: this is a disclosure button, not a menu
              // button. `aria-controls` is emitted only while the panel exists,
              // because the panel is unmounted when closed and a dangling
              // IDREF is its own accessibility defect.
              aria-controls={notifOpen ? NOTIF_PANEL_ID : undefined}
              className="relative flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted transition hover:bg-surface-hover"
            >
              <Bell className="h-4 w-4" aria-hidden="true" />
              {unreadCount > 0 && (
                // Numeric badge (was a 2×2 dot — audit N6 called out the
                // duplicate-and-invisible affordance). Sidebar still shows
                // its count; the two now visually agree instead of racing.
                <span
                  aria-hidden="true"
                  className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold leading-none text-white ring-2 ring-surface"
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>

            {/* Anchored with `end-0`, not `right-0`: these panels are wider
                than the 36px button they hang from, so in RTL a physical
                right-anchor would push them off the trailing edge of the
                viewport instead of opening inward.

                a11y-007: this used to be `role="menu"`. It is not a menu and it
                cannot be one. ARIA's menu role may only own menuitem /
                menuitemradio / menuitemcheckbox / group / separator children,
                and this panel owns an <h3>, a "Mark all read" button and a
                scrolling list of links whose text is a title, a prose message
                and a timestamp. Declaring a menu made that <h3> an invalid
                child (axe `aria-required-children`), cost it its heading
                semantics, and — via `aria-haspopup="menu"` on the trigger —
                promised arrow-key navigation and first-letter typeahead that
                nothing here implements. As an ordinary disclosure region the
                heading is a heading again, the links are links, and Tab
                already walks them in visual order because the panel follows
                the trigger in the DOM. */}
            <AnimatePresence>
              {notifOpen && (
                <motion.div
                  id={NOTIF_PANEL_ID}
                  initial={{ opacity: 0, y: -8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute end-0 top-12 z-popover w-80 overflow-hidden rounded-2xl border border-border bg-surface shadow-card-hover md:w-96"
                >
                  <div className="flex items-center justify-between border-b border-border p-4">
                    <h3 className="font-semibold">{t.topbar.notificationsLabel}</h3>
                    {unreadCount > 0 && (
                      <button
                        onClick={markAllRead}
                        className="text-xs font-medium text-primary-strong hover:underline"
                      >
                        {t.topbar.markAllRead}
                      </button>
                    )}
                  </div>
                  <div className="scrollbar-thin max-h-96 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <div className="p-8 text-center">
                        <Bell
                          className="mx-auto mb-2 h-10 w-10 text-fg-muted/40"
                          aria-hidden="true"
                        />
                        <p className="text-sm text-fg-muted">{t.topbar.noNotifications}</p>
                      </div>
                    ) : (
                      notifications.slice(0, 10).map((n) => (
                        <Link
                          key={n.id}
                          href={n.link || "#"}
                          onClick={() => {
                            markRead(n.id);
                            setNotifOpen(false);
                          }}
                          className={cn(
                            "flex gap-3 border-b border-border p-4 transition hover:bg-surface-hover",
                            !n.read && "bg-primary/5"
                          )}
                        >
                          <div
                            className={cn(
                              "mt-2 h-2 w-2 shrink-0 rounded-full",
                              n.type === "success" && "bg-success",
                              n.type === "warning" && "bg-warning",
                              n.type === "danger" && "bg-danger",
                              n.type === "info" && "bg-info"
                            )}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{n.title}</p>
                            <p className="mt-0.5 text-xs text-fg-muted">{n.message}</p>
                            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted/70">
                              {formatRelativeTime(n.createdAt)}
                            </p>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                  <Link
                    href="/notifications"
                    onClick={() => setNotifOpen(false)}
                    className="block border-t border-border p-3 text-center text-sm font-medium text-primary-strong hover:bg-surface-hover"
                  >
                    {t.topbar.viewAll}
                  </Link>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Profile */}
          <div ref={profileRef} className="relative">
            <button
              ref={profileButtonRef}
              onClick={() => openOnly(profileOpen ? null : "profile")}
              aria-label={t.topbar.accountMenu}
              aria-expanded={profileOpen}
              // Disclosure, not a menu button — see the notifications panel.
              aria-controls={profileOpen ? PROFILE_PANEL_ID : undefined}
              className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-surface-hover"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-forest text-xs font-semibold text-primary-fg">
                {currentUser?.name?.[0] || "U"}
              </div>
              <ChevronDown
                className="hidden h-3.5 w-3.5 text-fg-muted md:block"
                aria-hidden="true"
              />
            </button>

            {/* a11y-007: also a disclosure, not a menu. Two of its three
                controls are navigation links, and ARIA's own guidance is not to
                model site navigation as a menu; the panel additionally opens
                with a non-interactive name/email block, which has no legal
                place inside a menu at all. */}
            <AnimatePresence>
              {profileOpen && (
                <motion.div
                  id={PROFILE_PANEL_ID}
                  initial={{ opacity: 0, y: -8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute end-0 top-12 z-popover w-64 overflow-hidden rounded-2xl border border-border bg-surface shadow-card-hover"
                >
                  <div className="border-b border-border p-4">
                    <p className="text-sm font-semibold">{currentUser?.name}</p>
                    <p className="truncate text-xs text-fg-muted">{currentUser?.email}</p>
                  </div>
                  <div className="p-2">
                    <Link
                      href="/settings"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-surface-hover"
                    >
                      <User className="h-4 w-4" aria-hidden="true" />
                      {t.topbar.profileSettings}
                    </Link>
                    <Link
                      href="/team"
                      onClick={() => setProfileOpen(false)}
                      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-surface-hover"
                    >
                      <Settings className="h-4 w-4" aria-hidden="true" />
                      {t.topbar.teamManagement}
                    </Link>
                  </div>
                  <div className="border-t border-border p-2">
                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-danger transition hover:bg-danger/10"
                    >
                      <LogOut className="h-4 w-4" aria-hidden="true" />
                      {t.common.signOut}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </header>
  );
}
