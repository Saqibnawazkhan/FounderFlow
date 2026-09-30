/**
 * Read-side billing summary for the Settings → Plan section. Server-only.
 *
 * WHY THERE IS AN AMOUNT IN HERE (bill-016, 2026-09-30). This summary used to be
 * (plan, status, currentPeriodEnd, hasCustomer, configured) — a plan NAME, a
 * date, and nothing about money. Two sections above it the same page prints the
 * workspace's reporting currency (`Company.currency`, PKR by default), and
 * LemonSqueezy is a merchant of record that charges the card in its store
 * currency. So the product showed PKR everywhere and never once said that the
 * card statement would read USD, or how much.
 *
 * THREE PLACES THE NUMBER COULD HAVE COME FROM. Only one of them is honest here:
 *
 *   1. A live `getSubscription()` on render — rejected. That adds a third-party
 *      network call to the critical path of a page that currently makes none, so
 *      a LemonSqueezy outage or an unconfigured deployment would degrade or fail
 *      /settings. `createBillingPortalSessionAction` already makes that call, on
 *      a click, where a failure has a user in front of it to be reported to.
 *   2. A constant — rejected, and this is the trap the finding itself warned
 *      about. app/page.tsx sells Team at "$10 /mo"; the audit that raised this
 *      row guessed "$29". Either one typed in here becomes a lie the day the
 *      LemonSqueezy variant price changes, and nothing in this repo would fail.
 *   3. The stored webhook payload — taken. `BillingEvent.payload` already holds
 *      the raw signed body of every delivery this app APPLIED, and
 *      `subscription_payment_success` / `subscription_payment_recovered` are
 *      invoice-shaped: they carry `total` (minor units, tax included),
 *      `currency` and `total_formatted`. That is the provider's own record of
 *      what it actually took, on our own disk, served by an index that already
 *      exists (`@@index([companyId, receivedAt])`), and it needs no new column.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM.
 *
 *   • It is a LAST CHARGE, not a price. `total` includes tax and any discount,
 *     so it is what this customer was billed, which is exactly the number they
 *     are trying to match against a card statement — and is not necessarily
 *     what the next renewal will cost.
 *   • No billing INTERVAL. Nothing in any payload this app stores carries one:
 *     a LemonSqueezy subscription payload has `first_subscription_item.price_id`
 *     but the renewal interval lives on the Price/Variant object, which only an
 *     API call would fetch. The next date is already on screen, from
 *     `describeBillingPeriod`; inventing the word "monthly" here would be the
 *     hardcoded-price mistake in a different costume.
 *   • No invoice URL. The invoice payload has `urls.invoice_url`, but
 *     LemonSqueezy's hosted billing links are short-lived, so a copy stored now
 *     and rendered in six weeks is a dead link. The durable route to invoices is
 *     the customer portal behind the existing "Manage billing" button.
 *
 * PRIVACY. Those same bytes carry `user_email`, `user_name`, `card_brand` and
 * `card_last_four`. Exactly three scalars are lifted out of them and the rest is
 * dropped on this side of the RSC boundary; nothing else reaches the browser.
 * tests/lib/queries/billing-summary.test.ts asserts that.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import { canSeeFinances } from "@/lib/auth/role-gates";
import { normalizePlan, type Plan } from "@/lib/billing/plan";
import { isBillingConfigured } from "@/lib/lemonsqueezy/config";

/**
 * The currency LemonSqueezy bills this store in, when no real charge is on
 * record yet to prove it.
 *
 * A DEFAULT, never an override: the moment an applied invoice exists, its own
 * `currency` wins (see `billingCurrency` below). It is stated at all because a
 * workspace deciding whether to upgrade needs to know the charge will not be in
 * its own reporting currency, and at that point there is by definition no
 * invoice to read. "USD" is this repo's own documented understanding of the
 * account — see the header of lib/lemonsqueezy/config.ts.
 */
export const DEFAULT_BILLING_CURRENCY = "USD";

/**
 * Invoice events whose payload carries a total. Both of them: a recovered
 * payment is money moving just as much as a first-time success, and reading only
 * `subscription_payment_success` would show a stale amount to the customer whose
 * card had failed and then gone through.
 */
const PAYMENT_EVENT_NAMES = ["subscription_payment_success", "subscription_payment_recovered"];

/** What LemonSqueezy actually took, the last time it took anything. */
export interface BillingCharge {
  /** ISO 4217 code, upper-cased — the currency the card was charged in. */
  currency: string;
  /** The total in that currency's minor unit (cents), tax and discount applied. */
  amountMinor: number;
  /**
   * The provider's own rendering of the total, e.g. "$10.00". Null when the
   * payload omitted it — the screen then formats `amountMinor` itself rather
   * than guessing at a symbol.
   */
  formatted: string | null;
  /** ISO instant of the invoice (falling back to when we received it). */
  chargedAt: string;
}

export interface BillingSummary {
  plan: Plan;
  status: string | null;
  currentPeriodEnd: string | null;
  /** Whether this workspace has a Stripe customer yet (→ show "Manage"). */
  hasCustomer: boolean;
  /** Whether the deployment has Stripe configured at all. */
  configured: boolean;
  /**
   * The most recent charge we can prove, from the stored webhook payload. Null
   * for a workspace that has never been billed, and null — never a guess — when
   * the stored bytes cannot be read as an invoice.
   */
  lastCharge: BillingCharge | null;
  /**
   * The currency billing happens in: the last real charge's currency when there
   * is one, otherwise the store default. Always present, because the sentence
   * that reconciles it against `Company.currency` has to be renderable before
   * the first invoice exists.
   */
  billingCurrency: string;
}

/** A JSON value we have not yet proven anything about. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Lift the money fields out of a stored invoice payload.
 *
 * Exported so the parse is unit-testable without a database: these are bytes
 * from a third party, reached weeks after they arrived, and every failure mode
 * has to land on `null` rather than on a plausible-looking wrong number. A
 * screen that says nothing is recoverable; a screen that says "$10.50" because
 * `total` arrived as `10.5` is a support ticket about a charge that never
 * happened.
 *
 * `total` must be a non-negative INTEGER: LemonSqueezy documents it in minor
 * units, so a fractional value means the field is not what this function thinks
 * it is, and dividing it by 100 anyway would be inventing a price.
 */
export function readInvoiceCharge(
  payload: string | null | undefined,
  receivedAt: Date
): BillingCharge | null {
  if (!payload) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const attrs = asRecord(asRecord(asRecord(parsed)?.data)?.attributes);
  if (!attrs) return null;

  const total = attrs.total;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return null;

  const currency = attrs.currency;
  if (typeof currency !== "string" || currency.length === 0) return null;

  const formatted = attrs.total_formatted;
  const createdAt = typeof attrs.created_at === "string" ? new Date(attrs.created_at) : null;
  const chargedAt =
    createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : new Date(receivedAt);

  return {
    currency: currency.toUpperCase(),
    amountMinor: total,
    formatted: typeof formatted === "string" && formatted.length > 0 ? formatted : null,
    chargedAt: chargedAt.toISOString(),
  };
}

export async function getBillingSummary(): Promise<BillingSummary | null> {
  const { companyId, role } = await requireScopedSession();

  // NULL FOR ANYONE WHO MAY NOT SEE MONEY (A43). This used to return the
  // whole summary to every role, and app/(app)/settings/page.tsx calls it
  // unconditionally inside a Promise.all, so a MEMBER's RSC flight payload
  // carried `lastCharge.amountMinor`, `currency`, `formatted` and `chargedAt`
  // — the workspace's actual last invoice — even though the card that renders
  // them is drawn only for an admin. Withholding it at the source rather than
  // in the component is the point: `plan` and `status` had already crossed the
  // same way, and the payload is not a place a role check can be added later.
  //
  // `canSeeFinances`, deliberately, and NOT `role === "admin"` to match the
  // card. This repo owns exactly one finance boundary
  // (lib/auth/role-gates.ts, and `requireFinanceSession` exists so the code
  // that PRODUCES money data re-checks it). A third predicate shaped like one
  // component's current visibility would disagree with the route layer the
  // first time that component changes. So a cofounder still receives this and
  // still sees no card, which costs nothing; a member receives nothing, which
  // is the finding.
  if (!canSeeFinances(role)) return null;

  // Both reads are keyed on the same companyId, so they go out together. Making
  // the ledger read wait on the workspace read would have added a second
  // Supabase round trip to a page that already fans out five queries in
  // parallel — perf-001's mistake, in a query this finding introduces.
  const [c, lastPayment] = await Promise.all([
    db.company.findFirst({
      where: { id: companyId, deletedAt: null },
      select: {
        plan: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
        billingCustomerId: true,
      },
    }),
    // `outcome: "applied"` is load-bearing: a refused or skipped delivery is a
    // charge we decided did NOT belong to this workspace (a forgery, a foreign
    // store, a replay), and one of those becoming the amount on someone's
    // billing screen is worse than showing no amount at all.
    db.billingEvent.findFirst({
      where: {
        companyId,
        outcome: "applied",
        eventName: { in: PAYMENT_EVENT_NAMES },
      },
      orderBy: { receivedAt: "desc" },
      select: { payload: true, receivedAt: true },
    }),
  ]);

  const lastCharge = lastPayment
    ? readInvoiceCharge(lastPayment.payload, lastPayment.receivedAt)
    : null;

  return {
    plan: normalizePlan(c?.plan),
    status: c?.subscriptionStatus ?? null,
    currentPeriodEnd: c?.currentPeriodEnd ? c.currentPeriodEnd.toISOString() : null,
    hasCustomer: Boolean(c?.billingCustomerId),
    configured: isBillingConfigured(),
    lastCharge,
    billingCurrency: lastCharge?.currency ?? DEFAULT_BILLING_CURRENCY,
  };
}
