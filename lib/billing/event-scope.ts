/**
 * Is this webhook delivery even about something we sell? (bill-006)
 *
 * THE TRAP THIS EXISTS TO AVOID. The webhook read exactly four attributes off a
 * subscription payload — `status`, `customer_id`, `ends_at`, `renews_at` — and
 * ignored `test_mode`, `store_id`, `product_id` and `variant_id`, every one of
 * which is present on every delivery. `lib/lemonsqueezy/config.ts` had exported
 * `LS_STORE_ID` and `LS_VARIANT_ID_TEAM` the whole time; the route simply never
 * imported them. Two free-money paths followed, both silent:
 *
 *   1. TEST MODE. LemonSqueezy delivers test-mode events to the same store
 *      webhook, signed with the same secret. A test checkout uses a test card,
 *      moves no money, and wrote `plan = "team"`. Anyone who ever obtains a
 *      test buy link — or any operator who leaves the store in test mode after
 *      go-live — mints free Team workspaces.
 *
 *   2. THE WRONG PRODUCT. The moment the store gains a second, cheaper product
 *      — a $1 add-on, a discounted annual trial, anything — buying THAT granted
 *      Team, because the handler could not tell one product from another.
 *
 * WHERE THIS RUNS, AND WHY THERE. After signature verification, BEFORE identity
 * resolution. An event for someone else's store is not a workspace-identity
 * question at all, and letting it reach `resolveWebhookCompany` would turn
 * ordinary foreign traffic into `boundary: billing-forgery` pages for on-call.
 *
 * Pure and I/O-free, like `lib/billing/plan.ts` and
 * `lib/billing/webhook-identity.ts`: the route handler cannot be unit-tested
 * without a Prisma client, so every judgement it makes has to live somewhere a
 * test can reach with plain objects. See tests/lib/billing/event-scope.test.ts.
 */

import type { Plan } from "@/lib/billing/plan";

export type EventScopeReason =
  /** A test-mode event on a deployment that takes real money. */
  | "test-mode"
  /** Another LemonSqueezy store entirely. */
  | "foreign-store"
  /** Our store, but a product/variant that does not buy a plan here. */
  | "foreign-variant";

export type EventScopeVerdict =
  | {
      ok: true;
      /**
       * The plan this variant buys, or null when no mapping was possible —
       * either the payload carries no `variant_id` (invoice-shaped events) or
       * the deployment has no variant configured. Null means "do not derive a
       * plan from this event", NOT "this variant grants nothing".
       */
      plan: Plan | null;
      /**
       * False when the store/variant expectations were unconfigured and so were
       * skipped. The route raises this, because a check that silently does
       * nothing is worse than no check: it reads as covered.
       */
      enforced: boolean;
    }
  | { ok: false; reason: EventScopeReason };

export interface EventScopeInput {
  /** `attributes.test_mode`. Null when the payload omitted it. */
  testMode: boolean | null;
  /** `attributes.store_id`, stringified. */
  storeId: string | null;
  /**
   * `attributes.variant_id`, stringified. Null on invoice-shaped payloads
   * (`subscription_payment_*`), which carry a store and a subscription id but
   * no variant.
   */
  variantId: string | null;
  /** `LS_STORE_ID`. Empty string means unconfigured — the check is skipped. */
  expectedStoreId: string;
  /** variant id → plan. Empty means unconfigured — the check is skipped. */
  variantPlans: ReadonlyMap<string, Plan>;
  /** True only on a deployment that takes real money. */
  liveDeployment: boolean;
}

/**
 * variant id → plan, as an explicit table.
 *
 * A table rather than an `if (variantId === LS_VARIANT_ID_TEAM)` so that adding
 * a second paid tier is a DATA change (one more env var, one more entry) rather
 * than a security change to the identity path. An empty/unset variant id
 * produces an EMPTY table, never a `"" -> team` entry: a table keyed on the
 * empty string would match an event that carries no variant id at all, which is
 * a silent grant on every unconfigured deployment.
 */
export function variantPlanTable(teamVariantId: string): Map<string, Plan> {
  const table = new Map<string, Plan>();
  if (teamVariantId) table.set(teamVariantId, "team");
  return table;
}

/**
 * Does this deployment take real money?
 *
 * Gating on `NODE_ENV === "production"` alone would be wrong in both directions:
 * Vercel preview builds ARE production Next.js builds (so every preview would
 * reject the test-mode events it exists to try), and a self-hosted production
 * server has no `VERCEL_ENV` at all (so it would never be treated as live).
 * Same shape as `IS_PROD_BUILD` in scripts/vercel-build.mjs, extended for the
 * self-hosted case.
 */
export function isLiveDeployment(
  env: { VERCEL_ENV?: string; NODE_ENV?: string } = process.env
): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production";
  return env.NODE_ENV === "production";
}

/** The whole rule, as a pure function. */
export function decideEventScope(input: EventScopeInput): EventScopeVerdict {
  // Test mode is judged FIRST and needs no configuration to judge — the flag is
  // on the payload. Losing it alongside an unconfigured store check would be
  // the worst of both worlds: the one free-money path that needs no store setup
  // at all would be the one that goes unchecked.
  //
  // An ABSENT flag reads as "not test mode", i.e. ordinary handling. That is the
  // safe direction: the alternative (absent → assume test) would let anyone
  // suppress a real downgrade by omitting a field.
  if (input.testMode === true && input.liveDeployment) {
    return { ok: false, reason: "test-mode" };
  }

  const checksStore = input.expectedStoreId.length > 0;
  const checksVariant = input.variantPlans.size > 0;

  // Compare as STRINGS. `store_id` and `variant_id` arrive as JSON numbers and
  // the env vars are strings, and `90210 !== "90210"` is exactly how a
  // correct-looking equality check fails open.
  if (checksStore && input.storeId !== input.expectedStoreId) {
    return { ok: false, reason: "foreign-store" };
  }

  // No variant id on the payload (invoice events): in scope, but it cannot say
  // which plan was bought.
  if (input.variantId === null) {
    return { ok: true, plan: null, enforced: checksStore };
  }

  if (!checksVariant) {
    // Unconfigured. Pass, but say so, so the route can raise it rather than let
    // the gap read as covered.
    return { ok: true, plan: null, enforced: false };
  }

  const plan = input.variantPlans.get(input.variantId);
  if (!plan) return { ok: false, reason: "foreign-variant" };

  return { ok: true, plan, enforced: checksStore && checksVariant };
}
