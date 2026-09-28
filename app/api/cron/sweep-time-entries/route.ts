/**
 * Daily cron endpoint — safety net for the auto-close pipeline. If a user
 * forgot to clock out and then closed the browser (so the in-page idle
 * handler never fires), this sweep closes the entry at `lastActivityAt`.
 *
 * Cadence: once per day (00:10 UTC per vercel.json). Vercel's Hobby plan
 * caps crons at daily, so we can't run hourly. Daily is fine because the
 * sweeper sets `clockOutAt = lastActivityAt` — the recorded duration is
 * accurate regardless of when the sweep actually runs; only the visibility
 * of the "auto-closed" state is delayed.
 *
 * Auth: same CRON_SECRET pattern as materialize-recurring. Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on cron requests. A MISSING secret is a
 * misconfiguration, not an attack, so it raises a Sentry event before answering
 * 500 (prodready-003) — it used to return in silence, and a production deploy
 * that dropped the var meant this job 500'd every night behind nothing but a
 * Vercel log line nobody reads.
 *
 * Idempotency: the sweeper only touches rows where clockOutAt is still
 * null AND lastActivityAt < now - AUTO_CLOSE_MS, so re-running the cron
 * within the same day is a no-op.
 *
 * ALERTING (cron-008). This route was the last of the three nightly jobs still
 * answering `206 Partial Content` when some entries failed, behind a comment
 * claiming Vercel's cron dashboard "sees the non-2xx". 206 IS a 2xx: Vercel read
 * a permanently-failing sweep as a successful invocation, so the only escalation
 * path this job had never fired, and the "alert externally on a 206" half was
 * never built. A failed entry now answers 500, which restores Vercel's own
 * escalation.
 *
 * A status code still cannot express the worst failure mode — a night when the
 * job does not run AT ALL produces no response to escalate on — so the whole run
 * sits inside a Sentry cron check-in (`lib/cron/monitor.ts`). The check-in is
 * opened INSIDE the secret check: an unauthenticated probe of this URL is not a
 * run of the job and must not close the heartbeat in either direction.
 */

import { NextResponse } from "next/server";
// Imported from `lib/time/sweep.ts`, a plain server module — NOT from
// `lib/actions/time.ts`. That file is `"use server"` and sits in the client
// graph, so every export of it gets a public Server Action id; the sweeper used
// to live there and was therefore an unauthenticated, cross-workspace POST
// endpoint (cron-001). This route's CRON_SECRET check below is the sweeper's
// only gate, which only works while the function has no action id of its own.
import { sweepAutoCloseEntries } from "@/lib/time/sweep";
import { captureServerError } from "@/lib/sentry-server";
import { withCronCheckIn } from "@/lib/cron/monitor";
import { safeEqual } from "@/lib/safe-compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Must match the crontab in vercel.json, or Sentry's missed-beat alert is wrong. */
const MONITOR = { slug: "sweep-time-entries", schedule: "10 0 * * *" } as const;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed, but LOUDLY (prodready-003). `scripts/vercel-build.mjs` fails
    // a production build without CRON_SECRET; this is the belt to that brace,
    // for the var being removed after a green build.
    captureServerError(new Error("CRON_SECRET is not configured — sweep-time-entries cannot run"), {
      action: "sweepTimeEntries.config",
    });
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Inside the secret check on purpose: an unauthenticated probe of this URL is
  // not a run of the job, and must not close the heartbeat either way.
  return withCronCheckIn(MONITOR, () => sweepRun());
}

async function sweepRun(): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const result = await sweepAutoCloseEntries();
    // 500, not 206 (cron-008). The per-entry failures are already in Sentry
    // (see sweepAutoCloseEntries); what was missing is escalation, and 206 is a
    // 2xx that Vercel's cron view reads as a clean run. `withCronCheckIn`
    // turns this same status into a Sentry monitor error as well.
    const status = result.failed.length > 0 ? 500 : 200;
    return NextResponse.json(
      {
        ok: result.failed.length === 0,
        ranAt: new Date().toISOString(),
        entriesAutoClosed: result.closed.length,
        entriesAttempted: result.attempted,
        entriesFailed: result.failed.length,
        durationMs: Date.now() - startedAt,
      },
      { status }
    );
  } catch (e) {
    captureServerError(e, {
      action: "sweepTimeEntries:outer",
      extra: { durationMs: Date.now() - startedAt },
    });
    return NextResponse.json(
      { error: "Sweep failed", durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
