/**
 * A task deadline is a CALENDAR DAY. This module is the only place that knows
 * how that day is stored and how it is read back.
 *
 * Finding tasks-and-comments-011. `Task.deadline` is a `DateTime`, and what goes
 * into it comes from an `<input type="date">` — a day, with no time and no zone.
 * The server already read it back correctly, from UTC parts (`formatDeadline` in
 * lib/actions/tasks.ts, with a long comment defending exactly that). Every
 * CLIENT surface formatted the same instant in the VIEWER's zone instead, so for
 * a customer west of Greenwich:
 *
 *   • `format(new Date(t.deadline), "MMM dd")` on the card, the list row, the
 *     detail modal and the calendar all printed the day BEFORE the one the
 *     assigner picked — while the assignment email printed the right one. Two
 *     surfaces of one product stating different due dates for the same task.
 *   • `isPast` / `isToday` shifted with it, so the overdue flag fired a day
 *     early.
 *   • And "due today" could not be entered at all: `NewTaskSchema` compares the
 *     UTC-midnight value against the viewer's LOCAL start-of-today, and UTC
 *     midnight of today is five hours BEFORE local midnight at UTC-5.
 *
 * The product ships USD, EUR and GBP as workspace currencies, so a non-PKT
 * customer is expected rather than hypothetical.
 *
 * ── TWO DECISIONS ─────────────────────────────────────────────────────────
 *
 * 1. READING REBUILDS THE DAY FROM UTC PARTS, and returns a LOCAL midnight.
 *    `deadlineDay` is the conversion, done once at the boundary, so every
 *    date-fns call downstream (`format`, `isSameDay`, `startOfMonth`) keeps its
 *    ordinary local-time meaning and still lands on the intended day. The
 *    alternative — teaching each of a dozen call sites to read UTC parts — is
 *    the shape of bug this finding already is.
 *
 * 2. NEW ROWS ARE WRITTEN AT NOON UTC, not midnight. Reading is zone-proof
 *    either way, so this is not for this module's benefit; it is for the two
 *    files this slice does not own and therefore cannot fix:
 *
 *      • `lib/schemas/task.ts` compares the stored instant against the
 *        viewer's LOCAL start-of-today. Midnight UTC of today fails that test
 *        anywhere west of Greenwich — which is the "due today is rejected as in
 *        the past" symptom. Noon UTC passes it from UTC-11 through UTC+11.
 *      • `lib/tasks/calendar.ts` buckets by `isSameDay(new Date(deadline),
 *        cellDate)`, i.e. the viewer's local day. Noon UTC lands on the right
 *        local day across the same range; midnight UTC does not.
 *
 *    Both of those want a UTC-day comparison of their own, and both are
 *    reported as follow-ups. Until then, noon is what makes them behave. It
 *    costs nothing: the column now holds midnight-UTC rows (everything written
 *    before this change) and noon-UTC rows, and `deadlineDay` cannot tell them
 *    apart, which is the whole point. No migration is needed, and none is safe
 *    to assume — rows written by `duplicateProjectAction`'s deadline shift land
 *    on arbitrary times of day already.
 *
 *    The residual, stated plainly: for a viewer at UTC-5 between 19:00 and
 *    midnight local, `new Date().toISOString().slice(0, 10)` — what the form
 *    uses for the picker's `min` — has already rolled over to tomorrow's UTC
 *    date, so their own "today" is one day below the picker's floor. That is
 *    narrower than the bug it replaces (where "today" was refused for the whole
 *    day, in every UTC-negative zone) and it closes completely with the schema
 *    follow-up. `min` is deliberately NOT changed to the local day here, because
 *    with the current refine that would offer a date the server then rejects —
 *    the exact complaint in the finding.
 *
 * Pure, I/O-free and free of `"use client"`, so the client components, the
 * server actions and the schema can all hold the same rule.
 */

import { format, isSameDay, startOfDay } from "date-fns";

/**
 * The hour of day, in UTC, that a newly written deadline is stored at.
 *
 * Twelve, not zero. See decision 2 in the module header — it is the midpoint
 * that keeps a local-day interpretation of the instant correct from UTC-11 to
 * UTC+11, which is every timezone any customer of this product lives in.
 */
export const DEADLINE_HOUR_UTC = 12;

/** Accepts the ISO string the client receives or the `Date` the server holds. */
export type DeadlineInput = string | Date;

function asDate(deadline: DeadlineInput): Date {
  return deadline instanceof Date ? deadline : new Date(deadline);
}

/**
 * The calendar day this deadline names, as a LOCAL `Date` at midnight.
 *
 * Read from UTC parts, so a row stored at midnight UTC and a row stored at noon
 * UTC yield the same day. Returned in local time so `format`, `isSameDay` and
 * `startOfMonth` downstream mean what they usually mean.
 *
 * An unparseable value comes back as an `Invalid Date` rather than throwing:
 * these render inside a card, and a malformed row should show a blank date, not
 * blank the board.
 */
export function deadlineDay(deadline: DeadlineInput): Date {
  const instant = asDate(deadline);
  if (Number.isNaN(instant.getTime())) return instant;
  return new Date(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}

/** `"YYYY-MM-DD"` for the day this deadline names — the `<input type=date>` value. */
export function deadlineDayValue(deadline: DeadlineInput): string {
  const day = deadlineDay(deadline);
  if (Number.isNaN(day.getTime())) return "";
  return format(day, "yyyy-MM-dd");
}

/** The day, formatted with a date-fns mask. `""` for an unparseable value. */
export function formatDeadlineDay(deadline: DeadlineInput, mask: string): string {
  const day = deadlineDay(deadline);
  if (Number.isNaN(day.getTime())) return "";
  return format(day, mask);
}

/**
 * The instant to STORE for a `"YYYY-MM-DD"` picker value.
 *
 * Built by string concatenation rather than from a local `Date`, so the day the
 * user picked is the day that is stored regardless of the author's zone.
 */
export function deadlineInstantForDay(dayValue: string): string {
  const hour = String(DEADLINE_HOUR_UTC).padStart(2, "0");
  return new Date(`${dayValue}T${hour}:00:00.000Z`).toISOString();
}

/** True when the deadline's day is the same calendar day as `now`. */
export function isDeadlineToday(deadline: DeadlineInput, now: Date = new Date()): boolean {
  const day = deadlineDay(deadline);
  if (Number.isNaN(day.getTime())) return false;
  return isSameDay(day, now);
}

/**
 * True when the deadline's day is STRICTLY BEFORE today.
 *
 * Not `isPast(instant)`, which was the bug's second half: a deadline stored at
 * midnight (or noon) is "past" from early on the due day itself, so a task due
 * today rendered in overdue red — in PKT as well as at UTC-5. A day is not late
 * until it is over.
 */
export function isDeadlineOverdue(deadline: DeadlineInput, now: Date = new Date()): boolean {
  const day = deadlineDay(deadline);
  if (Number.isNaN(day.getTime())) return false;
  return day.getTime() < startOfDay(now).getTime();
}

/**
 * True when the deadline's day falls in the window `[today, today + days]`,
 * inclusive at both ends.
 *
 * Today counts as inside it. The previous comparison was `instant >= now`,
 * which silently excluded everything due today from "Next 7 days" — a filter
 * whose whole job is "what is coming up".
 */
export function isDeadlineWithinDays(
  deadline: DeadlineInput,
  days: number,
  now: Date = new Date()
): boolean {
  const day = deadlineDay(deadline);
  if (Number.isNaN(day.getTime())) return false;
  const start = startOfDay(now);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + days);
  return day.getTime() >= start.getTime() && day.getTime() <= end.getTime();
}
