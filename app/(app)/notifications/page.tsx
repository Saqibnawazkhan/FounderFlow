"use client";

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatRelativeTime } from "@/lib/utils";

export default function NotificationsPage() {
  const notifications = useStore((s) => s.getUserNotifications());
  const markRead = useStore((s) => s.markNotificationRead);
  const markAllRead = useStore((s) => s.markAllNotificationsRead);
  const clearAll = useStore((s) => s.clearNotifications);

  const unreadCount = notifications.filter((n) => !n.read).length;

  function handleClearAll() {
    if (!confirm("Clear all notifications? This cannot be undone.")) return;
    clearAll();
    toast.success("All notifications cleared");
  }

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            {unreadCount > 0 ? `You have ${unreadCount} unread notification${unreadCount !== 1 ? "s" : ""}` : "You're all caught up"}
          </p>
        </div>
        {notifications.length > 0 && (
          <div className="flex gap-2">
            {unreadCount > 0 && (
              <button onClick={() => { markAllRead(); toast.success("All marked as read"); }} className="btn-secondary">
                <CheckCheck className="h-4 w-4" /> Mark all read
              </button>
            )}
            <button onClick={handleClearAll} className="btn-ghost text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">
              <Trash2 className="h-4 w-4" /> Clear all
            </button>
          </div>
        )}
      </div>

      {/* List */}
      {notifications.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            description="When your team adds expenses, completes tasks, or invites new members, you'll see updates here."
          />
        </div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence>
            {notifications.map((n, i) => (
              <motion.div
                key={n.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 100 }}
                transition={{ duration: 0.2, delay: Math.min(i * 0.03, 0.3) }}
              >
                <Link
                  href={n.link || "#"}
                  onClick={() => markRead(n.id)}
                  className={cn(
                    "block card p-4 hover:shadow-card-hover transition-all group",
                    !n.read && "border-l-4 border-l-brand-500"
                  )}
                >
                  <div className="flex items-start gap-4">
                    <div className={cn(
                      "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
                      n.type === "success" && "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600",
                      n.type === "warning" && "bg-amber-100 dark:bg-amber-500/20 text-amber-600",
                      n.type === "danger" && "bg-red-100 dark:bg-red-500/20 text-red-600",
                      n.type === "info" && "bg-blue-100 dark:bg-blue-500/20 text-blue-600"
                    )}>
                      <Bell className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-sm">{n.title}</p>
                          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{n.message}</p>
                        </div>
                        {!n.read && (
                          <div className="h-2 w-2 rounded-full bg-brand-500 mt-2 shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-2">{formatRelativeTime(n.createdAt)}</p>
                    </div>
                  </div>
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
