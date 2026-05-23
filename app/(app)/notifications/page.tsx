"use client";

import Link from "next/link";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, formatRelativeTime } from "@/lib/utils";

const TYPE_FILL = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
} as const;

export default function NotificationsPage() {
  const notifications = useStore((s) => s.getUserNotifications());
  const markRead = useStore((s) => s.markNotificationRead);
  const markAllRead = useStore((s) => s.markAllNotificationsRead);
  const clearAll = useStore((s) => s.clearNotifications);
  const confirm = useConfirm();

  const unreadCount = notifications.filter((n) => !n.read).length;

  async function handleClearAll() {
    const ok = await confirm({
      title: "Clear all notifications?",
      description:
        "This cannot be undone. Read notifications stay readable, unread ones disappear.",
      confirmLabel: "Clear all",
      tone: "danger",
    });
    if (!ok) return;
    clearAll();
    toast.success("All notifications cleared");
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone={unreadCount > 0 ? "primary" : "cyan"}>
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Notifications
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            {unreadCount > 0
              ? `You have ${unreadCount} unread notification${unreadCount !== 1 ? "s" : ""}.`
              : "You're all caught up."}
          </p>
        </div>
        {notifications.length > 0 && (
          <div className="flex gap-2">
            {unreadCount > 0 && (
              <button
                onClick={() => {
                  markAllRead();
                  toast.success("All marked as read");
                }}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
              >
                <CheckCheck className="h-4 w-4" aria-hidden="true" /> Mark all read
              </button>
            )}
            <button
              onClick={handleClearAll}
              className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Clear all
            </button>
          </div>
        )}
      </header>

      {/* List */}
      {notifications.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            description="When your team adds expenses, completes tasks, or invites new members, you'll see updates here."
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => (
            <li key={n.id}>
              <Link
                href={n.link || "#"}
                onClick={() => markRead(n.id)}
                className={cn(
                  "group block rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-primary/30",
                  !n.read && "border-l-2 border-l-primary"
                )}
              >
                <div className="flex items-start gap-4">
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                      TYPE_FILL[n.type]
                    )}
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-fg">{n.title}</p>
                        <p className="mt-0.5 text-sm text-fg-muted">{n.message}</p>
                      </div>
                      {!n.read && (
                        <span
                          className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary"
                          aria-label="Unread"
                        />
                      )}
                    </div>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                      {formatRelativeTime(n.createdAt)}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
