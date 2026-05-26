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
 * `Authorization: Bearer <CRON_SECRET>` on cron requests.
 *
 * Idempotency: the sweeper only touches rows where clockOutAt is still
 * null AND lastActivityAt < now - AUTO_CLOSE_MS, so re-running the cron
 * within the same day is a no-op.
 */

import { NextResponse } from "next/server";
import { sweepAutoCloseEntries } from "@/lib/actions/time";
import { captureServerError } from "@/lib/sentry-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const closed = await sweepAutoCloseEntries();
    return NextResponse.json({
      ok: true,
      ranAt: new Date().toISOString(),
      entriesAutoClosed: closed,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    captureServerError(e, { action: "sweepTimeEntries:outer" });
    return NextResponse.json(
      { error: "Sweep failed", durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
