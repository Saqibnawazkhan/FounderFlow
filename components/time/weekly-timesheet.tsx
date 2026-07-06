"use client";

/**
 * Weekly timesheet grid (X2). Buckets the loaded time entries into a Mon–Sun
 * week with a per-day total and a week total, and lets the user page between
 * weeks. Pure client-side over the entries the /time RSC already fetched — no
 * extra round-trip. (Entries are capped at 500 newest server-side, so paging
 * far into the past can run past the window; that's called out in the audit.)
 */

import { useMemo, useState } from "react";
import {
  addWeeks,
  eachDayOfInterval,
  endOfWeek,
  format,
  isSameDay,
  isToday,
  startOfWeek,
  subWeeks,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { durationMs, formatDuration } from "@/lib/time/thresholds";
import { cn } from "@/lib/utils";
import type { TimeEntryClient } from "@/lib/queries/time";

const WEEK_OPTS = { weekStartsOn: 1 } as const; // Monday

export function WeeklyTimesheet({
  entries,
  showPerson,
  renderedAt,
}: {
  entries: TimeEntryClient[];
  showPerson: boolean;
  renderedAt: Date;
}) {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(renderedAt, WEEK_OPTS));

  const days = useMemo(
    () => eachDayOfInterval({ start: weekStart, end: endOfWeek(weekStart, WEEK_OPTS) }),
    [weekStart]
  );

  // Bucket entries by day (keyed on clock-in) with each day's rows + total.
  const buckets = useMemo(() => {
    return days.map((day) => {
      const rows = entries
        .filter((e) => isSameDay(new Date(e.clockInAt), day))
        .sort((a, b) => new Date(a.clockInAt).getTime() - new Date(b.clockInAt).getTime());
      const total = rows.reduce(
        (sum, e) =>
          sum +
          durationMs(
            new Date(e.clockInAt),
            e.clockOutAt ? new Date(e.clockOutAt) : null,
            renderedAt
          ),
        0
      );
      return { day, rows, total };
    });
  }, [days, entries, renderedAt]);

  const weekTotal = buckets.reduce((sum, b) => sum + b.total, 0);
  const isCurrentWeek = isSameDay(weekStart, startOfWeek(renderedAt, WEEK_OPTS));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-bg p-1">
          <button
            type="button"
            onClick={() => setWeekStart((w) => subWeeks(w, 1))}
            aria-label="Previous week"
            className="rounded-full p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="min-w-[9.5rem] text-center font-mono text-xs font-semibold tabular-nums text-fg">
            {format(weekStart, "MMM d")} – {format(endOfWeek(weekStart, WEEK_OPTS), "MMM d")}
          </span>
          <button
            type="button"
            onClick={() => setWeekStart((w) => addWeeks(w, 1))}
            aria-label="Next week"
            className="rounded-full p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          {!isCurrentWeek && (
            <button
              type="button"
              onClick={() => setWeekStart(startOfWeek(renderedAt, WEEK_OPTS))}
              className="rounded-full border border-border bg-bg px-3 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-primary/40 hover:text-primary-strong"
            >
              This week
            </button>
          )}
          <span className="font-mono text-xs text-fg-muted">
            Week total{" "}
            <span className="ml-1 font-bold tabular-nums text-fg">{formatDuration(weekTotal)}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
        {buckets.map(({ day, rows, total }) => (
          <div
            key={day.toISOString()}
            className={cn(
              "flex flex-col rounded-2xl border bg-surface p-3",
              isToday(day) ? "border-primary/40" : "border-border"
            )}
          >
            <div className="mb-2 flex items-baseline justify-between border-b border-border/60 pb-2">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                  {format(day, "EEE")}
                </p>
                <p
                  className={cn(
                    "text-sm font-bold",
                    isToday(day) ? "text-primary-strong" : "text-fg"
                  )}
                >
                  {format(day, "d")}
                </p>
              </div>
              <span className="font-mono text-[11px] font-bold tabular-nums text-fg-muted">
                {total > 0 ? formatDuration(total) : "—"}
              </span>
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              {rows.length === 0 ? (
                <p className="py-2 text-center text-[11px] text-fg-muted">No entries</p>
              ) : (
                rows.map((e) => {
                  const dur = durationMs(
                    new Date(e.clockInAt),
                    e.clockOutAt ? new Date(e.clockOutAt) : null,
                    renderedAt
                  );
                  return (
                    <div
                      key={e.id}
                      className="rounded-lg border border-border/60 bg-bg px-2 py-1.5"
                      title={e.note ?? undefined}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-fg">
                          {e.taskTitle ?? "Untagged"}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums text-cyan-strong">
                          {formatDuration(dur)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-wider text-fg-muted">
                          {format(new Date(e.clockInAt), "HH:mm")}
                          {e.clockOutAt
                            ? `–${format(new Date(e.clockOutAt), "HH:mm")}`
                            : " · running"}
                        </span>
                        {showPerson && (
                          <span className="truncate text-[9px] text-fg-muted">{e.userName}</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
