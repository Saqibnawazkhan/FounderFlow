/**
 * The one-shot latch for the announcement broadcast — and an honest account of
 * what it does NOT guarantee.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A DURABLE GUARANTEE WOULD NEED, AND WHY IT IS NOT HERE
 * ────────────────────────────────────────────────────────────────────────────
 * "Fire it twice, send once" is a uniqueness claim over time, and a uniqueness
 * claim needs somewhere durable to put the claim. The schema has no such place:
 * `prisma/schema.prisma` holds nineteen models and not one of them is a
 * key-value, ops or job-history table (the closest, `BillingEvent`, is a
 * provider ledger and polluting it would corrupt billing reconciliation). So a
 * real guarantee needs a migration, and this change is not allowed to write
 * one. The exact SQL is recorded at the bottom of this comment so the decision
 * is the owner's rather than lost.
 *
 * WHAT THIS GIVES INSTEAD. Module scope in a Node serverless function is
 * per-INSTANCE and lives as long as the instance stays warm. So:
 *
 *   • A second fire that lands on the same warm instance is refused outright.
 *     That covers the two likely repeats: a double-click, and a retry after the
 *     CALLER gave up — a curl that timed out or a client-side cancel — where the
 *     function itself ran to completion and the instance is now hot. The retry
 *     arrives seconds or minutes later and is served by that same instance.
 *   • Two fires that OVERLAP on the same instance are also refused: the latch
 *     moves to `in-flight` before the first send leaves, so the second request
 *     sees a claim rather than an empty state. Node is single-threaded per
 *     instance, and the claim is synchronous, so there is no interleaving
 *     window between the read and the write.
 *   • A `tag` on the payload (lib/announce/announcement.ts) collapses whatever
 *     does get through into ONE notification at the OS level. That is a
 *     presentation mercy, not a guarantee, and it is not counted as one.
 *
 * WHAT IT DOES NOT COVER, PLAINLY: a cold start, a redeploy, or Vercel routing
 * the second request to a different instance of the same deployment. In any of
 * those the latch is empty and the second fire sends again.
 *
 * And one more, because it is the exact case worth naming: if the FUNCTION is
 * killed at `maxDuration` partway through the fan-out, no response is written,
 * `settleBroadcast` never runs, and whether this module's state survives into
 * the next invocation is the platform's decision and not ours. So a retry after
 * a 60-second function timeout — as opposed to a timeout on the caller's side —
 * is in this list, not the one above. The route keeps the fan-out sequential and
 * batched so that is unlikely at this product's scale; "unlikely" is not
 * "cannot", which is what the SQL below is for.
 *
 * The route's response states how long the instance answering it has been warm,
 * so a repeat that DID send is at least visible in that response rather than
 * deniable. There is NO off-box record of a small broadcast: the route's
 * `warnBulkMutation` call keeps the canary's default 100-row threshold, so a
 * fan-out under that size leaves nothing in Sentry either. The response body is
 * the only account of a run, and that is a consequence of having no table — not
 * an oversight.
 *
 * THE DURABLE FIX, IF THE OWNER WANTS ONE (do not run this from a laptop; it
 * belongs in a Prisma migration applied by the build, per CLAUDE.md):
 *
 *   CREATE TABLE "BroadcastRun" (
 *     "id"              TEXT NOT NULL,          -- the announcement id
 *     "firedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 *     "usersTargeted"   INTEGER NOT NULL,
 *     "sendsSucceeded"  INTEGER NOT NULL,
 *     "sendsFailed"     INTEGER NOT NULL,
 *     CONSTRAINT "BroadcastRun_pkey" PRIMARY KEY ("id")
 *   );
 *
 * The primary key IS the guarantee: the route would `INSERT` the announcement
 * id inside the same transaction that precedes the fan-out and treat a `P2002`
 * unique violation as "already fired", which holds across instances, cold
 * starts and redeploys. It is a new table only — it touches no existing row, so
 * it carries no risk to customer data — and it is additive, so a rollback is a
 * `DROP TABLE`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * No I/O, no imports: a test resets it with `vi.resetModules()`, and there is
 * deliberately no exported reset, because a reset lever in production source is
 * a way to fire the broadcast twice on purpose.
 */

export type LatchState = "not-fired" | "in-flight" | "fired";

/** What the first live fire recorded, so a refusal can report it back. */
export interface LatchRecord {
  firedAt: string;
  outcome: "delivered" | "failed";
  sendsSucceeded: number;
  sendsFailed: number;
}

let state: LatchState = "not-fired";
let record: LatchRecord | null = null;

/** When this module was first loaded — i.e. how long this instance has run. */
const instanceStartedAt = Date.now();

/**
 * Try to become the one live fire.
 *
 * Synchronous and non-async on purpose: an `await` between reading `state` and
 * writing it would open exactly the interleaving window this exists to close.
 */
export function claimBroadcast(): {
  claimed: boolean;
  state: LatchState;
  record: LatchRecord | null;
} {
  if (state !== "not-fired") return { claimed: false, state, record };
  state = "in-flight";
  return { claimed: true, state, record: null };
}

/**
 * Close the claim. Called whatever the outcome, INCLUDING a failure.
 *
 * A failed run is NOT returned to `not-fired`. By the time this is reached the
 * payload has been handed to `sendPushToUsers`, which swallows per-device errors
 * and may well have delivered some of them, so "retry" means "send some people a
 * second copy". For an action that cannot be unsent, refusing the retry is the
 * safer failure — and the response says so rather than leaving the owner to
 * guess. The caller therefore claims AFTER the recipient query has succeeded, so
 * a database failure (which sends nothing) leaves the latch untouched and
 * genuinely retryable.
 */
export function settleBroadcast(outcome: Omit<LatchRecord, "firedAt">): void {
  state = "fired";
  record = { firedAt: new Date().toISOString(), ...outcome };
}

export function broadcastLatchState(): { state: LatchState; record: LatchRecord | null } {
  return { state, record };
}

/** Milliseconds this instance has been warm — the latch's effective lifetime. */
export function instanceUptimeMs(): number {
  return Date.now() - instanceStartedAt;
}
