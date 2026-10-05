/**
 * POST /api/cron/announce-broadcast — the one-shot push broadcast for the
 * product announcement in lib/announce/announcement.ts. Channel 2 of two; the
 * dashboard banner (app/(app)/dashboard/announcement-banner.tsx) is channel 1
 * and is the one that reaches everybody.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE OWNER'S COMMANDS. Dry run first; it sends nothing and is repeatable.
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   # 1. DRY RUN — counts the recipients, sends nothing.
 *   curl -sS -X POST \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://<your-production-domain>/api/cron/announce-broadcast"
 *
 *   # 2. FOR REAL — only after setting ANNOUNCE_BROADCAST_ENABLED="true" in the
 *   #    Vercel Production environment AND redeploying, because a Vercel env var
 *   #    does not reach a deployment that is already running.
 *   curl -sS -X POST \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     "https://<your-production-domain>/api/cron/announce-broadcast?live=1"
 *
 *   # 3. Afterwards: remove ANNOUNCE_BROADCAST_ENABLED again. The latch below
 *   #    is per-instance, so leaving it armed means the next person who curls
 *   #    this URL with ?live=1 sends the announcement a second time.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT LOOKS LIKE A CRON ROUTE BUT IS NOT ONE
 * ────────────────────────────────────────────────────────────────────────────
 * It lives under `app/api/cron/` because that prefix is what makes it reachable:
 * `auth.config.ts:101` allows `/api/cron/` through the middleware precisely
 * because those routes carry a `CRON_SECRET` bearer instead of a session. The
 * three sibling routes are this project's established pattern for "a privileged
 * job triggered from outside", and this is that, fired by a person instead of a
 * scheduler.
 *
 * It is deliberately NOT in `vercel.json`'s `crons` array, so Vercel never
 * invokes it — a scheduled announcement would arrive nightly, for ever. For the
 * same reason there is no `withCronCheckIn`: a Sentry cron monitor on a job with
 * no schedule would alert on a missed beat that was never promised.
 *
 * POST, not GET, and the sibling routes are GET because Vercel's scheduler only
 * issues GET. Nothing schedules this one, so it takes the verb that matches what
 * it does. A GET answers 405 and sends nothing, which keeps a browser visit, a
 * link preview and a prefetch from firing an unrecallable notification.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FOUR THINGS THIS ROUTE IS CAREFUL ABOUT
 * ────────────────────────────────────────────────────────────────────────────
 * 1. DRY RUN BY DEFAULT, on `PURGE_ENABLED`'s precedent: counting is free,
 *    sending cannot be undone. Two keys are needed to send — see
 *    lib/announce/broadcast-options.ts for why this one needs two where the
 *    purge needs one.
 *
 * 2. IDEMPOTENCY, as far as it honestly goes. `lib/announce/broadcast-latch.ts`
 *    refuses a repeat or an overlapping fire on the same warm instance and
 *    states, in that file, exactly what it does not cover (a cold start or a
 *    second instance) plus the migration that would close it. The claim is taken
 *    AFTER the recipient query and BEFORE the first send, so a database failure
 *    leaves it retryable and a send failure does not.
 *
 * 3. AN UNCONFIGURED DEPLOYMENT MUST NOT LOOK LIKE A SUCCESS.
 *    `isPushConfigured()` is false when the VAPID keys are absent, and
 *    `sendPushToUsers` then no-ops without a word. VAPID is required nowhere in
 *    `scripts/vercel-build.mjs`, so a production deploy with no keys is green,
 *    and "reached 0 devices" is indistinguishable from "nobody has a device".
 *    So this route answers 503 and refuses to run — in dry run too, because the
 *    dry run's whole job is to predict the live run — and it does not claim the
 *    latch, so the owner can set the keys and fire for real.
 *
 * 4. IT REPORTS WHAT HAPPENED, NOT THAT IT FINISHED. Users targeted, users with
 *    a live device, devices, sends attempted / succeeded / failed, rows pruned,
 *    and a one-line `verdict` in plain English, because the number that matters
 *    is easy to miss in a JSON body.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SCOPE: REAL, LIVE USERS ONLY
 * ────────────────────────────────────────────────────────────────────────────
 * Three exclusions, each for its own reason:
 *
 *   • `deletedAt: null` — a deactivated teammate. This is data-integrity-004's
 *     exact shape: nothing prunes `PushSubscription` when someone is removed and
 *     the purge has no individual-user stage, so their device rows live for ever
 *     in a live workspace. `sendPushToUsers` filters them at the delivery
 *     boundary as well; that filter is the second of two, not the only one,
 *     because a recipient list built upstream has forgotten it before.
 *   • `LIVE_WORKSPACE_SCOPE` — a workspace inside its 90-day recovery window.
 *     Its User rows are tombstoned too (`softDeleteWorkspace`), so the line
 *     above already covers it; this is the rule stated rather than re-derived,
 *     which is what lib/cron/live-scope.ts exists for.
 *   • `demo-nimbus` — the SEEDED demo workspace, excluded. Those are not real
 *     users: `prisma/seed.ts` recreates them on every reseed, nobody at those
 *     addresses asked for a notification, and "every real user" was the
 *     instruction. Named in the response body rather than left implied, so a
 *     reader of the dry run can see the decision instead of inferring it from a
 *     count.
 *
 * Deliberately NOT excluded: someone whose `NotificationPreference` rows turn
 * push off. That matrix is per-EVENT (lib/notify/fan-out.ts owns the event
 * union) and a one-time product announcement is not one of its events, so there
 * is no row to honour — inventing an event would mean routing this through the
 * fan-out, which writes a Notification row per recipient. Holding a live
 * `PushSubscription` is the consent signal being relied on here: it means the
 * person granted browser permission and subscribed a device. That is a real
 * limitation and it is stated rather than hidden.
 *
 * Tested in tests/lib/announce/broadcast-route.test.ts: the 401, the dry-run
 * default, the unconfigured-VAPID refusal, the double fire, the scope rules and
 * the delivered/failed split.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";
import { warnBulkMutation } from "@/lib/safety/bulk-mutation-guard";
import { safeEqual } from "@/lib/safe-compare";
import { LIVE_WORKSPACE_SCOPE } from "@/lib/cron/live-scope";
import { sendPushToUsers, type PushSendReport } from "@/lib/push/send";
import { isPushConfigured } from "@/lib/push/config";
import { ANNOUNCEMENT, ANNOUNCEMENT_PUSH_TAG } from "@/lib/announce/announcement";
import {
  ARMING_ENV_VAR,
  decideBroadcastOptions,
  type BroadcastRunOptions,
} from "@/lib/announce/broadcast-options";
import {
  broadcastLatchState,
  claimBroadcast,
  instanceUptimeMs,
  settleBroadcast,
} from "@/lib/announce/broadcast-latch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Workspaces that are not customers. One entry, and it is the seed.
 *
 * A constant rather than an inline literal so the response can name it: the dry
 * run has to be able to say what it chose to leave out, or its count is a number
 * with an unstated denominator.
 */
const EXCLUDED_COMPANY_IDS = ["demo-nimbus"];

/**
 * How many recipient ids to hand `sendPushToUsers` at once.
 *
 * It loads one `PushSubscription` page per call and fires every device in it
 * through `Promise.all`, so an unbatched call on a large tenant would open every
 * connection at once inside a 60s function. 500 ids is a few hundred HTTP
 * requests per batch, which the push services absorb, and it keeps the memory
 * footprint of the subscription page bounded.
 */
const RECIPIENT_BATCH = 500;

interface Counts {
  usersTargeted: number;
  usersWithLiveSubscription: number;
  deviceSubscriptions: number;
  sendsAttempted: number;
  sendsSucceeded: number;
  sendsFailed: number;
  subscriptionsPruned: number;
}

function zeroCounts(): Counts {
  return {
    usersTargeted: 0,
    usersWithLiveSubscription: 0,
    deviceSubscriptions: 0,
    sendsAttempted: 0,
    sendsSucceeded: 0,
    sendsFailed: 0,
    subscriptionsPruned: 0,
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  /* ── auth, exactly as the three sibling cron routes do it ─────────────── */

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed, but LOUDLY (prodready-003): `scripts/vercel-build.mjs` fails
    // a production build without CRON_SECRET, and this is the belt to that
    // brace, for the var being removed after a green build.
    captureServerError(new Error("CRON_SECRET is not configured — announce-broadcast cannot run"), {
      action: "announceBroadcast.config",
    });
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth || !safeEqual(auth, `Bearer ${expected}`)) {
    // Nothing is read and nothing is sent before this point. The message says
    // no more than the sibling routes', so it cannot be used to probe whether a
    // secret is configured.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /* ── what kind of run is this ─────────────────────────────────────────── */

  const options = decideBroadcastOptions(new URL(request.url).searchParams, process.env);

  /* ── can this deployment send at all ──────────────────────────────────── */

  if (!isPushConfigured()) {
    // 503, not a 200 with zeroes, and the latch is untouched. See point 3 in the
    // header: silence here is the single most likely way this announcement ends
    // up believed-sent and un-sent.
    return NextResponse.json(
      {
        ok: false,
        announcementId: ANNOUNCEMENT.id,
        mode: options.dryRun ? "dry-run" : "live",
        armed: options.armed,
        pushConfigured: false,
        state: broadcastLatchState().state,
        verdict:
          "REFUSED — web push is not configured in this environment. VAPID_PUBLIC_KEY and/or " +
          "VAPID_PRIVATE_KEY are missing, so isPushConfigured() is false and every send would " +
          "no-op in silence. NOTHING WAS SENT, and nothing is marked as fired: set both keys " +
          "(npx web-push generate-vapid-keys), set NEXT_PUBLIC_VAPID_PUBLIC_KEY to the same " +
          "public value, redeploy, and run the dry run again. The dashboard banner does not " +
          "depend on any of this and is already live.",
        counts: zeroCounts(),
        scope: scopeDescription(),
        refused: options.refused,
        ignoredEnabledValue: options.ignoredEnabledValue,
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
      { status: 503 }
    );
  }

  /* ── who would this reach ─────────────────────────────────────────────── */

  let recipientIds: string[];
  let subscriptionUserIds: string[];
  let deviceCount: number;
  try {
    const recipients = await db.user.findMany({
      where: {
        // data-integrity-004: the deactivated teammate, excluded here as well as
        // at the delivery boundary. See the header.
        deletedAt: null,
        // The shared rule, imported rather than re-typed (cron-010).
        ...LIVE_WORKSPACE_SCOPE,
        companyId: { notIn: EXCLUDED_COMPANY_IDS },
      },
      select: { id: true },
    });
    recipientIds = recipients.map((u) => u.id);

    // Counted separately from the send so the DRY RUN can report it. This reads
    // the same rows `sendPushToUsers` will load, with the same tombstone filter,
    // so the prediction and the run cannot disagree.
    const subs =
      recipientIds.length === 0
        ? []
        : await db.pushSubscription.findMany({
            where: { userId: { in: recipientIds }, user: { deletedAt: null } },
            select: { userId: true },
          });
    deviceCount = subs.length;
    subscriptionUserIds = Array.from(new Set(subs.map((s) => s.userId)));
  } catch (e) {
    captureServerError(e, { action: "announceBroadcast.recipients" });
    return NextResponse.json(
      {
        ok: false,
        announcementId: ANNOUNCEMENT.id,
        mode: options.dryRun ? "dry-run" : "live",
        state: broadcastLatchState().state,
        verdict:
          "FAILED while building the recipient list. NOTHING WAS SENT and nothing is marked " +
          "as fired, so this is safe to run again.",
        counts: zeroCounts(),
        durationMs: Date.now() - startedAt,
      },
      { status: 500 }
    );
  }

  const counts = zeroCounts();
  counts.usersTargeted = recipientIds.length;
  counts.usersWithLiveSubscription = subscriptionUserIds.length;
  counts.deviceSubscriptions = deviceCount;

  /* ── a dry run stops here, and is repeatable ──────────────────────────── */

  if (options.dryRun) {
    return NextResponse.json(
      {
        ok: true,
        announcementId: ANNOUNCEMENT.id,
        mode: "dry-run",
        armed: options.armed,
        pushConfigured: true,
        state: broadcastLatchState().state,
        verdict: dryRunVerdict(counts, options),
        payload: pushPayload(),
        counts,
        scope: scopeDescription(),
        refused: options.refused,
        ignoredEnabledValue: options.ignoredEnabledValue,
        instance: instanceDescription(),
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
      { status: 200 }
    );
  }

  /* ── the live send ────────────────────────────────────────────────────── */

  // Claimed here: after the reads that could fail harmlessly, before the first
  // byte leaves. See lib/announce/broadcast-latch.ts.
  const claim = claimBroadcast();
  if (!claim.claimed) {
    return NextResponse.json(
      {
        ok: true,
        announcementId: ANNOUNCEMENT.id,
        mode: "live",
        armed: options.armed,
        pushConfigured: true,
        state: claim.state === "in-flight" ? "in-flight" : "already-fired",
        verdict:
          claim.state === "in-flight"
            ? "REFUSED — a live broadcast is already in flight on this instance. Nothing was " +
              "sent by this request."
            : "REFUSED — this instance has already fired the broadcast. Nothing was sent by " +
              "this request. See `firstRun` for what the first one did.",
        firstRun: claim.record,
        counts: zeroCounts(),
        scope: scopeDescription(),
        refused: options.refused,
        instance: instanceDescription(),
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      },
      { status: 409 }
    );
  }

  let report: PushSendReport = {
    configured: true,
    subscriptions: 0,
    users: 0,
    succeeded: 0,
    failed: 0,
    pruned: 0,
  };
  try {
    for (let i = 0; i < recipientIds.length; i += RECIPIENT_BATCH) {
      const batch = await sendPushToUsers(
        recipientIds.slice(i, i + RECIPIENT_BATCH),
        pushPayload()
      );
      report = {
        configured: report.configured && batch.configured,
        subscriptions: report.subscriptions + batch.subscriptions,
        users: report.users + batch.users,
        succeeded: report.succeeded + batch.succeeded,
        failed: report.failed + batch.failed,
        pruned: report.pruned + batch.pruned,
      };
    }
  } finally {
    // `finally`, so a throw from the loop still settles the latch. The latch is
    // NOT released on failure, and that is the deliberate choice: by this point
    // devices may already have been delivered, so a retry means a second copy
    // for some people. lib/announce/broadcast-latch.ts argues it in full.
    settleBroadcast({
      outcome: report.failed === 0 && report.succeeded > 0 ? "delivered" : "failed",
      sendsSucceeded: report.succeeded,
      sendsFailed: report.failed,
    });
  }

  counts.sendsAttempted = report.succeeded + report.failed;
  counts.sendsSucceeded = report.succeeded;
  counts.sendsFailed = report.failed;
  counts.subscriptionsPruned = report.pruned;

  // The canary (lib/safety/bulk-mutation-guard.ts). Its rule is "every mutation
  // whose row count is bounded by customer data rather than by a constant
  // reports itself here", and this qualifies twice: the fan-out is bounded by
  // the number of paying customers, and `sendPushToUsers` DELETES a
  // PushSubscription row per dead device as it goes.
  //
  // The default 100-row threshold is kept, so this is silent for a small
  // broadcast and fires on a large one — which is the right way round for a
  // signal wired to an on-call alert rule (`boundary: bulk-mutation`), and the
  // reason this is NOT presented as the durable "it already fired" record. There
  // is no such record without the table in lib/announce/broadcast-latch.ts; the
  // response body below is the only account of this run.
  warnBulkMutation(counts.sendsAttempted, {
    action: "announceBroadcast",
    extra: {
      announcementId: ANNOUNCEMENT.id,
      usersTargeted: counts.usersTargeted,
      succeeded: counts.sendsSucceeded,
      failed: counts.sendsFailed,
      pruned: counts.subscriptionsPruned,
    },
  });

  const clean = counts.sendsFailed === 0;
  return NextResponse.json(
    {
      ok: clean,
      announcementId: ANNOUNCEMENT.id,
      mode: "live",
      armed: options.armed,
      pushConfigured: true,
      state: "fired",
      verdict: liveVerdict(counts),
      payload: pushPayload(),
      counts,
      scope: scopeDescription(),
      refused: options.refused,
      ignoredEnabledValue: options.ignoredEnabledValue,
      instance: instanceDescription(),
      ranAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    },
    // A partially failed broadcast is not a clean run, and it is also not
    // retryable (see the latch), so the status says "look at this" without
    // pretending the whole thing failed.
    { status: clean ? 200 : 207 }
  );
}

/**
 * A GET must not fire this, and must not look broken either.
 *
 * Without it, Next.js answers 405 with an empty body and the owner who typed
 * the URL into a browser learns nothing. The repeated `curl` line is the point.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: "Method Not Allowed",
      hint:
        "This endpoint sends a notification that cannot be recalled, so it refuses GET — a " +
        "browser visit, a link preview or a prefetch must not be able to fire it. Use: " +
        'curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" ' +
        '"https://<domain>/api/cron/announce-broadcast" (add ?live=1 to send for real).',
    },
    { status: 405, headers: { allow: "POST" } }
  );
}

function pushPayload() {
  return {
    title: ANNOUNCEMENT.title,
    body: ANNOUNCEMENT.body,
    url: ANNOUNCEMENT.url,
    // Collapses repeat deliveries into one notification at the OS level. Not an
    // idempotency guarantee and not counted as one — see the latch module.
    tag: ANNOUNCEMENT_PUSH_TAG,
  };
}

function scopeDescription() {
  return {
    excludedCompanyIds: EXCLUDED_COMPANY_IDS,
    liveWorkspacesOnly: true,
    tombstonedUsersExcluded: true,
    note:
      "Holding a live PushSubscription is the consent signal. The per-event " +
      "NotificationPreference matrix has no event for a one-time product announcement, so no " +
      "row is honoured here.",
  };
}

function instanceDescription() {
  return {
    uptimeMs: instanceUptimeMs(),
    note:
      "The one-shot latch is per serverless instance. A repeat served by a cold start or a " +
      "second instance would send again — see lib/announce/broadcast-latch.ts for the " +
      "migration that would make the guarantee durable.",
  };
}

function dryRunVerdict(counts: Counts, options: BroadcastRunOptions): string {
  const head =
    `DRY RUN — nothing was sent. A live run would reach ${counts.deviceSubscriptions} ` +
    `device(s) belonging to ${counts.usersWithLiveSubscription} of ${counts.usersTargeted} ` +
    `targeted user(s).`;

  const reach =
    counts.deviceSubscriptions === 0
      ? " 0 devices: no targeted user holds a push subscription, so a live run would deliver " +
        "NOTHING. Nothing in this product has ever asked anyone to enable notifications, so " +
        "this is the expected state — the dashboard banner is the channel that reaches people."
      : "";

  const arming = options.armed
    ? ` ${ARMING_ENV_VAR} is set to "true", so this deployment is ARMED: add ?live=1 to send.`
    : ` ${ARMING_ENV_VAR} is not set to "true", so no request to this deployment can send.`;

  return head + reach + arming;
}

function liveVerdict(counts: Counts): string {
  const base =
    `LIVE — sent to ${counts.sendsSucceeded} of ${counts.sendsAttempted} device(s) across ` +
    `${counts.usersWithLiveSubscription} of ${counts.usersTargeted} targeted user(s).`;
  const failed =
    counts.sendsFailed > 0
      ? ` ${counts.sendsFailed} failed (${counts.subscriptionsPruned} of those were dead ` +
        `subscriptions and have been removed). This is NOT retried automatically and must not ` +
        `be retried by hand: the succeeded sends cannot be unsent, so a second run would ` +
        `deliver a duplicate to everyone it already reached.`
      : "";
  const none =
    counts.sendsAttempted === 0
      ? " No device was reachable, so nobody received the push. The dashboard banner is " +
        "unaffected and still reaches everyone who opens the app."
      : "";
  return base + failed + none;
}
