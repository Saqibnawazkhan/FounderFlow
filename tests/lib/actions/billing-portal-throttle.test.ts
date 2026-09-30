// @vitest-environment node

/**
 * bill-019 — `createBillingPortalSessionAction` was the one billing action with
 * no rate limit, and it is the one that makes an outbound call on EVERY
 * invocation.
 *
 * `createCheckoutSessionAction` consumes `limiters.write` (lib/actions/billing.ts).
 * The portal action did not, and it reaches `getSubscription()` — a live
 * LemonSqueezy API request — before it can return anything. The only brake in
 * the product was the `busy` flag on the settings screen
 * (`app/(app)/settings/settings-client.tsx`), which is client state: a direct
 * POST to the server action ignores it entirely. So a single signed-in admin
 * could spend the DEPLOYMENT's LemonSqueezy quota, which is shared by every
 * other workspace on it — checkout and portal would then fail for tenants who
 * did nothing.
 *
 * WHY THESE ASSERTIONS AND NOT A STRUCTURAL ONE. `@/lib/rate-limit` is NOT
 * mocked here; the bucket is the real one and the count is the count an admin
 * hits. A test that greps the source for `limiters.write` cannot tell a wired
 * gate from an import, and this repo has shipped that exact shape repeatedly.
 * The load-bearing assertion is therefore not "the call was refused" but "the
 * OUTBOUND CALL DID NOT HAPPEN" — that is the resource the finding is about.
 *
 * Two counter-assertions guard against over-tightening: the portal shares one
 * budget with checkout (both are `limiters.write` keyed on the user id, so an
 * admin cannot get a fresh allowance by alternating the two buttons), and a
 * second admin in the same workspace is never refused for the first one's
 * hammering — the key is the user, not the company.
 *
 * NODE ENVIRONMENT: nothing renders, and the action module pulls in the
 * LemonSqueezy SDK and next-auth shapes that have no business in a DOM.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  session: { value: null as unknown },
  /** Every outbound LemonSqueezy request this file provoked. */
  outbound: [] as string[],
  company: {
    id: "c_nimbus",
    name: "Nimbus",
    plan: "free",
    subscriptionStatus: null as string | null,
    currentPeriodEnd: null as Date | null,
    billingSubscriptionId: "sub_9001",
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    company: {
      findFirst: async () => H.company,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ auth: async () => H.session.value }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
// Billing is key-driven and OFF in the test env, so the real config module
// would short-circuit both actions before the gate is ever reached.
vi.mock("@/lib/lemonsqueezy/config", () => ({
  isBillingConfigured: () => true,
  LS_STORE_ID: "store_1",
  LS_VARIANT_ID_TEAM: "variant_1",
  APP_URL: "https://app.founderflow.com",
}));
vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  lemonSqueezySetup: vi.fn(),
  getSubscription: async (id: string) => {
    H.outbound.push(`getSubscription:${id}`);
    return {
      data: { data: { attributes: { urls: { customer_portal: "https://ls.test/portal" } } } },
      error: null,
    };
  },
  createCheckout: async () => {
    H.outbound.push("createCheckout");
    return { data: { data: { attributes: { url: "https://ls.test/checkout" } } }, error: null };
  },
}));

import {
  createBillingPortalSessionAction,
  createCheckoutSessionAction,
} from "@/lib/actions/billing";
import { limiters } from "@/lib/rate-limit";

type Result = { success: boolean; error?: string };

/** `limiters.write` — 60 per user per minute (lib/rate-limit.ts). */
const WRITE_LIMIT = 60;

function signedInAs(id: string): void {
  H.session.value = {
    user: { id, companyId: "c_nimbus", role: "admin", email: "ayesha@nimbus.app" },
  };
}

function refused(r: Result): boolean {
  return r.success === false && /Too many requests/.test(r.error ?? "");
}

beforeEach(() => {
  limiters.write.reset();
  H.outbound.length = 0;
  H.company.plan = "free";
  H.company.subscriptionStatus = null;
  H.company.currentPeriodEnd = null;
  H.company.billingSubscriptionId = "sub_9001";
  signedInAs("u_ayesha");
});

describe("bill-019 — the billing portal action is rate limited", () => {
  it("stops making outbound LemonSqueezy requests once the write budget is spent", async () => {
    for (let i = 0; i < WRITE_LIMIT; i++) {
      const r = (await createBillingPortalSessionAction()) as Result;
      expect(r.success).toBe(true);
    }
    expect(H.outbound).toHaveLength(WRITE_LIMIT);

    // The 61st click in the same minute. The point of the finding is the
    // outbound call, so assert the quota first and the message second.
    const over = (await createBillingPortalSessionAction()) as Result;
    expect(H.outbound).toHaveLength(WRITE_LIMIT);
    expect(refused(over)).toBe(true);
  });

  it("refuses a scripted loop long before it can drain the deployment's quota", async () => {
    for (let i = 0; i < 500; i++) await createBillingPortalSessionAction();
    expect(H.outbound.length).toBeLessThanOrEqual(WRITE_LIMIT);
  });

  it("shares one budget with checkout, so alternating the two buttons buys nothing", async () => {
    // Half the budget on the portal…
    for (let i = 0; i < WRITE_LIMIT / 2; i++) {
      expect(((await createBillingPortalSessionAction()) as Result).success).toBe(true);
    }
    // …the other half on checkout. `plan: "free"` so checkout gets as far as
    // the outbound call rather than the "already on Team" refusal.
    for (let i = 0; i < WRITE_LIMIT / 2; i++) {
      expect(((await createCheckoutSessionAction()) as Result).success).toBe(true);
    }
    expect(refused((await createBillingPortalSessionAction()) as Result)).toBe(true);
    expect(refused((await createCheckoutSessionAction()) as Result)).toBe(true);
  });

  it("does not refuse a second admin because the first one hammered it", async () => {
    for (let i = 0; i < WRITE_LIMIT + 5; i++) await createBillingPortalSessionAction();
    signedInAs("u_bilal");
    const bilal = (await createBillingPortalSessionAction()) as Result;
    expect(bilal.success).toBe(true);
  });

  it("still answers the first honest click with a portal URL", async () => {
    const r = (await createBillingPortalSessionAction()) as Result & {
      data?: { url: string };
    };
    expect(r.success).toBe(true);
    expect(r.data?.url).toBe("https://ls.test/portal");
  });

  it("does not spend the budget on a non-admin, who never reaches the API anyway", async () => {
    H.session.value = {
      user: { id: "u_member", companyId: "c_nimbus", role: "member", email: "m@nimbus.app" },
    };
    const r = (await createBillingPortalSessionAction()) as Result;
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Only the workspace admin/);
    expect(H.outbound).toHaveLength(0);
  });
});
