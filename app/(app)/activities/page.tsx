"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity as ActivityIcon,
  CheckCircle2,
  CheckSquare,
  Filter,
  Search,
  ShieldCheck,
  Trash2,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
  Zap,
  type LucideIcon,
} from "lucide-react";
import toast from "react-hot-toast";
import { listActivitiesAction } from "@/lib/actions/activities";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { PillBadge } from "@/components/landing/pill-badge";
import { cn } from "@/lib/utils";
import type { Activity, ActivityType } from "@/lib/types";
import { format, isToday, isYesterday, startOfDay } from "date-fns";

type ActivityTone = "primary" | "cyan" | "pink" | "danger" | "warning" | "info";

const ACTIVITY_META: Record<ActivityType, { icon: LucideIcon; tone: ActivityTone; label: string }> =
  {
    expense_added: { icon: TrendingDown, tone: "pink", label: "Expense" },
    investment_added: { icon: TrendingUp, tone: "primary", label: "Investment" },
    task_assigned: { icon: CheckSquare, tone: "cyan", label: "Task assigned" },
    task_completed: { icon: CheckCircle2, tone: "primary", label: "Task completed" },
    task_updated: { icon: CheckSquare, tone: "info", label: "Task updated" },
    task_deleted: { icon: Trash2, tone: "danger", label: "Task deleted" },
    transaction_deleted: { icon: Trash2, tone: "danger", label: "Transaction deleted" },
    user_joined: { icon: UserPlus, tone: "cyan", label: "Team update" },
    user_removed: { icon: UserMinus, tone: "danger", label: "Member removed" },
    user_role_changed: { icon: ShieldCheck, tone: "warning", label: "Role changed" },
    company_created: { icon: Zap, tone: "primary", label: "Company" },
  };

const TONE_FILL: Record<ActivityTone, string> = {
  primary: "bg-primary/15 text-primary-strong border-primary/30",
  cyan: "bg-cyan/15 text-cyan-strong border-cyan/30",
  pink: "bg-pink/15 text-pink-strong border-pink/30",
  danger: "bg-danger/15 text-danger border-danger/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  info: "bg-info/15 text-info border-info/30",
};

export default function ActivitiesPage() {
  // Activities on Supabase (Phase 1.C).
  const [activities, setActivities] = useState<Activity[]>([]);
  useEffect(() => {
    let cancelled = false;
    listActivitiesAction().then((res) => {
      if (cancelled) return;
      if (res.success) setActivities(res.data);
      else toast.error(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const filtered = useMemo(
    () =>
      activities.filter((a) => {
        const matchSearch = !search || a.message.toLowerCase().includes(search.toLowerCase());
        const matchType = typeFilter === "all" || a.type === typeFilter;
        return matchSearch && matchType;
      }),
    [activities, search, typeFilter]
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof filtered>();
    filtered.forEach((a) => {
      const key = startOfDay(new Date(a.createdAt)).toISOString();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    });
    return Array.from(groups.entries()).sort(
      (a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime()
    );
  }, [filtered]);

  function getDayLabel(dateStr: string): string {
    const d = new Date(dateStr);
    if (isToday(d)) return "Today";
    if (isYesterday(d)) return "Yesterday";
    return format(d, "EEEE, MMM dd");
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Header */}
      <header>
        <PillBadge>Live feed</PillBadge>
        <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Activity
        </h1>
        <p className="mt-2 text-sm text-fg-muted md:text-base">
          A live timeline of everything happening in your company.
        </p>
      </header>

      {/* Filters */}
      <section
        aria-label="Filter activity"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="activity-search" className="sr-only">
            Search activity
          </label>
          <input
            id="activity-search"
            placeholder="Search activity…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg py-2.5 pl-10 pr-4 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
          />
        </div>
        <div className="relative">
          <Filter
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="activity-type" className="sr-only">
            Filter by type
          </label>
          <select
            id="activity-type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pl-10 pr-10 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            <option value="all">All activity types</option>
            <option value="expense_added">Expenses</option>
            <option value="investment_added">Investments</option>
            <option value="task_assigned">Tasks assigned</option>
            <option value="task_completed">Tasks completed</option>
            <option value="user_joined">Team updates</option>
          </select>
        </div>
      </section>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface">
          <EmptyState
            icon={ActivityIcon}
            title="No activity yet"
            description="As your team works, every action will be logged here in real time."
          />
        </div>
      ) : (
        <div className="space-y-10">
          {grouped.map(([dayKey, dayActivities]) => (
            <div key={dayKey}>
              <div className="sticky top-20 z-sticky mb-5">
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 shadow-card">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg">
                    {getDayLabel(dayKey)}
                  </p>
                  <span className="text-fg-muted">·</span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                    {dayActivities.length} {dayActivities.length === 1 ? "event" : "events"}
                  </span>
                </div>
              </div>
              <div className="relative pl-8">
                <div className="absolute bottom-2 left-[15px] top-2 w-px bg-gradient-to-b from-border via-border to-transparent" />
                <div className="space-y-3">
                  {dayActivities.map((activity) => {
                    const meta = ACTIVITY_META[activity.type];
                    return (
                      <article
                        key={activity.id}
                        className="group relative rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-primary/30"
                      >
                        <div
                          className={cn(
                            "absolute -left-[37px] top-4 flex h-7 w-7 items-center justify-center rounded-full border ring-4 ring-bg",
                            TONE_FILL[meta.tone]
                          )}
                        >
                          <meta.icon className="h-3.5 w-3.5" aria-hidden="true" />
                        </div>
                        <div className="flex items-start gap-3">
                          <Avatar name={activity.userName} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm leading-relaxed text-fg">{activity.message}</p>
                            <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                              <span>{format(new Date(activity.createdAt), "h:mm a")}</span>
                              <span>·</span>
                              <span>{meta.label}</span>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
