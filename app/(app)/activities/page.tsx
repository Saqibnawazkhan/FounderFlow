"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity as ActivityIcon,
  CheckCircle2,
  CheckSquare,
  Filter,
  Search,
  Trash2,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Zap,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { cn, formatRelativeTime, formatDateTime } from "@/lib/utils";
import type { ActivityType } from "@/lib/types";
import { format, isToday, isYesterday, startOfDay } from "date-fns";

const ACTIVITY_META: Record<ActivityType, { icon: typeof ActivityIcon; color: string; label: string }> = {
  expense_added: { icon: TrendingDown, color: "from-amber-500 to-orange-500", label: "Expense" },
  investment_added: { icon: TrendingUp, color: "from-emerald-500 to-teal-500", label: "Investment" },
  task_assigned: { icon: CheckSquare, color: "from-blue-500 to-cyan-500", label: "Task Assigned" },
  task_completed: { icon: CheckCircle2, color: "from-emerald-500 to-teal-500", label: "Task Completed" },
  task_updated: { icon: CheckSquare, color: "from-violet-500 to-purple-500", label: "Task Updated" },
  task_deleted: { icon: Trash2, color: "from-red-500 to-pink-500", label: "Task Deleted" },
  transaction_deleted: { icon: Trash2, color: "from-red-500 to-pink-500", label: "Transaction Deleted" },
  user_joined: { icon: UserPlus, color: "from-pink-500 to-rose-500", label: "Team Update" },
  company_created: { icon: Zap, color: "from-brand-500 to-accent-500", label: "Company" },
};

export default function ActivitiesPage() {
  const activities = useStore((s) => s.getCompanyActivities());

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    return activities.filter((a) => {
      const matchSearch = !search || a.message.toLowerCase().includes(search.toLowerCase());
      const matchType = typeFilter === "all" || a.type === typeFilter;
      return matchSearch && matchType;
    });
  }, [activities, search, typeFilter]);

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
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Activity</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-1">
          A live timeline of everything happening in your company.
        </p>
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            placeholder="Search activity..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-10"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="input pl-10 pr-10 min-w-[200px]"
          >
            <option value="all">All activity types</option>
            <option value="expense_added">Expenses</option>
            <option value="investment_added">Investments</option>
            <option value="task_assigned">Tasks Assigned</option>
            <option value="task_completed">Tasks Completed</option>
            <option value="user_joined">Team Updates</option>
          </select>
        </div>
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={ActivityIcon}
            title="No activity yet"
            description="As your team works, every action will be logged here in real time."
          />
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(([dayKey, dayActivities]) => (
            <div key={dayKey}>
              <div className="sticky top-20 z-10 mb-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
                  <div className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse" />
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    {getDayLabel(dayKey)}
                  </p>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-xs text-slate-500">{dayActivities.length} events</span>
                </div>
              </div>
              <div className="relative pl-8">
                <div className="absolute left-[15px] top-2 bottom-2 w-px bg-gradient-to-b from-slate-200 via-slate-200 to-transparent dark:from-slate-800 dark:via-slate-800" />
                <div className="space-y-4">
                  {dayActivities.map((activity, i) => {
                    const meta = ACTIVITY_META[activity.type];
                    return (
                      <motion.div
                        key={activity.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.3, delay: Math.min(i * 0.05, 0.5) }}
                        className="relative card p-4 group hover:shadow-card-hover"
                      >
                        <div className={cn(
                          "absolute -left-[37px] top-4 h-7 w-7 rounded-full bg-gradient-to-br flex items-center justify-center text-white shadow-md ring-4 ring-slate-50 dark:ring-[#09090f]",
                          meta.color
                        )}>
                          <meta.icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex items-start gap-3">
                          <Avatar name={activity.userName} size="sm" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed">{activity.message}</p>
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className="text-xs text-slate-400">{format(new Date(activity.createdAt), "h:mm a")}</span>
                              <span className="text-slate-300">·</span>
                              <span className="text-xs text-slate-400">{meta.label}</span>
                            </div>
                          </div>
                        </div>
                      </motion.div>
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
