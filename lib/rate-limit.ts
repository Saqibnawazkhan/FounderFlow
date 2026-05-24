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

  return {
    consume(key: string): RateLimitResult {
      // Test/CI bypass — smoke tests run dozens of auth attempts from the
      // same IP back-to-back, which would otherwise trip the limiter and
      // mask real regressions. Production never sets this.
      if (process.env.RATE_LIMIT_DISABLED === "true") {
        return { allowed: true, remaining: limit, retryAfterMs: 0 };
      }
      const now = Date.now();
      const cutoff = now - windowMs;
      let bucket = store.get(key);
      if (!bucket) {
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
      bucket.push(now);
      return {
        allowed: true,
        remaining: limit - bucket.length,
        retryAfterMs: 0,
      };
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
  /** 5 attempts per IP per minute. Covers login + signup. */
  auth: rateLimiter("auth", { limit: 5, windowMs: 60_000 }),
  /** 60 writes per user per minute. Covers transaction / task / invite create. */
  write: rateLimiter("write", { limit: 60, windowMs: 60_000 }),
};
