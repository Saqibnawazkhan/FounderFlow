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
 *  it returns the literal interval. */
export function durationMs(
  clockInAt: Date,
  clockOutAt: Date | null,
  now: Date = new Date()
): number {
  if (clockOutAt) return Math.max(0, clockOutAt.getTime() - clockInAt.getTime());
  return Math.max(0, now.getTime() - clockInAt.getTime());
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
