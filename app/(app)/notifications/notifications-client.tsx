"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Bell, CheckCheck, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import {
  clearNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/lib/actions/notifications";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  NOTIFICATION_CATEGORY_LABELS,
  type Notification,
  type NotificationCategory,
} from "@/lib/types";

const TYPE_FILL = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
} as const;

const CATEGORY_ORDER: NotificationCategory[] = ["task", "finance", "team", "system"];

export function NotificationsClient({ notifications }: { notifications: Notification[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const unreadCount = notifications.filter((n) => !n.read).length;

  // Category + unread filters (X4). Client-side over the loaded list (the
  // page fetches all of the user's notifications).
  const [category, setCategory] = useState<"all" | NotificationCategory>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const categoryCounts = useMemo(() => {
    const counts = new Map<NotificationCategory, number>();
    for (const n of notifications) counts.set(n.category, (counts.get(n.category) ?? 0) + 1);
    return counts;
  }, [notifications]);

  const visible = useMemo(
    () =>
      notifications.filter((n) => {
        if (category !== "all" && n.category !== category) return false;
        if (unreadOnly && n.read) return false;
        return true;
      }),
    [notifications, category, unreadOnly]
  );

  // Server actions already revalidatePath('/notifications'), but router.refresh
  // re-renders the current RSC tree without a full nav so the new props arrive
  // immediately.
  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleMarkRead(id: string) {
    const result = await markNotificationReadAction(id);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    refresh();
  }

  async function handleMarkAllRead() {
    const result = await markAllNotificationsReadAction();
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    // Honest message based on what actually got marked — a "Marked all
    // read" toast when zero rows changed is confusing.
    if (result.data.changed === 0) toast("Nothing to mark — you're all caught up", { icon: "✓" });
    else toast.success(`Marked ${result.data.changed} as read`);
    refresh();
  }

  async function handleClearAll() {
    const ok = await confirm({
      title: "Clear all notifications?",
      description:
        "This cannot be undone. Read notifications stay readable, unread ones disappear.",
      confirmLabel: "Clear all",
      tone: "danger",
    });
    if (!ok) return;
    const result = await clearNotificationsAction();
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    if (result.data.deleted === 0) toast("Nothing to clear", { icon: "✓" });
    else toast.success(`Cleared ${result.data.deleted} notification(s)`);
    refresh();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
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
                onClick={handleMarkAllRead}
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

      {notifications.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip
            active={category === "all"}
            onClick={() => setCategory("all")}
            label="All"
            count={notifications.length}
          />
          {CATEGORY_ORDER.filter((c) => (categoryCounts.get(c) ?? 0) > 0).map((c) => (
            <FilterChip
              key={c}
              active={category === c}
              onClick={() => setCategory(c)}
              label={NOTIFICATION_CATEGORY_LABELS[c]}
              count={categoryCounts.get(c) ?? 0}
            />
          ))}
          <button
            type="button"
            onClick={() => setUnreadOnly((v) => !v)}
            aria-pressed={unreadOnly}
            className={cn(
              "ml-auto inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
              unreadOnly
                ? "border-primary/50 bg-primary/10 text-primary-strong"
                : "border-border bg-bg text-fg-muted hover:text-fg"
            )}
          >
            Unread only
          </button>
        </div>
      )}

      {notifications.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Bell}
            title="No notifications yet"
            description="When your team adds expenses, completes tasks, or invites new members, you'll see updates here."
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={Bell}
            title="Nothing here"
            description="No notifications match this filter. Try another category or clear the unread toggle."
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((n) => (
            <li key={n.id}>
              <Link
                href={n.link || "#"}
                onClick={() => handleMarkRead(n.id)}
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

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
        active
          ? "border-primary/50 bg-primary/10 text-primary-strong"
          : "border-border bg-bg text-fg-muted hover:text-fg"
      )}
    >
      {label}
      <span
        className={cn(
          "font-mono text-[10px] tabular-nums",
          active ? "text-primary-strong/70" : "text-fg-muted/70"
        )}
      >
        {count}
      </span>
    </button>
  );
}
