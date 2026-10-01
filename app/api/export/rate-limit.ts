/**
 * The export endpoint's rate limiter (rep-010).
 *
 * ── WHY THIS IS A SEPARATE MODULE AND NOT TWO LINES IN route.ts ─────────────
 * Next.js validates the export surface of a Route Handler: its generated
 * `.next/types/app/api/export/route.ts` feeds `typeof import(route)` through
 * `Diff<{ GET?, POST?, dynamic?, runtime?, maxDuration?, … }, TEntry>`, which
 * produces a type error for any key that is not on that list. So `route.ts`
 * cannot export the limiter or its numbers for a test to import — `next build`
 * would fail, which is worse than the problem it solves. A colocated module can
 * export whatever it likes, and `app/api/export/` has no other route in it.
 *
 * ── WHY NOT lib/rate-limit.ts's `limiters` TABLE ────────────────────────────
 * That is where this belongs, and that file belongs to another agent in this
 * wave. `rateLimiter()` anchors its buckets on `globalThis` keyed by NAME, so a
 * limiter declared here is behaviourally identical to one declared in that
 * table — including for a test, which can construct `rateLimiter("export", …)`
 * and clear the route's keys. Move it into `limiters` when the file is free.
 * Same situation, and the same reasoning, as `handleLimiter` in
 * lib/actions/profile.ts.
 *
 * ── THE NUMBERS ────────────────────────────────────────────────────────────
 * Five per ten minutes, per person, per scope.
 *
 * FIVE, because an export is a deliberate act a person performs once. The
 * budget has to absorb a failed download, a retry, and pulling both scopes
 * while deciding which one they wanted — not a loop.
 *
 * TEN MINUTES rather than the usual one, because the abuse being priced is
 * REPETITION, not a burst. A 60-second window refills fast enough that "export
 * the whole workspace over and over" stays free; the point is that the fifth
 * copy in ten minutes is already well past anything a person does.
 *
 * PER SCOPE as well as per person. `limiters.read`'s docstring in
 * lib/rate-limit.ts states the rule: "a rejection that lands on a DIFFERENT
 * action from the one that caused it is the worst class of bug this file can
 * cause." `scope=me` is one person's own rows and is open to every role;
 * `scope=workspace` is the twelve-table read. A member told their personal
 * download is rate-limited because an admin has been exporting the workspace
 * would have no way to understand why — and acct-009 exists precisely because a
 * member's only data operation used to be "delete my account".
 *
 * IN-MEMORY, so it resets on a cold start and is not shared across regions.
 * That is a real limitation and it is the same one every limiter in this app
 * has: this is a speed bump against repetition and a guard against a
 * self-inflicted function-budget drain, not a quota. The durable version of this
 * is the Activity row (see route.ts), which is the part a founder can audit.
 */

import { rateLimiter, type RateLimitOptions } from "@/lib/rate-limit";

/** Exported so the route's tests can assert the budget rather than guess it. */
export const EXPORT_RATE_LIMIT: RateLimitOptions = {
  limit: 5,
  windowMs: 10 * 60_000,
};

/** The bucket name, so a test can reach the same store. */
export const EXPORT_LIMITER_NAME = "export";

export const exportLimiter = rateLimiter(EXPORT_LIMITER_NAME, EXPORT_RATE_LIMIT);

/**
 * The key an export spends against: the caller AND the scope they asked for.
 * Distinct scopes are distinct buckets — see the header.
 */
export function exportLimitKey(scope: string, userId: string): string {
  return `${scope}:${userId}`;
}
