/**
 * Tier 3 canary: any single mutation that touches more than N rows fires a
 * Sentry warning. The point isn't to block the mutation — a legit workspace
 * delete IS supposed to nuke thousands of rows — but to make "an admin
 * clicked something and 12,000 rows disappeared" visible in the ops feed
 * with the userId, companyId, and the action name attached.
 *
 * Two intended callsites, right now:
 *   1. deleteWorkspaceAction — every real workspace hits this on click
 *   2. /api/cron/purge-soft-deleted — nightly hard-purge past the 90-day
 *      window; ok to be large but if it's suddenly 10x usual, we want to
 *      know before customers do.
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
