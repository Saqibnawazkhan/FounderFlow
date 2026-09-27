/**
 * Plan model + feature gates. Pure (no I/O), so it's safe on the Edge runtime,
 * server actions, and the client.
 *
 * Two plans today, mirroring the landing pricing page:
 *   free ("Solo") — up to 2 members
 *   team ("Team") — unlimited members + paid features
 *
 * The workspace's `plan` column is written by exactly one thing (the
 * LemonSqueezy webhook at `app/api/webhooks/lemonsqueezy/route.ts`) — but it is
 * NOT on its own the source of truth for entitlement. See `effectivePlan`
 * below, and read the next paragraph before gating anything on `plan` alone.
 * Billing is LemonSqueezy — NOT Stripe, which won't onboard Pakistan-based
 * sellers — so don't go looking for a Stripe handler; there isn't one.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT WAS WRONG (bill-004, audit 2026-09-26).
 * The old header said: "Gate on the plan, not on the raw subscription status: a
 * `cancelled` subscription keeps paid access until the period ends (the webhook
 * only flips `plan` to free on `subscription_expired`), so reading the status
 * here would revoke features from someone who already paid for the month."
 *
 * The first half is right and still stands. The conclusion was wrong, because it
 * rested on an assumption nothing enforced: that `subscription_expired` always
 * arrives. `plan` had NO other writer, so a single lost delivery — a silent 200
 * on an event that could not be placed (bill-008), an endpoint that was down, a
 * retry budget that ran out, a card that failed permanently so LemonSqueezy's
 * dunning ended in events this app ignored — left the workspace on Team for
 * ever, free, with no in-app way to correct it. "Until the period ends" was
 * never checked against a clock: `currentPeriodEnd` was written by the webhook
 * and then read in exactly one place, a "Renews {date}" label.
 *
 * THE RULE NOW. Entitlement is a function of (plan, status, currentPeriodEnd,
 * now), and `effectivePlan` is that function. It is still not the raw status —
 * `cancelled` keeps its paid month, as the old comment correctly wanted — it is
 * the status combined with the date the subscription itself says it is paid
 * through. That turns a lost downgrade from a permanent free licence into an
 * entitlement that simply expires on its own.
 */

export type Plan = "free" | "team";

/** Free workspaces are capped at this many active members (pricing: "up to 2"). */
export const FREE_MEMBER_LIMIT = 2;

export const PLAN_LABELS: Record<Plan, string> = {
  free: "Solo",
  team: "Team",
};

/** Coerce any stored/legacy value to a known plan. Unknown → free. */
export function normalizePlan(plan: string | null | undefined): Plan {
  return plan === "team" ? "team" : "free";
}

/** Max members a plan allows (Infinity = unlimited on Team). */
export function memberLimitForPlan(plan: string | null | undefined): number {
  return normalizePlan(plan) === "team" ? Infinity : FREE_MEMBER_LIMIT;
}

/* ------------------------------------------------------------------------- *
 * Subscription status vocabulary
 *
 * LemonSqueezy's documented statuses: on_trial, active, paused, past_due,
 * unpaid, cancelled, expired. Both sets below live HERE rather than in the
 * webhook route, because the read side (this file's gates) and the write side
 * (the route) disagreeing about which statuses are paid is exactly how a
 * workspace ends up entitled to features the billing screen says it has lost.
 * ------------------------------------------------------------------------- */

/**
 * Statuses that entitle a workspace to the paid plan — SUBJECT to the period
 * check below, which is the part bill-004 was missing.
 *
 * `cancelled` is in here on purpose: the customer has already paid for the
 * current month and keeps it until `ends_at`. `past_due` is in here because
 * LemonSqueezy is still retrying the card and most of those recover; cutting
 * access off on the first failed charge would churn customers who are about to
 * pay. `paused` is deliberately absent — a paused subscription is not being
 * billed, so it is not buying anything.
 */
export const PAID_SUBSCRIPTION_STATUSES: readonly string[] = [
  "active",
  "on_trial",
  "past_due",
  "cancelled",
];

/**
 * Statuses a subscription can never come back from.
 *
 * LemonSqueezy mints a NEW subscription (new id) when someone resubscribes
 * after expiry, so `expired` on a given subscription id is final. `unpaid`
 * means dunning is exhausted and goes the same way. This one-way property is
 * what lets the webhook refuse a replayed `active` for an id it has already
 * recorded as dead (bill-002) — without it, a captured delivery is a permanent
 * free licence.
 */
export const TERMINAL_SUBSCRIPTION_STATUSES: readonly string[] = ["expired", "unpaid"];

export function isPaidSubscriptionStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && PAID_SUBSCRIPTION_STATUSES.indexOf(status) !== -1;
}

export function isTerminalSubscriptionStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && TERMINAL_SUBSCRIPTION_STATUSES.indexOf(status) !== -1;
}

/**
 * How long paid access survives past `currentPeriodEnd`, per stored status.
 *
 * These are not padding for its own sake — each one covers a specific way that
 * revoking access exactly on the stored date would be WRONG:
 *
 *   • `active` / `on_trial` (3 days): the renewal charge and its webhook are not
 *     simultaneous. Between `renews_at` passing and `subscription_updated`
 *     landing, a perfectly good customer's stored date is in the past. Revoking
 *     there would be a self-inflicted outage on the happy path — and since the
 *     only thing that would restore them is the webhook we are still waiting
 *     for, any hiccup in delivery becomes a visible incident.
 *
 *   • `past_due` (14 days): LemonSqueezy retries a failed card several times
 *     over about two weeks, and most of those recover. This is the dunning
 *     window; it is where bill-018's "your card failed" notification does its
 *     work. After it, the customer is not a payment problem, they are a
 *     non-customer.
 *
 *   • `cancelled` (1 day): `ends_at` is an exact, deliberate access end, so the
 *     only slack it needs is for clock and timezone skew.
 *
 * A status nobody has thought about gets the stingy default, not the generous
 * one: an unknown status must not be a way to buy two extra weeks.
 */
export const ACCESS_GRACE_DAYS: Readonly<Record<string, number>> = {
  active: 3,
  on_trial: 3,
  past_due: 14,
  cancelled: 1,
};

export const DEFAULT_ACCESS_GRACE_DAYS = 1;

export function accessGraceDays(status: string | null | undefined): number {
  if (typeof status !== "string") return DEFAULT_ACCESS_GRACE_DAYS;
  const found = ACCESS_GRACE_DAYS[status];
  return typeof found === "number" ? found : DEFAULT_ACCESS_GRACE_DAYS;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The billing columns every gate and label in this file reads. */
export interface BillingStateLike {
  plan: string | null | undefined;
  subscriptionStatus: string | null | undefined;
  /**
   * `Company.currentPeriodEnd`. A `Date` server-side; an ISO string once it has
   * been through `getBillingSummary` and reached the browser. Both are accepted
   * so the client and the server can ask the same question of the same helper.
   */
  currentPeriodEnd: Date | string | null | undefined;
}

/**
 * Parse a stored period end, refusing anything that is not a real instant.
 *
 * `new Date("later")` is an Invalid Date whose `getTime()` is NaN, and EVERY
 * comparison against NaN is false — so a naive `end < now` check on a corrupt
 * value silently KEEPS paid access, which is the failure direction that costs
 * money. Returning null instead makes the caller take its explicit
 * "no date, cannot bound this" branch.
 */
function parsePeriodEnd(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The instant paid access actually ends: the stored period end plus the grace
 * window for the stored status. Null means "nothing to bound this with" —
 * either no date is stored or it is unparseable.
 */
export function paidAccessEndsAt(state: BillingStateLike): Date | null {
  const end = parsePeriodEnd(state.currentPeriodEnd);
  if (!end) return null;
  return new Date(end.getTime() + accessGraceDays(state.subscriptionStatus ?? null) * MS_PER_DAY);
}

/**
 * What the workspace is ACTUALLY entitled to right now. Gate on this, not on
 * `company.plan` (bill-004).
 *
 * It only ever takes access away, never grants it: a workspace whose `plan` is
 * "free" stays free whatever the dates say, so this can never become a second
 * upgrade path. The three ways it drops someone to free:
 *
 *   1. a terminal status (`expired` / `unpaid`) — final regardless of dates,
 *      because a stale future `renews_at` must not outvote a dead subscription;
 *   2. the paid-through date plus its grace window is in the past;
 *   3. `plan` was already free.
 *
 * NO stored date at all means unbounded, deliberately. Seeded and hand-comped
 * workspaces (the `demo-nimbus` demo workspace, anyone the operator upgraded by
 * hand) have no billing dates, and the alternative — treating "no date" as
 * "expired" — would silently de-licence them.
 */
export function effectivePlan(state: BillingStateLike, now: Date = new Date()): Plan {
  if (normalizePlan(state.plan) === "free") return "free";
  if (isTerminalSubscriptionStatus(state.subscriptionStatus ?? null)) return "free";
  const endsAt = paidAccessEndsAt(state);
  if (endsAt && endsAt.getTime() <= now.getTime()) return "free";
  return "team";
}

/**
 * Max members the workspace may have, honouring the period check.
 *
 * `memberLimitForPlan` stays for the callers that genuinely only hold a plan
 * string, but any caller with the whole Company row should use this one: the
 * member cap is the gate bill-004's revenue leak actually flowed through (a
 * lapsed workspace kept inviting unlimited teammates for free).
 */
export function memberLimitForCompany(state: BillingStateLike, now: Date = new Date()): number {
  return memberLimitForPlan(effectivePlan(state, now));
}

/* ------------------------------------------------------------------------- *
 * Billing-screen copy (bill-005)
 * ------------------------------------------------------------------------- */

export type BillingNoticeTone = "neutral" | "warning" | "danger";

export interface BillingPeriodNotice {
  /** The sentence under the plan name on Settings → Plan & billing. */
  text: string;
  tone: BillingNoticeTone;
  /** True when the customer has to DO something (a failed card). */
  needsAction: boolean;
}

/**
 * The sentence the billing screen shows about the current period.
 *
 * WHY THIS LIVES HERE AND NOT IN THE COMPONENT (bill-005). The settings page
 * had one branch for every status:
 *
 *   isTeam ? (billing.currentPeriodEnd ? `Renews ${fmt(...)}` : "Unlimited …")
 *
 * and `currentPeriodEnd` is `ends_at ?? renews_at`, where `ends_at` is set
 * PRECISELY WHEN THE SUBSCRIPTION HAS BEEN CANCELLED. So the cancelled case —
 * the one case where the date means "your access stops" — was the one case
 * guaranteed to be labelled "you will be charged again". A customer who
 * cancelled read "Renews 3 Nov" and either believed they were still subscribed
 * (and was blindsided when access stopped) or believed they were about to be
 * charged (and filed a chargeback). It also hid bill-004 from the operator: a
 * lapsed workspace displayed a cheerful past-dated "Renews".
 *
 * Putting the copy next to `effectivePlan` is what stops the sentence and the
 * entitlement from drifting apart again: the "we have stopped charging you"
 * wording is chosen by the same function that decides the features are off.
 *
 * `formatDate` is injected rather than imported so this module stays free of
 * `lib/utils` (which reaches for the DOM in `downloadFile`) and therefore stays
 * safe on the Edge runtime. Pass `formatDate` from `@/lib/utils`.
 *
 * Returns null for a workspace that has never subscribed — the free-plan
 * upgrade pitch is marketing copy that belongs beside `FREE_MEMBER_LIMIT` in
 * the settings component, not in a billing module.
 */
export function describeBillingPeriod(
  state: BillingStateLike,
  formatDate: (date: Date) => string,
  now: Date = new Date()
): BillingPeriodNotice | null {
  const status = state.subscriptionStatus ?? null;
  const end = parsePeriodEnd(state.currentPeriodEnd);

  // Never subscribed: nothing to say about a period that does not exist.
  if (normalizePlan(state.plan) === "free" && !status) return null;

  // Ask the gate, not the column. If the features are off, the sentence says so
  // — whatever `plan` still happens to hold.
  if (effectivePlan(state, now) === "free") {
    return {
      text: end
        ? `Subscription ended ${formatDate(end)} - upgrade to restore Team features`
        : "Subscription ended - upgrade to restore Team features",
      tone: "danger",
      needsAction: true,
    };
  }

  // A failed card is the only state with a deadline the CUSTOMER controls, so it
  // is checked before the generic no-date fallback: "update your card" is worth
  // saying even when we have no date to put on it.
  if (status === "past_due") {
    const deadline = paidAccessEndsAt(state);
    return {
      text: deadline
        ? `Payment failed - update your card by ${formatDate(deadline)}`
        : "Payment failed - update your card to keep Team features",
      tone: "danger",
      needsAction: true,
    };
  }

  // Comped / seeded / hand-granted workspaces, and anything else with no date.
  if (!end) {
    return { text: "Unlimited members + paid features", tone: "neutral", needsAction: false };
  }

  switch (status) {
    case "active":
      return { text: `Renews ${formatDate(end)}`, tone: "neutral", needsAction: false };
    case "on_trial":
      // A trial does renew — into a paid month — so the word is honest here.
      return { text: `Trial - renews ${formatDate(end)}`, tone: "neutral", needsAction: false };
    case "cancelled":
      // The bill-005 case. `ends_at` is when access STOPS.
      return {
        text: `Cancelled - access ends ${formatDate(end)}`,
        tone: "warning",
        needsAction: false,
      };
    case "paused":
      return { text: `Paused - resumes ${formatDate(end)}`, tone: "warning", needsAction: false };
    default:
      // A status LemonSqueezy has grown that this build has never heard of.
      // State the fact we are sure of and claim nothing about renewal — an
      // unknown status must never inherit the reassuring wording by default.
      return { text: `Paid through ${formatDate(end)}`, tone: "neutral", needsAction: false };
  }
}
