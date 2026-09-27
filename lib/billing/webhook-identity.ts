/**
 * Which workspace does an incoming LemonSqueezy subscription event belong to?
 *
 * THE TRAP THIS EXISTS TO AVOID (bill-001, audit 2026-09-26). A valid HMAC
 * signature on a webhook proves the event came from LemonSqueezy. It proves
 * NOTHING about who the payer is entitled to pay for. LemonSqueezy's hosted
 * buy links accept checkout custom data straight off the query string:
 *
 *   https://store.lemonsqueezy.com/buy/<uuid>?checkout[custom][company_id]=<anything>
 *
 * so `meta.custom_data.company_id` is BUYER-SUPPLIED INPUT that arrives wearing
 * a valid signature. The previous resolver returned it verbatim and the write
 * was `updateMany({ where: { id: companyId } })`, which meant a stranger could
 * buy a Team plan "for" someone else's workspace and overwrite its `plan`,
 * `subscriptionStatus`, `billingSubscriptionId` and `billingCustomerId`. Two
 * consequences, both bad: the stranger could flip a paying customer to free by
 * cancelling their own subscription, and the victim's "Manage billing" button
 * started opening the STRANGER's LemonSqueezy portal, because
 * `createBillingPortalSessionAction` derives the portal from the workspace's
 * `billingSubscriptionId`.
 *
 * THE RULE. `data.id` (the subscription id) and `attributes.customer_id` are
 * assigned by LemonSqueezy and cannot be chosen by the buyer; `custom_data` can.
 * So resolution is strictly ordered by trustworthiness:
 *
 *   1. the subscription id, matched against a binding WE recorded from an
 *      earlier verified event  -> authoritative;
 *   2. the buyer's `company_id` claim, but only if the named workspace is
 *      still unbound (`billingSubscriptionId === null`, a genuine first
 *      activation) or is already bound to this very subscription;
 *   3. the provider-assigned `customer_id`, for portal/renewal events that
 *      carry no custom data and whose subscription id is new to us (a plan
 *      change mints a new subscription id against the same customer) - and ONLY
 *      when it matches exactly one workspace. It is the one key here with no
 *      unique constraint, so two workspaces behind one paying customer make it
 *      ambiguous, and an ambiguous answer is refused rather than guessed at
 *      (bill-012).
 *
 * Anything else is refused. A refusal that could only have been produced
 * deliberately is flagged `forged: true`, which is what makes the route answer
 * 400 and raise a `boundary: billing-forgery` Sentry error instead of quietly
 * 200-ing.
 *
 * Kept pure and I/O-free (like lib/billing/plan.ts) on purpose: the route
 * handler around it cannot be unit-tested without a Prisma client, so ALL of
 * the judgement lives here where a test can reach it with plain objects. See
 * tests/lib/billing/webhook-identity.test.ts.
 *
 * RESIDUAL GAP, deliberately left open. Step 2 still trusts the claim for a
 * workspace that has never subscribed, so a stranger can still upgrade someone
 * else's FREE workspace and end up owning its billing row. Closing that needs a
 * server-generated nonce written to the Company when WE create the checkout,
 * and echoed back in custom_data - i.e. a new column, which this change is not
 * permitted to add. Tracked as a follow-up; the migration it needs is spelled
 * out there.
 */

/** The Company fields the billing lookup selects. */
export type BillingCompanyRow = {
  id: string;
  billingSubscriptionId: string | null;
  billingCustomerId: string | null;
  /** Tier 3 tombstone. Selected, NOT filtered in SQL - see CompanyBillingLookup. */
  deletedAt: Date | null;
};

/** How a workspace was identified. Drives the compare-and-set on the write. */
export type IdentitySource =
  | "subscription" // matched a binding we already recorded
  | "claim-confirmed" // claim agrees with the recorded binding
  | "first-activation" // claim named an unbound workspace
  | "customer"; // no claim; matched the provider-assigned customer id

export type RejectReason =
  /** The claim named a workspace that belongs to a different subscription. */
  | "forged-claim"
  /** The claim named a workspace that does not exist. */
  | "claim-unknown"
  /** The resolved workspace is tombstoned - never write billing state to it. */
  | "company-deleted"
  /**
   * The provider-assigned customer id matched MORE THAN ONE workspace, so the
   * fallback cannot say which one the event is about (bill-012). Not an attack:
   * one person paying for two workspaces is an ordinary shape, and
   * `billingCustomerId` carries no unique constraint.
   */
  | "customer-ambiguous"
  /** Nothing trustworthy to go on. Not necessarily an attack. */
  | "unresolvable";

export type WebhookIdentity =
  | { ok: true; companyId: string; via: IdentitySource }
  | {
      ok: false;
      reason: RejectReason;
      /** True when the refusal implies deliberate tampering, not just noise. */
      forged: boolean;
      claimedCompanyId: string | null;
    };

/** Everything the decision is allowed to look at. No I/O beyond this. */
export type IdentityEvidence = {
  /** `data.id`, stringified. Provider-assigned. */
  subscriptionId: string | null;
  /** `attributes.customer_id`, stringified. Provider-assigned. */
  customerId: string | null;
  /** `meta.custom_data.company_id`. BUYER-SUPPLIED. Untrusted. */
  claimedCompanyId: string | null;
  bySubscription: BillingCompanyRow | null;
  byClaim: BillingCompanyRow | null;
  byCustomer: BillingCompanyRow | null;
  /**
   * True when the customer-id lookup matched more than one workspace (bill-012).
   * OPTIONAL, and absent must mean "no ambiguity detected" rather than "unknown,
   * so refuse" - otherwise every existing caller starts rejecting.
   */
  customerAmbiguous?: boolean;
};

/**
 * Pull `company_id` out of `meta.custom_data` without coercing it.
 *
 * No `String(...)` anywhere: a hand-built checkout link can make this an array
 * or an object, and coercion is how `"[object Object]"` or `"a,b"` becomes a
 * company id that then gets matched against the database.
 */
export function readClaimedCompanyId(customData: unknown): string | null {
  if (!customData || typeof customData !== "object" || Array.isArray(customData)) return null;
  const raw = (customData as Record<string, unknown>).company_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The whole rule, as a pure function. Order matters and is the security
 * property - read the header comment before reordering anything here.
 */
export function decideWebhookCompany(evidence: IdentityEvidence): WebhookIdentity {
  const claimedCompanyId = evidence.claimedCompanyId;
  const reject = (reason: RejectReason, forged: boolean): WebhookIdentity => ({
    ok: false,
    reason,
    forged,
    claimedCompanyId,
  });

  // No subscription id means there is nothing provider-assigned to bind to, and
  // the claim alone must never be enough. The old code was worse than useless
  // here: it wrote `billingSubscriptionId: null`, wiping a live binding and
  // leaving the workspace in exactly the unbound state that the next forged
  // checkout can claim.
  if (!evidence.subscriptionId) return reject("unresolvable", false);

  // 1. A binding we recorded ourselves from an earlier verified event. This is
  //    the only fully trustworthy path.
  if (evidence.bySubscription) {
    if (evidence.bySubscription.deletedAt) {
      // Innocent cause: a real subscriber deleted their workspace and renewals
      // keep arriving. Not forgery - but still no write, because the row is
      // inside its recovery window and ops treat it as gone.
      return reject("company-deleted", false);
    }
    if (claimedCompanyId && claimedCompanyId !== evidence.bySubscription.id) {
      // The two identifiers contradict each other. Resolving by the recorded
      // binding would in fact be safe, but we refuse anyway: custom_data is
      // fixed at checkout creation, so a mismatch means someone is driving this
      // flow by hand, and silently picking a winner would hide that.
      return reject("forged-claim", true);
    }
    return { ok: true, companyId: evidence.bySubscription.id, via: "subscription" };
  }

  // 2. Unrecorded subscription. The claim is the only pointer we have, and it
  //    is attacker-controlled, so it has to earn its way in.
  if (claimedCompanyId) {
    if (!evidence.byClaim) {
      // Nobody mistypes a cuid into a checkout link. Treat it as probing.
      return reject("claim-unknown", true);
    }
    if (evidence.byClaim.deletedAt) {
      // An unbound tombstone is the most attractive target there is: no
      // existing subscription to collide with, and a resurrected paid plan on
      // a workspace ops believes is deleted.
      return reject("company-deleted", true);
    }
    if (evidence.byClaim.billingSubscriptionId === null) {
      // Genuine first activation: nothing to overwrite, so the claim is
      // harmless to honour. The nonce follow-up is what would make this
      // positively verified rather than merely harmless.
      return { ok: true, companyId: evidence.byClaim.id, via: "first-activation" };
    }
    if (evidence.byClaim.billingSubscriptionId === evidence.subscriptionId) {
      // Defensive: step 1 should already have caught this. Reachable only if
      // the two lookups disagree (e.g. a duplicate binding), and harmless -
      // the claim is confirmed by a binding we recorded.
      return { ok: true, companyId: evidence.byClaim.id, via: "claim-confirmed" };
    }
    // THE bill-001 CASE: the claimed workspace is already paying for a
    // different subscription. This is the takeover attempt.
    return reject("forged-claim", true);
  }

  // 3. No claim. Fall back to the provider-assigned customer id, which the
  //    buyer cannot choose (LemonSqueezy derives it from the paying account).
  //    Needed because a plan change mints a NEW subscription id for an existing
  //    customer, and portal-driven events carry no custom data.
  //
  //    Note this is only reached when there was no claim at all. A REJECTED
  //    claim never falls through to here - otherwise the gate would be
  //    decorative: forge a claim, get refused, have the event applied to your
  //    own workspace anyway and the alert written off as noise.
  //
  //    bill-012: this is the ONLY non-unique key in the resolution order, and
  //    the old lookup was `findFirst` with no orderBy over a column with no
  //    unique constraint - so Postgres returned whichever row it liked and the
  //    choice could change between queries. The serial-founder / agency case is
  //    ordinary: one LemonSqueezy customer (one email, one card) subscribing for
  //    two workspaces leaves two rows with the same billingCustomerId, and then
  //    a cancellation for workspace B could downgrade workspace A. The only
  //    correct answer is to refuse and alert; guessing right is luck, and a bug
  //    that resolves by luck never reproduces on demand.
  if (evidence.customerAmbiguous) return reject("customer-ambiguous", false);
  if (evidence.customerId && evidence.byCustomer) {
    if (evidence.byCustomer.deletedAt) return reject("company-deleted", false);
    return { ok: true, companyId: evidence.byCustomer.id, via: "customer" };
  }

  // Events for products/stores we don't know about land here. Ordinary noise.
  return reject("unresolvable", false);
}

/**
 * Sentinel a customer-id lookup returns INSTEAD of a row when the id matched
 * more than one workspace (bill-012).
 *
 * A sentinel rather than a second `countByCustomerId` call because the lookup
 * already has the rows in hand - `take: 2` costs nothing over `take: 1` - and a
 * separate count is one more chance for the two answers to disagree.
 */
export const AMBIGUOUS_CUSTOMER = "ambiguous-customer";

export type CustomerLookupResult = BillingCompanyRow | null | typeof AMBIGUOUS_CUSTOMER;

/**
 * The three reads the decision needs.
 *
 * Implementations must NOT filter `deletedAt` in the query. Filtering there
 * would make a tombstoned workspace indistinguishable from a non-existent one,
 * and the difference matters twice: it decides whether a refusal is reported as
 * forgery, and it stops a claim from sliding into the gap left by a tombstoned
 * row that a filtered lookup pretended wasn't there. The tombstone is enforced
 * by `decideWebhookCompany`, and again by `deletedAt: null` on the update.
 *
 * `byCustomerId` must also be DETERMINISTIC and must report ambiguity rather
 * than pick a winner: it is the only lookup here whose key has no unique
 * constraint. Return `AMBIGUOUS_CUSTOMER` when two or more workspaces match.
 */
export interface CompanyBillingLookup {
  byId(companyId: string): Promise<BillingCompanyRow | null>;
  bySubscriptionId(subscriptionId: string): Promise<BillingCompanyRow | null>;
  byCustomerId(customerId: string): Promise<CustomerLookupResult>;
}

/**
 * Gather the evidence, then decide. The only async part; every judgement call
 * lives in `decideWebhookCompany`.
 */
export async function resolveWebhookCompany(
  input: { subscriptionId: string | null; customerId: string | null; customData: unknown },
  lookup: CompanyBillingLookup
): Promise<WebhookIdentity> {
  const claimedCompanyId = readClaimedCompanyId(input.customData);
  const { subscriptionId, customerId } = input;

  if (!subscriptionId) {
    return decideWebhookCompany({
      subscriptionId: null,
      customerId,
      claimedCompanyId,
      bySubscription: null,
      byClaim: null,
      byCustomer: null,
    });
  }

  const bySubscription = await lookup.bySubscriptionId(subscriptionId);
  // Only look up what the decision can actually use: once a recorded binding
  // exists it wins outright, so don't spend two more queries (nor hand the
  // decision rows it must ignore).
  const byClaim = !bySubscription && claimedCompanyId ? await lookup.byId(claimedCompanyId) : null;
  const customerLookup: CustomerLookupResult =
    !bySubscription && !claimedCompanyId && customerId
      ? await lookup.byCustomerId(customerId)
      : null;
  const customerAmbiguous = customerLookup === AMBIGUOUS_CUSTOMER;

  return decideWebhookCompany({
    subscriptionId,
    customerId,
    claimedCompanyId,
    bySubscription,
    byClaim,
    byCustomer: customerAmbiguous ? null : customerLookup,
    customerAmbiguous,
  });
}

/**
 * Extra `where` clauses that re-assert, at write time, the binding the decision
 * was made on. Turns the update into a compare-and-set.
 *
 * Why this is not paranoia: the read and the write are separate statements, and
 * LemonSqueezy delivers events concurrently (and retries them). Two forged
 * first-activation events racing for the same unbound workspace both read
 * `billingSubscriptionId === null` and both pass the decision; this clause is
 * what makes the second one match zero rows instead of stealing the workspace
 * from the first. It must never return `{}` - an empty guard silently widens
 * the update back to id-only, which is the bug this whole module exists for.
 */
export function identityWriteGuard(
  via: IdentitySource,
  subscriptionId: string,
  customerId: string | null
): { billingSubscriptionId?: string | null; billingCustomerId?: string } {
  switch (via) {
    case "first-activation":
      // Claim the workspace only while it is still unclaimed.
      return { billingSubscriptionId: null };
    case "customer":
      // Deliberately NOT the subscription id: this path exists precisely
      // because the incoming subscription id is not yet recorded anywhere.
      return customerId
        ? { billingCustomerId: customerId }
        : /* unreachable - the decision needs a customerId to pick this path -
             but fall back to something narrowing rather than nothing. */
          { billingSubscriptionId: subscriptionId };
    case "subscription":
    case "claim-confirmed":
      return { billingSubscriptionId: subscriptionId };
  }
}
