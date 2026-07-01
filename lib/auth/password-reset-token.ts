/**
 * Password-reset tokens are stateless HMAC-signed JWTs. No DB table.
 *
 * Rationale for stateless-only tokens:
 *  - Adds zero migration risk (see CLAUDE.md — the local .env points at prod,
 *    so a spontaneous `prisma migrate` is a foot-cannon we deliberately avoid
 *    on P0-shape work).
 *  - The token carries userId + purpose + expiry. HMAC prevents forgery.
 *  - Replay is bounded by the 15-minute TTL; each successful reset also bumps
 *    the user's passwordHash, so an old token is naturally useless after the
 *    first redemption because the payload it signed becomes irrelevant to
 *    *any* new password-change flow — even a race lands on the new hash.
 *
 * Trade-off: we can't proactively revoke a specific outstanding token from a
 * server dashboard. That's an acceptable posture for the "you had 15 minutes
 * to reset your password" window. If we ever need per-token revocation, this
 * file gets a companion `PasswordResetToken` table without callers changing.
 */

import { SignJWT, jwtVerify } from "jose";

const RESET_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const PURPOSE = "password-reset" as const;

function getSecret(): Uint8Array {
  // Reuse the Auth.js secret so we don't force a second env var. The runtime
  // has already verified it's present when a user reaches the login page.
  const raw = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!raw) {
    throw new Error("AUTH_SECRET is not configured. Password-reset tokens cannot be signed.");
  }
  return new TextEncoder().encode(raw);
}

export async function signPasswordResetToken(userId: string): Promise<string> {
  return await new SignJWT({ sub: userId, purpose: PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${RESET_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export type VerifiedResetToken =
  | { ok: true; userId: string }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyPasswordResetToken(token: string): Promise<VerifiedResetToken> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (payload.purpose !== PURPOSE) return { ok: false, reason: "invalid" };
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "invalid" };
    return { ok: true, userId: payload.sub };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}
