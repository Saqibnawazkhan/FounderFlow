/**
 * Email-verification tokens — stateless HMAC-signed JWTs, same design as the
 * password-reset tokens ([[password-reset-token]]). No DB table.
 *
 * Why stateless: the token carries the userId + purpose + expiry, signed with
 * AUTH_SECRET so it can't be forged. Verifying it needs no lookup beyond the
 * final `UPDATE User SET emailVerifiedAt = now()`.
 *
 * TTL is generous (7 days) — an email-verification link is far less sensitive
 * than a password reset (worst case of a leaked link: someone marks YOUR
 * email as verified, which only helps you), so we optimize for "the user gets
 * to it eventually" rather than a tight replay window.
 *
 * The `purpose` claim means a password-reset token can never be replayed as a
 * verification token or vice versa, even though both are signed with the same
 * secret.
 */

import { SignJWT, jwtVerify } from "jose";

const VERIFY_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const PURPOSE = "email-verification" as const;

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!raw) {
    throw new Error("AUTH_SECRET is not configured. Email-verification tokens cannot be signed.");
  }
  return new TextEncoder().encode(raw);
}

export async function signEmailVerificationToken(userId: string): Promise<string> {
  return await new SignJWT({ sub: userId, purpose: PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${VERIFY_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export type VerifiedEmailToken =
  | { ok: true; userId: string }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyEmailVerificationToken(token: string): Promise<VerifiedEmailToken> {
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
