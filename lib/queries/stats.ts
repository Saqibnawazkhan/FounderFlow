/**
 * Per-account stats for /settings — surfaced as three cards above the
 * profile section: total tracked time, last sign-in, and member-since.
 *
 * Scoped to session.user.id. The time figure sums every TimeEntry (open
 * entries are credited up to `now`), so it matches what the user sees on
 * /time when they aggregate "Total tracked".
 *
 * ── WHY THE SUM IS SQL AND NOT A reduce() (perf-003) ───────────────────────
 * This used to be `db.timeEntry.findMany({ where: { userId } })` with no `take`
 * followed by `entries.reduce(durationMs)`, and `entries.length` for the count.
 * Three /settings cards therefore pulled every row the person has ever clocked
 * into the Node heap — a year of ordinary use is four figures per person, and on
 * a serverless function an unbounded read is a memory ceiling rather than a slow
 * page. The sibling roll-ups elsewhere in lib/queries/ are already aggregates;
 * this was the one that was not.
 *
 * ── THE SQL, DECISION BY DECISION ──────────────────────────────────────────
 *
 * `(NOW() AT TIME ZONE 'UTC')` rather than a bound `now` parameter. Prisma maps
 * `DateTime` to `TIMESTAMP(3)` WITHOUT time zone (see the add_time_entries
 * migration), holding a UTC wall clock. Mixing a bound `timestamptz` parameter
 * into `COALESCE(timestamp, …)` makes Postgres resolve the whole expression as
 * timestamptz and convert the stored column using the SESSION's TimeZone — so
 * the open-entry duration would shift by the server's offset on any deployment
 * whose session TZ is not UTC. `NOW() AT TIME ZONE 'UTC'` is a timestamp in the
 * same domain as the column, whatever the session is set to.
 *
 * `GREATEST(…, 0)` mirrors `durationMs`, which is `Math.max(0, …)`. An entry
 * edited so clock-out precedes clock-in contributed 0 there; without GREATEST it
 * would contribute a NEGATIVE here and quietly eat other entries' hours.
 *
 * Note the credit for an OPEN entry is uncapped, which is what `durationMs`
 * actually does — its own doc comment claims it caps at the auto-close horizon
 * and the code does not. This mirrors the behaviour, not the comment; see the
 * cross-file note in the delivery follow-ups.
 *
 * `::double precision` / `::int` casts are load-bearing: `EXTRACT(EPOCH …)`
 * returns `numeric` (Prisma → `Prisma.Decimal`) and `COUNT(*)` returns int8
 * (Prisma → `BigInt`). Either one reaching the RSC boundary un-coerced renders
 * as "[object Object]" or throws "Do not know how to serialize a BigInt", so the
 * cast is the first line of defence and `Number()` below is the second.
 *
 * `$queryRaw`, never `$queryRawUnsafe`: every `${…}` in a Prisma tagged template
 * is a bound parameter.
 *
 * Tested in tests/lib/queries/account-stats-sum.test.ts.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";

export interface AccountStats {
  totalTrackedMs: number;
  /** Count of finished + open sessions — useful as a "you've used this N times" feel. */
  sessionCount: number;
  lastSignInAt: string | null;
  memberSince: string;
}

/** What the raw query yields. Typed loosely on purpose: the driver may hand back
 *  a Decimal/BigInt/string for a numeric column, and pretending otherwise is how
 *  "[object Object]" ships to a customer's settings page. */
type TrackedTimeRow = {
  totalTrackedMs: number | string | bigint | { toString(): string };
  sessionCount: number | string | bigint;
};

export async function getAccountStats(): Promise<AccountStats> {
  const { userId } = await requireScopedSession();
  const [user, trackedRows] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { createdAt: true, lastSignInAt: true },
    }),
    db.$queryRaw<TrackedTimeRow[]>`
      SELECT
        COALESCE(
          SUM(
            GREATEST(
              EXTRACT(
                EPOCH FROM (COALESCE("clockOutAt", (NOW() AT TIME ZONE 'UTC')) - "clockInAt")
              ) * 1000,
              0
            )
          ),
          0
        )::double precision AS "totalTrackedMs",
        COUNT(*)::int AS "sessionCount"
      FROM "TimeEntry"
      WHERE "userId" = ${userId}
    `,
  ]);
  if (!user) throw new Error("User not found");

  // COALESCE guarantees a row even with no entries, but an empty array is
  // cheaper to defend against than to debug.
  const tracked = trackedRows[0];

  return {
    totalTrackedMs: tracked ? Number(tracked.totalTrackedMs) : 0,
    sessionCount: tracked ? Number(tracked.sessionCount) : 0,
    lastSignInAt: user.lastSignInAt ? user.lastSignInAt.toISOString() : null,
    memberSince: user.createdAt.toISOString(),
  };
}
