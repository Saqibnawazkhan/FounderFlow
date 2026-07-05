/**
 * Password-reset tokens are stateless HMAC-signed JWTs. No DB table.
 *
 * Rationale for stateless-only tokens:
 *  - Adds zero migration risk. The token carries userId + purpose + expiry +
 *    a password-version claim (`pv`). HMAC prevents forgery.
 *
 * Single-use (real, not aspirational): the token embeds `pv`, a short digest
 * of the user's CURRENT passwordHash at mint time (computed by the caller via
 * `passwordVersion`). On redemption the action recomputes `pv` from the live
 * hash and rejects the token if they differ. Because a successful reset writes
 * a new bcrypt hash, `pv` changes, so the same link cannot be replayed after
 * the first use — and any *other* outstanding reset link for that user is
 * invalidated at the same moment. This closes the previous replay-within-TTL
 * hole (the old comment claiming "naturally useless after first redemption"
 * was false — nothing actually checked it).
 *
 * Trade-off: we can't proactively revoke a specific outstanding token from a
 * server dashboard. If we ever need that, this file gets a companion
 * `PasswordResetToken` table without callers changing.
 */

import { createHash } from "crypto";
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

/**
 * A short, opaque fingerprint of the current password hash. Changes the
 * instant the password is reset, which is what makes a token single-use.
 * (SHA-256 of the bcrypt hash, not the password — the raw password never
 * reaches here.)
 */
export function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

export async function signPasswordResetToken(userId: string, pv: string): Promise<string> {
  return await new SignJWT({ sub: userId, purpose: PURPOSE, pv })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${RESET_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export type VerifiedResetToken =
  | { ok: true; userId: string; pv: string }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyPasswordResetToken(token: string): Promise<VerifiedResetToken> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (payload.purpose !== PURPOSE) return { ok: false, reason: "invalid" };
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "invalid" };
    if (typeof payload.pv !== "string" || !payload.pv) return { ok: false, reason: "invalid" };
    return { ok: true, userId: payload.sub, pv: payload.pv };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}
