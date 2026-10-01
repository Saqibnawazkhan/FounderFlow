"use client";

/**
 * Weekly timesheet grid (X2). Buckets the loaded time entries into a Mon–Sun
 * week with a per-day total and a week total, and lets the user page between
 * weeks. Pure client-side over the entries the /time RSC already fetched — no
 * extra round-trip.
 *
 * A SESSION IS SPLIT AT LOCAL MIDNIGHT, NOT FILED UNDER ITS START DAY
 * (time-018). This was `entries.filter(e => isSameDay(clockInAt, day))` plus a
 * sum of each matched row's FULL duration, so an overnight shift was credited
 * entirely to the day it began: a Sunday 22:00 → Monday 02:00 session put four
 * hours in the previous week's Sunday cell and nothing in the week that contains
 * most of it, understating the new week's total with no indication, while within
 * one week the start day over-reported by exactly what the next day lost. The
 * column headers read as "hours worked on this date", so the numbers were wrong
 * in a way that looked authoritative.
 *
 * `clippedDurationMs` (lib/time/thresholds.ts) owns the arithmetic, and its test
 * asserts the property this grid depends on: summing a session's per-day shares
 * returns the whole session, so no hour is lost and none is counted twice. The
 * day bounds passed to it are date-fns local midnights — never a start plus 24 h
 * — so a DST day is 23 h or 25 h wide and still adds up. Pakistan has no DST, so
 * that half is inert today and is not inert for the first customer in a zone with
 * one.
 *
 * A row that began before the day it appears in is labelled "cont.", because
 * "22:00–02:00 · 2h" on a day the session did not start is its own wrong number.
 */

import { useMemo, useState } from "react";
import {
  addDays,
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
import { clippedDurationMs, formatDuration } from "@/lib/time/thresholds";
import { cn } from "@/lib/utils";
import type { TimeEntryClient } from "@/lib/queries/time";

const WEEK_OPTS = { weekStartsOn: 1 } as const; // Monday

export function WeeklyTimesheet({
  entries,
  showPerson,
  renderedAt,
  initialWeekStart,
  loadedSince = null,
}: {
  entries: TimeEntryClient[];
  showPerson: boolean;
  renderedAt: Date;
  /** Which week to open on. Defaults to the week containing `renderedAt`. */
  initialWeekStart?: Date;
  /**
   * The oldest moment the loaded entries actually cover, or null when they cover
   * everything (time-010).
   *
   * /time reads a bounded window of the newest entries. Paging this grid past that
   * window used to draw seven "No entries" cells and "Week total 0m" for a week
   * that is populated in the database — and empty cells where real work happened
   * read as lost data, indistinguishable from a week the person took off. A week
   * outside the window now says so instead of reporting a zero it cannot know.
   */
  loadedSince?: Date | null;
}) {
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeek(initialWeekStart ?? renderedAt, WEEK_OPTS)
  );

  const days = useMemo(
    () => eachDayOfInterval({ start: weekStart, end: endOfWeek(weekStart, WEEK_OPTS) }),
    [weekStart]
  );

  // Bucket entries by the days they OVERLAP, each row carrying only that day's
  // share. A row appears in every day it touched; the day total is the sum of the
  // clipped shares, so the seven cells add up to the week and the week adds up to
  // the list view.
  const buckets = useMemo(() => {
    return days.map((day) => {
      const dayEnd = addDays(day, 1);
      const rows = entries
        .map((e) => {
          const clockIn = new Date(e.clockInAt);
          const clockOut = e.clockOutAt ? new Date(e.clockOutAt) : null;
          return {
            entry: e,
            clockIn,
            clockOut,
            share: clippedDurationMs(clockIn, clockOut, day, dayEnd, renderedAt),
            // True when the session began on an earlier day, i.e. this cell shows
            // a continuation rather than a session that started here.
            carriedOver: clockIn.getTime() < day.getTime(),
          };
        })
        // `share > 0` is the overlap test. The second clause keeps a session that
        // started in this day but has not yet accrued a measurable millisecond —
        // a just-pressed "Clock in" — visible on its own day instead of vanishing.
        .filter((r) => r.share > 0 || (r.clockIn >= day && r.clockIn < dayEnd))
        .sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime());
      const total = rows.reduce((sum, r) => sum + r.share, 0);
      return { day, rows, total };
    });
  }, [days, entries, renderedAt]);

  const weekTotal = buckets.reduce((sum, b) => sum + b.total, 0);
  const isCurrentWeek = isSameDay(weekStart, startOfWeek(renderedAt, WEEK_OPTS));
  // The whole displayed week finished before the loaded window begins, so this
  // grid knows nothing about it. `null` means "in range" and keeps the narrowing.
  const notLoadedBefore =
    loadedSince && addDays(weekStart, 7).getTime() <= loadedSince.getTime() ? loadedSince : null;

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
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
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
            <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
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
          {/* Deliberately absent when the week is outside the loaded window: a
              "Week total 0m" for a week nobody fetched is a claim, not a blank. */}
          {!notLoadedBefore && (
            <span className="font-mono text-xs text-fg-muted">
              Week total{" "}
              <span className="ms-1 font-bold tabular-nums text-fg">
                {formatDuration(weekTotal)}
              </span>
            </span>
          )}
        </div>
      </div>

      {notLoadedBefore ? (
        <p
          role="status"
          className="rounded-2xl border border-border bg-surface p-6 text-center text-sm text-fg-muted"
        >
          Sessions before {format(notLoadedBefore, "d MMM yyyy")} aren&apos;t loaded on this page,
          so this week can&apos;t be shown. That is not the same as the week being empty.
        </p>
      ) : (
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
                  rows.map(({ entry: e, clockIn, clockOut, share, carriedOver }) => (
                    <div
                      key={e.id}
                      className="rounded-lg border border-border/60 bg-bg px-2 py-1.5"
                      title={e.note ?? undefined}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-fg">
                          {e.taskTitle ?? "Untagged"}
                        </span>
                        {/* The share of this session that fell on THIS day, which is
                          what the day total is made of — not the session length. */}
                        <span className="shrink-0 font-mono text-[10px] font-bold tabular-nums text-forest-strong">
                          {formatDuration(share)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-wider text-fg-muted">
                          {carriedOver && "cont. "}
                          {format(clockIn, "HH:mm")}
                          {clockOut ? `–${format(clockOut, "HH:mm")}` : " · running"}
                        </span>
                        {showPerson && (
                          <span className="truncate text-[9px] text-fg-muted">{e.userName}</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
