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
 * (1) vs (4) also produced bill-009, and the ledger of delivered event ids that
 * this file spent the whole audit saying it did not have now EXISTS: every
 * delivery writes one `BillingEvent` row, and the applied ones write it inside
 * the same `$transaction` as the `Company` update. That single insert is what
 * turns the table into an idempotency key rather than a log — a replayed
 * delivery loses on the unique index and changes nothing, instead of being
 * judged by whether its own dates still look current. See `recordDelivery` and
 * `isLedgerReplay` below, and the model comment in prisma/schema.prisma.
 *
 * WHAT THE LEDGER DOES NOT COVER, stated plainly so the next reader does not
 * trust it further than it goes. It keys on `meta.webhook_id`, falling back to a
 * hash of the signed bytes, so two DIFFERENT deliveries that both legitimately
 * say the same thing are two rows and both apply (correct — they are not
 * replays). A delivery we answer 500 to writes NO row at all, because the row
 * would be an idempotency key for a delivery we have just asked LemonSqueezy to
 * send again. And the two older guards stay, because they cover what a key
 * cannot: `MAX_GRANT_AGE_MS` refuses a first delivery that is simply too old to
 * be allowed to GRANT the paid plan, and `enforceFreePlanDowngrade` makes a
 * downgrade take the paid privileges away (bill-013) instead of only changing a
 * column.
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

/**
 * Facts a lookup discovers that its return type has no way to express.
 *
 * One object per DELIVERY, never a module-level flag: the handler is re-entered
 * concurrently (LemonSqueezy delivers and retries in parallel), and a shared
 * mutable flag would let one delivery's ambiguity refuse another's write.
 */
interface LookupFlags {
  /**
   * More than one workspace holds the incoming subscription id (bill-012, the
   * half on the column the resolver PREFERS). `CompanyBillingLookup` can only
   * answer "a row or nothing", so the ambiguity is recorded here and refused by
   * the caller.
   */
  subscriptionAmbiguous: boolean;
}

/** The three reads the identity decision needs, bound to Prisma. */
function buildLookup(flags: LookupFlags): CompanyBillingLookup {
  return {
    byId: (companyId) =>
      db.company.findFirst({ where: { id: companyId }, select: COMPANY_BILLING_SELECT }),

    // bill-012, on the column the whole resolution order is built on. This was
    // also `findFirst` with no orderBy, and `billingSubscriptionId` carries no
    // unique constraint either — so "prefer the recorded binding" was only ever
    // as good as that binding being unique, and two rows holding one
    // subscription id (a Tier 3 restore, a hand-written repair) turned "which
    // paying customer does this cancellation downgrade?" into a coin flip that
    // could land differently on the retry. Same remedy as below: see both rows,
    // refuse, and say so.
    bySubscriptionId: async (subscriptionId) => {
      const rows = await db.company.findMany({
        where: { billingSubscriptionId: subscriptionId },
        select: COMPANY_BILLING_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2,
      });
      if (rows.length > 1) {
        flags.subscriptionAmbiguous = true;
        // Null, not the first row: the caller refuses the whole delivery on the
        // flag, and handing the decision a row it must not use is how a guard
        // ends up bypassed by the next edit.
        return null;
      }
      return rows[0] ?? null;
    },

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
    //
    // bill-011: the ambiguity is judged over LIVE workspaces only, and that is the
    // one place in this file where `deletedAt` belongs in the query. A tombstoned
    // workspace is not a candidate this fallback has to choose between — the
    // decision refuses it and the update re-asserts `deletedAt: null` — so
    // counting one towards the ambiguity refuses the LIVE workspace beside it and
    // buys nothing. The shape is ordinary: a founder deletes their first
    // workspace, keeps the second, and both rows carry the one customer id, so
    // their next plan change (a new subscription id, no custom_data) resolved to
    // `customer-ambiguous` and never applied.
    //
    // The second query is what keeps the CompanyBillingLookup contract: when no
    // live workspace matches, the tombstone must still come back, or a refusal
    // that should read `company-deleted` reads `unresolvable` instead and the
    // difference between "gone" and "never existed" is lost.
    byCustomerId: async (customerId) => {
      const live = await db.company.findMany({
        where: { billingCustomerId: customerId, deletedAt: null },
        select: COMPANY_BILLING_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2,
      });
      if (live.length > 1) return AMBIGUOUS_CUSTOMER;
      if (live.length === 1) return live[0];
      const tombstoned = await db.company.findMany({
        where: { billingCustomerId: customerId, deletedAt: { not: null } },
        select: COMPANY_BILLING_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1,
      });
      return tombstoned[0] ?? null;
    },
  };
}

/* ── The delivered-event ledger (bill-009, bill-002) ─────────────────────── */

/**
 * What we did about a delivery, in one token. `BillingEvent.outcome` has no
 * default on purpose — the writer has to state it.
 *
 *   applied — the Company write committed, in the same transaction as this row.
 *   refused — we would not honour it: out of scope, a forged claim, or an
 *             identity that cannot be pinned to one workspace.
 *   skipped — in scope and honest, but not news: a replay, a stale grant, a
 *             superseded subscription, a delivery we cannot place.
 */
type LedgerOutcome = "applied" | "refused" | "skipped";

/** One webhook delivery: how it is identified, and the bytes it arrived as. */
interface Delivery {
  /**
   * THE IDEMPOTENCY KEY. `meta.webhook_id` when LemonSqueezy sent one, otherwise
   * a hash of the exact bytes the signature covers. Never a freshly-minted
   * cuid/uuid/timestamp: a value that collides with nothing turns the unique
   * index into a row counter. See the comment on `BillingEvent.eventId`.
   */
  eventId: string;
  /** `meta.event_name`, verbatim — including names this route does not handle. */
  eventName: string;
  /** The raw signed body. Verbatim: a re-serialised copy verifies as a forgery. */
  payload: string;
}

function deliveryEventId(meta: unknown, rawBody: Buffer): string {
  const webhookId =
    meta && typeof meta === "object" ? (meta as Record<string, unknown>).webhook_id : undefined;
  // Same coercion rule as `attrId`: a string or a finite number, nothing else.
  // An object here would stringify to "[object Object]" and become one shared
  // idempotency key for every delivery that carried one.
  if (typeof webhookId === "string" && webhookId.length > 0) return webhookId;
  if (typeof webhookId === "number" && Number.isFinite(webhookId)) return String(webhookId);
  return `sha256:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
}

/**
 * Was that P2002 the ledger's unique index, rather than some other constraint?
 *
 * Duck-typed on `code` instead of importing Prisma's error class (the route
 * imports the client, not its error types), and narrowed on the target: reading
 * ANY unique violation as "already delivered" would silently drop a real
 * delivery the day some other unique column collides.
 */
function isLedgerReplay(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  if ((e as { code?: unknown }).code !== "P2002") return false;
  const target = (e as { meta?: { target?: unknown } }).meta?.target;
  if (typeof target === "string") return target.indexOf("eventId") !== -1;
  if (Array.isArray(target)) return target.indexOf("eventId") !== -1;
  // No target to read. The ledger insert is the only `create` inside these
  // transactions, so attributing it here is the honest reading.
  return true;
}

/** Thrown inside the write transaction so the ledger row rolls back with it. */
class BillingWriteMiss extends Error {}

interface LedgerFacts {
  outcome: LedgerOutcome;
  /** The verdict string, matching the Sentry breadcrumbs. Null for a plain apply. */
  reason: string | null;
  /** Null when the delivery resolved to no workspace — the row still gets written. */
  companyId?: string | null;
  subscriptionId: string | null;
  customerId: string | null;
}

function ledgerRow(delivery: Delivery, facts: LedgerFacts) {
  return {
    eventId: delivery.eventId,
    eventName: delivery.eventName,
    subscriptionId: facts.subscriptionId,
    customerId: facts.customerId,
    companyId: facts.companyId ?? null,
    outcome: facts.outcome,
    reason: facts.reason,
    payload: delivery.payload,
  };
}

/**
 * Record a delivery we are NOT applying.
 *
 * Never throws and never changes the HTTP answer: a refusal that has already
 * been decided must not turn into a 500 — and therefore a retry of the whole
 * delivery — because its own audit row failed to write. A P2002 here means this
 * delivery was recorded before; the first row stands, which is the point.
 *
 * Deliberately NOT called on the paths that answer 500. A row there would be an
 * idempotency key for a delivery we have just asked LemonSqueezy to send again,
 * and the retry would come back and be swallowed as a replay.
 */
async function recordDelivery(delivery: Delivery, facts: LedgerFacts): Promise<void> {
  try {
    await db.billingEvent.create({ data: ledgerRow(delivery, facts) });
  } catch (e) {
    if (isLedgerReplay(e)) return;
    captureServerError(e, {
      action: "lemonSqueezyWebhook.recordDelivery",
      extra: { eventName: delivery.eventName, outcome: facts.outcome, reason: facts.reason },
    });
  }
}

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
  delivery: Delivery,
  sub: { id?: string | number; attributes?: Record<string, unknown> },
  customData: unknown
): Promise<NextResponse> {
  const eventName = delivery.eventName;
  const attrs = sub.attributes ?? {};
  const status = String(attrs.status ?? "");
  // Both provider-assigned: the buyer cannot choose either.
  const subscriptionId = sub.id != null ? String(sub.id) : null;
  const customerId = attrId(attrs, "customer_id");
  /** The ids every ledger row on this path carries, resolved or not. */
  const ids = { subscriptionId, customerId };

  const scope = scopeEvent(eventName, attrs, ids);
  if (!scope.ok) {
    // 200: retrying will never make a test-mode event, or another store's
    // product, become something we sell.
    await recordDelivery(delivery, { outcome: "refused", reason: scope.reason, ...ids });
    return NextResponse.json({ received: true, ignored: scope.reason });
  }

  const flags: LookupFlags = { subscriptionAmbiguous: false };
  const identity = await resolveWebhookCompany(
    { subscriptionId, customerId, customData },
    buildLookup(flags)
  );

  // bill-012. Two workspaces hold this subscription id, so "prefer the recorded
  // binding" cannot say which one the event is about. Checked BEFORE the verdict
  // is read, because the resolver was handed a null for that lookup and may have
  // gone on to resolve by the claim or the customer id — and applying a
  // cancellation to the workspace that answered second is exactly the coin flip
  // this finding is about. 200: no retry can disambiguate it, only a human can.
  if (flags.subscriptionAmbiguous) {
    reportUnplaceableBillingEvent({
      eventName,
      reason: "subscription-ambiguous",
      subscriptionId,
      customerId,
      extra: { claimedCompanyId: identity.ok ? null : identity.claimedCompanyId },
    });
    await recordDelivery(delivery, {
      outcome: "refused",
      reason: "subscription-ambiguous",
      ...ids,
    });
    return NextResponse.json({ received: true, ignored: "subscription-ambiguous" });
  }

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
      // Recorded, and STILL answered 400. The ledger row is the durable half of
      // the audit trail (Sentry ages out); the 400 is the half LemonSqueezy's own
      // dashboard keeps. A re-POST of the same forgery takes this branch again
      // and answers 400 again — it never reaches the replay path, so recording it
      // cannot turn a second attempt into a cheerful 200.
      await recordDelivery(delivery, { outcome: "refused", reason: identity.reason, ...ids });
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
      // NO ledger row on this branch, deliberately. We are asking LemonSqueezy to
      // send this delivery again; a row here would be an idempotency key for it,
      // and the retry we asked for would come back and be swallowed as a replay —
      // losing the customer's upgrade for good at the moment the operator fixed
      // the cause. The Sentry report above is the record until then.
      return NextResponse.json({ error: "Could not place this subscription" }, { status: 500 });
    }
    // An ambiguous customer id is a refusal (someone has to choose); the rest are
    // honest deliveries we simply cannot place.
    await recordDelivery(delivery, {
      outcome: identity.reason === "customer-ambiguous" ? "refused" : "skipped",
      reason: identity.reason,
      ...ids,
    });
    return NextResponse.json({ received: true, ignored: identity.reason });
  }

  // resolveWebhookCompany never returns ok without a subscription id (its
  // first rule), but that guarantee can't cross the type boundary — re-check
  // rather than reach for a non-null assertion.
  if (!subscriptionId) {
    await recordDelivery(delivery, { outcome: "skipped", reason: "unresolvable", ...ids });
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
    await recordDelivery(delivery, {
      outcome: "skipped",
      reason: "company-vanished",
      companyId: null,
      ...ids,
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
    // bill-002 / bill-003. The breadcrumb is the on-call signal; the ledger row
    // below is the durable record (Sentry ages out, disputes do not). 200,
    // because the refusal is final — a retry would be refused for the same
    // reason.
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
    await recordDelivery(delivery, {
      outcome: "skipped",
      reason: decision.reason,
      companyId: identity.companyId,
      ...ids,
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
    await recordDelivery(delivery, {
      outcome: "skipped",
      reason: "stale-grant",
      companyId: identity.companyId,
      ...ids,
    });
    return NextResponse.json({ received: true, skipped: "stale-grant" });
  }

  // bill-010. A period key we could not read was DROPPED rather than written, so
  // one malformed date cannot become a delivery LemonSqueezy retries for ever
  // (that is `readPeriodEnd`'s job, and the reason nothing throws here). What is
  // left is that the customer's stored paid-through date is now silently stale:
  // the row below would say `applied` with no reason, which is indistinguishable
  // from a clean delivery. So the drop is recorded — on the ledger row, which
  // outlives Sentry and is what a billing dispute is settled from.
  //
  // Only on this path, deliberately. A delivery refused or skipped for some other
  // reason dropped nothing, because it wrote nothing, and overwriting its reason
  // with this one would hide the reason that mattered.
  const appliedReason = period.unreadable ? "period-end-unreadable" : null;

  // bill-009 + bill-002. THE WRITE AND ITS LEDGER ROW, IN ONE TRANSACTION.
  //
  // The insert is what makes the table an idempotency key rather than a log:
  // a replayed delivery carries the same `eventId`, loses on the unique index,
  // and the whole transaction — including the Company update that ran a moment
  // earlier — rolls back. So a delivery is recorded as applied if and only if
  // its write committed, and the replay changes nothing at all.
  //
  // The update runs FIRST so the row's outcome can be honest: a compare-and-set
  // that matches zero rows must not leave a ledger row claiming it applied, and
  // throwing rolls that row back with it.
  try {
    await db.$transaction(async (tx) => {
      const result = await tx.company.updateMany({
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
      if (result.count === 0) throw new BillingWriteMiss();
      await tx.billingEvent.create({
        data: ledgerRow(delivery, {
          outcome: "applied",
          reason: appliedReason,
          companyId: identity.companyId,
          ...ids,
        }),
      });
    });
  } catch (e) {
    if (e instanceof BillingWriteMiss) {
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
      await recordDelivery(delivery, {
        outcome: "skipped",
        reason: "write-miss",
        companyId: identity.companyId,
        ...ids,
      });
      return NextResponse.json({ received: true, ignored: "write-miss" });
    }
    if (isLedgerReplay(e)) {
      // Already delivered. Nothing was written — the transaction took the
      // Company update back out with it — so this is the one refusal that needs
      // no further record: the row that refused it IS the record.
      reportSkippedBillingWrite({
        eventName,
        reason: "replay",
        subscriptionId,
        customerId,
        companyId: identity.companyId,
        extra: { eventId: delivery.eventId, incomingStatus: status },
      });
      return NextResponse.json({ received: true, skipped: "replay" });
    }
    // Anything else is transient: let the outer catch answer 500 so LemonSqueezy
    // retries. No ledger row, so the retry is not swallowed as a replay.
    throw e;
  }

  if (period.unreadable) {
    // bill-010. Raised AFTER the write commits, so it reports something that
    // actually happened, and exactly once per applied delivery. Nobody on this
    // side can fix it — the sender is producing a date we cannot read — so the
    // useful output is an operator who knows which workspace is carrying a stale
    // paid-through date, and what arrived instead of a date.
    captureServerError(
      new Error(`Billing event carried an unreadable paid-through date: ${eventName}`),
      {
        action: "lemonSqueezyWebhook.unreadablePeriodEnd",
        companyId: identity.companyId,
        extra: {
          eventName,
          subscriptionId,
          customerId,
          endsAt: attrs.ends_at,
          renewsAt: attrs.renews_at,
          // What the workspace is still claiming to be paid through, which is
          // the number support will be asked about.
          storedPeriodEnd: stored.currentPeriodEnd,
        },
      }
    );
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
  delivery: Delivery,
  attrs: Record<string, unknown>
): Promise<NextResponse> {
  const eventName = delivery.eventName;
  const subscriptionId = attrId(attrs, "subscription_id");
  const customerId = attrId(attrs, "customer_id");
  const ids = { subscriptionId, customerId };

  const scope = scopeEvent(eventName, attrs, ids);
  if (!scope.ok) {
    await recordDelivery(delivery, { outcome: "refused", reason: scope.reason, ...ids });
    return NextResponse.json({ received: true, ignored: scope.reason });
  }

  if (!subscriptionId) {
    reportUnplaceableBillingEvent({
      eventName,
      reason: "invoice-without-subscription",
      subscriptionId: null,
      customerId,
    });
    await recordDelivery(delivery, {
      outcome: "skipped",
      reason: "invoice-without-subscription",
      ...ids,
    });
    return NextResponse.json({ received: true, ignored: "invoice-without-subscription" });
  }

  // No claim path and no customer-id fallback: a payment event may only report on
  // a binding we already hold, never create one.
  //
  // bill-012: `findMany` + `take: 2`, not `findFirst`. `billingSubscriptionId`
  // has no unique constraint, so two workspaces holding one subscription id made
  // "which workspace does this declined card belong to?" a coin flip — and the
  // loser is marked `past_due` on somebody else's failed payment.
  const bound = await db.company.findMany({
    where: { billingSubscriptionId: subscriptionId, deletedAt: null },
    select: { id: true, subscriptionStatus: true, currentPeriodEnd: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
  });
  if (bound.length > 1) {
    reportUnplaceableBillingEvent({
      eventName,
      reason: "subscription-ambiguous",
      subscriptionId,
      customerId,
      extra: { matchedCompanyIds: bound.map((c) => c.id) },
    });
    await recordDelivery(delivery, {
      outcome: "refused",
      reason: "subscription-ambiguous",
      ...ids,
    });
    return NextResponse.json({ received: true, ignored: "subscription-ambiguous" });
  }
  const company = bound[0] ?? null;
  if (!company) {
    // bill-011. Before calling this a subscription we have never seen, ask whether
    // we hold the binding on a TOMBSTONED workspace — the query above filters
    // those out, deliberately, because a tombstoned workspace must never be
    // written to. But "never written to" and "unidentifiable" are different
    // answers, and the ledger row for a charge is the one row in the table that
    // exists to answer "whose money was this?". Recording `unknown-subscription`
    // with a null companyId for a subscription we can name is the ledger throwing
    // away the fact it was built to keep.
    const tombstoned = await db.company.findMany({
      where: { billingSubscriptionId: subscriptionId, deletedAt: { not: null } },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
    });
    const deleted = tombstoned[0] ?? null;
    if (deleted) {
      reportUnplaceableBillingEvent({
        eventName,
        reason: "company-deleted",
        subscriptionId,
        customerId,
        companyId: deleted.id,
      });
      // Still no write of any kind: the workspace is inside its Tier 3 recovery
      // window and ops treat it as gone. Only the record improves.
      await recordDelivery(delivery, {
        outcome: "skipped",
        reason: "company-deleted",
        companyId: deleted.id,
        ...ids,
      });
      return NextResponse.json({ received: true, ignored: "company-deleted" });
    }

    reportUnplaceableBillingEvent({
      eventName,
      reason: "unknown-subscription",
      subscriptionId,
      customerId,
    });
    // bill-009: "money arrived and we could not place it" is the single most
    // valuable row in the ledger, and it is the one a nullable companyId exists
    // for. It was previously a 200 and a Sentry breadcrumb with Sentry's
    // retention, which is not a record of a payment dispute.
    await recordDelivery(delivery, {
      outcome: "skipped",
      reason: "unknown-subscription",
      companyId: null,
      ...ids,
    });
    return NextResponse.json({ received: true, ignored: "unknown-subscription" });
  }

  // bill-009 + bill-002, same shape as the subscription path: the status change
  // and the ledger row commit together, so a re-POSTed invoice cannot mark a
  // recovered workspace `past_due` a second time. A payment_success writes no
  // column at all — the ledger row IS the record, which is the whole of bill-009
  // for the event a disputed charge actually corresponds to.
  try {
    await db.$transaction(async (tx) => {
      if (eventName === "subscription_payment_failed") {
        // Only from a healthy status, and only the status column. Overwriting
        // `cancelled` or `expired` with `past_due` would resurrect a workspace that is
        // on its way out. `plan` deliberately stays paid: the dunning window in
        // ACCESS_GRACE_DAYS is what gives the customer time to fix the card, and the
        // notification below is what tells them to.
        await tx.company.updateMany({
          where: {
            id: company.id,
            deletedAt: null,
            billingSubscriptionId: subscriptionId,
            subscriptionStatus: { in: ["active", "on_trial"] },
          },
          data: { subscriptionStatus: "past_due" },
        });
      } else if (eventName === "subscription_payment_recovered") {
        await tx.company.updateMany({
          where: {
            id: company.id,
            deletedAt: null,
            billingSubscriptionId: subscriptionId,
            subscriptionStatus: "past_due",
          },
          data: { subscriptionStatus: "active" },
        });
      }
      await tx.billingEvent.create({
        data: ledgerRow(delivery, {
          outcome: "applied",
          reason: null,
          companyId: company.id,
          ...ids,
        }),
      });
    });
  } catch (e) {
    if (isLedgerReplay(e)) {
      reportSkippedBillingWrite({
        eventName,
        reason: "replay",
        subscriptionId,
        customerId,
        companyId: company.id,
        extra: { eventId: delivery.eventId },
      });
      return NextResponse.json({ received: true, skipped: "replay" });
    }
    throw e;
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
    meta?: { event_name?: string; custom_data?: unknown; webhook_id?: string | number };
    data?: { id?: string | number; attributes?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  const eventName = event.meta?.event_name ?? "";
  const sub = event.data;

  // Identified ONCE, from the verified bytes, and carried into every branch: the
  // ledger is only an idempotency key if the same delivery always produces the
  // same key, and `payload` is only evidence if it is the bytes the signature
  // covered rather than a re-serialisation of them.
  const delivery: Delivery = {
    eventId: deliveryEventId(event.meta, rawBody),
    eventName,
    payload: rawBody.toString("utf8"),
  };

  try {
    if (SUB_EVENTS.has(eventName) && sub?.attributes) {
      return await handleSubscriptionEvent(delivery, sub, event.meta?.custom_data);
    }
    if (INVOICE_EVENTS.has(eventName) && sub?.attributes) {
      return await handlePaymentEvent(delivery, sub.attributes);
    }
  } catch (e) {
    // 500 so LemonSqueezy retries transient failures. No ledger row was written
    // on the way here (the handlers roll theirs back and rethrow), so the retry
    // is not swallowed as a replay.
    captureServerError(e, { action: "lemonSqueezyWebhook", extra: { eventName } });
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }

  // Everything else — order_created, order_refunded, license_key_*, and whatever
  // a future store version invents. A quiet 200 is correct here and is NOT the
  // bill-008 silence: plans are modelled off subscriptions only, so an order event
  // must not be able to set one (that is the negative result the audit checked).
  // Reporting every one of them would bury the reports that matter.
  //
  // bill-009 draws the one distinction that matters: NOT reporting them is right,
  // not RECORDING them is not. "What arrived" and "what we understood" are
  // different questions, and a dispute is usually about the gap between them —
  // e.g. an `order_refunded` we never acted on. The row is cheap and silent.
  await recordDelivery(delivery, {
    outcome: "skipped",
    reason: "unhandled-event",
    subscriptionId: null,
    customerId: null,
  });
  return NextResponse.json({ received: true });
}
