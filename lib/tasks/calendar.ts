/**
 * Month-grid construction for the /tasks calendar view.
 *
 * Pure and I/O-free so the bucketing rules are unit-testable without a DOM —
 * the same split as `lib/time/thresholds.ts`, which the weekly timesheet
 * leans on.
 *
 * Two rules earn their own tests:
 *
 *   • Weeks start on MONDAY, matching `components/time/weekly-timesheet.tsx`.
 *     A product that shows Mon-start timesheets and Sun-start tasks is a bug
 *     report waiting to happen.
 *
 *   • A task is bucketed by its deadline's LOCAL calendar day. `Task.deadline`
 *     is an ISO-8601 instant (UTC); bucketing on the UTC day would push a task
 *     due 23:59 local onto the following day for every user east of Greenwich
 *     — which is all of them, the workspace being PKT (+05:00). `new Date(iso)`
 *     then `isSameDay` compares in the viewer's zone, which is what a person
 *     looking at a calendar means by "due that day".
 *
 * `now` is injected rather than read from the clock so "today" is pinnable in
 * tests; callers pass the real date.
 */

import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import type { Task } from "@/lib/types";

/** Monday-start weeks. Shared with the weekly timesheet. */
export const WEEK_OPTS = { weekStartsOn: 1 } as const;

/** How many task chips a day cell shows before collapsing behind "+N more". */
export const MAX_CHIPS_PER_DAY = 3;

export type CalendarCell<T> = {
  date: Date;
  /** False for the leading/trailing days that pad the grid out to whole weeks. */
  inMonth: boolean;
  isToday: boolean;
  tasks: T[];
};

/** Urgent first, then the board's manual order — so a day reads worst-first. */
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Lay `month` out as whole Monday-start weeks and drop each task onto its
 * deadline's local day. Always returns a multiple of 7 cells (35 or 42), so
 * the grid never needs to pad at render time.
 */
export function buildMonthGrid<T extends Pick<Task, "deadline" | "priority" | "order">>(
  month: Date,
  tasks: T[],
  now: Date
): CalendarCell<T>[] {
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), WEEK_OPTS),
    end: endOfWeek(endOfMonth(month), WEEK_OPTS),
  });

  return days.map((date) => ({
    date,
    inMonth: isSameMonth(date, month),
    isToday: isSameDay(date, now),
    tasks: tasks
      .filter((t) => isSameDay(new Date(t.deadline), date))
      .sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || a.order - b.order
      ),
  }));
}
