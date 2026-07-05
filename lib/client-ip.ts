/**
 * Extract the client IP from request headers inside a Server Action, for use
 * as a rate-limit key.
 *
 * SECURITY: never key on the *leftmost* x-forwarded-for entry. On Vercel the
 * platform APPENDS the real client IP to whatever x-forwarded-for the client
 * sent, so `xff[0]` is fully attacker-controlled — rotating it per request
 * hands out a fresh rate-limit bucket every time and defeats brute-force /
 * signup-spam / reset-flood throttling.
 *
 * Order of preference:
 *   1. x-real-ip — set by Vercel's edge from the actual TCP peer; the client
 *      cannot spoof it. This is the trusted value on our deploy target.
 *   2. x-forwarded-for LAST hop — the entry added by the nearest trusted
 *      proxy (not the spoofable client-supplied leftmost value).
 *   3. "unknown" fallback so we never key on undefined.
 */

import { headers } from "next/headers";

export async function getClientIp(): Promise<string> {
  const h = await headers();

  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();

  const forwardedFor = h.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    // Last hop is added by the closest trusted proxy, not the client.
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}
