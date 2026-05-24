/**
 * Extract the client IP from request headers inside a Server Action.
 *
 * Order of preference:
 *   1. x-forwarded-for (first hop) — what Vercel + most proxies set
 *   2. x-real-ip — Nginx-style
 *   3. fallback string so we never key on undefined (would collapse all
 *      anonymous traffic into the same bucket and over-block)
 */

import { headers } from "next/headers";

export async function getClientIp(): Promise<string> {
  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  if (forwardedFor) {
    // first IP in the chain is the original client
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}
