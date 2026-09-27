/**
 * In-memory sliding-window rate limiter. Suitable for single-instance deploys
 * (one Node process). For multi-region / multi-instance prod, swap the storage
 * for Upstash Redis — the consume() signature stays the same so callers
 * (server actions) don't have to change.
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
 *   - Doesn't share state across Vercel regions. Use Upstash for that.
 *   - In dev mode Next hot-reloads modules — we anchor the store on
 *     globalThis so the buckets survive recompile cycles.
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
    // Blanket bypass. The comment that used to sit here said the smoke tests
    // rely on this; they do not, and nothing in the repo sets it. The puppeteer
    // harness under scripts/ gets its isolation from a distinct per-agent
    // `x-real-ip` (a distinct key is a distinct bucket), `.env.local` pins this
    // to "false" so local dev runs WITH the limiter, and three QA scripts
    // report a true value as a finding because it makes their brute-force
    // probes silently inert.
    //
    // So treat it as a hazard, not a knob: it is the one line that can switch
    // off every gate in this file, including the login throttle in
    // lib/auth/login-throttle.ts, and nothing in scripts/vercel-build.mjs stops
    // it being set in Vercel's Production scope.
    if (process.env.RATE_LIMIT_DISABLED === "true") {
      return { allowed: true, remaining: limit, retryAfterMs: 0 };
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

/**
 * Pre-built limiters used by server actions. Tune the numbers here in one
 * place; callers just import and call .consume().
 *
 * Defaults err on the strict side for auth (brute-force protection) and
 * looser for writes (avoid blocking legitimate burst usage).
 */
export const limiters = {
  /**
   * 5 attempts per IP per minute. Covers the login + signup SERVER ACTIONS —
   * the fast, UI-side rejection that can return a readable error to the form.
   */
  auth: rateLimiter("auth", { limit: 5, windowMs: 60_000 }),
  /**
   * 5 credential checks per IP per minute, consumed inside the Credentials
   * provider's authorize() — the choke point BOTH login paths funnel through
   * (see lib/auth/login-throttle.ts for the whole argument).
   *
   * A SEPARATE KEY-SPACE FROM `auth`, ON PURPOSE, and this is not cosmetic.
   * loginAction consumes `auth`, then calls signIn(), which calls authorize().
   * If authorize() consumed `auth` as well, one form submission would spend TWO
   * entries and the advertised 5/min would silently become 2 — a founder with
   * three typos locked out of their own product. Two buckets means each layer
   * counts each attempt exactly once, and the effective limit on the form stays
   * the 5 the copy promises. (Same reasoning as `read` vs `write` below: a
   * rejection must land on the action that caused it.)
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
   * password reset runs on the `auth` bucket (lib/actions/password-reset.ts)
   * and never reads or writes this one.
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
