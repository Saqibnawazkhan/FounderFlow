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
 *
 * REVOCABLE, which it was not (audit acct-004 / auth-004). The token used to
 * carry `{ sub, newEmail, purpose }` and an expiry, and nothing else — nothing
 * about the account it was minted against. So:
 *
 *   • acct-004. Someone with a borrowed session requested a change to their own
 *     address and walked away. The victim did the documented thing and changed
 *     their password, which bumps `sessionVersion` and kills every session —
 *     and the outstanding link went on working for the rest of the hour,
 *     because no part of it was tied to the password or the session. Clicking
 *     it moved the login email, and /forgot-password then handed over the
 *     account.
 *   • auth-004. With three addresses inside one hour (A→B→C), replaying the
 *     A→B link found the row at C, found no collision on B, and wrote B —
 *     silently snapping a paying customer's login address back to a typo they
 *     had already corrected, which is an unrecoverable lockout because the
 *     reset mail then goes to the wrong inbox.
 *
 * THE FIX, and it is the same mechanism `pv` already gives password-reset
 * tokens (lib/auth/password-reset-token.ts): the token carries `bv`, a digest
 * of the account state it was minted against. The redeeming action recomputes
 * `bv` from the live row and rejects the token if it differs. One claim, three
 * inputs, and every one of them is a thing that must revoke a pending change:
 *
 *   sessionVersion — bumped by a password change, a password reset, and any
 *                    future "log out all devices"; also bumped by a SUCCESSFUL
 *                    email change, which is what makes the link single-use.
 *   email          — a later change that has already landed invalidates every
 *                    link minted before it (auth-004), independently of the
 *                    session version.
 *   passwordHash   — belt and braces. Both password paths bump sessionVersion
 *                    in the same UPDATE as the new hash today, so this is
 *                    redundant *today*; it is here so that acct-004 cannot
 *                    silently reopen if that ever stops being true.
 *
 * A token with no `bv` at all is rejected as invalid, not tolerated: unbound is
 * precisely the vulnerability, and an optional binding is no binding. The only
 * cost is that links minted before this shipped stop working, i.e. a window one
 * TTL wide.
 *
 * Trade-off (unchanged from the reset token): we cannot proactively revoke one
 * specific outstanding token from a dashboard. If that is ever needed, this
 * file gains a companion table without callers changing.
 */

import { createHash } from "crypto";
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

/** The live-row fields a pending email change is bound to. */
export type EmailChangeBindingState = {
  email: string;
  sessionVersion: number;
  passwordHash: string;
};

/**
 * A short, opaque fingerprint of the account state a confirmation link was
 * minted against. Changes the instant any of the three inputs changes, which is
 * what makes the link revocable and single-use.
 *
 * Opaque on purpose: the digest travels inside a JWT payload, which is base64,
 * not encryption, and that payload is mailed to an address that in the typo
 * case belongs to a stranger. A plain `oldEmail` claim would tell that inbox
 * the account's real address; a digest tells it nothing. The raw password never
 * reaches here either — only the bcrypt hash, exactly as `passwordVersion`
 * does.
 *
 * NUL-separated because concatenation alone is ambiguous: "1" + "a@b" and
 * "1a" + "@b" would otherwise be the same string, and a binding with a
 * collision is a binding with a bypass.
 */
export function emailChangeBinding(state: EmailChangeBindingState): string {
  return createHash("sha256")
    .update(
      [String(state.sessionVersion), state.email.trim().toLowerCase(), state.passwordHash].join(
        "\u0000"
      )
    )
    .digest("hex")
    .slice(0, 16);
}

export async function signEmailChangeToken(
  userId: string,
  newEmail: string,
  bv: string
): Promise<string> {
  return await new SignJWT({ sub: userId, newEmail, purpose: PURPOSE, bv })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${CHANGE_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export type VerifiedEmailChangeToken =
  | { ok: true; userId: string; newEmail: string; bv: string }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyEmailChangeToken(token: string): Promise<VerifiedEmailChangeToken> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    if (payload.purpose !== PURPOSE) return { ok: false, reason: "invalid" };
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "invalid" };
    if (typeof payload.newEmail !== "string" || !payload.newEmail) {
      return { ok: false, reason: "invalid" };
    }
    // No binding → no way to revoke it → not a token we will honour. This is
    // the shape of every link minted before acct-004 was fixed.
    if (typeof payload.bv !== "string" || !payload.bv) return { ok: false, reason: "invalid" };
    return { ok: true, userId: payload.sub, newEmail: payload.newEmail, bv: payload.bv };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "invalid" };
  }
}
