/**
 * What should a subscription event actually WRITE? (bill-002, bill-003, bill-007)
 *
 * `lib/billing/webhook-identity.ts` answers "whose workspace is this?". This
 * module answers the question after it: "given what we already hold, is this
 * event news, and which columns does it get to touch?". The route used to answer
 * both by assuming the answer was always "yes, all of them".
 *
 * THE THREE TRAPS THIS EXISTS TO AVOID.
 *
 * bill-002 — REPLAY. The handler applied whatever it was handed, every time it
 * was handed it. There is no ledger of delivered event ids, and a LemonSqueezy
 * HMAC signature never expires, so one captured `active` delivery — from a proxy
 * log, the ngrok tunnel documented in .env.local.example, a mis-scoped Sentry
 * breadcrumb, or the LemonSqueezy dashboard's own "resend" button — was a
 * permanent free Team licence. Re-POST it after `subscription_expired` and the
 * workspace flipped back to paid with the old `renews_at` restored.
 *
 * bill-003 — OUT OF ORDER. The same root cause with no attacker at all. The
 * route answers 500 on a transient failure *on purpose* so LemonSqueezy retries,
 * so it deliberately manufactures delayed redeliveries. Real sequence: a DB blip
 * 500s the `subscription_expired` for sub_10; the customer resubscribes minutes
 * later and sub_11 applies correctly; the backoff then lands the old expiry and
 * the paying customer is set to plan="free" with `billingSubscriptionId`
 * repointed at a dead subscription — so their "Manage billing" button resolves a
 * subscription that no longer exists, and recovery needs hand-written SQL
 * because `plan` has no in-app writer.
 *
 * bill-007 — ABSENT MEANT NULL. Every column was written on every event:
 * `currentPeriodEnd: periodEnd ? new Date(periodEnd) : null`. An event that
 * merely OMITS `renews_at` therefore erased the customer's paid-through date,
 * and the same pattern on `billingCustomerId` orphaned the workspace from its
 * subscription for good (that column is the identity resolver's last-resort
 * anchor, so nulling it makes every later event without custom_data
 * unresolvable — the workspace then never downgrades and never updates again).
 *
 * WHAT THIS CANNOT DO, AND WHY. A real replay guard needs a ledger of delivered
 * event ids, unique on (provider, eventId), inserted in the same transaction as
 * the Company update so a duplicate fails on the unique constraint. That is a
 * new table, and this change is not permitted to add one. So every rule below is
 * built ONLY from state already on the Company row, and the residual gap is
 * stated plainly: replaying a delivery that is still CURRENT is not detected
 * here. That is tolerable precisely because it is idempotent — it re-writes the
 * same values — but it is not the same as being airtight, and there is no audit
 * record of what was skipped beyond the Sentry breadcrumb the route raises. The
 * DDL for the ledger is in the delivery follow-ups.
 *
 * Pure and I/O-free for the same reason as its two sibling modules: the route
 * handler cannot be unit-tested without a Prisma client, so the judgement has to
 * live where a test can reach it. See tests/lib/billing/subscription-write.test.ts.
 */

import {
  isPaidSubscriptionStatus,
  isTerminalSubscriptionStatus,
  accessGraceDays,
  normalizePlan,
  type Plan,
} from "@/lib/billing/plan";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The billing state already stored on the resolved workspace. */
export interface StoredBillingState {
  plan: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  billingSubscriptionId: string | null;
}

/** A subscription event, after the route has parsed and scoped it. */
export interface IncomingSubscriptionEvent {
  /** `data.id`. Provider-assigned, never null by the time it reaches here. */
  subscriptionId: string;
  /** `attributes.status`, verbatim. */
  status: string;
  /** `attributes.customer_id`, stringified, or null when the payload omitted it. */
  customerId: string | null;
  /** `ends_at ?? renews_at`, parsed. Null = the key was there and empty. */
  periodEnd: Date | null;
  /** True when the payload carried NEITHER `ends_at` NOR `renews_at`. bill-007. */
  periodEndAbsent: boolean;
  /** The plan the purchased variant maps to, or null when unmappable. bill-006. */
  variantPlan: Plan | null;
}

export type SubscriptionWriteSkip =
  /** A paid status arriving for a subscription we already recorded as dead. */
  | "replay-after-terminal"
  /** An event about a subscription this workspace has already moved on from. */
  | "superseded-subscription";

/** Only the columns an event is allowed to touch. Keys absent = leave alone. */
export interface SubscriptionWriteData {
  plan: Plan;
  subscriptionStatus: string;
  /**
   * Always present, always non-null. An unbound workspace is the most
   * attractive forgery target there is (see lib/billing/webhook-identity.ts), so
   * nothing here may ever be the thing that unbinds one.
   */
  billingSubscriptionId: string;
  billingCustomerId?: string;
  currentPeriodEnd?: Date | null;
}

export type SubscriptionWriteDecision =
  | { apply: false; reason: SubscriptionWriteSkip }
  | {
      apply: true;
      data: SubscriptionWriteData;
      /**
       * True when the event's OWN paid-through date has already passed, so a
       * paid status was downgraded to free rather than honoured. This is the
       * date half of the replay guard and it is worth logging: it means we were
       * handed a statement about a period that is over.
       */
      lapsed: boolean;
      /**
       * True when `status` is neither on the paid list nor terminal — `paused`
       * today, or anything LemonSqueezy grows tomorrow. The plan column was HELD
       * rather than decided, so this is the signal that our status vocabulary has
       * fallen behind the provider's. bill-020.
       */
      unrecognisedStatus: boolean;
    };

/**
 * Pull the period end out of a raw attributes bag, distinguishing ABSENT from
 * PRESENT-AND-NULL. That distinction IS bill-007: absent is silence and must
 * leave the stored value alone; present-and-null is a statement ("there is no
 * next date") and is written.
 *
 * `ends_at` wins over `renews_at` because it is only ever set once a
 * subscription has been cancelled, at which point it is the date that matters.
 *
 * An unparseable date counts as ABSENT, not as an Invalid Date: handing one to
 * Prisma throws, the route's catch answers 500, and LemonSqueezy then retries
 * the same unparseable payload on a backoff for ever. Dropping just the date
 * lets the rest of the event apply.
 *
 * bill-010, THE SECOND HALF. "Unreadable" therefore behaves exactly like
 * "absent" — the stored date is left alone and nothing throws — but it is not
 * the same EVENT. Absent is the provider saying nothing; unreadable is the
 * provider saying something we could not understand, which means the customer's
 * paid-through date is now stale and we are the only ones who know. So the two
 * are reported separately: `absent` drives the write (bill-007), `unreadable`
 * drives the record. Collapsing them was why a malformed date could be dropped
 * with no trace beyond a `currentPeriodEnd` nobody could explain.
 */
export function readPeriodEnd(attrs: Record<string, unknown>): {
  periodEnd: Date | null;
  absent: boolean;
  /** A period key WAS present and could not be read as a date. bill-010. */
  unreadable: boolean;
} {
  const hasEnds = Object.prototype.hasOwnProperty.call(attrs, "ends_at");
  const hasRenews = Object.prototype.hasOwnProperty.call(attrs, "renews_at");
  if (!hasEnds && !hasRenews) return { periodEnd: null, absent: true, unreadable: false };

  const raw = hasEnds && attrs.ends_at != null ? attrs.ends_at : attrs.renews_at;
  if (typeof raw !== "string" || raw.length === 0) {
    // Both keys present and empty: a real statement, so not absent.
    if (raw == null) return { periodEnd: null, absent: false, unreadable: false };
    // A number or object where a date string belongs — we cannot trust it, and
    // we must not turn it into 1970 or an Invalid Date. An empty string lands
    // here too: it is present-but-unusable, which is not the same statement as
    // an explicit `null`, so it leaves the stored date alone AND gets reported.
    return { periodEnd: null, absent: true, unreadable: true };
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { periodEnd: null, absent: true, unreadable: true };
  return { periodEnd: parsed, absent: false, unreadable: false };
}

/**
 * The whole rule. Order matters: the two refusals come before any plan is
 * computed, because a stale event must not even be allowed to have an opinion.
 */
export function decideSubscriptionWrite(
  stored: StoredBillingState,
  event: IncomingSubscriptionEvent,
  now: Date = new Date()
): SubscriptionWriteDecision {
  const sameSubscription = stored.billingSubscriptionId === event.subscriptionId;
  const storedIsTerminal = isTerminalSubscriptionStatus(stored.subscriptionStatus);

  // ---- bill-002: a subscription cannot come back from the dead ------------
  // `expired` / `unpaid` are one-way doors (LemonSqueezy mints a NEW id on
  // resubscribe), so a paid status for an id we have already recorded as dead
  // can only be a replay. A LATER terminal event is still accepted: `expired`
  // twice, or `unpaid` after `expired`, restores nothing and refusing it would
  // leave the stored status behind the truth.
  if (sameSubscription && storedIsTerminal && !isTerminalSubscriptionStatus(event.status)) {
    return { apply: false, reason: "replay-after-terminal" };
  }

  // ---- bill-003: a rebinding must be a plausible SUCCESSOR ----------------
  // A rebinding is the one write here that destroys information (the existing
  // binding), and the workspace's own state is the only clock we have. So while
  // the stored subscription is still live, an event about a DIFFERENT
  // subscription only gets to take over if it is a step forward:
  //
  //   • a terminal event for another id cannot be a statement about ours —
  //     an `expired` for sub_10 says nothing whatever about sub_11;
  //   • a paid-through date EARLIER than the one we hold is going backwards;
  //   • no date at all gives us nothing to judge on, and "refuse and alert"
  //     beats "clobber a live paying binding and hope".
  //
  // A genuine plan change (new id, later renewal) passes all three, which is
  // what keeps these rules from collapsing into "never rebind".
  if (!sameSubscription && stored.billingSubscriptionId !== null && !storedIsTerminal) {
    const incomingIsTerminal = isTerminalSubscriptionStatus(event.status);
    const goesBackwards = Boolean(
      stored.currentPeriodEnd &&
      event.periodEnd &&
      event.periodEnd.getTime() < stored.currentPeriodEnd.getTime()
    );
    const undatable = event.periodEndAbsent || event.periodEnd === null;
    if (incomingIsTerminal || goesBackwards || undatable) {
      return { apply: false, reason: "superseded-subscription" };
    }
  }

  // ---- bill-004, write side: a paid status is not a blank cheque -----------
  // The event's own paid-through date bounds what it can grant. This is also the
  // half of the replay guard that needs no stored state at all: a replayed
  // `active` carries the OLD `renews_at`, so by the time replaying it is worth
  // anything, the date it claims to be paid through has passed.
  const accessEndsAt = event.periodEnd
    ? new Date(event.periodEnd.getTime() + accessGraceDays(event.status) * MS_PER_DAY)
    : null;
  const lapsed = Boolean(accessEndsAt && accessEndsAt.getTime() <= now.getTime());

  // ---- bill-020: three outcomes, not two ----------------------------------
  // This used to be `isPaidSubscriptionStatus(status) && !lapsed ? plan : "free"`
  // — an allow-list of four strings deciding entitlement with no reference to
  // the funded date for anything OFF the list. Two things fell through it.
  //
  // `paused` is the one the customer feels. `effectivePlan` on the read side
  // never consults this predicate: it takes access away only for a terminal
  // status or an expired date, so a paused subscription with a future date keeps
  // Team there, and `describeBillingPeriod` has a "Paused - resumes {date}"
  // branch for exactly that row. This writer was the only thing preventing that
  // state from existing — `subscription_paused` wrote `plan: "free"` on arrival,
  // mid-period, so pausing (LemonSqueezy's own retention button, reachable from
  // the portal this app links to) was punished HARDER than cancelling, and the
  // copy branch was unreachable.
  //
  // The other is worse because it is silent and unbounded: any status the
  // provider adds later is also off the list, so a vocabulary change at
  // LemonSqueezy would de-licence every workspace it reached.
  //
  // So: terminal or lapsed revokes; a paid status grants what the variant buys;
  // and a status that is NEITHER holds what we already had. Holding is the
  // fail-safe reading in both directions — "not terminal, therefore team" would
  // have handed paid features to a free workspace off an unrecognised word.
  // `isPaidSubscriptionStatus("paused")` stays FALSE on purpose: it answers "is
  // money moving", which it is not. Entitlement is the date's job.
  const statusIsTerminal = isTerminalSubscriptionStatus(event.status);
  const statusIsPaid = isPaidSubscriptionStatus(event.status);
  const unrecognisedStatus = !statusIsTerminal && !statusIsPaid;
  const plan: Plan = statusIsTerminal
    ? "free"
    : lapsed
      ? "free"
      : statusIsPaid
        ? (event.variantPlan ?? "team")
        : normalizePlan(stored.plan);

  // ---- bill-007: build the data object CONDITIONALLY ----------------------
  const data: SubscriptionWriteData = {
    plan,
    subscriptionStatus: event.status,
    billingSubscriptionId: event.subscriptionId,
  };
  // Only ever set, never cleared — nulling this orphans the workspace from its
  // subscription permanently.
  if (event.customerId) data.billingCustomerId = event.customerId;
  // Absent = unchanged. Present-and-null = explicitly cleared.
  if (!event.periodEndAbsent) data.currentPeriodEnd = event.periodEnd;

  return { apply: true, data, lapsed, unrecognisedStatus };
}
