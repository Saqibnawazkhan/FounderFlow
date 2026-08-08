/**
 * Session-invalidation primitives.
 *
 * FounderFlow uses stateless JWT sessions — the signed cookie is trusted on
 * every request with no DB lookup, which is fast but means a session can't be
 * revoked before it expires. That let a soft-deleted (tombstoned) user's live
 * tab keep reading data until the cookie died on its own.
 *
 * The fix: each User carries a `sessionVersion`. It's baked into the JWT at
 * sign-in, and the auth `jwt` callback re-checks the token against the live
 * row on every request (see lib/auth.ts). If the user is gone, tombstoned, or
 * the version was bumped, the session is killed immediately.
 *
 * `sessionTokenStillValid` is the pure decision (unit-tested); `bumpSessionVersion`
 * is the lever that forces every existing session for a user to sign out.
 */

import { db } from "@/lib/db";

/** The live-row fields the session check reads. */
export type SessionUserState = {
  deletedAt: Date | null;
  sessionVersion: number;
};

/**
 * Should a JWT with `tokenVersion` still be honoured given the user's live
 * state? Callers pass `null` for `current` when the user row no longer exists.
 * A missing token version is treated as 0 (legacy tokens minted before this
 * feature, whose users default to sessionVersion 0 — so they stay valid).
 */
export function sessionTokenStillValid(
  tokenVersion: number | undefined,
  current: SessionUserState | null
): boolean {
  if (!current) return false; // user hard-deleted / never existed
  if (current.deletedAt) return false; // tombstoned (soft delete)
  return (tokenVersion ?? 0) === current.sessionVersion;
}

/**
 * Force every existing session for a user to sign out on its next request by
 * advancing their session version. Call after a password reset/change or a
 * "log out all devices" request.
 */
export async function bumpSessionVersion(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
  });
}
