/**
 * LemonSqueezy webhook — the source of truth for a workspace's plan.
 *
 * Checkout + the customer portal are just hosted UI; the actual billing state
 * (upgraded, cancelled, past-due, expired) lands here as signed events. We
 * verify the HMAC-SHA256 signature against LEMONSQUEEZY_WEBHOOK_SECRET, then
 * reconcile the Company row from the subscription payload.
 *
 * FOUR INDEPENDENT QUESTIONS, and conflating any two of them was a bug. Each of
 * the last three now has a pure, unit-tested module, because a Next.js route
 * handler cannot be reached by a test without a Prisma client:
 *
 *   1. Did this come from LemonSqueezy?        the HMAC, in POST below
 *   2. Is it about something we SELL?          lib/billing/event-scope.ts
 *   3. Whose workspace is it about?            lib/billing/webhook-identity.ts
 *   4. Is it news, and which columns may it touch?
 *                                              lib/billing/subscription-write.ts
 *
 * (1) vs (3) was bill-001. The signature answers "did this come from
 * LemonSqueezy?". It does NOT answer "is this payer entitled to this workspace?",
 * because `meta.custom_data` is set by whoever opens the hosted buy link
 * (`?checkout[custom][company_id]=<anything>`) and LemonSqueezy signs it
 * faithfully. This route used to trust `custom_data` verbatim and write with
 * `where: { id: companyId }`, so a stranger could buy a plan "for" someone else's
 * workspace and take over its billing row.
 *
 * (1) vs (2) was bill-006. The handler read exactly four attributes — status,
 * customer_id, ends_at, renews_at — so a TEST-MODE subscription (no money moves)
 * granted a real paid plan, and so would a subscription for any other product in
 * the store.
 *
 * (1) vs (4) was bill-002/003/007. A valid signature never expires, so a captured
 * delivery replayed after expiry restored the paid plan for ever; a retried
 * delivery arriving out of order overwrote newer state; and every column was
 * written on every event, so an event that merely OMITTED a field erased it.
 *
 * WHAT THIS ROUTE STILL DOES NOT HAVE, and it matters: there is no ledger of
 * delivered event ids, so replay protection is INFERRED from state already on the
 * Company row rather than enforced. See the header of
 * lib/billing/subscription-write.ts for exactly what that does and does not
 * cover, and the delivery follow-ups for the DDL. Two guards here narrow the gap
 * without a table and neither closes it: `MAX_GRANT_AGE_MS` refuses a delivery
 * that is too old to be allowed to GRANT the paid plan, and
 * `enforceFreePlanDowngrade` makes a downgrade take the paid privileges away
 * (bill-013) instead of only changing a column.
 *
 * Setup: LemonSqueezy dashboard → Settings → Webhooks → add
 *   https://<domain>/api/webhooks/lemonsqueezy
 * subscribed to the subscription_* events — INCLUDING the three
 * subscription_payment_* ones, which this handler now acts on (bill-018), so a
 * store that was only subscribed to the lifecycle seven needs updating too —
 * with a signing secret you also put in LEMONSQUEEZY_WEBHOOK_SECRET.
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import {
  LS_STORE_ID,
  LS_VARIANT_ID_TEAM,
  LS_WEBHOOK_SECRET,
  isWebhookConfigured,
} from "@/lib/lemonsqueezy/config";
import { captureServerError } from "@/lib/sentry-server";
import {
  captureBillingForgery,
  reportOutOfScopeBillingEvent,
  reportSkippedBillingWrite,
  reportUnplaceableBillingEvent,
} from "@/lib/billing/billing-forgery";
import {
  decideEventScope,
  isLiveDeployment,
  variantPlanTable,
  type EventScopeVerdict,
} from "@/lib/billing/event-scope";
import {
  AMBIGUOUS_CUSTOMER,
  identityWriteGuard,
  resolveWebhookCompany,
  type CompanyBillingLookup,
} from "@/lib/billing/webhook-identity";
import { decideSubscriptionWrite, readPeriodEnd } from "@/lib/billing/subscription-write";
import { memberLimitForPlan, normalizePlan, PLAN_LABELS } from "@/lib/billing/plan";
import { billingAlertForEvent, notifyWorkspaceAdmins } from "@/lib/billing/billing-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Subscription lifecycle events whose `data` is a Subscription object.
const SUB_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]);

/**
 * Payment events, whose `data` is a Subscription INVOICE — not a Subscription.
 *
 * THE TRAP, and it is why these get their own handler instead of being added to
 * SUB_EVENTS. On an invoice-shaped payload `data.id` is an INVOICE id. Feeding it
 * to the identity resolver as a subscription id would bind the workspace to an id
 * LemonSqueezy will never send again — and a workspace whose
 * `billingSubscriptionId` points at nothing real is, to every later event, the
 * same as an UNBOUND workspace, which is the most attractive forgery target there
 * is (see lib/billing/webhook-identity.ts step 2). The subscription id on these
 * payloads is `attributes.subscription_id`.
 *
 * They also carry no `variant_id`, so they can never be used to derive a plan;
 * the scope check handles that by reporting `plan: null`.
 */
const INVOICE_EVENTS = new Set([
  "subscription_payment_failed",
  "subscription_payment_success",
  "subscription_payment_recovered",
]);

/**
 * variant id → plan, built once. See lib/billing/event-scope.ts for why this is a
 * table and not an `if`: a second paid tier should be a data change, not a change
 * to the code that decides who gets paid features.
 */
const VARIANT_PLANS = variantPlanTable(LS_VARIANT_ID_TEAM);

/**
 * `deletedAt` is SELECTED, never filtered in the query — see the contract on
 * CompanyBillingLookup. A tombstoned workspace must come back so the decision
 * can refuse it explicitly, instead of looking identical to a workspace that
 * does not exist (which is a gap a forged claim can slip into).
 */
const COMPANY_BILLING_SELECT = {
  id: true,
  billingSubscriptionId: true,
  billingCustomerId: true,
  deletedAt: true,
} as const;

/** The three reads the identity decision needs, bound to Prisma. */
const dbLookup: CompanyBillingLookup = {
  byId: (companyId) =>
    db.company.findFirst({ where: { id: companyId }, select: COMPANY_BILLING_SELECT }),
  bySubscriptionId: (subscriptionId) =>
    db.company.findFirst({
      where: { billingSubscriptionId: subscriptionId },
      select: COMPANY_BILLING_SELECT,
    }),
  // bill-012. This was `findFirst` with NO orderBy, over a column with no unique
  // constraint — so Postgres returned whichever row it liked and the choice could
  // change between queries. One person paying for two workspaces (one email, one
  // card: the ordinary serial-founder / agency case) leaves two rows with the same
  // billingCustomerId, and a cancellation for workspace B could then downgrade
  // workspace A — non-deterministically, so it would never reproduce on demand.
  //
  // `take: 2` is all the information needed: "exactly one" or "more than one".
  // Ambiguity is REPORTED, never resolved — guessing right is luck, and the
  // decision refuses and alerts instead. The orderBy makes even the one-row case
  // stable, so two queries during one delivery cannot disagree.
  byCustomerId: async (customerId) => {
    const rows = await db.company.findMany({
      where: { billingCustomerId: customerId },
      select: COMPANY_BILLING_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
    });
    if (rows.length > 1) return AMBIGUOUS_CUSTOMER;
    return rows[0] ?? null;
  },
};

/**
 * Read a provider-assigned id off an attributes bag.
 *
 * NO blanket `String(...)`. The old code was `attrs.customer_id != null ?
 * String(attrs.customer_id) : null`, which turns an object into
 * `"[object Object]"` and an array into `"a,b"` — values that then get matched
 * against the database as if they were ids. Same rule as `readClaimedCompanyId`
 * in lib/billing/webhook-identity.ts: a finite number is the only coercion worth
 * doing, because LemonSqueezy sends ids as JSON numbers.
 */
function attrId(attrs: Record<string, unknown>, key: string): string | null {
  const value = attrs[key];
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Read a boolean flag, distinguishing "absent" (null) from "false". */
function attrFlag(attrs: Record<string, unknown>, key: string): boolean | null {
  const value = attrs[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * bill-002, the half that needs no new table: HOW OLD MAY A DELIVERY BE AND STILL
 * GRANT THE PAID PLAN?
 *
 * There is still no ledger of delivered event ids (see the file header), and a
 * LemonSqueezy HMAC signature never expires — so a body captured once was, in
 * principle, a re-usable licence for ever. `decideSubscriptionWrite` already
 * refuses a paid status for a subscription recorded as dead, and downgrades one
 * whose own paid-through date has passed; what neither rule can see is a replay of
 * a delivery whose dates are still current (an `active` re-POSTed after a
 * cancellation, which un-cancels the workspace and restores the old renews_at).
 *
 * Seven days. LemonSqueezy's own retry budget is hours, not days, so this refuses
 * nothing a healthy integration produces; it converts "for ever" into a window.
 *
 * DIRECTIONAL, and that is the point: the age check applies ONLY to an event that
 * would GRANT the paid plan. A replay is worth capturing in one direction only, and
 * refusing a stale DOWNGRADE would leave a workspace paid for free — the failure
 * that costs money. A payload with no usable timestamp is not refused either: the
 * other guards still apply, and inventing an age would turn a missing field into a
 * revenue incident.
 */
const MAX_GRANT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Age of this delivery per the subscription's own `updated_at`, or null when the
 * payload carries no parseable timestamp.
 */
function deliveryAgeMs(attrs: Record<string, unknown>, now: Date): number | null {
  const raw = attrs.updated_at ?? attrs.created_at;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  return now.getTime() - at.getTime();
}

/**
 * bill-006. Is this event about our store, our product, and real money?
 *
 * Runs BEFORE identity resolution, deliberately: an event for someone else's
 * store is not a workspace-identity question, and letting it reach
 * `resolveWebhookCompany` would turn ordinary foreign traffic into
 * `boundary: billing-forgery` pages for on-call.
 */
function scopeEvent(
  eventName: string,
  attrs: Record<string, unknown>,
  ids: { subscriptionId: string | null; customerId: string | null }
): EventScopeVerdict {
  const verdict = decideEventScope({
    testMode: attrFlag(attrs, "test_mode"),
    storeId: attrId(attrs, "store_id"),
    variantId: attrId(attrs, "variant_id"),
    expectedStoreId: LS_STORE_ID,
    variantPlans: VARIANT_PLANS,
    liveDeployment: isLiveDeployment(),
  });

  if (!verdict.ok) {
    reportOutOfScopeBillingEvent({
      eventName,
      reason: verdict.reason,
      subscriptionId: ids.subscriptionId,
      customerId: ids.customerId,
      extra: {
        storeId: attrId(attrs, "store_id"),
        variantId: attrId(attrs, "variant_id"),
        testMode: attrFlag(attrs, "test_mode"),
      },
    });
  } else if (!verdict.enforced && isLiveDeployment()) {
    // A check that silently does nothing is worse than no check, because it reads
    // as covered. This is a live deployment taking real money with
    // LEMONSQUEEZY_STORE_ID or LEMONSQUEEZY_VARIANT_ID_TEAM unset, so the
    // wrong-store and wrong-product gates are off. Error level: a configuration
    // fault, not traffic noise.
    captureServerError(new Error("Billing scope checks are unconfigured on a live deployment"), {
      action: "lemonSqueezyWebhook.scopeUnenforced",
      extra: { eventName, hasStoreId: Boolean(LS_STORE_ID), variantCount: VARIANT_PLANS.size },
    });
  }

  return verdict;
}

/**
 * bill-013. WHAT A DOWNGRADE TAKES AWAY.
 *
 * Before this, a downgrade took nothing: `plan` gated exactly one thing in the
 * whole codebase (`inviteUserAction`), so one paid month bought seats for ever —
 * subscribe, invite twenty people, cancel, and nothing revoked, suspended, or even
 * reported the overage while the billing screen went on saying "Up to 2 members".
 *
 * TWO OF THE THREE HALVES ARE HERE. (1) Still-pending invites issued while the
 * workspace was paid are burnt: a token is a credential, and one handed out under
 * Team must not be redeemable on Solo. A free workspace may of course invite again,
 * inside its cap, and `inviteUserAction` enforces that at issue time.
 * (2) `acceptInviteAction` (lib/actions/team.ts) now asks the cap at ACCEPTANCE,
 * which closes the same hole for a token minted before this shipped.
 *
 * THE THIRD HALF IS NOT HERE, and cannot be: suspending the surplus MEMBERS needs
 * a column to suspend them with (a `seatSuspended` flag on User that `auth()` and
 * `requireScopedSession()` honour), and adding a column is outside this change.
 * Deleting or tombstoning teammates to fit a plan change is not an acceptable
 * substitute — it destroys customer data over a billing event. So the overage is
 * REPORTED, at error level with the count, which is the difference between an
 * operator who can see the state and one reading a screen that claims the limit is
 * being honoured.
 */
async function enforceFreePlanDowngrade(companyId: string, eventName: string): Promise<void> {
  try {
    const burnt = await db.inviteToken.deleteMany({ where: { companyId, usedAt: null } });
    const activeMembers = await db.user.count({ where: { companyId, deletedAt: null } });
    const limit = memberLimitForPlan("free");
    if (activeMembers > limit) {
      captureServerError(
        new Error(
          `Workspace is over the ${PLAN_LABELS.free} member limit after a downgrade: ` +
            `${activeMembers} active members, limit ${limit}`
        ),
        {
          action: "lemonSqueezyWebhook.seatOverage",
          companyId,
          extra: { eventName, activeMembers, limit, invitesRevoked: burnt.count },
        }
      );
    }
  } catch (e) {
    // A downgrade that has already been written must not be turned into a 500 (and
    // therefore a retry of the whole delivery) by its own follow-up work.
    captureServerError(e, {
      action: "lemonSqueezyWebhook.enforceFreePlanDowngrade",
      companyId,
      extra: { eventName },
    });
  }
}

/**
 * A subscription lifecycle event — the only path that may change `plan`.
 *
 * `customData` is BUYER-SUPPLIED and stays untrusted all the way down; it is the
 * resolver's job to decide whether it has earned anything. Note that
 * `handlePaymentEvent` takes no parameter for it at all, on purpose: a payment
 * event must never be able to create a binding.
 */
async function handleSubscriptionEvent(
  eventName: string,
  sub: { id?: string | number; attributes?: Record<string, unknown> },
  customData: unknown
): Promise<NextResponse> {
  const attrs = sub.attributes ?? {};
  const status = String(attrs.status ?? "");
  // Both provider-assigned: the buyer cannot choose either.
  const subscriptionId = sub.id != null ? String(sub.id) : null;
  const customerId = attrId(attrs, "customer_id");

  const scope = scopeEvent(eventName, attrs, { subscriptionId, customerId });
  if (!scope.ok) {
    // 200: retrying will never make a test-mode event, or another store's
    // product, become something we sell.
    return NextResponse.json({ received: true, ignored: scope.reason });
  }

  const identity = await resolveWebhookCompany(
    { subscriptionId, customerId, customData },
    dbLookup
  );

  if (!identity.ok) {
    if (identity.forged) {
      // 400, not 200: a forged event must never be recorded as delivered
      // successfully in the LemonSqueezy dashboard — the failed delivery is
      // part of the audit trail.
      captureBillingForgery({
        eventName,
        reason: identity.reason,
        claimedCompanyId: identity.claimedCompanyId,
        subscriptionId,
        customerId,
      });
      return NextResponse.json(
        { error: "Event does not belong to that workspace" },
        { status: 400 }
      );
    }

    // bill-008. This branch used to be an implicit `else {}` followed by a
    // cheerful `{ received: true }` — money in, nothing delivered, and not one
    // log line for support to look at. Every unplaceable delivery is reported now.
    reportUnplaceableBillingEvent({
      eventName,
      reason: identity.reason,
      subscriptionId,
      customerId,
      extra: { claimedCompanyId: identity.claimedCompanyId, scopeEnforced: scope.enforced },
    });

    // 500 (so LemonSqueezy retries while the operator fixes the cause) ONLY when
    // we actually policed the store and variant. Without that, an unconfigured
    // deployment would answer 500 to every foreign event it cannot place and sit
    // in a permanent retry loop over traffic that was never ours. The other
    // reasons are not retryable by anybody: a tombstoned workspace stays
    // tombstoned, and no number of retries can disambiguate a shared customer id.
    if (identity.reason === "unresolvable" && scope.enforced) {
      return NextResponse.json({ error: "Could not place this subscription" }, { status: 500 });
    }
    return NextResponse.json({ received: true, ignored: identity.reason });
  }

  // resolveWebhookCompany never returns ok without a subscription id (its
  // first rule), but that guarantee can't cross the type boundary — re-check
  // rather than reach for a non-null assertion.
  if (!subscriptionId) {
    return NextResponse.json({ received: true, ignored: "unresolvable" });
  }

  // The staleness decision needs what we already hold. A primary-key read on a
  // webhook is free, and keeping it separate from the identity lookup keeps that
  // module's row type down to the fields its rules are allowed to see.
  const stored = await db.company.findFirst({
    where: { id: identity.companyId, deletedAt: null },
    select: {
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      billingSubscriptionId: true,
    },
  });
  if (!stored) {
    // Resolved a moment ago and gone now: deleted or tombstoned between the two
    // reads. Not retryable, but not silent either.
    reportUnplaceableBillingEvent({
      eventName,
      reason: "company-vanished",
      subscriptionId,
      customerId,
      companyId: identity.companyId,
    });
    return NextResponse.json({ received: true, ignored: "company-vanished" });
  }

  const period = readPeriodEnd(attrs);
  const decision = decideSubscriptionWrite(stored, {
    subscriptionId,
    status,
    customerId,
    periodEnd: period.periodEnd,
    periodEndAbsent: period.absent,
    variantPlan: scope.plan,
  });

  if (!decision.apply) {
    // bill-002 / bill-003. Until the delivered-event ledger exists, this
    // breadcrumb IS the audit trail for a refused delivery. 200, because the
    // refusal is final — a retry would be refused for the same reason.
    reportSkippedBillingWrite({
      eventName,
      reason: decision.reason,
      subscriptionId,
      customerId,
      companyId: identity.companyId,
      extra: {
        storedSubscriptionId: stored.billingSubscriptionId,
        storedStatus: stored.subscriptionStatus,
        storedPeriodEnd: stored.currentPeriodEnd,
        incomingStatus: status,
        incomingPeriodEnd: period.periodEnd,
      },
    });
    return NextResponse.json({ received: true, skipped: decision.reason });
  }

  // bill-002. A GRANT — and only a grant — has to be recent. See MAX_GRANT_AGE_MS.
  const ageMs = deliveryAgeMs(attrs, new Date());
  if (decision.data.plan === "team" && ageMs !== null && ageMs > MAX_GRANT_AGE_MS) {
    reportSkippedBillingWrite({
      eventName,
      reason: "stale-grant",
      subscriptionId,
      customerId,
      companyId: identity.companyId,
      extra: {
        ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)),
        updatedAt: attrs.updated_at,
        incomingStatus: status,
        storedStatus: stored.subscriptionStatus,
      },
    });
    // 200: a retry of a delivery this old would be refused for the same reason,
    // and answering 400 would mark a possibly-legitimate delivery as failed in the
    // LemonSqueezy dashboard without telling the operator anything new.
    return NextResponse.json({ received: true, skipped: "stale-grant" });
  }

  const result = await db.company.updateMany({
    where: {
      id: identity.companyId,
      // Never write billing state onto a tombstoned workspace: it is inside
      // its Tier 3 recovery window and ops treat it as gone. Belt and
      // braces with the same check inside the decision.
      deletedAt: null,
      // Compare-and-set: re-assert the binding the decision was made on, so
      // a concurrent (or retried) event that rebinds the row between our
      // read and this write matches zero rows instead of stealing it.
      ...identityWriteGuard(identity.via, subscriptionId, customerId),
    },
    // Built by decideSubscriptionWrite, and deliberately PARTIAL: a key that is
    // absent leaves the column alone. bill-007 was this object being assembled
    // inline with every key always present, so an event that merely omitted
    // `renews_at` nulled the customer's paid-through date.
    data: decision.data,
  });

  if (result.count === 0) {
    // The row moved between the read and the write — lost race, or someone
    // rebinding concurrently. Nothing to retry (a retry would re-resolve
    // from the new state anyway), but it should be visible.
    captureServerError(
      new Error(`Billing write matched no rows: ${eventName} via ${identity.via}`),
      {
        action: "lemonSqueezyWebhook.writeMiss",
        companyId: identity.companyId,
        extra: { eventName, subscriptionId, customerId, via: identity.via },
      }
    );
    return NextResponse.json({ received: true, ignored: "write-miss" });
  }

  if (decision.lapsed) {
    // Applied, but the paid status was NOT honoured: the period this event claims
    // to be paid through has already passed. Same breadcrumb as a refused write,
    // because it is the same signal — we were handed a statement about a period
    // that is over, which is what a replayed delivery looks like from here.
    reportSkippedBillingWrite({
      eventName,
      reason: "paid-status-past-its-period",
      subscriptionId,
      customerId,
      companyId: identity.companyId,
      extra: { incomingStatus: status, incomingPeriodEnd: period.periodEnd },
    });
  }

  // bill-013. The plan just went from paid to free: take the paid privileges away.
  if (decision.data.plan === "free" && normalizePlan(stored.plan) === "team") {
    await enforceFreePlanDowngrade(identity.companyId, eventName);
  }

  // bill-018. A cancellation or an expiry is the customer hearing it from us,
  // rather than discovering it when their invites stop working.
  const alert = billingAlertForEvent(eventName);
  if (alert) {
    await notifyWorkspaceAdmins({
      companyId: identity.companyId,
      kind: alert,
      // The date we just wrote; falling back to the one we already held, for the
      // case where the payload carried no period keys at all (bill-007).
      accessEndsAt:
        decision.data.currentPeriodEnd !== undefined
          ? decision.data.currentPeriodEnd
          : stored.currentPeriodEnd,
    });
  }

  return NextResponse.json({ received: true });
}

/**
 * bill-018. A payment event: the card was declined, or it recovered.
 *
 * These may NOT change `plan` or any id, and both reasons are load-bearing. An
 * invoice's `status` is the INVOICE's, not the subscription's (LemonSqueezy sends
 * a `subscription_updated` carrying the real status alongside), and `data.id` here
 * is an invoice id — see the comment on INVOICE_EVENTS. So this path resolves
 * STRICTLY against a subscription binding we already recorded, and the only column
 * it touches is `subscriptionStatus`, as a narrow compare-and-set.
 */
async function handlePaymentEvent(
  eventName: string,
  attrs: Record<string, unknown>
): Promise<NextResponse> {
  const subscriptionId = attrId(attrs, "subscription_id");
  const customerId = attrId(attrs, "customer_id");

  const scope = scopeEvent(eventName, attrs, { subscriptionId, customerId });
  if (!scope.ok) {
    return NextResponse.json({ received: true, ignored: scope.reason });
  }

  if (!subscriptionId) {
    reportUnplaceableBillingEvent({
      eventName,
      reason: "invoice-without-subscription",
      subscriptionId: null,
      customerId,
    });
    return NextResponse.json({ received: true, ignored: "invoice-without-subscription" });
  }

  // No claim path and no customer-id fallback: a payment event may only report on
  // a binding we already hold, never create one.
  const company = await db.company.findFirst({
    where: { billingSubscriptionId: subscriptionId, deletedAt: null },
    select: { id: true, subscriptionStatus: true, currentPeriodEnd: true },
  });
  if (!company) {
    reportUnplaceableBillingEvent({
      eventName,
      reason: "unknown-subscription",
      subscriptionId,
      customerId,
    });
    return NextResponse.json({ received: true, ignored: "unknown-subscription" });
  }

  if (eventName === "subscription_payment_failed") {
    // Only from a healthy status, and only the status column. Overwriting
    // `cancelled` or `expired` with `past_due` would resurrect a workspace that is
    // on its way out. `plan` deliberately stays paid: the dunning window in
    // ACCESS_GRACE_DAYS is what gives the customer time to fix the card, and the
    // notification below is what tells them to.
    await db.company.updateMany({
      where: {
        id: company.id,
        deletedAt: null,
        billingSubscriptionId: subscriptionId,
        subscriptionStatus: { in: ["active", "on_trial"] },
      },
      data: { subscriptionStatus: "past_due" },
    });
  } else if (eventName === "subscription_payment_recovered") {
    await db.company.updateMany({
      where: {
        id: company.id,
        deletedAt: null,
        billingSubscriptionId: subscriptionId,
        subscriptionStatus: "past_due",
      },
      data: { subscriptionStatus: "active" },
    });
  }

  const alert = billingAlertForEvent(eventName);
  if (alert) {
    await notifyWorkspaceAdmins({
      companyId: company.id,
      kind: alert,
      accessEndsAt: company.currentPeriodEnd,
    });
  }

  return NextResponse.json({ received: true });
}

export async function POST(request: Request) {
  if (!isWebhookConfigured()) {
    return NextResponse.json({ error: "Billing not configured" }, { status: 503 });
  }

  // Read the body as BYTES and HMAC those bytes. Never re-serialize the parsed
  // JSON — key order and whitespace would change and every signature would
  // fail. Hashing the Buffer rather than a decoded string also keeps the digest
  // over exactly what was sent, with no UTF-8 decode/re-encode round trip in
  // between (a lone surrogate or invalid byte would otherwise become U+FFFD
  // before hashing, and a valid event could fail verification).
  const rawBody = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get("x-signature") ?? "";
  // HMAC-SHA256 of the raw body, hex-encoded, timing-safe compared.
  const digest = crypto.createHmac("sha256", LS_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const digBuf = Buffer.from(digest, "hex");
  // Length first (a digest length is not a secret), then constant-time. Note
  // Buffer.from(x, "hex") silently truncates at the first non-hex character, so
  // garbage collapses to a short buffer and is caught by the length check —
  // timingSafeEqual would otherwise throw on mismatched lengths.
  if (sigBuf.length !== digBuf.length || !crypto.timingSafeEqual(sigBuf, digBuf)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: {
    meta?: { event_name?: string; custom_data?: unknown };
    data?: { id?: string | number; attributes?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const eventName = event.meta?.event_name ?? "";
  const sub = event.data;

  try {
    if (SUB_EVENTS.has(eventName) && sub?.attributes) {
      return await handleSubscriptionEvent(eventName, sub, event.meta?.custom_data);
    }
    if (INVOICE_EVENTS.has(eventName) && sub?.attributes) {
      return await handlePaymentEvent(eventName, sub.attributes);
    }
  } catch (e) {
    // 500 so LemonSqueezy retries transient failures.
    captureServerError(e, { action: "lemonSqueezyWebhook", extra: { eventName } });
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  // Everything else — order_created, order_refunded, license_key_*, and whatever
  // a future store version invents. A quiet 200 is correct here and is NOT the
  // bill-008 silence: plans are modelled off subscriptions only, so an order event
  // must not be able to set one (that is the negative result the audit checked).
  // Reporting every one of them would bury the reports that matter.
  return NextResponse.json({ received: true });
}
