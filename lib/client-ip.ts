/**
 * Extract the client IP from request headers inside a Server Action, for use
 * as a rate-limit key.
 *
 * ── THE RULE: A FORWARDING HEADER IS ONLY WORTH READING IF SOMETHING ────────
 * ── OVERWRITES IT ──────────────────────────────────────────────────────────
 *
 * `x-real-ip` and `x-forwarded-for` are ordinary request headers. Anyone can
 * send them. They are useful only where a proxy in front of us REPLACES
 * whatever the client sent, and that is a property of the deployment, not of
 * the header name. This file used to read `x-real-ip` verbatim, always, with
 * the comment "the client cannot spoof it" — true of Vercel's edge, asserted
 * nowhere, and false the moment the same code runs behind nginx, in Docker,
 * under `vercel dev`, or self-hosted. A client that picks its own header picks
 * its own rate-limit bucket, which is audit finding sec-001.
 *
 * So trust is now *declared*:
 *
 *   TRUSTED_PROXY_HEADER   name of the ONE header your proxy overwrites on
 *                          every request (e.g. `cf-connecting-ip` behind
 *                          Cloudflare, `x-real-ip` behind nginx with
 *                          `proxy_set_header X-Real-IP $remote_addr`). Set it
 *                          to `none` to read no header at all.
 *   unset, on Vercel       `x-real-ip` then the last `x-forwarded-for` hop.
 *                          Vercel's edge sets both from the TCP peer; this is
 *                          our deploy target and `VERCEL=1` is how we know we
 *                          are on it.
 *   unset, in dev/test     same as Vercel. A laptop is not a trust boundary,
 *                          and the puppeteer harness under scripts/ relies on
 *                          a per-agent `x-real-ip` to get its own buckets.
 *   unset, anywhere else   NOTHING is trusted. A production runtime we cannot
 *                          identify gets no client address rather than an
 *                          attacker-supplied one.
 *
 * NEVER THE LEFTMOST x-forwarded-for ENTRY: on Vercel the platform APPENDS the
 * real client IP to whatever the client sent, so `xff[0]` is fully
 * attacker-controlled — rotating it per request hands out a fresh rate-limit
 * bucket every time and defeats brute-force / signup-spam / reset-flood
 * throttling. The last hop is the one a trusted proxy added.
 *
 * ── AND WHEN THERE IS NO TRUSTED ADDRESS ───────────────────────────────────
 * The old fallback was the literal string "unknown", which is a BUCKET: every
 * visitor with no proxy header shared one 5-per-minute budget across login,
 * password reset and account deletion, so one attacker could lock out every
 * real customer at once. We now return `UNTRUSTED_CLIENT_IP`, which
 * `lib/rate-limit.ts` recognises: `ipBucketKey()` swaps in the account the
 * request is about, and `gateAuthAction()` falls back to per-account limits.
 * The sentinel is never itself counted as an address.
 */

import { headers } from "next/headers";
import { UNTRUSTED_CLIENT_IP } from "@/lib/rate-limit";

// Re-exported so callers can import the sentinel from either module. It is
// DEFINED in lib/rate-limit.ts because that is the module that has to
// recognise it, and keeping it there keeps `next/headers` out of that file.
export { UNTRUSTED_CLIENT_IP };

/**
 * An IPv6 address with a zone id is 45-odd characters. Anything past 64 is not
 * an address, and since a header value becomes a Map key in a store with no
 * eviction sweep, accepting arbitrary length would be a memory-growth
 * primitive. Rejected outright rather than truncated: truncating would MERGE
 * distinct clients into one bucket, which is the bug this file is fixing.
 */
const MAX_IP_VALUE_LENGTH = 64;

export type ClientIpInfo =
  | { trusted: true; ip: string; header: string }
  | {
      trusted: false;
      ip: null;
      /**
       * `no-trusted-header`: nothing is declared and we cannot identify the
       * platform. `header-absent`: we would trust one, it wasn't sent.
       * `header-unusable`: it was sent and was empty or absurd.
       */
      reason: "no-trusted-header" | "header-absent" | "header-unusable";
    };

/**
 * Which headers may be read, in order of preference. Empty means "no request
 * header is trustworthy here".
 *
 * Reads `process.env` at call time, not at module load, so a test (or a
 * runtime that sets vars late) sees the value it set.
 */
export function trustedIpHeaders(env: Record<string, string | undefined> = process.env): string[] {
  const declared = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (declared) {
    // An explicit opt-out, for a deployment that is directly exposed.
    if (declared === "none" || declared === "off" || declared === "false") return [];
    // Exactly one header, and only that one: if your proxy overwrites
    // cf-connecting-ip, x-real-ip is still whatever the client typed.
    return [declared];
  }
  const onVercel = env.VERCEL === "1" || env.VERCEL === "true";
  if (onVercel || env.NODE_ENV !== "production") return ["x-real-ip", "x-forwarded-for"];
  return [];
}

/**
 * The last non-empty comma-separated entry of a header value, or null if there
 * isn't a usable one. Handles both single-value headers (`x-real-ip`) and hop
 * lists (`x-forwarded-for`) with one rule, so the two can never drift.
 */
export function lastTrustedHop(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(",");
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i].trim();
    if (!candidate) continue;
    return candidate.length <= MAX_IP_VALUE_LENGTH ? candidate : null;
  }
  return null;
}

/**
 * The full verdict: the address AND whether it can be trusted. Prefer this
 * over `getClientIp()` when the caller can do something useful with the
 * distinction (e.g. logging, or choosing a different bucket key).
 */
export async function getClientIpInfo(): Promise<ClientIpInfo> {
  const allowed = trustedIpHeaders();
  if (allowed.length === 0) {
    return { trusted: false, ip: null, reason: "no-trusted-header" };
  }

  const h = await headers();
  let sawSomething = false;
  for (let i = 0; i < allowed.length; i++) {
    const name = allowed[i];
    const raw = h.get(name);
    if (raw === null || raw.trim() === "") continue;
    sawSomething = true;
    const value = lastTrustedHop(raw);
    if (value) return { trusted: true, ip: value, header: name };
  }
  return {
    trusted: false,
    ip: null,
    reason: sawSomething ? "header-unusable" : "header-absent",
  };
}

/**
 * The address to use as a rate-limit key, or `UNTRUSTED_CLIENT_IP` when there
 * is none. Pass the result to `ipBucketKey(ip, identity)` or to
 * `gateAuthAction()` from lib/rate-limit.ts — never straight into
 * `limiter.consume()`, or the sentinel becomes a shared bucket again.
 */
export async function getClientIp(): Promise<string> {
  const info = await getClientIpInfo();
  return info.trusted ? info.ip : UNTRUSTED_CLIENT_IP;
}
