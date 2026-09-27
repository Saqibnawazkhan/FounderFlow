/**
 * A daily send budget for notification email.
 *
 * `lib/email/send.ts` goes out over Gmail SMTP, which caps a free account at
 * roughly 500 messages/day (~2000 on Workspace). Past that Gmail starts
 * rejecting with a 550 — and it rejects EVERYTHING, including the password
 * resets and invites that people cannot use the product without. A runaway
 * notification loop taking account recovery down with it is the failure this
 * prevents.
 *
 * So notification email spends from a budget deliberately set below the real
 * cap, leaving headroom for transactional mail. When the budget is gone,
 * notifications degrade to in-app and push; nothing throws, nothing retries,
 * and the notification row is written either way.
 *
 * Counting is in-memory and per-instance, exactly like `lib/rate-limit.ts` —
 * on several warm Vercel instances the effective ceiling is higher than the
 * number below. That is understood and acceptable: this is a circuit breaker
 * against a loop, not an accountant. The same file documents the upgrade path
 * (swap the store for Upstash Redis, keep the signature).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deliberately under Gmail's ~500/day free-tier cap. The remainder is reserved
 * for transactional mail: verification, password reset, email change, invites.
 */
export const DAILY_NOTIFICATION_EMAIL_BUDGET = 300;

type Counter = { windowStart: number; sent: number };

// Survives dev hot-reload the same way the rate limiter's buckets do.
const globalForQuota = globalThis as unknown as { __ff_email_quota?: Counter };

function counter(now: number): Counter {
  const existing = globalForQuota.__ff_email_quota;
  if (!existing || now - existing.windowStart >= DAY_MS) {
    const fresh = { windowStart: now, sent: 0 };
    globalForQuota.__ff_email_quota = fresh;
    return fresh;
  }
  return existing;
}

/**
 * Claim budget for `count` messages.
 *
 * Returns how many may actually be sent — possibly fewer than asked for, and
 * possibly zero. Callers send to that many recipients and drop the rest rather
 * than queueing: a notification email that arrives tomorrow is worse than one
 * that never arrives, and the in-app row is already there.
 */
export function claimEmailBudget(count: number, now: number = Date.now()): number {
  if (count <= 0) return 0;
  const c = counter(now);
  const remaining = Math.max(0, DAILY_NOTIFICATION_EMAIL_BUDGET - c.sent);
  const granted = Math.min(count, remaining);
  c.sent += granted;
  return granted;
}

/** Remaining budget in the current window — for diagnostics and tests. */
export function remainingEmailBudget(now: number = Date.now()): number {
  return Math.max(0, DAILY_NOTIFICATION_EMAIL_BUDGET - counter(now).sent);
}

/** Test seam. Never called in product code. */
export function __resetEmailBudget(): void {
  globalForQuota.__ff_email_quota = undefined;
}
