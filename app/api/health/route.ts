/**
 * GET /api/health — liveness, for something that is not a customer.
 *
 * WHY THIS EXISTS (prodready-018). Until this route landed, every endpoint under
 * `app/api` required a session, a `CRON_SECRET` bearer or a provider HMAC
 * signature, so there was no URL an uptime monitor, a status page or a platform
 * health check could poll. The failures this app is most exposed to — a
 * migration that half-applied, a Supabase pooler with no free connections, a
 * rotated password that was not updated in Vercel — all leave the app SERVING,
 * with every data-bearing page throwing. Mean time to detection was "until
 * somebody who pays us notices". `scripts/qa-production-readiness.mjs` has
 * probed this path for longer than it existed and reported it missing.
 *
 * WHAT IT ANSWERS, AND NOTHING MORE. `{ ok, db, commit, ms, checkedAt }`:
 * 200 when the round-trip succeeded, 503 when it did not. There is deliberately
 * no error detail. Prisma's connection errors quote the host and port they
 * failed to reach (P1001: "Can't reach database server at `<host>`:`<port>`"),
 * and echoing that from an unauthenticated endpoint would publish the database
 * hostname of a project whose whole defence is that nobody knows it. The commit
 * SHA is the one build detail that goes out: it is what makes "is the fix
 * deployed yet?" answerable from outside, and it reveals nothing a deploy does
 * not already expose.
 *
 * WHY NO SENTRY CAPTURE HERE. The signal this route produces is the status code,
 * consumed by whatever polls it. Capturing an event per failed probe would emit
 * one Sentry error every poll interval for the whole duration of an outage —
 * burning the quota precisely when it is needed for the errors that explain the
 * cause. The monitor alerts; this route only answers.
 *
 * WHY NO RATE LIMITER, BUT A MEMO INSTEAD. Every limiter in `lib/rate-limit.ts`
 * is keyed per IP or per user, and a monitor polling from rotating egress IPs is
 * exactly the caller a per-IP bucket would eventually refuse — a 429 that an
 * uptime check records as an outage. The real hazard is not request rate, it is
 * request rate turning into DATABASE load on the live pooler from an endpoint
 * that needs no credential. So the probe is memoised for `MEMO_TTL_MS` and
 * deduplicated while in flight: however hard this URL is hit, it costs at most
 * one `SELECT 1` per window per instance. The cost is that a result can be up to
 * that window stale, which `checkedAt` states outright, and which no sane poll
 * interval is short enough to notice.
 *
 * Pinned by tests/app/health/health-route.test.ts. Reachability is two layers —
 * the path is in `authorized()`'s public allow-list in auth.config.ts, because
 * the middleware matcher inspects it and would otherwise answer a 302 to /login,
 * which a monitor records as "up".
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The probe's own deadline. The failure mode this endpoint exists to report is
 * usually a HANG, not a throw: a pool with no free connections leaves the query
 * pending, and a probe that waits as long as the connection does is a probe the
 * monitor times out on first — which turns a precise 503 into an
 * indistinguishable "no response", indistinguishable from the network.
 */
const DB_TIMEOUT_MS = 2500;

/** How long one answer is reused for. See "WHY NO RATE LIMITER" above. */
const MEMO_TTL_MS = 5000;

type Probe = { ok: boolean; ms: number };

/** Module scope, so one per serverless instance for its lifetime. */
let memo: (Probe & { at: number }) | null = null;
let inFlight: Promise<Probe> | null = null;

async function probeDatabase(): Promise<Probe> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("health probe timed out")), DB_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, ms: Date.now() - startedAt };
  } catch {
    // Swallowed on purpose, and not re-thrown or logged with its message: see
    // the header. The query itself may still be pending after a timeout; that
    // is harmless, it is a read and it resolves into nothing.
    return { ok: false, ms: Date.now() - startedAt };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The memoised probe: at most one round-trip per window, and never two at once. */
async function currentProbe(): Promise<Probe & { at: number }> {
  const fresh = memo !== null && Date.now() - memo.at < MEMO_TTL_MS;
  if (fresh && memo !== null) return memo;
  if (inFlight === null) {
    inFlight = probeDatabase().then((probe) => {
      memo = { ...probe, at: Date.now() };
      inFlight = null;
      return probe;
    });
  }
  await inFlight;
  // `probeDatabase` never rejects, so `memo` is always set by the time the
  // in-flight promise settles. The fallback is for the type, not for a case.
  return memo ?? { ok: false, ms: 0, at: Date.now() };
}

export async function GET() {
  const probe = await currentProbe();
  return NextResponse.json(
    {
      ok: probe.ok,
      db: probe.ok ? "up" : "down",
      // Empty string treated as unset: a Vercel var saved with no value, and
      // local dev, both hand us "" rather than undefined.
      commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      ms: probe.ms,
      checkedAt: new Date(probe.at).toISOString(),
    },
    {
      status: probe.ok ? 200 : 503,
      headers: {
        // A CDN- or browser-cached 200 is a health check that reports the last
        // time things were fine, for as long as the cache lives.
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        // Belt to robots.txt's `Disallow: /api/`, which already covers this
        // path: a header travels with the response even if the file is reached
        // some other way.
        "x-robots-tag": "noindex, nofollow",
      },
    }
  );
}
