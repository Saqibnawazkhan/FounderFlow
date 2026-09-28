/**
 * Cron heartbeats — the half of the alerting story that HTTP status codes
 * cannot express (cron-008).
 *
 * THE BUG THIS CLOSES. All three nightly routes answered `206 Partial Content`
 * when some of their work failed, with a comment claiming that "Vercel cron
 * monitoring escalates on 5xx, but a 206 still shows up in dashboards + makes
 * it possible to alert externally on partial drops". Both halves were wrong in
 * the same direction:
 *
 *   - 206 is a 2xx. Vercel's cron view reads it as a SUCCESSFUL invocation, so
 *     the only escalation path these jobs had never fired.
 *   - "possible to alert externally" was never built. There was no alert rule,
 *     no monitor, no check-in anywhere in the repo.
 *
 * So a permanently-failing purge stage (cron-002) and a workspace that can
 * never be erased (cron-006) both surfaced as a 206 nobody reads. The routes
 * now answer 500 on a failed stage, which restores Vercel's own escalation.
 *
 * A status code still cannot express the worst failure mode: a job that does
 * not run AT ALL. No invocation means no response to escalate on — the Hobby
 * cron-count limit, a deploy window, or a removed schedule are all silent.
 * That is what a check-in is for: Sentry knows the crontab, so a MISSING
 * heartbeat is itself the alert.
 *
 * `captureCheckIn` is a no-op when SENTRY_DSN is unset (local dev, partial
 * staging installs), exactly like `captureException`, so this is safe to call
 * unconditionally.
 *
 * NOTE for whoever wires the third route: `app/api/cron/sweep-time-entries`
 * still carries the old 206 + no-check-in shape. It was outside a04's file
 * ownership in the P1 wave — see the handback's needsOtherFiles.
 */

import * as Sentry from "@sentry/nextjs";

export interface CronMonitor {
  /** Sentry monitor slug. Keep it equal to the route segment. */
  slug: string;
  /** The crontab expression from vercel.json, so Sentry can expect the beat. */
  schedule: string;
  /** Minutes late before Sentry calls the run missed. */
  checkinMargin?: number;
  /** Minutes a run may take before Sentry calls it stuck. */
  maxRuntime?: number;
}

/**
 * The pure decision, kept separate so it is unit-testable without Sentry: which
 * check-in status closes a run that answered this HTTP status.
 *
 * Anything outside 2xx is an error. 206 is deliberately NOT special-cased as a
 * success — treating a partial failure as a green heartbeat is the exact defect
 * this module exists to remove. The routes no longer emit 206 at all; this
 * keeps the decision correct if one ever does again.
 */
export function checkInStatusForHttp(status: number): "ok" | "error" {
  return status >= 200 && status < 300 && status !== 206 ? "ok" : "error";
}

/**
 * Run a cron handler between an `in_progress` and a terminal check-in.
 *
 * Call it AFTER the secret check: an unauthenticated probe of the URL is not a
 * run of the job, and letting one close the heartbeat as an error would page
 * on-call for a port scan. A thrown error closes the check-in as an error and
 * is re-thrown untouched.
 */
export async function withCronCheckIn<T extends { status: number }>(
  monitor: CronMonitor,
  handler: () => Promise<T>
): Promise<T> {
  let checkInId: string | undefined;
  try {
    checkInId = Sentry.captureCheckIn(
      { monitorSlug: monitor.slug, status: "in_progress" },
      {
        schedule: { type: "crontab", value: monitor.schedule },
        checkinMargin: monitor.checkinMargin ?? 10,
        maxRuntime: monitor.maxRuntime ?? 5,
        timezone: "Etc/UTC",
      }
    );
  } catch {
    // Telemetry must never be able to stop the nightly job from running.
    checkInId = undefined;
  }

  const close = (status: "ok" | "error") => {
    try {
      Sentry.captureCheckIn({ checkInId, monitorSlug: monitor.slug, status });
    } catch {
      /* same reason as above */
    }
  };

  try {
    const res = await handler();
    close(checkInStatusForHttp(res.status));
    return res;
  } catch (e) {
    close("error");
    throw e;
  }
}
