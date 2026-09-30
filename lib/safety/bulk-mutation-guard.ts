/**
 * Tier 3 canary: any single mutation that touches more than N rows fires a
 * Sentry warning. The point isn't to block the mutation — a legit workspace
 * delete IS supposed to nuke thousands of rows — but to make "an admin
 * clicked something and 12,000 rows disappeared" visible in the ops feed
 * with the userId, companyId, and the action name attached.
 *
 * WHERE IT IS CALLED FROM. This header used to say "two intended callsites,
 * right now" and name `deleteWorkspaceAction` and the purge cron. That stopped
 * being true and then became actively misleading (cron-011): the list had grown
 * to nine — account deletion and workspace deletion, project delete, the two
 * bulk task paths, bulk transaction delete, and four stages of the purge — while
 * the two jobs that write across EVERY tenant with no row cap were the ones
 * still missing. A reader checking "is the canary wired in?" against this
 * comment would have concluded yes for the purge and stopped looking.
 *
 * So: no list. `grep -rn warnBulkMutation lib app` is authoritative and cannot
 * go stale. What is worth stating is the RULE — every mutation whose row count
 * is bounded by customer data rather than by a constant reports itself here,
 * including the nightly jobs, which are the only callers with no human behind
 * them to notice.
 *
 * NOT A CEILING, and cron-011 asked for one. A hard abort past (say) 5x the
 * trailing average needs persisted run history — a table, which this change
 * cannot add — and the failure it would cause is its own hazard: refusing to
 * post a customer's rent on a legitimate catch-up night after an outage is worse
 * than posting it loudly. Reporting stays the contract; a ceiling is a separate,
 * schema-bearing decision.
 *
 * We tag Sentry with `boundary: bulk-mutation` so a single alert rule can
 * page on-call whenever this trips.
 */

import { captureServerError } from "@/lib/sentry-server";
import * as Sentry from "@sentry/nextjs";

export interface BulkMutationContext {
  action: string;
  userId?: string;
  companyId?: string;
  /** Anything worth including — table names touched, ids, etc. */
  extra?: Record<string, unknown>;
}

/**
 * The soft warning threshold. Chosen at 100 because a real signup workspace
 * in this shape has ~50 rows across all tables in the first week — a spike
 * past 100 in one action is either legitimate deletion (which we want to
 * see) or a bug (which we want to see faster).
 */
export const BULK_MUTATION_THRESHOLD = 100;

/**
 * Fire-and-continue warning: capture a Sentry event when a mutation touches
 * more than `threshold` rows. Never throws — this is telemetry, not a gate.
 * The mutation has already happened by the time this is called.
 */
export function warnBulkMutation(
  count: number,
  ctx: BulkMutationContext,
  threshold = BULK_MUTATION_THRESHOLD
): void {
  if (count <= threshold) return;
  try {
    Sentry.captureMessage(`Bulk mutation exceeded threshold: ${ctx.action} touched ${count} rows`, {
      level: "warning",
      tags: {
        boundary: "bulk-mutation",
        action: ctx.action,
        ...(ctx.companyId ? { companyId: ctx.companyId } : {}),
      },
      user: ctx.userId ? { id: ctx.userId } : undefined,
      extra: { rowCount: count, threshold, ...ctx.extra },
    });
  } catch (err) {
    // Defensive — if Sentry itself is misbehaving, we don't want to punish
    // the caller. Fall through to the local capture helper which no-ops
    // when SENTRY_DSN is unset (local dev + partial staging installs).
    captureServerError(err, { action: "warnBulkMutation" });
  }
}
