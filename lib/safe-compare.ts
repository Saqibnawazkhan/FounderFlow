import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison for shared secrets (e.g. the CRON_SECRET
 * Bearer check). A plain `a !== b` short-circuits on the first differing byte,
 * leaking a timing signal about how much of the secret is correct. Over HTTP
 * that signal is buried in network jitter so exploitability is low, but a
 * constant-time compare is cheap insurance. Length is compared first (and not
 * in constant time — the length of a secret is not itself sensitive).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
