/**
 * Brute-force throttling for credential sign-in.
 *
 * WHY THIS FILE EXISTS (audit auth-001 + sec-008, both filed independently):
 * the 5/min login limit used to be consumed only inside `loginAction`, the
 * server action behind the login FORM. But the form is not the endpoint — the
 * browser posts to `POST /api/auth/callback/credentials`, `auth.config.ts`
 * marks `/api/auth` PUBLIC, and the csrfToken that route wants is handed out
 * by the public `GET /api/auth/csrf`. So a script could skip the action
 * entirely and reach `authorize()`, and `bcrypt.compare`, with no bucket, no
 * lockout and no captcha: unlimited guesses against a known address, as fast
 * as the server answered. lib/auth.ts even carried a comment claiming the
 * limiter covered that path.
 *
 * The rule now lives at the choke point both paths share — the Credentials
 * provider's authorize() — instead of at one of the two doors into it.
 * `loginAction` keeps its own `limiters.auth` check as the fast UI-side
 * rejection (it can return readable copy; authorize() can only return null).
 *
 * TWO KEYS, because one is not enough:
 *   - by IP, which catches a burst from one machine;
 *   - by EMAIL, which is the only thing that sees the attack this product
 *     actually invites — a distributed spray at one named founder's address,
 *     one guess per rented proxy, where every per-IP bucket sits at 1 forever.
 *
 * Deliberately NOT here: a durable store. `limiters` is in-memory on
 * globalThis, so on Vercel each lambda instance keeps its own counters and a
 * cold start forgets them. That makes these real numbers into soft ones under
 * horizontal scale. See the follow-up note at the bottom of this file.
 */

import { limiters } from "@/lib/rate-limit";

/** Which bucket refused the attempt. For logging/metrics, never for the user. */
export type LoginThrottleScope = "ip" | "email";

export type LoginThrottleDecision =
  | { allowed: true }
  | { allowed: false; scope: LoginThrottleScope; retryAfterMs: number };

/**
 * The per-account bucket key.
 *
 * Lowercased to match the `email.toLowerCase()` in the authorize() lookup. If
 * these two disagreed, `Founder@…` and `founder@…` would be one account with
 * two budgets and the per-account limit would be trivially walkable — capitalise
 * a letter, get a fresh 10 guesses. Trimmed for the same reason: the credentials
 * schema does not trim, so " a@b.com" reaches us as a distinct string.
 */
export function loginEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Gate one credential attempt, BEFORE any DB read or bcrypt compare.
 *
 * WHAT CONSUMES WHAT, and why the two buckets differ:
 *
 *  - The per-IP bucket consumes on EVERY attempt, success or failure. It is
 *    pricing the WORK, not the wrongness: the lookup plus a cost-12 bcrypt is
 *    roughly a quarter-second of CPU, and we cannot know an attempt will
 *    succeed until we have already spent it. Charging only failures would leave
 *    a valid-credential flood as a free CPU sink — a DoS with a login form.
 *
 *  - The per-EMAIL bucket only CHECKS here and is consumed later, by
 *    `recordLoginFailure`, once bcrypt has actually said no. Counting failures
 *    only means a founder signing in from ten devices never walks themselves
 *    into a lockout on their own account, which is the failure mode that would
 *    make an account-keyed limit unshippable.
 *
 * `ip` comes from `getClientIp()`, which falls back to the literal "unknown"
 * when no proxy headers are present. On Vercel, x-real-ip is always set from
 * the TCP peer, so production keys on a real address. In local dev there are no
 * such headers and every caller shares the one "unknown" bucket — accepted, and
 * NOT worked around by weakening production, because the form path already
 * shared that same key before this change (via `limiters.auth`): dev is no
 * worse off than it was, and a second bucket at the same 5/min does not change
 * when a human hits it.
 *
 * DO NOT "fix" a local annoyance with `RATE_LIMIT_DISABLED=true`. That flag is
 * a hazard, not a tool: `.env.local` deliberately pins it to "false", so the
 * limiter is LIVE in local dev, and the puppeteer harness under scripts/ gets
 * its isolation from a distinct per-agent `x-real-ip` instead — a distinct IP
 * buys a distinct bucket, which is the supported way to run many attempts at
 * once. Three QA scripts treat a true value as a finding precisely because it
 * silently makes their brute-force probes inert
 * (`scripts/qa-auth-and-sessions.mjs` fails the run over it), and
 * `qa-production-readiness.mjs` notes that nothing in the build stops the same
 * var being set in Vercel's Production scope, where it would disable this file
 * entirely with zero signal.
 */
export function gateLoginAttempt(ip: string, email: string): LoginThrottleDecision {
  const byIp = limiters.credentials.consume(ip);
  if (!byIp.allowed) {
    return { allowed: false, scope: "ip", retryAfterMs: byIp.retryAfterMs };
  }

  // check(), not consume(): this attempt has not failed yet.
  const byEmail = limiters.credentialsEmail.check(loginEmailKey(email));
  if (!byEmail.allowed) {
    return { allowed: false, scope: "email", retryAfterMs: byEmail.retryAfterMs };
  }

  return { allowed: true };
}

/**
 * Record one failed credential check against the account's failure budget.
 *
 * Called for a wrong password AND for an address that does not exist. Both, on
 * purpose: if a miss were free, guessing addresses would be the cheap probe,
 * and the `findFirst` behind it is a real query either way — a miss is the
 * slowest kind to serve, since there is no row for a LIMIT to short-circuit on.
 */
export function recordLoginFailure(email: string): void {
  limiters.credentialsEmail.consume(loginEmailKey(email));
}

/**
 * FOLLOW-UP, deliberately not done here (needs infra, not code): move these two
 * buckets to a durable shared store — Upstash Redis is what lib/rate-limit.ts
 * already names as the intended swap, and `consume()`/`check()` keep their
 * signatures, so only the storage changes. Until then the guarantee is
 * per-instance: an attacker who can land requests on N warm lambdas gets N
 * times the budget, and a redeploy resets every counter. That is a real
 * weakening of the numbers above, and it is still strictly better than the
 * unbounded endpoint this replaced.
 */
