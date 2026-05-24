"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, ChevronDown, LogOut, Menu, Moon, Search, Settings, Sun, User } from "lucide-react";
import { useStore } from "@/lib/store";
import { logoutAction } from "@/lib/actions/auth";
import {
  listNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/actions/notifications";
import { formatRelativeTime, cn } from "@/lib/utils";
import toast from "react-hot-toast";
import type { Notification } from "@/lib/types";
import { useT } from "@/lib/i18n/use-t";

export function Topbar() {
  const router = useRouter();
  const currentUser = useStore((s) => s.currentUser);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const logout = useStore((s) => s.logout);
  const setMobileNavOpen = useStore((s) => s.setMobileNavOpen);
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
  const notifRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

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
      if (e.key === "Escape") {
        setNotifOpen(false);
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, []);

  async function handleLogout() {
    // Server action clears the Auth.js cookie; local store cleanup follows.
    await logoutAction();
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
            we have less room and the burger is already an anchor home. */}
        <Link href="/dashboard" className="flex items-center gap-2 sm:hidden">
          <span className="text-sm font-bold tracking-tight">FounderFlow</span>
        </Link>

        {/* Search — collapses on very small screens to leave room for actions */}
        <div className="hidden max-w-md flex-1 sm:block">
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
              aria-hidden="true"
            />
            <label htmlFor="topbar-search" className="sr-only">
              {t.common.search}
            </label>
            <input
              id="topbar-search"
              placeholder={t.common.search}
              className="w-full rounded-xl border border-transparent bg-bg py-2 pl-10 pr-4 text-sm transition-all focus:border-primary/30 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </div>

        {/* Spacer pushes right-side actions to the end when search is hidden */}
        <div className="flex-1 sm:hidden" />

        <div className="flex items-center gap-1 sm:gap-2">
          <button
            onClick={toggleTheme}
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
              onClick={() => setNotifOpen(!notifOpen)}
              aria-label={
                unreadCount > 0
                  ? `${t.topbar.notificationsLabel}, ${unreadCount}`
                  : t.topbar.notificationsLabel
              }
              aria-expanded={notifOpen}
              aria-haspopup="menu"
              className="relative flex h-9 w-9 items-center justify-center rounded-xl text-fg-muted transition hover:bg-surface-hover"
            >
              <Bell className="h-4 w-4" aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger ring-2 ring-surface" />
              )}
            </button>

            <AnimatePresence>
              {notifOpen && (
                <motion.div
                  role="menu"
                  initial={{ opacity: 0, y: -8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-12 z-popover w-80 overflow-hidden rounded-2xl border border-border bg-surface shadow-card-hover md:w-96"
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
              onClick={() => setProfileOpen(!profileOpen)}
              aria-label={t.topbar.accountMenu}
              aria-expanded={profileOpen}
              aria-haspopup="menu"
              className="flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-surface-hover"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-cyan text-xs font-semibold text-primary-fg">
                {currentUser?.name?.[0] || "U"}
              </div>
              <ChevronDown
                className="hidden h-3.5 w-3.5 text-fg-muted md:block"
                aria-hidden="true"
              />
            </button>

            <AnimatePresence>
              {profileOpen && (
                <motion.div
                  role="menu"
                  initial={{ opacity: 0, y: -8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-12 z-popover w-64 overflow-hidden rounded-2xl border border-border bg-surface shadow-card-hover"
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
    </header>
  );
}
