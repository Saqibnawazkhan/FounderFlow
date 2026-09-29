"use client";

/**
 * Calendar view for /tasks — the third tab beside Board and List.
 *
 * Every task has exactly one anchor: `Task.deadline` is required and non-null
 * in the schema, so there is no "undated" bucket to design around.
 *
 * Layout is two renderings of the same data, not two components:
 *   • md+  — a 7-column Monday-start month grid. The vocabulary comes from
 *            components/time/weekly-timesheet.tsx: the same pager pill shell,
 *            the same today treatment.
 *   • <md  — an agenda. Seven columns on a 375px phone gives ~50px cells,
 *            which cannot hold a task title, so the narrow layout lists only
 *            the days that actually have work.
 *
 * "Two renderings of the same data" is load-bearing, not a turn of phrase: the
 * two layouts must surface the SAME task set. `agendaDays` is the only place
 * the narrow list is derived, and it is exported so
 * tests/lib/tasks/calendar.test.ts can hold it against the grid's own cells
 * without a DOM.
 *
 * Bucketing and sorting live in lib/tasks/calendar.ts so they can be tested
 * without a DOM; this file owns presentation and the "+N more" disclosure.
 */

import { useEffect, useMemo, useState } from "react";
import { addMonths, format, isSameMonth, startOfMonth, subMonths } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { buildMonthGrid, MAX_CHIPS_PER_DAY, type CalendarCell } from "@/lib/tasks/calendar";
import { cn } from "@/lib/utils";
import type { TaskWithCount } from "@/lib/queries/tasks";

/** Mon-first, matching WEEK_OPTS. Short labels so narrow cells never wrap. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Mirrors PRIORITY_STYLES on the board, reduced to a dot for a 20px chip. */
const PRIORITY_DOT: Record<string, string> = {
  urgent: "bg-danger",
  high: "bg-warning",
  medium: "bg-info",
  low: "bg-fg-muted/50",
};

/**
 * The days the narrow agenda lists: every rendered cell that carries work.
 *
 * Note what is NOT here — a `c.inMonth` filter. It used to be, and it meant a
 * task due on one of the leading/trailing padding days (31 Aug inside the
 * September grid, say) rendered on a laptop and silently vanished on a phone.
 * The desktop grid maps all 35/42 cells, so the grid is the honest one: if a
 * day is on screen, the work on it is real. Dropping only the EMPTY days is
 * what the narrow layout actually needs — a phone cannot afford thirty-five
 * headers with nothing under them.
 */
export function agendaDays<T>(cells: CalendarCell<T>[]): CalendarCell<T>[] {
  return cells.filter((c) => c.tasks.length > 0);
}

export function TaskCalendar({
  tasks,
  now,
  onOpenDetail,
  highlightId = null,
  registerRef,
}: {
  tasks: TaskWithCount[];
  /** Injected so today is deterministic under test. */
  now: Date;
  onOpenDetail: (task: TaskWithCount) => void;
  /**
   * The task a `?taskId=` notification link is pointing at, if any. Board and
   * List have always taken these two; the calendar did not, which made the
   * deep link inert for anyone whose persisted view was Calendar — a dead
   * notification link, and the view choice survives refreshes. Optional so the
   * calendar still renders standalone (and in its own component tests).
   */
  highlightId?: string | null;
  registerRef?: (id: string) => (el: HTMLElement | null) => void;
}) {
  const [month, setMonth] = useState<Date>(() => startOfMonth(now));
  // Which day cell has had its "+N more" opened. One at a time: this is a
  // disclosure, not a filter, and leaving several open just reflows the grid.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const cells = useMemo(() => buildMonthGrid(month, tasks, now), [month, tasks, now]);
  const isCurrentMonth = isSameMonth(month, now);
  const daysWithTasks = useMemo(() => agendaDays(cells), [cells]);

  // A notification link can name a task due in a month the calendar is not
  // showing — it opens on today's. Page to the task's month so the highlight
  // has something to land on; otherwise the deep link "works" but the user
  // stares at an unchanged September while their task sits in November.
  useEffect(() => {
    if (!highlightId) return;
    const target = tasks.find((t) => t.id === highlightId);
    if (!target) return;
    const due = startOfMonth(new Date(target.deadline));
    if (Number.isNaN(due.getTime())) return;
    setMonth((prev) => (isSameMonth(prev, due) ? prev : due));
  }, [highlightId, tasks]);

  // ...and open the day if the linked task is one of the ones folded behind
  // "+N more". A deep link that scrolls you to a collapsed cell is the same
  // dead end as no deep link at all. This is a second pass rather than part of
  // the jump above because the cell only exists once `month` has moved. The
  // disclosure is left open afterwards on purpose: the highlight ring clears
  // itself after a couple of seconds, and re-hiding the task the user followed
  // a link to reach would undo the whole point.
  useEffect(() => {
    if (!highlightId) return;
    const cell = cells.find((c) => c.tasks.some((t) => t.id === highlightId));
    if (!cell) return;
    if (cell.tasks.slice(0, MAX_CHIPS_PER_DAY).some((t) => t.id === highlightId)) return;
    setExpandedKey(cell.date.toISOString());
  }, [highlightId, cells]);

  function goto(next: Date) {
    setMonth(next);
    setExpandedKey(null);
  }

  return (
    <section>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Toolbar. Attached to the grid rather than floating above it — three
            stacked toolbars pushed the calendar itself below the fold. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5">
          <div className="inline-flex items-center gap-1 rounded-full border border-border bg-bg p-1">
            <button
              type="button"
              onClick={() => goto(subMonths(month, 1))}
              aria-label="Previous month"
              className="rounded-full p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
            >
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </button>
            <span className="min-w-[9.5rem] text-center font-mono text-xs font-semibold tabular-nums text-fg">
              {format(month, "MMMM yyyy")}
            </span>
            <button
              type="button"
              onClick={() => goto(addMonths(month, 1))}
              aria-label="Next month"
              className="rounded-full p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
            >
              <ChevronRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </button>
          </div>

          {!isCurrentMonth && (
            <button
              type="button"
              onClick={() => goto(startOfMonth(now))}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
            >
              <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
              This month
            </button>
          )}
        </div>

        {/* md+ : month grid. `data-calendar` names the two layouts so tests can
          scope to one without matching an unrelated `md:block` in the shell. */}
        <div data-calendar="grid" className="hidden md:block">
          <div className="grid grid-cols-7 border-b border-border">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="px-2 py-2.5 text-center font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
              >
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {cells.map((cell) => {
              const key = cell.date.toISOString();
              const expanded = expandedKey === key;
              const visible = expanded ? cell.tasks : cell.tasks.slice(0, MAX_CHIPS_PER_DAY);
              const hidden = cell.tasks.length - visible.length;

              return (
                <div
                  key={key}
                  // Stable hook for scripts/smoke-tasks-calendar.mjs, which
                  // asserts in the real DOM that a task lands on the right day
                  // — the one thing the jsdom tests cannot prove.
                  data-date={format(cell.date, "yyyy-MM-dd")}
                  className={cn(
                    "min-h-[7.5rem] border-b border-e border-border p-1.5",
                    !cell.inMonth && "bg-bg/40"
                  )}
                >
                  <div className="mb-1 flex items-center justify-between px-1">
                    <span
                      className={cn(
                        "font-mono text-[11px] tabular-nums",
                        cell.isToday
                          ? "grid h-5 w-5 place-items-center rounded-full bg-primary font-bold text-primary-fg"
                          : cell.inMonth
                            ? "text-fg"
                            : "text-fg-muted/50"
                      )}
                    >
                      {format(cell.date, "d")}
                    </span>
                    {cell.isToday && <span className="sr-only">Today</span>}
                  </div>

                  <ul className="space-y-1">
                    {visible.map((task) => (
                      <li key={task.id}>
                        <TaskChip
                          task={task}
                          onOpen={onOpenDetail}
                          highlighted={highlightId === task.id}
                          externalRef={registerRef?.(task.id)}
                        />
                      </li>
                    ))}
                  </ul>

                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => setExpandedKey(key)}
                      className="mt-1 w-full rounded-md px-1.5 py-0.5 text-start text-[11px] font-medium text-primary-strong transition-colors hover:bg-surface-hover"
                    >
                      +{hidden} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* below md : agenda */}
        <div data-calendar="agenda" className="space-y-3 p-3 md:hidden">
          {daysWithTasks.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border bg-bg/40 p-6 text-center text-sm text-fg-muted">
              Nothing due in {format(month, "MMMM")}.
            </p>
          ) : (
            daysWithTasks.map((cell) => (
              <div
                key={cell.date.toISOString()}
                data-date={format(cell.date, "yyyy-MM-dd")}
                className="overflow-hidden rounded-2xl border border-border bg-surface"
              >
                <div
                  className={cn(
                    "flex items-baseline gap-2 border-b border-border px-4 py-2.5",
                    cell.isToday && "bg-primary/[0.08]"
                  )}
                >
                  <span className="font-mono text-sm font-bold tabular-nums text-fg">
                    {/* The grid greys a padding day to say "this is not your
                        month"; a bare number in a vertical list cannot. Name
                        the month instead, so a 31 sitting above a 15 reads as
                        31 Aug rather than as a list out of order. */}
                    {format(cell.date, cell.inMonth ? "d" : "d MMM")}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
                    {format(cell.date, "EEEE")}
                  </span>
                  {cell.isToday && (
                    <span className="ms-auto rounded-full bg-primary px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-primary-fg">
                      Today
                    </span>
                  )}
                </div>
                <ul className="space-y-1 p-2">
                  {cell.tasks.map((task) => (
                    <li key={task.id}>
                      <TaskChip
                        task={task}
                        onOpen={onOpenDetail}
                        highlighted={highlightId === task.id}
                        externalRef={registerRef?.(task.id)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function TaskChip({
  task,
  onOpen,
  highlighted = false,
  externalRef,
}: {
  task: TaskWithCount;
  onOpen: (t: TaskWithCount) => void;
  highlighted?: boolean;
  /**
   * Registers this node as a scroll target for `?taskId=`. Both layouts render
   * at once (one is CSS-hidden), so the SAME task registers twice — the
   * caller's registry is built to hold several nodes per id and pick one that
   * is actually laid out. See tasks-client.tsx.
   */
  externalRef?: (el: HTMLElement | null) => void;
}) {
  const done = task.status === "completed";
  return (
    <button
      type="button"
      ref={externalRef}
      onClick={() => onOpen(task)}
      title={task.title}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md border border-border bg-bg px-1.5 py-1 text-start text-[11px] transition-colors hover:border-primary/40 hover:bg-surface-hover",
        done && "opacity-60",
        highlighted && "border-primary/60 bg-primary/[0.08] ring-2 ring-primary/50"
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", PRIORITY_DOT[task.priority])}
      />
      <span className={cn("truncate text-fg", done && "line-through")}>{task.title}</span>
    </button>
  );
}
