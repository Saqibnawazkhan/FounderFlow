/**
 * Per-account stats for /settings — surfaced as three cards above the
 * profile section: total tracked time, last sign-in, and member-since.
 *
 * Scoped to session.user.id. The time figure sums every TimeEntry (open
 * entries are credited up to `now`), so it matches what the user sees on
 * /time when they aggregate "Total tracked".
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { durationMs } from "@/lib/time/thresholds";

export interface AccountStats {
  totalTrackedMs: number;
  /** Count of finished + open sessions — useful as a "you've used this N times" feel. */
  sessionCount: number;
  lastSignInAt: string | null;
  memberSince: string;
}

export async function getAccountStats(): Promise<AccountStats> {
  const { userId } = await requireScopedSession();
  const [user, entries] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { createdAt: true, lastSignInAt: true },
    }),
    db.timeEntry.findMany({
      where: { userId },
      select: { clockInAt: true, clockOutAt: true },
    }),
  ]);
  if (!user) throw new Error("User not found");

  const now = new Date();
  const totalTrackedMs = entries.reduce(
    (acc, e) => acc + durationMs(e.clockInAt, e.clockOutAt, now),
    0
  );

  return {
    totalTrackedMs,
    sessionCount: entries.length,
    lastSignInAt: user.lastSignInAt ? user.lastSignInAt.toISOString() : null,
    memberSince: user.createdAt.toISOString(),
  };
}
