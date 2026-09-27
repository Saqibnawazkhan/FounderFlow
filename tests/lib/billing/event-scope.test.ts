/**
 * bill-006 - "a test card buys a real plan".
 *
 * THE BUG THIS ENCODES. The webhook read exactly four attributes off a
 * subscription payload - `status`, `customer_id`, `ends_at`, `renews_at` - and
 * ignored `test_mode`, `store_id`, `product_id` and `variant_id`, all of which
 * are present on every delivery. Two free-money paths followed:
 *
 *   1. LemonSqueezy delivers TEST-MODE events to the same store webhook, signed
 *      with the same secret. A test checkout uses a test card, moves no money,
 *      and wrote plan="team". Anyone who ever sees a test buy link - or any
 *      operator who leaves the store in test mode after go-live - mints free
 *      Team workspaces.
 *   2. The moment the store gains a second, cheaper product - a $1 add-on, a
 *      discounted annual trial - buying THAT granted Team, because the handler
 *      could not tell one product from another.
 *
 * Both were silent. `lib/lemonsqueezy/config.ts` has exported LS_STORE_ID and
 * LS_VARIANT_ID_TEAM the whole time; the webhook simply never imported them.
 *
 * THE RULE THESE TESTS PIN. The scope check runs after signature verification
 * and BEFORE identity resolution, because an event for someone else's store is
 * not a workspace-identity question at all. And a variant grants a plan only
 * through an explicit table, so adding a second paid tier is a data change
 * rather than a security change.
 */

import { describe, expect, it } from "vitest";
import {
  decideEventScope,
  isLiveDeployment,
  variantPlanTable,
  type EventScopeInput,
} from "@/lib/billing/event-scope";

const STORE = "90210";
const TEAM_VARIANT = "555001";

function input(over: Partial<EventScopeInput> = {}): EventScopeInput {
  return {
    testMode: false,
    storeId: STORE,
    variantId: TEAM_VARIANT,
    expectedStoreId: STORE,
    variantPlans: variantPlanTable(TEAM_VARIANT),
    liveDeployment: true,
    ...over,
  };
}

describe("decideEventScope - test mode", () => {
  it("REFUSES a test-mode event on a deployment that takes real money", () => {
    const v = decideEventScope(input({ testMode: true }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("test-mode");
  });

  it("ACCEPTS a test-mode event on a non-live deployment", () => {
    // Preview/local deployments are how the flow is developed at all, so the
    // gate is on the deployment, not on the payload alone.
    expect(decideEventScope(input({ testMode: true, liveDeployment: false })).ok).toBe(true);
  });

  it("ACCEPTS a live event on a live deployment", () => {
    expect(decideEventScope(input()).ok).toBe(true);
  });

  it("treats an ABSENT test_mode as live rather than as test", () => {
    // Fail in the direction that costs money to attack, not in the direction
    // that gives it away: an omitted flag must not read as "this is only a
    // test, block it"... and must not read as "definitely test mode, allow it
    // through on prod" either. Absent = not test = normal handling.
    expect(decideEventScope(input({ testMode: null })).ok).toBe(true);
    expect(decideEventScope(input({ testMode: null, liveDeployment: false })).ok).toBe(true);
  });
});

describe("decideEventScope - store and variant", () => {
  it("REFUSES an event from another store", () => {
    const v = decideEventScope(input({ storeId: "1" }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("foreign-store");
  });

  it("REFUSES a subscription for a product we do not sell a plan for", () => {
    // The $1 add-on case. 424242 is not in the table, so it buys nothing.
    const v = decideEventScope(input({ variantId: "424242" }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("foreign-variant");
  });

  it("reports which plan the variant bought", () => {
    const v = decideEventScope(input());
    expect(v.ok && v.plan).toBe("team");
  });

  it("ACCEPTS an event with no variant_id and reports no plan", () => {
    // Invoice-shaped payloads (subscription_payment_failed and friends) carry a
    // store id and a subscription id but no variant. They are still OURS, they
    // just cannot be used to derive a plan - which is exactly what `plan: null`
    // says to the caller.
    const v = decideEventScope(input({ variantId: null }));
    expect(v.ok).toBe(true);
    expect(v.ok && v.plan).toBeNull();
  });

  it("skips the checks it has no configuration for, and says so", () => {
    // A deployment can have LEMONSQUEEZY_WEBHOOK_SECRET without the store or
    // variant ids (isWebhookConfigured only requires the secret). Hard-failing
    // there would break every such deployment; silently passing would hide the
    // hole. The verdict carries `enforced` so the route can raise it.
    const v = decideEventScope(
      input({
        expectedStoreId: "",
        variantPlans: variantPlanTable(""),
        storeId: "1",
        variantId: "9",
      })
    );
    expect(v.ok).toBe(true);
    expect(v.ok && v.enforced).toBe(false);

    // …and the fully configured case does report itself as enforced, so the
    // assertion above is about configuration and not about `enforced` always
    // being false.
    const configured = decideEventScope(input());
    expect(configured.ok && configured.enforced).toBe(true);
  });

  it("checks test mode even when store and variant are unconfigured", () => {
    // Test mode needs no configuration to judge - it is on the payload. Losing
    // it along with the store check would be the worst of both worlds.
    const v = decideEventScope(
      input({ expectedStoreId: "", variantPlans: variantPlanTable(""), testMode: true })
    );
    expect(v.ok).toBe(false);
  });

  it("compares ids as strings, because JSON gives them as numbers", () => {
    // store_id and variant_id arrive as JSON numbers; the env vars are strings.
    // `90210 !== "90210"` is how a correct-looking check fails open.
    expect(decideEventScope(input({ storeId: String(90210), variantId: String(555001) })).ok).toBe(
      true
    );
  });
});

describe("variantPlanTable", () => {
  it("maps the configured Team variant to the team plan", () => {
    expect(variantPlanTable(TEAM_VARIANT).get(TEAM_VARIANT)).toBe("team");
  });

  it("is empty when nothing is configured, rather than mapping the empty string", () => {
    // `variantPlans.get("")` matching an event with no variant id would be a
    // silent grant on an unconfigured deployment.
    expect(variantPlanTable("").size).toBe(0);
  });
});

describe("isLiveDeployment", () => {
  it("is true on Vercel production", () => {
    expect(isLiveDeployment({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(true);
  });

  it("is false on a Vercel preview, even though NODE_ENV is production there", () => {
    // Preview builds run a production Next.js build. Gating on NODE_ENV alone
    // would make every preview reject the test-mode events it exists to try.
    expect(isLiveDeployment({ VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(false);
  });

  it("is true for a self-hosted production build with no VERCEL_ENV", () => {
    expect(isLiveDeployment({ NODE_ENV: "production" })).toBe(true);
  });

  it("is false in local development", () => {
    expect(isLiveDeployment({ NODE_ENV: "development" })).toBe(false);
    expect(isLiveDeployment({})).toBe(false);
  });
});
