/**
 * Idle-entry auto-close sweeper — the body of the daily cron at
 * `app/api/cron/sweep-time-entries/route.ts`. Plain server module: NO
 * `"use server"` directive, and that omission is the security control.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/actions/time.ts` (audit finding cron-001):
 * `lib/actions/time.ts` starts with `"use server"`, and four client components
 * import from it (the /time page client, the topbar clock widget, and the edit
 * + manual-entry modals). Next.js mints a callable, publicly-routable Server
 * Action id for EVERY export of such a module — not only the exports a
 * component happens to call. This function was written as a cron body, so it
 * has no `auth()`, no role check and no rate limit, and its `where` clause has
 * no `companyId` filter. Exported from there, it was a public POST endpoint
 * that ended every running timer in every customer workspace, for anyone on
 * the internet, with no login. Nothing in a diff showed it: the hazard was the
 * *export*, not the code.
 *
 * DO NOT "FIX" THIS BY ADDING `auth()` AND MOVING IT BACK. The caller is a
 * Vercel cron request — there is no user session to authenticate, so an
 * `auth()` gate would not harden the job, it would make the job fail closed
 * every night and stale timers would accumulate forever. Nor is a companyId
 * filter the fix: the sweep is *meant* to be global, because it sweeps on
 * behalf of the platform, not on behalf of a workspace. The only correct fix
 * is what you are reading — the function is not reachable from the client
 * graph, so no action id is ever generated for it. The cron route (which does
 * authenticate, via CRON_SECRET) is its one and only entry point.
 *
 * Keep this module out of any `"use client"` import chain. `tests/lib/time/
 * sweep-reachability.test.ts` enforces both halves of that.
 */

import { db } from "@/lib/db";
import { AUTO_CLOSE_MS } from "@/lib/time/thresholds";
import { LIVE_ROW_AND_WORKSPACE_SCOPE } from "@/lib/cron/live-scope";
import { captureServerError } from "@/lib/sentry-server";

export interface SweepResult {
  attempted: number;
  closed: string[];
  failed: { id: string; error: string }[];
}

/**
 * Cron handler — runs daily (see vercel.json). Closes any open entry that
 * hasn't heartbeat-ed in AUTO_CLOSE_MS.
 *
 * Returns a detailed result instead of a count so the cron endpoint can:
 *   • respond 206 Partial Content if some entries fail (Vercel cron monitor
 *     will only alert on 5xx, but 206 still surfaces in dashboards)
 *   • log per-entry failures to Sentry with the entry id so triage isn't
 *     "something failed somewhere"
 *
 * Each entry is closed in its own update — NOT a single $transaction —
 * because one stuck row shouldn't block sweeping the other 99.
 *
 * No `revalidatePath` here: there is no request/render context in a cron
 * invocation to revalidate, and the /time page is dynamic anyway.
 */
export async function sweepAutoCloseEntries(): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - AUTO_CLOSE_MS);
  const stale = await db.timeEntry.findMany({
    // cron-010. `{ clockOutAt: null, lastActivityAt: { lt: cutoff } }` was the
    // whole clause, so for the full 90-day recovery window this job stamped
    // `clockOutAt` and `autoClosed: true` into timesheets belonging to deleted
    // workspaces — and, since TimeEntry became soft-deletable on 2026-09-29,
    // into individually deleted entries too, defeating the tombstone that exists
    // so a member's mis-click no longer destroys billable hours. A restored
    // workspace then came back with clock-outs at times nobody chose, which for
    // a customer who invoices from this data is a billing discrepancy.
    //
    // The scope is the shared rule rather than a literal here, because the
    // materializer already had it and this job did not; see lib/cron/live-scope.ts
    // for why `user: { deletedAt: null }` is deliberately NOT part of it (a
    // deactivated person cannot stop their own timer, so excluding them leaves it
    // running for ever).
    where: { ...LIVE_ROW_AND_WORKSPACE_SCOPE, clockOutAt: null, lastActivityAt: { lt: cutoff } },
    select: { id: true, lastActivityAt: true, userId: true, companyId: true },
  });
  if (stale.length === 0) return { attempted: 0, closed: [], failed: [] };

  const closed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const s of stale) {
    try {
      // data-integrity-007. This was `update({ where: { id: s.id } })` — the
      // primary key alone. The loop is deliberately NOT one transaction ("one
      // stuck row shouldn't block sweeping the other 99"), so every row carries
      // its own window between the snapshot above and this write, and
      // AUTO_CLOSE_MS is 12.5 hours. A user who finished a long session and
      // clocked out at 18:00 got `clockOutAt = lastActivityAt` — 05:30 — plus
      // `autoClosed: true`, so the entry ended twelve hours before they stopped
      // working and the audit trail said the system did it. TimeEntry has no
      // history column, so the value they actually recorded was simply gone, and
      // their own record then contradicted them on an hours-based invoice.
      //
      // The guard belongs IN the statement: a re-read would only move the window.
      // A count of 0 means the user beat us to it, which is a normal outcome of a
      // sweep and must NOT be reported as a failure — `failed` drives the route's
      // 500 and the Sentry monitor, so counting it would turn correct behaviour
      // into a nightly incident.
      const { count } = await db.timeEntry.updateMany({
        where: { id: s.id, clockOutAt: null, deletedAt: null },
        data: { clockOutAt: s.lastActivityAt, autoClosed: true },
      });
      if (count === 0) continue;
      closed.push(s.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown sweep error";
      failed.push({ id: s.id, error: msg });
      captureServerError(e, {
        action: "sweepAutoCloseEntries:entry",
        extra: { entryId: s.id, userId: s.userId, companyId: s.companyId },
      });
    }
  }
  return { attempted: stale.length, closed, failed };
}
