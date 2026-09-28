/**
 * In-memory sliding-window rate limiter, plus the auth-family gates built on
 * top of it (`gateAuthAction`).
 *
 * Sliding-window algorithm: each key has a deque of request timestamps. On
 * each call we drop timestamps older than the window, then check whether
 * adding the new one would exceed the limit. O(N) per request where N is the
 * limit (small constant), and memory is bounded by `limit * keys`.
 *
 * Caller pattern:
 *   const limiter = rateLimiter("login", { limit: 5, windowMs: 60_000 });
 *   const result = limiter.consume(ip);
 *   if (!result.allowed) return { success: false, error: result.error };
 *
 * Caveats:
 *   - Resets when the Node process restarts. That's OK for soft brute-force
 *     protection; not OK for hard quotas.
 *   - Doesn't share state across Vercel instances or regions: N warm lambdas
 *     are N independent buckets, so the real ceiling is N × the number below.
 *     That is audit finding sec-011 and it is NOT fixed here. Read the next
 *     paragraph before planning the fix, because the comment that used to sit
 *     here was wrong about it.
 *   - In dev mode Next hot-reloads modules — we anchor the store on
 *     globalThis so the buckets survive recompile cycles.
 *
 * ── THE UPSTASH SWAP IS NOT A DROP-IN, whatever the old comment said ───────
 * This file used to promise "swap the storage for Upstash Redis — the
 * consume() signature stays the same so callers (server actions) don't have to
 * change", and lib/auth/login-throttle.ts carried it too (both corrected now;
 * lib/email/quota.ts:20 still states it about its own counter). It is false, and it is
 * the kind of false that makes someone under-estimate a security task: every
 * Redis client is async, `consume(key): RateLimitResult` is synchronous, and
 * `authorize()` / every server action treats it as such. A shared store means
 * an async API and therefore an `await` at all ~40 call sites. Plan for that.
 *
 * AND POINT IT AT THE ADDRESS-KEYED BUCKETS FIRST. This banner used to offer a
 * shortcut — "a `User.failedLoginCount` + `User.failedLoginWindowStartedAt`
 * pair needs no shared cache at all, because the row IS the shared state" —
 * and `20260928000100_add_failed_login_counter` was written on the strength of
 * it. It was rejected on 2026-09-29 and the columns should go: a row can only
 * make durable the per-ACCOUNT failure budget, and a durable per-account budget
 * is a reliable, fleet-wide, deploy-proof way for a stranger who knows an
 * address to refuse its owner sign-in. The argument in full, including why
 * `credentialsEmail` should stay in this in-memory store even after a shared one
 * exists, is at the bottom of lib/auth/login-throttle.ts; it is enforced by
 * tests/lib/auth/durable-login-counter.test.ts.
 */

type Bucket = number[]; // timestamps (ms) of recent allowed requests

type Store = Map<string, Bucket>;

declare global {
  // eslint-disable-next-line no-var
  var __ff_rate_limit_stores: Map<string, Store> | undefined;
}

const stores: Map<string, Store> =
  globalThis.__ff_rate_limit_stores ?? (globalThis.__ff_rate_limit_stores = new Map());

function getStore(name: string): Store {
  let s = stores.get(name);
  if (!s) {
    s = new Map();
    stores.set(name, s);
  }
  return s;
}

export interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Number of requests remaining in the current window after this one. */
  remaining: number;
  /** Milliseconds until the oldest in-window request rolls off (Retry-After). */
  retryAfterMs: number;
  /** Human-friendly error message when allowed=false. */
  error?: string;
}

export interface RateLimiter {
  consume(key: string): RateLimitResult;
  /**
   * Same verdict as consume(), but records NOTHING. For the case where the
   * decision and the thing being counted are not the same event — the login
   * failure bucket in lib/auth/login-throttle.ts gates on the way IN but can
   * only count on the way OUT, once bcrypt has answered. Calling consume()
   * twice there would charge one attempt two entries.
   */
  check(key: string): RateLimitResult;
  /** Test helper — clears all keys for this limiter. */
  reset(): void;
}

/**
 * Is `RATE_LIMIT_DISABLED=true` allowed to take effect in this runtime?
 *
 * The flag is a blanket bypass for every limiter in this file, including the
 * login throttle in lib/auth/login-throttle.ts that is the app's only
 * brute-force threshold — audit finding prodready-002. It has no runtime
 * signal of any kind, and the root `.env` shipped it set to "true" for months.
 *
 * `scripts/vercel-build.mjs` refuses a production BUILD that carries it
 * (FORBIDDEN_PROD_ENV). This is the runtime half of the same gate, because a
 * build-time check cannot see a var added to the Production scope AFTER the
 * build, an inherited shell env on a self-hosted box, or a `next start` run by
 * hand. Two independent gates, neither of which relies on the other.
 *
 * Preview deploys still honour the flag ON PURPOSE: the build guard's own
 * error text tells whoever is debugging a limiter to do it on a preview, and
 * breaking that would just push them towards editing this file instead.
 *
 * Pure so it can be unit-tested; exported for the same reason.
 */
export function rateLimitBypassEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.RATE_LIMIT_DISABLED !== "true") return false;
  return !isProductionRuntime(env);
}

/**
 * Vercel sets VERCEL_ENV to production / preview / development, and it is the
 * only signal that distinguishes a preview deploy (NODE_ENV=production there
 * too) from the real thing. Off Vercel — Docker, a VPS, `next start` — there
 * is no VERCEL_ENV, so NODE_ENV is all we have, and the fail-closed reading of
 * `NODE_ENV=production` is "this is somebody's production".
 */
function isProductionRuntime(env: Record<string, string | undefined>): boolean {
  const vercelEnv = env.VERCEL_ENV;
  if (vercelEnv) return vercelEnv === "production";
  return env.NODE_ENV === "production";
}

/**
 * One line per process, not per request: a misconfiguration should be findable
 * in the logs without drowning them (and without turning a log drain into a
 * bill). Each cold start re-announces it, which is the right frequency — it is
 * a deploy-level mistake.
 */
let warnedAboutIgnoredBypass = false;
function warnBypassIgnored(): void {
  if (warnedAboutIgnoredBypass) return;
  warnedAboutIgnoredBypass = true;
  console.error(
    "[rate-limit] RATE_LIMIT_DISABLED is set in a production runtime and is being IGNORED. " +
      "Every limiter stays ON. Unset it in the Production scope — see prodready-002 and " +
      "scripts/vercel-build.mjs (FORBIDDEN_PROD_ENV)."
  );
}

/**
 * Returns a limiter scoped to `name`. Reusing the same name across callers
 * shares the same key-space — useful when several actions should share a
 * single bucket (e.g. all auth attempts).
 */
export function rateLimiter(name: string, opts: RateLimitOptions): RateLimiter {
  const store = getStore(name);
  const { limit, windowMs } = opts;

  // One implementation for both consume() and check(); `record` is the only
  // difference. Kept as a single function so the window-eviction rule can
  // never drift between "is it allowed" and "count it".
  function evaluate(key: string, record: boolean): RateLimitResult {
    // Blanket bypass — see rateLimitBypassEnabled() for why a production
    // runtime ignores it, and why a preview deploy does not. Nothing in the
    // repo sets it: `.env.local` pins it to "false" so local dev runs WITH the
    // limiter, the puppeteer harness under scripts/ gets its isolation from a
    // distinct per-agent `x-real-ip` (a distinct key is a distinct bucket),
    // and three QA scripts report a true value as a finding because it makes
    // their brute-force probes silently inert.
    if (process.env.RATE_LIMIT_DISABLED === "true") {
      if (rateLimitBypassEnabled()) {
        return { allowed: true, remaining: limit, retryAfterMs: 0 };
      }
      warnBypassIgnored();
    }
    const now = Date.now();
    const cutoff = now - windowMs;
    let bucket = store.get(key);
    if (!bucket) {
      // A pure check() must not plant an empty bucket: keys are caller-supplied
      // (IPs, email addresses) and this store has no eviction sweep, so a
      // read-only probe that allocated would hand an attacker a memory-growth
      // primitive for free.
      if (!record) return { allowed: true, remaining: limit, retryAfterMs: 0 };
      bucket = [];
      store.set(key, bucket);
    }
    // Drop timestamps that fell outside the window.
    while (bucket.length > 0 && bucket[0] <= cutoff) {
      bucket.shift();
    }
    if (bucket.length >= limit) {
      const retryAfterMs = bucket[0] + windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
        error: `Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
      };
    }
    if (record) bucket.push(now);
    return {
      allowed: true,
      remaining: limit - bucket.length,
      retryAfterMs: 0,
    };
  }

  return {
    consume(key: string): RateLimitResult {
      return evaluate(key, true);
    },
    check(key: string): RateLimitResult {
      return evaluate(key, false);
    },
    reset() {
      store.clear();
    },
  };
}

/* ────────────────────────── client-address keys ──────────────────────────── */

/**
 * What `getClientIp()` returns when NO forwarding header can be trusted —
 * audit finding sec-001.
 *
 * It lives here rather than in lib/client-ip.ts because this is the module
 * that has to recognise it (lib/client-ip.ts re-exports it, so either import
 * works). Keeping it out of client-ip.ts also keeps this file free of the
 * `next/headers` import, which is what lets it be unit-tested with no mocks.
 *
 * The old value was the literal string "unknown", and it was a BUCKET like any
 * other: wherever no proxy set a header — self-host, Docker, nginx, `vercel
 * dev`, a local box — every visitor in the world shared one 5-per-minute
 * budget, so a single attacker could lock every real customer out of login,
 * password reset and account deletion simultaneously. Never key a limiter on a
 * constant.
 */
export const UNTRUSTED_CLIENT_IP = "untrusted-client-ip";

/**
 * Is this string an address we may use as a bucket key at all?
 *
 * "unknown" is rejected alongside the current sentinel deliberately: it is the
 * value this code used to return, and if any caller, cached bundle or copied
 * snippet reintroduces it, it must not silently become a shared bucket again.
 */
export function isTrustedIpKey(ip: string | null | undefined): boolean {
  if (typeof ip !== "string") return false;
  const value = ip.trim();
  if (value === "") return false;
  return value !== UNTRUSTED_CLIENT_IP && value !== "unknown";
}

/**
 * Normalise the account side of a key. Lowercased and trimmed to match
 * `loginEmailKey` in lib/auth/login-throttle.ts: if these disagreed,
 * `Founder@…` and `founder@…` would be one account with two budgets and any
 * per-account limit would be walkable by capitalising a letter.
 */
function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

/**
 * The key for a limiter that WANTS to count per client address, given that we
 * may not have one.
 *
 * With a trusted address the key is that address verbatim — same key-space as
 * before this change, so an existing bucket keeps counting the same thing.
 * Without one we key on the account the request is about, prefixed so an
 * address and an email can never collide. The result is that "no trusted IP"
 * degrades to a per-account limit instead of one global bucket: an attacker
 * spends their own budget, never everybody's.
 */
export function ipBucketKey(ip: string, identity: string): string {
  if (isTrustedIpKey(ip)) return ip.trim();
  return `id:${normalizeIdentity(identity)}`;
}

/**
 * Pre-built limiters used by server actions. Tune the numbers here in one
 * place; callers just import and call .consume().
 *
 * Defaults err on the strict side for auth (brute-force protection) and
 * looser for writes (avoid blocking legitimate burst usage).
 */
export const limiters = {
  /**
   * 5 attempts per IP per minute.
   *
   * DEPRECATED, and left in place only so nothing breaks mid-migration: this
   * is the single bucket that ten server actions across five modules shared
   * (audit auth-007), which is why a colleague clicking a verification link
   * could be told "Too many requests" because two other people had just signed
   * in. New call sites use `gateAuthAction` below; when the last of the ten has
   * moved, delete this.
   */
  auth: rateLimiter("auth", { limit: 5, windowMs: 60_000 }),
  /**
   * 5 credential checks per IP per minute, consumed inside the Credentials
   * provider's authorize() — the choke point BOTH login paths funnel through
   * (see lib/auth/login-throttle.ts for the whole argument).
   *
   * ONE CONSUMER, ON PURPOSE, and this is not cosmetic.
   * `loginAction` used to consume `auth` and then call signIn(), which calls
   * authorize(). Since auth-007 it calls `gateAuthAction({ kind: "login" })`,
   * which CHECKS these buckets and consumes nothing, so authorize() remains the
   * only consumer. That is the invariant to protect: if both layers consumed,
   * one form submission would spend TWO entries and the advertised 5/min would
   * silently become 2 — a founder with three typos locked out of their own
   * product. One consumer means each attempt is counted exactly once and the
   * the 5 the copy promises. (Same reasoning as `read` vs `write` below: a
   * rejection must land on the action that caused it.)
   *
   * `gateAuthAction({ kind: "login" })` only CHECKS this bucket, never
   * consumes it, for exactly the same reason.
   */
  credentials: rateLimiter("credentials", { limit: 5, windowMs: 60_000 }),
  /**
   * 10 FAILED credential checks per email address per 15 minutes.
   *
   * WHY A SECOND KEY AT ALL: an IP-keyed bucket does nothing against the attack
   * that actually threatens this product — a distributed spray at one KNOWN
   * address (a founder whose email is on the landing page), one guess per
   * rented proxy. Every bucket stays at 1 forever. Keying the account is the
   * only thing that sees it.
   *
   * WIDER WINDOW, SMALLER RATE than the IP bucket: this one is meant to price
   * a slow grind (10 guesses / 15 min ≈ 960/day, hopeless against any real
   * password) rather than to catch a burst, which the IP bucket already does.
   *
   * ACCEPTED TRADEOFF: an attacker who knows the address can burn the budget
   * deliberately and keep the owner out for up to 15 minutes. That is real, and
   * it is why the window is minutes and not hours, why it counts failures only
   * (a legitimate sign-in never erodes it), and why it is NOT an
   * administrator-cleared lockout. The owner's way out stays open throughout:
   * password reset runs on its own `emailDispatch` budget and never reads or
   * writes this one.
   *
   * SO FOR THIS BUCKET ALONE, THE IN-MEMORY STORE IS PART OF THE MITIGATION —
   * do not "fix" it when a shared store arrives. Every other limiter here is
   * weakened by being per-instance. This one is a lockout primitive by
   * construction (the gate must refuse before bcrypt, so it cannot tell the
   * owner's correct password from a guess), and being per-instance and
   * evaporating on a cold start is what keeps that lockout an annoyance instead
   * of a dependable denial of sign-in. That is why the durable row-counter route
   * was rejected — see the bottom of lib/auth/login-throttle.ts.
   */
  credentialsEmail: rateLimiter("credentials-email", { limit: 10, windowMs: 15 * 60_000 }),
  /** 60 writes per user per minute. Covers transaction / task / invite create. */
  write: rateLimiter("write", { limit: 60, windowMs: 60_000 }),
  /**
   * 120 reads per user per minute. Covers command-palette search.
   *
   * SEPARATE FROM `write` ON PURPOSE. A read that spends the write budget
   * produces the worst class of bug this file can cause: the rejection lands
   * on a DIFFERENT action from the one that caused it, so the user reports
   * "saving sometimes fails when I'm busy" and it never reproduces on a quiet
   * account. Searching must never be able to stop someone sending a message.
   *
   * Sized for a person typing, not for a script: the palette debounces at
   * ~200ms, so sustained human use lands well under this, while a scripted
   * term-by-term enumeration of a workspace hits it. That enumeration is the
   * abuse actually worth pricing — `searchWorkspace` runs four unindexed
   * ILIKE scans per call, and a term matching NOTHING is the most expensive
   * one to serve, because LIMIT cannot short-circuit a filter with no matches.
   */
  read: rateLimiter("read", { limit: 120, windowMs: 60_000 }),
};

/* ───────────────────────── the auth family (auth-007) ─────────────────────── */

/**
 * The buckets behind `gateAuthAction`, one pair per RISK CLASS.
 *
 * WHY CLASSES AND NOT ONE BUCKET: `limiters.auth` was consumed by signup,
 * login, request-reset, redeem-reset, request-email-change, confirm-email-
 * change, verify-email, resend-verification, delete-account and delete-
 * workspace. Behind an office NAT or a carrier CGNAT that is ONE key for
 * everybody, so five ordinary events in a minute — two sign-ins, a signup, a
 * resend — used the whole company's budget and the sixth person got an error
 * about something they did not do. It is the same defect the `read`/`write`
 * split above was created to prevent, and the rule is the same: a rejection
 * must land on the action that caused it.
 *
 * EVERY CLASS IS TWO-DIMENSIONAL where an identity exists: one bucket per
 * client address (which prices a burst from one machine) and one per account
 * (which is the only thing that sees a distributed attack on one target, and
 * the only thing that keeps a noisy neighbour from spending a colleague's
 * budget). Both must pass.
 */
const authGates = {
  /**
   * Signup. 15 per 10 minutes per address: a burst larger than the old 5/min
   * allowed (a team of a dozen onboarding at once is real) but a sustained
   * rate three times lower (1.5/min vs 5/min), because sustained is what a
   * script does. Each signup costs a bcrypt(12) and a verification email
   * against a Gmail account with a daily send cap, so the sustained number is
   * the one that matters.
   */
  signupIp: rateLimiter("auth-signup-ip", { limit: 15, windowMs: 10 * 60_000 }),
  /**
   * 5 per submitted address per 10 minutes. Low value against an attacker
   * (they pick a fresh address every time) but it stops one address being
   * hammered, and it costs nothing.
   */
  signupEmail: rateLimiter("auth-signup-email", { limit: 5, windowMs: 10 * 60_000 }),
  /**
   * "We will now send a human an email": request-password-reset,
   * resend-verification, request-email-change. 10 per 10 minutes per address.
   */
  emailSendIp: rateLimiter("auth-email-send-ip", { limit: 10, windowMs: 10 * 60_000 }),
  /**
   * 5 per target account per 15 minutes — the dimension that did not exist
   * before, and the one that actually protects a person's inbox and our send
   * quota. Keyed on the SUBMITTED address for the reset flow, so it reveals
   * nothing about whether an account exists (the action's anti-enumeration
   * posture is preserved: same budget either way).
   *
   * ACCEPTED TRADEOFF, same shape as `credentialsEmail`: someone who knows
   * your address can burn your reset-email budget for 15 minutes. Self-healing
   * window, failures and successes counted alike, no admin unlock needed.
   */
  emailSendAccount: rateLimiter("auth-email-send-account", { limit: 5, windowMs: 15 * 60_000 }),
  /**
   * Redeeming a signed link: verify-email, confirm-email-change,
   * redeem-password-reset. 30 per minute per address.
   *
   * Loose on purpose. These tokens are HS256 JWTs signed with AUTH_SECRET
   * (lib/auth/email-verification-token.ts, lib/auth/password-reset-token.ts),
   * so the protection against a guessed token is cryptographic, not numeric —
   * the limiter here is a courtesy valve against a hot loop, and the cost of a
   * refused attempt is a customer being told their perfectly good link is
   * "too many requests". That trade should fall heavily on the side of the
   * customer.
   */
  tokenRedeemIp: rateLimiter("auth-token-redeem-ip", { limit: 30, windowMs: 60_000 }),
  /**
   * Password-confirmed destruction: delete-account, delete-workspace.
   * 10 per 10 minutes per address, 5 per 10 minutes per user.
   *
   * The per-USER bucket is the real one: these are authenticated actions, so
   * the account is always known, and keying the budget to it means an office
   * sharing one address can never block each other from closing their own
   * accounts — while a hijacked session still gets only 5 password guesses
   * per 10 minutes.
   */
  destructiveIp: rateLimiter("auth-destructive-ip", { limit: 10, windowMs: 10 * 60_000 }),
  destructiveUser: rateLimiter("auth-destructive-user", { limit: 5, windowMs: 10 * 60_000 }),
};

/**
 * What a caller is asking permission to do. The identity is part of the type
 * for every class that has one, so a call site cannot forget to pass it and
 * silently fall back to a shared bucket — that omission is the whole of
 * sec-001.
 */
export type AuthGateRequest =
  /**
   * The login FORM's fast, readable rejection. CHECKS ONLY — see
   * `gateAuthAction`. `email` is needed because it is what the buckets are
   * keyed on when there is no trusted address.
   */
  | { kind: "login"; ip: string; email: string }
  | { kind: "signup"; ip: string; email: string }
  /** `account`: the address we would mail, or the signed-in user's id. */
  | { kind: "emailDispatch"; ip: string; account: string }
  /** No identity: the token has not been verified yet, so there is none. */
  | { kind: "tokenRedeem"; ip: string }
  | { kind: "destructive"; ip: string; userId: string };

/**
 * Allowed, and nothing was counted, because there was nothing to count on.
 * `remaining` is deliberately huge rather than 0 so a caller that logs it
 * cannot read this as "you have used your last one".
 */
const ALLOWED_UNCOUNTED: RateLimitResult = {
  allowed: true,
  remaining: Number.MAX_SAFE_INTEGER,
  retryAfterMs: 0,
};

/**
 * Gate one auth-family action. Returns the first refusal, so `result.error` is
 * always the message for the bucket that actually refused.
 *
 * `login` IS DIFFERENT AND THE DIFFERENCE IS LOAD-BEARING: it only CHECKS the
 * two buckets that `lib/auth/login-throttle.ts` consumes inside `authorize()`.
 * loginAction → signIn() → authorize() is one user action passing through two
 * layers; if both layers consumed, one form submission would spend two entries
 * and the advertised 5/min would silently be 2/min. The form's job here is the
 * readable early error (authorize() can only return null); the counting
 * happens once, at the choke point both the form and a direct POST to
 * /api/auth/callback/credentials go through.
 *
 * Every other class consumes, because for those the action IS the event.
 */
export function gateAuthAction(req: AuthGateRequest): RateLimitResult {
  switch (req.kind) {
    case "login": {
      const email = normalizeIdentity(req.email);
      const byIp = limiters.credentials.check(ipBucketKey(req.ip, email));
      if (!byIp.allowed) return byIp;
      return limiters.credentialsEmail.check(email);
    }
    case "signup": {
      const email = normalizeIdentity(req.email);
      const byIp = authGates.signupIp.consume(ipBucketKey(req.ip, email));
      if (!byIp.allowed) return byIp;
      return authGates.signupEmail.consume(email);
    }
    case "emailDispatch": {
      const account = normalizeIdentity(req.account);
      const byIp = authGates.emailSendIp.consume(ipBucketKey(req.ip, account));
      if (!byIp.allowed) return byIp;
      return authGates.emailSendAccount.consume(account);
    }
    case "tokenRedeem": {
      // No identity to fall back on, and pooling every visitor into one bucket
      // would hand an attacker a way to refuse everybody else's verification
      // links. Since the token itself is unforgeable, the honest answer when
      // there is no trusted address is "allowed, uncounted".
      if (!isTrustedIpKey(req.ip)) return ALLOWED_UNCOUNTED;
      return authGates.tokenRedeemIp.consume(req.ip.trim());
    }
    case "destructive": {
      const userId = normalizeIdentity(req.userId);
      const byIp = authGates.destructiveIp.consume(ipBucketKey(req.ip, userId));
      if (!byIp.allowed) return byIp;
      return authGates.destructiveUser.consume(userId);
    }
  }
}

/** Test helper — clears every auth-family bucket, including the legacy ones. */
export function resetAuthGates(): void {
  limiters.auth.reset();
  limiters.credentials.reset();
  limiters.credentialsEmail.reset();
  Object.values(authGates).forEach((gate) => gate.reset());
}
