/**
 * Pure time-tracking helpers. No DB, no Prisma — just math against
 * Date / number args. Tested in isolation in tests/lib/time/.
 *
 * Three thresholds, derived once so the client, server action, and cron
 * stay aligned:
 *
 *   WARN_AFTER_MS  — show the in-app "still working?" modal after this much
 *                    idle time since the last heartbeat.
 *   AUTO_CLOSE_MS  — the cron / client idle fallback closes the entry once
 *                    inactivity passes this point. Strictly larger than
 *                    WARN_AFTER_MS, with a 30-min response window.
 *   HEARTBEAT_MS   — how often the client sends a heartbeat while the entry
 *                    is open. Small enough that an auto-close at
 *                    lastActivityAt only "loses" a few minutes of credit.
 */

export const HEARTBEAT_MS = 5 * 60 * 1000; // 5 min
export const WARN_AFTER_MS = 12 * 60 * 60 * 1000; // 12 h
export const RESPONSE_WINDOW_MS = 30 * 60 * 1000; // 30 min after warn
export const AUTO_CLOSE_MS = WARN_AFTER_MS + RESPONSE_WINDOW_MS; // 12.5 h

/**
 * Ceiling on ONE hand-logged session (time-005). 24 h, deliberately looser than
 * `AUTO_CLOSE_MS`: the auto-close horizon is about an unattended tab, while this
 * is about a human typing two timestamps, and a 20-hour launch night is a thing
 * people really log. `CreateManualEntrySchema` and `UpdateTimeEntrySchema` both
 * refine against it, so the create path and the admin-edit path cannot disagree
 * about what a plausible session is.
 *
 * It exists because `createManualEntryAction` is ungated by role on purpose
 * ("any member can log their own forgotten work with no elevated permission"),
 * which put the number behind /settings "Total tracked", the /time KPI and every
 * project rollup in the hands of the workspace's lowest-privilege user.
 */
export const MAX_MANUAL_ENTRY_MS = 24 * 60 * 60 * 1000; // 24 h

export type EntryState = "active" | "warn" | "auto-close";

/** Decide what the client should do for an open entry given the clock. */
export function entryState(lastActivityAt: Date, now: Date = new Date()): EntryState {
  const idle = now.getTime() - lastActivityAt.getTime();
  if (idle >= AUTO_CLOSE_MS) return "auto-close";
  if (idle >= WARN_AFTER_MS) return "warn";
  return "active";
}

/** Elapsed working time in milliseconds, capped at the auto-close horizon
 *  while the entry is still open. Once an entry is closed (clockOutAt set)
 *  it returns the literal interval.
 *
 *  THE CAP IS NEW (time-015). This docstring promised it for four months while
 *  the body was `Math.max(0, now - clockInAt)`. Auto-close is driven by IDLE
 *  time, not elapsed time, and `<ClockWidget>` heartbeats every HEARTBEAT_MS
 *  whenever `document.hidden` is false — so a tab parked on a second monitor
 *  resets `lastActivityAt` for ever, `entryState` never leaves "active", and the
 *  sweep's `lastActivityAt: { lt: cutoff }` never matches. A timer started Friday
 *  afternoon read 70h+ on Monday, with no badge anywhere saying the figure was
 *  junk, and that figure is summed into /time "Total tracked", /settings and
 *  `getClockedInPeers`.
 *
 *  A CLOSED ENTRY IS NEVER CAPPED, and that asymmetry is the point. While open,
 *  the number answers "how long has this been running", which for an unattended
 *  tab is a guess, and AUTO_CLOSE_MS is the horizon this product already says it
 *  will not credit past. Once somebody (or the sweep) wrote `clockOutAt` the
 *  interval is recorded history, and clamping it would silently rewrite a
 *  customer's timesheet — which is the same class of harm as the bug.
 *
 *  This bounds the DISPLAY. `heartbeatAction` bounds the ROW, by refusing and
 *  auto-closing once an entry has been open for MAX_MANUAL_ENTRY_MS regardless of
 *  idle time; without that half the stored interval would still be unbounded the
 *  moment anyone finally clocked out.
 *
 *  The two numbers differ ON PURPOSE and it is not a loose end. THIS cap (12.5h)
 *  is what a DISPLAY should credit an unattended tab, and the heartbeat's ceiling
 *  (24h) is the point a live session stops being plausible at all — a heartbeat
 *  only arrives while the tab is visible, so it is evidence somebody is there, and
 *  holding an attended session to a stricter limit than a hand-logged one was
 *  taking hours off people who were working. `lib/queries/stats.ts` mirrors THIS
 *  function, branch for branch, because it answers the same question. */
export function durationMs(
  clockInAt: Date,
  clockOutAt: Date | null,
  now: Date = new Date()
): number {
  if (clockOutAt) return Math.max(0, clockOutAt.getTime() - clockInAt.getTime());
  return Math.min(AUTO_CLOSE_MS, Math.max(0, now.getTime() - clockInAt.getTime()));
}

/**
 * The share of a session that falls inside one calendar day (time-018).
 *
 * `[dayStart, dayEnd)` is a half-open local-day window — pass the two midnights
 * date-fns hands you, NOT a start plus 24 h, so a DST day is 23 h or 25 h wide
 * and the arithmetic still adds up. Pakistan has no DST, so that case is inert
 * today and is not inert for the first customer in a zone that has one.
 *
 * WHY THIS EXISTS. `<WeeklyTimesheet>` bucketed rows with
 * `isSameDay(clockInAt, day)` and then summed each matched row's FULL duration,
 * so a Sunday 22:00 → Monday 02:00 session put four hours into the previous
 * week's Sunday cell and nothing into the week that contains most of it. The
 * per-day figures read as "hours worked on this date", the two adjacent weeks
 * disagreed with the list view's own total, and there was no indication of
 * either.
 *
 * Summing this over every day a session touches returns exactly `durationMs` of
 * that session: no hour is lost and none is counted twice. The test asserts that
 * property rather than a handful of examples.
 *
 * An open entry is clipped at `now` and carries `durationMs`'s cap, so the two
 * views of the same running session cannot report different totals.
 */
export function clippedDurationMs(
  clockInAt: Date,
  clockOutAt: Date | null,
  dayStart: Date,
  dayEnd: Date,
  now: Date = new Date()
): number {
  const start = clockInAt.getTime();
  const end = clockOutAt ? clockOutAt.getTime() : Math.min(now.getTime(), start + AUTO_CLOSE_MS);
  const from = Math.max(start, dayStart.getTime());
  const to = Math.min(end, dayEnd.getTime());
  return Math.max(0, to - from);
}

/** "1h 23m" / "8h 04m" / "0m" formatter — UI uses this in tables + the
 *  topbar timer. Seconds-precision burns CPU + adds visual noise; keep to
 *  whole minutes for everything except the live ticker (which can add
 *  seconds on top via the same h/m base). */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

/** Sum durations on a list of {clockInAt, clockOutAt} pairs. `now` is used
 *  to time the still-open ones. */
export function sumDurations(
  entries: { clockInAt: Date; clockOutAt: Date | null }[],
  now: Date = new Date()
): number {
  return entries.reduce((acc, e) => acc + durationMs(e.clockInAt, e.clockOutAt, now), 0);
}

/** Whether a user is currently allowed to manually edit clock times.
 *  Centralised so the action + UI render path agree. */
export function canEditEntryTimes(role: "admin" | "cofounder" | "member"): boolean {
  return role === "admin" || role === "cofounder";
}
