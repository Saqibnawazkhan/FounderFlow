/**
 * THE month boundary. One rule, one file, imported by both the server queries
 * and the client cards so four surfaces cannot disagree about which month a
 * transaction belongs to again.
 *
 * ── THE BOUNDARY RULE ──────────────────────────────────────────────────────
 * A month is the half-open interval [start, endExclusive) in **UTC**:
 *
 *     2026-10-01T00:00:00.000Z  ≤  date  <  2026-11-01T00:00:00.000Z
 *
 * UTC, not local, and that is not a stylistic choice. `Transaction.date` is a
 * DATE-ONLY value: `<input type="date">` yields "2026-10-01",
 * components/transactions/transaction-form.tsx does
 * `new Date("2026-10-01").toISOString()` — and JS parses a bare date-only ISO
 * string as UTC midnight — and the column is `TIMESTAMP(3)` (no zone), so what
 * lands in Postgres is the UTC wall clock 2026-10-01T00:00:00.000. The value
 * carries no zone and no time; the only bucketing that round-trips it is UTC.
 *
 * WHAT WENT WRONG WITHOUT THIS FILE (money-007). The server already bucketed in
 * UTC — `new Date(Date.UTC(y, m, 1))` in lib/queries/budgets.ts,
 * lib/budgets/check.ts and lib/queries/projects.ts. The client cards used
 * date-fns `startOfMonth`/`endOfMonth`, which are LOCAL. In America/Bogota
 * (UTC-5) local start-of-October is 2026-10-01T05:00Z, so a row stored for
 * "October 1st" fell in SEPTEMBER on /dashboard and /reports while already
 * consuming the OCTOBER budget cap on /budgets and the project page. Every
 * customer west of UTC, every month end, in both directions. A team in a
 * positive-offset zone (Karachi, where this was built) never sees it.
 *
 * It also removes a quieter defect: an RSC renders in the Vercel container's
 * timezone (UTC) and hydrates in the viewer's, so a LOCAL boundary made the
 * server pass and the client pass compute different figures from identical
 * rows. A UTC boundary is the same number on both sides of the wire.
 *
 * HALF-OPEN, NOT INCLUSIVE. `gte`/`lt` is what every server query already
 * passes Prisma, so `endExclusive` is the shape that can be handed straight to
 * a `where`. An inclusive `endOfMonth` (…T23:59:59.999) silently drops a row
 * stored with microsecond precision and has to be re-derived per call site,
 * which is how two spellings of one boundary got into the product.
 *
 * NO date-fns HERE, DELIBERATELY. Every date-fns month helper works in the
 * runtime's local calendar. Importing one into this module would put the exact
 * trap it exists to close one keystroke away. Plain `Date.UTC` arithmetic and
 * `Intl` with an explicit `timeZone: "UTC"` are the whole implementation.
 *
 * Tested in tests/lib/queries/month-boundary.test.ts, which asserts its own
 * timezone first — under TZ=UTC every case here is vacuous.
 */

/** A month as Prisma wants it: `{ date: { gte: start, lt: endExclusive } }`. */
export interface UtcMonthWindow {
  start: Date;
  endExclusive: Date;
}

/**
 * UTC midnight on the 1st of `ref`'s month, shifted by `monthOffset` months.
 *
 * `Date.UTC` normalises out-of-range months for us, so -13 walks back a year
 * and a month without any year/month bookkeeping at the call site.
 */
export function startOfUtcMonth(ref: Date, monthOffset = 0): Date {
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + monthOffset, 1));
}

/** The half-open UTC month containing `ref`, shifted by `monthOffset`. */
export function utcMonthWindow(ref: Date, monthOffset = 0): UtcMonthWindow {
  return {
    start: startOfUtcMonth(ref, monthOffset),
    endExclusive: startOfUtcMonth(ref, monthOffset + 1),
  };
}

/**
 * Does `value` fall in `ref`'s UTC month? Takes the ISO string form too,
 * because transactions cross the RSC boundary as strings (`toClient` in
 * lib/queries/transactions.ts) and every client-side call site would otherwise
 * wrap its own `new Date(...)`.
 */
export function isInUtcMonth(value: Date | string, ref: Date, monthOffset = 0): boolean {
  const window = utcMonthWindow(ref, monthOffset);
  const at = typeof value === "string" ? new Date(value) : value;
  return at >= window.start && at < window.endExclusive;
}

/**
 * "Oct" for a bucket start.
 *
 * WHY THIS EXISTS: `format(monthStart, "MMM")` renders a UTC-midnight Date in
 * the RUNTIME's zone, so the October bucket prints "Sep" for every viewer west
 * of UTC — a second off-by-one, in the label rather than the sum, that moving
 * the bucket to UTC would otherwise have introduced. `timeZone: "UTC"` is the
 * whole point of the function; `en-US` matches the output date-fns produced.
 */
const UTC_MONTH_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
export function utcMonthShortLabel(at: Date): string {
  return UTC_MONTH_SHORT.format(at);
}

/**
 * UTC midnight, `months` calendar months before `ref`'s day — a ROLLING
 * window's lower bound, not a calendar month's.
 *
 * Used for the 3-month average burn. Deliberately NOT `startOfUtcMonth(ref, -2)`:
 * a calendar window includes a partial current month, so early in the month the
 * divide-by-3 understates burn and therefore OVERSTATES runway, which is the
 * one number on the dashboard a founder makes decisions on.
 *
 * Midnight rather than `ref`'s clock time so the window edge does not depend on
 * what time of day the page was opened: a row dated the boundary day is stored
 * at UTC midnight and would otherwise drop in or out over the course of a day.
 *
 * CLAMPS into short months instead of overflowing. `Date.UTC(2026, 1, 31)`
 * normalises FORWARD to March 3rd, which would move a burn window three days
 * without anyone noticing; date-fns `subMonths` clamps to Feb 28, and so do we.
 */
export function utcMonthsAgo(ref: Date, months: number): Date {
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() - months;
  // Day 0 of the FOLLOWING month is the last day of the target month.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(ref.getUTCDate(), lastDayOfTargetMonth)));
}
