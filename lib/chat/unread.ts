/**
 * The unread badge's arithmetic.
 *
 * Split out of lib/queries/chat.ts because the cap is a product decision with
 * an exact boundary (99 renders as "99", 100 renders as "99+"), and a
 * boundary nobody can unit-test is a boundary that drifts. The query does the
 * counting; this decides what a count means to the rail.
 */

/**
 * The largest number the badge will ever show. The UI renders "99+" when a
 * capped count comes back, so this is also the threshold above which the
 * exact number stops being interesting — nobody reads 247 differently from
 * 99, and letting the number grow unbounded makes the badge change width.
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
