"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  Archive,
  CheckCircle2,
  CheckSquare,
  Edit3,
  FolderPlus,
  Filter,
  Loader2,
  Search,
  ShieldCheck,
  Trash2,
  TrendingDown,
  TrendingUp,
  UserMinus,
  UserPlus,
  UserCog,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { loadMoreActivitiesAction } from "@/lib/actions/activities";
import { cn } from "@/lib/utils";
import type { Activity, ActivityType } from "@/lib/types";
import { format, isToday, isYesterday, startOfDay } from "date-fns";

type ActivityTone = "primary" | "cyan" | "pink" | "danger" | "warning" | "info";

const ACTIVITY_META: Record<ActivityType, { icon: LucideIcon; tone: ActivityTone; label: string }> =
  {
    expense_added: { icon: TrendingDown, tone: "pink", label: "Expense" },
    investment_added: { icon: TrendingUp, tone: "primary", label: "Investment" },
    task_created: { icon: CheckSquare, tone: "primary", label: "Task created" },
    task_assigned: { icon: CheckSquare, tone: "cyan", label: "Task assigned" },
    task_completed: { icon: CheckCircle2, tone: "primary", label: "Task completed" },
    task_updated: { icon: CheckSquare, tone: "info", label: "Task updated" },
    task_deleted: { icon: Trash2, tone: "danger", label: "Task deleted" },
    transaction_deleted: { icon: Trash2, tone: "danger", label: "Transaction deleted" },
    user_joined: { icon: UserPlus, tone: "cyan", label: "Team update" },
    user_removed: { icon: UserMinus, tone: "danger", label: "Member removed" },
    user_role_changed: { icon: ShieldCheck, tone: "warning", label: "Role changed" },
    company_created: { icon: Zap, tone: "primary", label: "Company" },
    project_created: { icon: FolderPlus, tone: "primary", label: "Project created" },
    project_updated: { icon: Edit3, tone: "info", label: "Project updated" },
    project_archived: { icon: Archive, tone: "warning", label: "Project archived" },
    project_supervisor_changed: { icon: UserCog, tone: "cyan", label: "Supervisor changed" },
  };

const TONE_FILL: Record<ActivityTone, string> = {
  primary: "bg-primary/15 text-primary-strong border-primary/30",
  cyan: "bg-cyan/15 text-cyan-strong border-cyan/30",
  pink: "bg-pink/15 text-pink-strong border-pink/30",
  danger: "bg-danger/15 text-danger-strong border-danger/30",
  warning: "bg-warning/15 text-warning-strong border-warning/30",
  info: "bg-info/15 text-info-strong border-info/30",
};

/** An activity row plus how many identical consecutive events it absorbed.
 *  repeatCount = 1 → a normal single event; > 1 → rendered with a ×N badge. */
type DedupedActivity = Activity & { repeatCount: number };

// Collapse window: identical events this close together are one user action
// stuttering (double-click, retried request, HMR double-fire), not two
// separate pieces of news. 5 minutes is wide enough to absorb bursts and
// narrow enough that genuinely repeated work (same task re-completed the
// next morning) still shows as separate rows.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/** Read-side dedupe (audit X15): rapid consecutive events with the same
 *  type + message + actor collapse into one row carrying a repeat count.
 *  Server rows are untouched — this is presentation-only, so the audit
 *  trail in the DB stays complete. Assumes input is newest-first (the
 *  query orders by createdAt desc). */
function dedupeConsecutive(rows: Activity[]): DedupedActivity[] {
  const out: DedupedActivity[] = [];
  for (const a of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === a.type &&
      prev.message === a.message &&
      prev.userId === a.userId &&
      Math.abs(new Date(prev.createdAt).getTime() - new Date(a.createdAt).getTime()) <=
        DEDUPE_WINDOW_MS
    ) {
      prev.repeatCount += 1;
      continue;
    }
    out.push({ ...a, repeatCount: 1 });
  }
  return out;
}

type Props = {
  initialActivities: Activity[];
  initialCursor: string | null;
  users: { id: string; name: string }[];
  activeUserId: string; // "all" or a userId
};

export function ActivitiesClient({ initialActivities, initialCursor, users, activeUserId }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Accumulated feed + the cursor for the next page (X5). Seeded from the
  // RSC's first page; re-seeded whenever the server re-fetches (e.g. the
  // per-user filter changes the URL and a fresh first page arrives).
  const [activities, setActivities] = useState<Activity[]>(initialActivities);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setActivities(initialActivities);
    setCursor(initialCursor);
  }, [initialActivities, initialCursor]);

  // Per-user filter (X6) — a URL change so the server re-queries from page 1.
  function changeUser(userId: string) {
    const url = userId === "all" ? "/activities" : `/activities?user=${userId}`;
    startTransition(() => router.push(url));
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const res = await loadMoreActivitiesAction({
      cursor,
      userId: activeUserId === "all" ? null : activeUserId,
    });
    setLoadingMore(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    // De-dupe by id on append — a row created between page fetches could
    // otherwise slip into two pages and render twice.
    setActivities((prev) => {
      const seen = new Set(prev.map((a) => a.id));
      return [...prev, ...res.data.items.filter((a) => !seen.has(a.id))];
    });
    setCursor(res.data.nextCursor);
  }

  const filtered = useMemo(
    () =>
      dedupeConsecutive(
        activities.filter((a) => {
          const matchSearch = !search || a.message.toLowerCase().includes(search.toLowerCase());
          const matchType = typeFilter === "all" || a.type === typeFilter;
          return matchSearch && matchType;
        })
      ),
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
    <>
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
        <div className="relative">
          <Users
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="activity-user" className="sr-only">
            Filter by person
          </label>
          <select
            id="activity-user"
            value={activeUserId}
            onChange={(e) => changeUser(e.target.value)}
            className="w-full min-w-[180px] appearance-none rounded-xl border border-border bg-bg py-2.5 pl-10 pr-10 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            <option value="all">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
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
                            <p className="text-sm leading-relaxed text-fg">
                              {activity.message}
                              {activity.repeatCount > 1 && (
                                <span
                                  title={`This event fired ${activity.repeatCount} times within a few minutes`}
                                  className="ml-2 inline-flex items-center rounded-full border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] font-bold text-fg-muted"
                                >
                                  ×{activity.repeatCount}
                                </span>
                              )}
                            </p>
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

      {cursor && (
        <div className="flex flex-col items-center gap-2 pt-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-primary/40 hover:text-primary-strong disabled:opacity-60"
          >
            {loadingMore ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
              </>
            ) : (
              "Load more"
            )}
          </button>
          {(search || typeFilter !== "all") && (
            <p className="text-center text-[11px] text-fg-muted">
              Search and type filters apply to loaded events — load more to search further back.
            </p>
          )}
        </div>
      )}
    </>
  );
}
