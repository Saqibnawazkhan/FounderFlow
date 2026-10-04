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
 * `loginAction` keeps a fast UI-side rejection so it can return readable copy
 * (authorize() can only return null), but since auth-007 that is
 * `gateAuthAction({ kind: "login" })`, which CHECKS the two buckets below and
 * consumes nothing — `limiters.auth` is no longer involved and now has no
 * production caller at all. Keep it a check: a consume here would double-count
 * one form submission and halve the advertised limit.
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
 * FOLLOW-UP, deliberately not done here (needs infra, not code): make the
 * per-ADDRESS counter durable and shared. Until then the guarantee is
 * per-instance — an attacker who can land requests on N warm lambdas gets N
 * times the budget, and a redeploy resets every counter. That is a real
 * weakening of the numbers above, and it is still strictly better than the
 * unbounded endpoint this replaced.
 *
 * DO NOT BUDGET THIS AS A STORAGE SWAP. This file used to claim that moving to
 * Upstash Redis would leave `consume()` / `check()` signatures intact "so only
 * the storage changes", and lib/rate-limit.ts carried the same sentence before
 * correcting itself (see the banner at the top of that file). It is false, and
 * false in the direction that makes someone under-estimate a security task:
 * every Redis client is async, both methods are declared synchronous in
 * `RateLimiter`, and `authorize()` plus more than 60 call sites across more
 * than 20 files treat them as such. A shared store means an async API and an
 * `await` at every one of them. That figure is measured by
 * tests/lib/rate-limit-shared-store.test.ts and held to a floor; the "~40"
 * this sentence used to carry was an approximation, and it under-stated the
 * task in the same direction the paragraph is warning about.
 *
 * ── THE ROW-COUNTER ROUTE: DECIDED AGAINST, 2026-09-29 ──────────────────────
 *
 * This note used to recommend the cheap alternative — a durable PER-ACCOUNT
 * counter on the row itself, `User.failedLoginCount` +
 * `User.failedLoginWindowStartedAt`, which `20260928000100_add_failed_login_
 * counter` duly added. Do not wire it, and do not re-add the columns. The
 * recommendation was wrong, and this paragraph is why, because the reasoning is
 * the only thing that stops it being written a third time.
 *
 * COST WAS NEVER THE OBJECTION. It is genuinely almost free: `authorize()`'s
 * `findFirst` passes no `select`, so both columns already arrive on every single
 * attempt (no extra read), and the success-path zeroing could ride the
 * fire-and-forget `lastSignInAt` UPDATE that is already there (no extra write) —
 * the same "one statement so the two cannot land apart" trick used for
 * `sessionVersion` + password hash. Only a failure needs one more UPDATE, ~10ms
 * behind a ~250ms bcrypt.
 *
 * THE OBJECTION IS THAT IT CAN ONLY MAKE A LOCKOUT DURABLE. Look at where a
 * durable count would have to be consulted. `gateLoginAttempt` runs before the
 * lookup and before bcrypt — it has to, because a refusal issued AFTER the
 * compare saves no work and limits no guesses, so it would be a diff that
 * references a counter and changes nothing. A pre-bcrypt gate cannot know the
 * password is right. So the ten failures an attacker sends for free refuse the
 * real owner as well, and `tests/lib/auth/durable-login-counter.test.ts` pins
 * exactly that.
 *
 * Today that is survivable only because the counter evaporates: it is
 * per-instance, so a lockout has to be maintained across every warm lambda and
 * is voided by the next cold start or deploy. Moving it onto the row keeps the
 * shape and removes every one of those escapes — a stranger who knows an
 * address gets a reliable, fleet-wide, deploy-proof refusal of sign-in, held
 * open indefinitely for ten requests per fifteen minutes, against a product
 * holding companies' financial records, whose founders' addresses are on the
 * landing page. There is no admin unlock in this app, and `SENTRY_DSN` is still
 * unset in the Production scope (prodready-006), so the first report of it would
 * be a customer email.
 *
 * What it buys in exchange is one order of magnitude: 10×N failures per 15
 * minutes becomes 10. Both numbers are far below what cracking a real password
 * needs and far above what protects a weak one, so no outcome changes — while
 * the DoS goes from flaky to dependable. That trade is the wrong way round.
 *
 * THE STRUCTURAL REASON, which is the part worth remembering: the `User` row can
 * only make durable the ONE bucket whose durability is a weapon. The bucket
 * whose durability would be purely protective is `credentials`, keyed on the
 * client address — and it has no row to hang off, which is precisely why the row
 * route looked cheap. The cheapness and the hazard are the same property.
 *
 * SO THE ANSWER TO sec-011 IS THE SHARED STORE (Upstash / Vercel KV), sized as
 * the async refactor it is, and pointed at the per-ADDRESS bucket first: that is
 * the dimension horizontal scale multiplies without bound, it prices the CPU an
 * attacker spends, and making it durable adds no lockout. `credentialsEmail`
 * should stay in memory even then — for this one bucket, per-instance and
 * self-evaporating is the mitigation, not the caveat.
 *
 * Also considered and rejected: writing the columns without reading them (a
 * security column with no reader is a false assurance, and is the exact
 * reachability defect this wave exists to undo); refusing after the compare (no
 * behaviour change); and adding latency to over-budget failures (on serverless
 * we would be paying for the sleep in billed duration while the attacker simply
 * opens more connections).
 *
 * The one legitimate reason to keep these two columns is a different feature
 * altogether: showing the owner "N failed sign-in attempts since X" on
 * /settings, beside the `lastSignInAt` row that is already there. That is a
 * product decision, not sec-011, and it only counts if the reader ships in the
 * same change as the writer.
 */
