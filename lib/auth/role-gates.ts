/**
 * Pure role-gate helpers. No I/O — safe for the Edge runtime (middleware),
 * Node runtime (server actions), and the client (sidebar filter).
 *
 * Permission model:
 *   admin     — founder; full access including finances + team management
 *   cofounder — full access including finances; can't change roles or remove users
 *   member    — tasks, time, team (read), notifications, settings ONLY
 *
 * Finance surfaces hidden from members: every page that can show a PKR
 * figure or a transaction-related event. The activity feed leaks finance
 * activity types ("Ahmed added an expense"), so it's hidden too rather
 * than filtered — keeps the rule simple and unambiguous.
 */

export type Role = "admin" | "cofounder" | "member";

/**
 * Routes (page paths) a member is NOT allowed to visit. Anything not on
 * this list is a member-allowed route. Used by both the middleware
 * redirect AND the sidebar nav filter to stay in sync.
 *
 * Notes:
 *   • Match by exact path or "/path/" prefix so `/expenses/123` is gated
 *     even though only `/expenses` is listed.
 *   • `/` is the public landing; not gated — but logged-in members landing
 *     there get bounced via the post-login redirect (see homeRouteForRole).
 */
export const MEMBER_BLOCKED_ROUTES: readonly string[] = [
  "/dashboard",
  "/expenses",
  "/investments",
  "/recurring",
  "/budgets",
  "/reports",
  "/activities",
];

export function canSeeFinances(role: Role): boolean {
  return role === "admin" || role === "cofounder";
}

/** True if the given pathname matches one of the member-blocked routes. */
export function isMemberBlockedRoute(pathname: string): boolean {
  return MEMBER_BLOCKED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/")
  );
}

/**
 * Where to send a user after sign-in or after they hit a route they're
 * not allowed to visit. Admin/cofounder default to /dashboard; members
 * go straight to /tasks since that's the only thing they can do.
 */
export function homeRouteForRole(role: Role): string {
  return canSeeFinances(role) ? "/dashboard" : "/tasks";
}
