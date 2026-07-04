/**
 * Email-change tokens — stateless HMAC-signed JWTs, same design as the
 * password-reset + email-verification tokens. Unlike those, the payload also
 * carries the PROPOSED new email so the confirmation link proves ownership of
 * the destination address (the link is sent TO the new address).
 *
 * TTL is short (1 hour) because changing the login email is security-
 * sensitive — a stale link shouldn't let someone hijack the address days
 * later. The `purpose` claim keeps it from being replayed as a
 * verification / reset token even though all three share AUTH_SECRET.
 */

import { SignJWT, jwtVerify } from "jose";

const CHANGE_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const PURPOSE = "email-change" as const;

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!raw) {
    throw new Error("AUTH_SECRET is not configured. Email-change tokens cannot be signed.");
  }
  return new TextEncoder().encode(raw);
}

export async function signEmailChangeToken(userId: string, newEmail: string): Promise<string> {
  return await new SignJWT({ sub: userId, newEmail, purpose: PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${CHANGE_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export type VerifiedEmailChangeToken =
  | { ok: true; userId: string; newEmail: string }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyEmailChangeToken(token: string): Promise<VerifiedEmailChangeToken> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (payload.purpose !== PURPOSE) return { ok: false, reason: "invalid" };
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "invalid" };
    if (typeof payload.newEmail !== "string" || !payload.newEmail) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, userId: payload.sub, newEmail: payload.newEmail };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}
