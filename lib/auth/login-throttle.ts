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

import { ipBucketKey, limiters } from "@/lib/rate-limit";

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
 * WHAT THE PER-IP BUCKET IS ACTUALLY KEYED ON, and why it is not `ip`:
 *
 * `ip` comes from `getClientIp()`, which returns a real address only where a
 * forwarding header may be believed, and otherwise the sentinel
 * `UNTRUSTED_CLIENT_IP` — every self-hosted box, every Docker/nginx deployment,
 * `vercel dev`, and any production runtime lib/client-ip.ts cannot identify. So
 * the key is `ipBucketKey(ip, loginEmailKey(email))`:
 *
 *   - With a trusted address the key is that address verbatim, byte-identical
 *     to what this file used before, so nothing about Vercel changes. An office
 *     behind one address still shares the 5/min, which is the point of an
 *     address-keyed bucket and not a bug.
 *   - Without one it degrades to a per-ACCOUNT key. A sentinel used verbatim is
 *     a BUCKET: one 5-per-minute budget shared by every visitor alive, which an
 *     attacker empties deliberately to refuse sign-in to every paying customer
 *     at once, from one machine. Never key a limiter on a constant.
 *
 * (An earlier version of this paragraph said the fallback was the literal string
 * "unknown" and called the shared bucket "accepted", true only of local dev. It
 * was wrong on both counts by the time it was read: the sentinel had been
 * renamed, the fallback reaches production wherever we are not on Vercel, and
 * `gateAuthAction({ kind: "login" })` in lib/rate-limit.ts had already moved to
 * `ipBucketKey` — so the form's CHECK and this function's CONSUME were
 * addressing different keys, leaving the form-side gate reading a bucket
 * nothing ever wrote. A comment that overstates a safety mechanism is this
 * repo's most recurrent defect; both layers now use one key function, and
 * tests/lib/auth/login-throttle.test.ts pins that they agree.)
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
  // `ipBucketKey`, never the raw `ip`: see the paragraph above, and note that
  // `gateAuthAction({ kind: "login" })` CHECKS this same key. The two must not
  // drift, or the form's readable early rejection stops seeing this counter.
  const byIp = limiters.credentials.consume(ipBucketKey(ip, loginEmailKey(email)));
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
 * FOLLOW-UP, deliberately not done here (needs infra, not code): make these two
 * counters durable and shared. Until then the guarantee is per-instance — an
 * attacker who can land requests on N warm lambdas gets N times the budget, and
 * a redeploy resets every counter. That is a real weakening of the numbers
 * above, and it is still strictly better than the unbounded endpoint this
 * replaced.
 *
 * DO NOT BUDGET THIS AS A STORAGE SWAP. This file used to claim that moving to
 * Upstash Redis would leave `consume()` / `check()` signatures intact "so only
 * the storage changes", and lib/rate-limit.ts carried the same sentence before
 * correcting itself (see the banner at the top of that file). It is false, and
 * false in the direction that makes someone under-estimate a security task:
 * every Redis client is async, both methods are declared synchronous in
 * `RateLimiter`, and `authorize()` plus ~40 server-action call sites treat them
 * as such. A shared store means an async API and an `await` at every one of
 * them.
 *
 * The cheaper route, and the one the audit prefers (sec-011): a durable
 * PER-ACCOUNT counter on the row itself — `User.failedLoginCount` +
 * `User.failedLoginWindowStartedAt`, which the
 * `20260928000100_add_failed_login_counter` migration adds. The row IS the
 * shared state, so no cache is needed; `authorize()` already reads that row,
 * and it would replace `credentialsEmail` only, leaving the per-address bucket
 * (which has no row to hang off) in memory where it is.
 */
