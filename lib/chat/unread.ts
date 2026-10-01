/**
 * The unread badge's arithmetic.
 *
 * Split out of lib/queries/chat.ts because the cap is a product decision with
 * an exact boundary (99 renders as "99", 100 renders as "99+"), and a
 * boundary nobody can unit-test is a boundary that drifts. The query does the
 * counting; this decides what a count means to the rail.
 */

/**
 * The largest number the badge will ever show. A count that arrives at the UI
 * equal to this is "99 or more", never a literal ninety-nine, because both read
 * paths clamp through `capUnread` before the number leaves the server — so
 * `unreadLabel` renders it as "99+". The exact figure stops being interesting
 * up here anyway: nobody reads 247 differently from 99, and an unbounded number
 * makes the badge change width.
 */
export const UNREAD_CAP = 99;

/**
 * Clamp a raw unread count into what the badge can display.
 *
 * Negative and non-finite inputs collapse to 0 rather than propagating: the
 * count arrives from a `groupBy` aggregate, and a badge reading "-1" or "NaN"
 * is worse than a badge reading nothing.
 */
export function capUnread(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), UNREAD_CAP);
}

/**
 * True when the badge should render the "+" suffix — i.e. the real count was
 * clipped. The UI asks this rather than comparing against 99 itself, so the
 * cap lives in exactly one module.
 */
export function isUnreadCapped(count: number): boolean {
  return Number.isFinite(count) && count > UNREAD_CAP;
}

/**
 * What the badge actually renders: the number, or `"99+"` at the cap.
 *
 * Lives here rather than beside a component because TWO surfaces render it —
 * the per-channel badge in the channel rail and the total on the sidebar's
 * Chat row — and two surfaces showing different numbers for the same unread
 * messages is the exact bug this session has kept finding. One function, so
 * "99+" starts and stops at the same place on both.
 *
 * TAKES AN ALREADY-CAPPED COUNT, which is why it compares `>= UNREAD_CAP` and
 * deliberately does NOT call `isUnreadCapped`. Both query paths run the count
 * through `capUnread` before it leaves the server, so 99 arriving here means
 * "99 or more", never a literal ninety-nine. `isUnreadCapped` answers a
 * question about the RAW count (`> 99`), and asking it here would render a
 * clipped 400 as a flat "99" — under-reporting, the one direction a badge
 * must not fail in. Running the input through `capUnread` first means a raw
 * count passed by mistake still labels correctly.
 */
export function unreadLabel(count: number): string {
  const shown = capUnread(count);
  return shown >= UNREAD_CAP ? `${UNREAD_CAP}+` : String(shown);
}
