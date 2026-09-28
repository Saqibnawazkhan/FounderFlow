/**
 * Shared session helper for lib/queries/ — the one place a scoped read decides
 * who is asking.
 *
 * Three properties, each of which was missing and each of which is a finding:
 *
 * 1. ONE VALIDATION PER REQUEST (perf-001). `auth()`'s jwt callback does a
 *    `SELECT … FROM "User" WHERE id = $1` on every invocation, and this helper
 *    used to call it unconditionally — six times on /dashboard, six across four
 *    sequential stages on /projects/[id]. On Vercel against Supabase that is
 *    ~100ms of pure duplicate work on the waterfall pages and 6x the pgbouncer
 *    pressure per concurrent user, which is the difference between a traffic
 *    spike being slow and being 500s. `getSession` below memoizes the read for
 *    the life of ONE request.
 *
 * 2. A REVOKED SESSION GETS AN EXIT, NOT AN ERROR CARD (auth-002). This used to
 *    `throw new Error("Not authenticated")`. Middleware cannot catch the case —
 *    the Edge `jwt` callback in auth.config.ts does no database read, so a
 *    cryptographically valid cookie whose `sessionVersion` has been bumped
 *    (the common cause: "I changed my password on my laptop") passes
 *    `authorized()` and the navigation is allowed. The RSC then got an empty
 *    session and threw, which landed in app/(app)/error.tsx — "Something broke
 *    loading this page", whose two CTAs both re-enter the same loop. The other
 *    device became a permanent error screen and the only way out was typing
 *    /login by hand. `redirect()` makes Next issue a real navigation instead.
 *
 * 3. THE FINANCE BOUNDARY IS RE-ASKED HERE (sec-002). CLAUDE.md promises two
 *    layers that agree: middleware gates the route, the server code that
 *    produces the data re-checks. Only /reports ever did. The middleware gate
 *    reads `role` out of the user's own cookie, which the Edge callback never
 *    refreshes — so a demoted co-founder who blocks the single
 *    /api/auth/session request keeps the stale claim for the JWT lifetime (30
 *    days) and keeps loading the ledger. `requireFinanceSession()` asks the
 *    same question against the role the Node `jwt` callback just refreshed
 *    from the live row, so it is independent of the cookie's freshness.
 *
 * WHY A PER-REQUEST MEMO AND NOT A CACHE WITH A TTL. A TTL would have cut the
 * duplicate reads further and paid for it by breaking (2) and (3): the entire
 * value of the per-request DB read is that a revocation or a demotion takes
 * effect on the NEXT request. A 30-second TTL is a 30-second window in which a
 * tombstoned user still reads data, and it is invisible in testing. So the memo
 * is scoped to one request and nothing longer, and the number of DB reads per
 * request goes 6 → 1, never 1 → 0. tests/lib/queries/session-gate.test.ts
 * asserts the count goes back up on the next request, so a later "optimisation"
 * to a TTL fails a test instead of quietly aging the security model.
 */

import * as React from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canSeeFinances, homeRouteForRole } from "@/lib/auth/role-gates";

export type ScopedSession = {
  userId: string;
  userName: string;
  email: string;
  companyId: string;
  role: "admin" | "cofounder" | "member";
};

/**
 * React's request-scoped memoizer, looked up rather than imported by name.
 *
 * `import { cache } from "react"` is the documented App Router idiom and it is
 * what runs in production: Next resolves `react` in the server layer to a build
 * that exports `cache`, and its entries live and die with the request's cache
 * scope. But React 18.3.1's own package exports `cache` ONLY from its
 * react-server entry, so under any other resolution — a vitest run, a client
 * bundle that pulls this module in by accident — the import is `undefined` and
 * a bare `cache(...)` at module scope would throw on import and take every
 * caller down with it.
 *
 * So it is a lookup with an identity fallback. The failure mode of being wrong
 * about the runtime is then one extra `auth()` per query — today's performance,
 * which is a known quantity — and never a session read that outlives its
 * request. A memo that guessed wrong in the other direction (a module-level
 * promise, say) would hand one user's session to the next one, so the
 * asymmetry is deliberate: the fallback has to be the slow answer, not the
 * shared one.
 */
type Memoize = <Fn extends (...args: never[]) => unknown>(fn: Fn) => Fn;

const identity: Memoize = (fn) => fn;

const perRequest: Memoize = (React as unknown as { cache?: Memoize }).cache ?? identity;

/**
 * The session for THIS request, read at most once.
 *
 * Exported so the ~66 bare `await auth()` call sites elsewhere in the app can
 * migrate onto it one file at a time; every one of them is another duplicate
 * User read today.
 */
export const getSession = perRequest(() => auth());

/**
 * The signed-in user's scope, or a redirect to /login.
 *
 * DOES NOT RETURN when there is no usable session — it calls `redirect()`,
 * which throws a NEXT_REDIRECT that Next turns into a 307 (303 from a server
 * action). Two consequences worth knowing at the call sites:
 *
 *   • A caller that wraps this in `try { … } catch {}` swallows the redirect
 *     the same way it used to swallow the throw. Those callers are no worse
 *     than before — they already turned "not authenticated" into a generic
 *     error envelope — but they are the places to convert next.
 *   • `getProjectTitleForUser` deliberately swallows it (`.catch(() => null)`)
 *     so `generateMetadata` cannot redirect a page out from under its own
 *     render; the page body performs the redirect a moment later.
 */
export async function requireScopedSession(): Promise<ScopedSession> {
  const session = await getSession();
  if (!session?.user?.id || !session.user.companyId) {
    // The cookie is either absent or no longer honoured (tombstoned user,
    // bumped sessionVersion, a claim set from before companyId was minted).
    // An RSC cannot clear a cookie, and it does not need to: Auth.js clears it
    // on the next /api/auth/session call, and a fresh sign-in overwrites it.
    // What the user needs is a way out of the loop.
    redirect("/login");
  }
  return {
    userId: session.user.id,
    userName: session.user.name ?? "",
    email: session.user.email ?? "",
    companyId: session.user.companyId,
    role: session.user.role,
  };
}

/**
 * The same scope, but only for a caller allowed to see money — the second layer
 * the ledger reads never had (sec-002).
 *
 * Call it at the top of anything that reads a transaction, a budget, a
 * recurring rule, a runway figure or the activity feed. It is the shape
 * app/(app)/reports/page.tsx already uses, hoisted to where the DATA is
 * decided so it applies to every route and every server action that reaches
 * the same query, not just the one page that remembered.
 *
 * DIVERTS RATHER THAN THROWING, and to the same place middleware sends a
 * member (`homeRouteForRole`), for two reasons. A demoted teammate is not
 * looking at a bug, so an error card would be a lie; and the two layers now
 * agree on the outcome as well as the predicate, which is what CLAUDE.md
 * claims. `canSeeFinances` is the real predicate the sidebar, the export route
 * and /reports use — so anything that is not `admin` or `cofounder`, including
 * a role invented by a tampered cookie or added to role-gates.ts next quarter,
 * fails closed here rather than sliding past a `role === "member"` comparison.
 */
export async function requireFinanceSession(): Promise<ScopedSession> {
  const scope = await requireScopedSession();
  if (!canSeeFinances(scope.role)) {
    redirect(homeRouteForRole(scope.role));
  }
  return scope;
}
