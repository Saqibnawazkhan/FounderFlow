/**
 * bill-001 - "whoever pays decides which workspace they bought".
 *
 * THE BUG THIS ENCODES. A LemonSqueezy hosted buy link accepts arbitrary
 * checkout custom data from whoever opens it:
 *
 *   https://store.lemonsqueezy.com/buy/<uuid>?checkout[custom][company_id]=<anything>
 *
 * LemonSqueezy then faithfully signs a webhook whose `meta.custom_data`
 * contains that value. The signature is therefore NOT evidence of ownership:
 * it proves the event came from LemonSqueezy, and nothing at all about which
 * workspace the payer is entitled to. The old `resolveCompanyId` returned
 * `meta.custom_data.company_id` verbatim (`if (typeof fromCustom === "string"
 * && fromCustom) return fromCustom;`) and the write was an unqualified
 * `updateMany({ where: { id: companyId } })`, so a stranger could point a
 * cheap checkout at someone else's workspace id and take over its billing row:
 * plan, subscription id and customer id all overwritten. The victim's "Manage
 * billing" button then opened the STRANGER's portal, because that button
 * resolves the portal from `Company.billingSubscriptionId`.
 *
 * THE RULE THESE TESTS PIN. The subscription id (`data.id`, assigned by
 * LemonSqueezy, never by the buyer) is the only trustworthy identifier in the
 * payload. So: resolve by it first; accept the buyer's `company_id` claim ONLY
 * when the named workspace is unclaimed (`billingSubscriptionId === null`, a
 * genuine first activation) or already bound to this very subscription (a
 * replay / renewal); refuse everything else, loudly.
 *
 * Why the last block reads route.ts as text instead of calling it: a Next.js
 * route handler may only export the HTTP verbs, so it cannot export a constant
 * for a test to inspect, and importing it drags in the Prisma client.
 * tests/lib/db/purge-invariants.test.ts and tests/lib/db/script-safety.test.ts
 * already use source-text assertions for exactly this reason. The pure
 * resolver carries the behaviour; those tests only prove the route is WIRED to
 * it and has not quietly regrown the verbatim-trust line.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideWebhookCompany,
  identityWriteGuard,
  readClaimedCompanyId,
  resolveWebhookCompany,
  type BillingCompanyRow,
  type CompanyBillingLookup,
} from "@/lib/billing/webhook-identity";

/** A Company row as the billing lookup selects it. Unbound + live by default. */
function company(over: Partial<BillingCompanyRow> & { id: string }): BillingCompanyRow {
  return {
    billingSubscriptionId: null,
    billingCustomerId: null,
    deletedAt: null,
    ...over,
  };
}

/**
 * In-memory stand-in for the Prisma lookup. Deliberately does NOT filter
 * tombstoned rows - same as the real one - because the whole point is that the
 * decision must be able to tell "tombstoned" apart from "does not exist" and
 * refuse the first rather than letting a claim slide in behind it.
 */
function fakeLookup(rows: BillingCompanyRow[]): CompanyBillingLookup {
  return {
    byId: async (id) => rows.find((r) => r.id === id) ?? null,
    bySubscriptionId: async (subId) => rows.find((r) => r.billingSubscriptionId === subId) ?? null,
    byCustomerId: async (custId) => rows.find((r) => r.billingCustomerId === custId) ?? null,
  };
}

describe("readClaimedCompanyId", () => {
  it("reads a non-empty string claim out of custom_data", () => {
    expect(readClaimedCompanyId({ company_id: "cmp_a" })).toBe("cmp_a");
  });

  it("returns null for absent, empty, or non-string claims", () => {
    expect(readClaimedCompanyId(undefined)).toBeNull();
    expect(readClaimedCompanyId(null)).toBeNull();
    expect(readClaimedCompanyId({})).toBeNull();
    expect(readClaimedCompanyId({ company_id: "" })).toBeNull();
    // LemonSqueezy stringifies custom data, but a hand-crafted checkout link
    // can produce an array or object here. Never coerce - coercion is how
    // "[object Object]" becomes a company id.
    expect(readClaimedCompanyId({ company_id: 123 })).toBeNull();
    expect(readClaimedCompanyId({ company_id: ["cmp_a"] })).toBeNull();
    expect(readClaimedCompanyId("cmp_a")).toBeNull();
  });
});

describe("decideWebhookCompany - the forgery gate", () => {
  it("REJECTS a forged company_id aimed at an already-subscribed workspace (bill-001)", async () => {
    // The attack, end to end: victim already pays (sub_victim). The attacker
    // opens the buy link with ?checkout[custom][company_id]=cmp_victim and
    // pays for sub_attacker. LemonSqueezy signs it, so the HMAC check passes.
    const victim = company({
      id: "cmp_victim",
      billingSubscriptionId: "sub_victim",
      billingCustomerId: "cus_victim",
    });
    const identity = await resolveWebhookCompany(
      {
        subscriptionId: "sub_attacker",
        customerId: "cus_attacker",
        customData: { company_id: "cmp_victim" },
      },
      fakeLookup([victim])
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("forged-claim");
    // `forged` is what makes the route answer 400 and page on-call instead of
    // shrugging with a 200.
    expect(identity.forged).toBe(true);
    expect(identity.claimedCompanyId).toBe("cmp_victim");
  });

  it("ACCEPTS a genuine first activation (claimed workspace has no subscription yet)", async () => {
    const mine = company({ id: "cmp_mine" });
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_new", customerId: "cus_new", customData: { company_id: "cmp_mine" } },
      fakeLookup([mine])
    );

    expect(identity).toEqual({ ok: true, companyId: "cmp_mine", via: "first-activation" });
  });

  it("ACCEPTS a replay/renewal naming the subscription it already owns", async () => {
    // subscription_updated / _cancelled / _resumed all re-send the original
    // custom_data. Resolution must be idempotent, not one-shot.
    const mine = company({
      id: "cmp_mine",
      billingSubscriptionId: "sub_mine",
      billingCustomerId: "cus_mine",
    });
    const identity = await resolveWebhookCompany(
      {
        subscriptionId: "sub_mine",
        customerId: "cus_mine",
        customData: { company_id: "cmp_mine" },
      },
      fakeLookup([mine])
    );

    expect(identity).toEqual({ ok: true, companyId: "cmp_mine", via: "subscription" });
  });

  it("REFUSES a soft-deleted workspace named by a claim", async () => {
    // A tombstoned workspace is inside its 90-day recovery window. Writing a
    // paid plan onto it would resurrect billing state on a row ops believes is
    // gone - and an unbound tombstone is the most attractive forgery target of
    // all, since nothing is there to conflict with.
    const dead = company({ id: "cmp_dead", deletedAt: new Date("2026-09-01T00:00:00Z") });
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_new", customerId: "cus_new", customData: { company_id: "cmp_dead" } },
      fakeLookup([dead])
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("company-deleted");
    expect(identity.forged).toBe(true);
  });

  it("REFUSES a soft-deleted workspace reached through its own subscription id", async () => {
    // Same refusal, innocent cause: a real subscriber deleted their workspace
    // and the renewal webhook keeps arriving. No write, but not forgery either.
    const dead = company({
      id: "cmp_dead",
      billingSubscriptionId: "sub_dead",
      deletedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_dead", customerId: "cus_dead", customData: null },
      fakeLookup([dead])
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("company-deleted");
    expect(identity.forged).toBe(false);
  });

  it("REJECTS a claim that names no workspace at all", async () => {
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_new", customerId: "cus_new", customData: { company_id: "cmp_ghost" } },
      fakeLookup([company({ id: "cmp_other" })])
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("claim-unknown");
    // Nobody invents a cuid by accident - treat it as probing.
    expect(identity.forged).toBe(true);
  });

  it("REJECTS a claim that disagrees with the subscription's recorded owner", async () => {
    // The subscription is already bound to cmp_a, but custom_data says cmp_b.
    // Resolving by subscription id alone would be SAFE here, yet we still
    // refuse: the two identifiers contradicting each other means something is
    // tampering with a flow that is supposed to be closed, and silently
    // picking a winner would hide it.
    const rows = [
      company({ id: "cmp_a", billingSubscriptionId: "sub_1", billingCustomerId: "cus_a" }),
      company({ id: "cmp_b", billingSubscriptionId: "sub_2", billingCustomerId: "cus_b" }),
    ];
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_1", customerId: "cus_a", customData: { company_id: "cmp_b" } },
      fakeLookup(rows)
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("forged-claim");
    expect(identity.forged).toBe(true);
  });

  it("falls back to the provider-assigned customer id when there is no claim", async () => {
    // Portal-driven events can arrive without custom_data, and a plan change
    // can mint a NEW subscription id. customer_id is assigned by LemonSqueezy
    // from the paying account, so unlike company_id it is not buyer-forgeable.
    const mine = company({
      id: "cmp_mine",
      billingSubscriptionId: "sub_old",
      billingCustomerId: "cus_mine",
    });
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_new", customerId: "cus_mine", customData: null },
      fakeLookup([mine])
    );

    expect(identity).toEqual({ ok: true, companyId: "cmp_mine", via: "customer" });
  });

  it("does not fall back to the customer id once a claim has been rejected", async () => {
    // Otherwise the gate is decorative: forge a claim, get refused, and have
    // the event quietly applied to your own workspace anyway.
    const rows = [
      company({ id: "cmp_victim", billingSubscriptionId: "sub_victim" }),
      company({ id: "cmp_attacker", billingCustomerId: "cus_attacker" }),
    ];
    const identity = await resolveWebhookCompany(
      {
        subscriptionId: "sub_attacker",
        customerId: "cus_attacker",
        customData: { company_id: "cmp_victim" },
      },
      fakeLookup(rows)
    );

    expect(identity.ok).toBe(false);
  });

  it("ignores (without crying forgery) an event it simply cannot place", async () => {
    const identity = await resolveWebhookCompany(
      { subscriptionId: "sub_stranger", customerId: "cus_stranger", customData: null },
      fakeLookup([])
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("unresolvable");
    expect(identity.forged).toBe(false);
  });

  it("refuses to resolve anything when the payload carries no subscription id", async () => {
    // The old code wrote `billingSubscriptionId: sub.id != null ? ... : null`,
    // so a payload with no id NULLED OUT a live binding - which is exactly the
    // state that makes a workspace claimable by the next forged checkout.
    const identity = await resolveWebhookCompany(
      { subscriptionId: null, customerId: "cus_mine", customData: { company_id: "cmp_mine" } },
      fakeLookup([company({ id: "cmp_mine" })])
    );

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("unresolvable");
  });

  it("is a pure function of the evidence it is handed", () => {
    // decideWebhookCompany does no I/O, so the rules can be reasoned about
    // (and fuzzed) without a database anywhere near them.
    expect(
      decideWebhookCompany({
        subscriptionId: "sub_1",
        customerId: "cus_1",
        claimedCompanyId: "cmp_victim",
        bySubscription: null,
        byClaim: company({ id: "cmp_victim", billingSubscriptionId: "sub_other" }),
        byCustomer: null,
      })
    ).toEqual({
      ok: false,
      reason: "forged-claim",
      forged: true,
      claimedCompanyId: "cmp_victim",
    });
  });
});

describe("bill-012 - two workspaces behind one paying customer", () => {
  it("REFUSES to pick one when the customer id matches more than one workspace", () => {
    // The serial-founder / agency case is ordinary, not exotic: one
    // LemonSqueezy customer (one email, one card) subscribing for two
    // workspaces leaves two rows with the same billingCustomerId, and
    // `billingCustomerId` has no unique constraint. The old fallback was
    // `findFirst` with no orderBy, so Postgres returned whichever row it liked
    // and the choice could change between queries: cancel workspace B and
    // workspace A gets downgraded, non-deterministically, so it never
    // reproduces on demand.
    //
    // The only correct answer is to refuse and alert. Guessing right is luck.
    const identity = decideWebhookCompany({
      subscriptionId: "sub_new",
      customerId: "cus_shared",
      claimedCompanyId: null,
      bySubscription: null,
      byClaim: null,
      byCustomer: null,
      customerAmbiguous: true,
    });

    expect(identity.ok).toBe(false);
    if (identity.ok) return;
    expect(identity.reason).toBe("customer-ambiguous");
    // Not forgery: the customer did nothing wrong, our data model did. A 400 +
    // page-on-call would be the wrong response to an ordinary billing shape.
    expect(identity.forged).toBe(false);
  });

  it("still resolves by the recorded subscription binding when the customer is ambiguous", () => {
    // Ambiguity on the LAST-RESORT key must not break the authoritative one.
    // This is the path that makes the shared-customer case work at all: both
    // workspaces keep their own subscription binding, and every event that
    // carries a subscription id we have seen resolves exactly.
    const identity = decideWebhookCompany({
      subscriptionId: "sub_a",
      customerId: "cus_shared",
      claimedCompanyId: null,
      bySubscription: company({
        id: "cmp_a",
        billingSubscriptionId: "sub_a",
        billingCustomerId: "cus_shared",
      }),
      byClaim: null,
      byCustomer: null,
      customerAmbiguous: true,
    });

    expect(identity).toEqual({ ok: true, companyId: "cmp_a", via: "subscription" });
  });

  it("defaults to unambiguous when the flag is absent", () => {
    // The flag is optional so existing callers keep compiling; absent must mean
    // "no ambiguity detected", never "unknown, so refuse".
    const identity = decideWebhookCompany({
      subscriptionId: "sub_new",
      customerId: "cus_mine",
      claimedCompanyId: null,
      bySubscription: null,
      byClaim: null,
      byCustomer: company({ id: "cmp_mine", billingCustomerId: "cus_mine" }),
    });
    expect(identity).toEqual({ ok: true, companyId: "cmp_mine", via: "customer" });
  });
});

describe("identityWriteGuard - compare-and-set on the write", () => {
  it("lets a first activation write only while the workspace is still unbound", () => {
    // Two forged checkouts racing for the same unbound workspace: both read
    // billingSubscriptionId === null, so the decision passes twice. This
    // where-clause is what makes the second updateMany match zero rows.
    expect(identityWriteGuard("first-activation", "sub_new", "cus_new")).toEqual({
      billingSubscriptionId: null,
    });
  });

  it("re-asserts the subscription binding the decision was made on", () => {
    expect(identityWriteGuard("subscription", "sub_1", "cus_1")).toEqual({
      billingSubscriptionId: "sub_1",
    });
    expect(identityWriteGuard("claim-confirmed", "sub_1", "cus_1")).toEqual({
      billingSubscriptionId: "sub_1",
    });
  });

  it("re-asserts the customer binding on the customer-id path", () => {
    // Not the subscription id here: this path exists precisely because the
    // incoming subscription id is new to us.
    expect(identityWriteGuard("customer", "sub_new", "cus_mine")).toEqual({
      billingCustomerId: "cus_mine",
    });
  });

  it("never returns an empty guard, which would widen the update to id-only", () => {
    for (const via of [
      "subscription",
      "claim-confirmed",
      "first-activation",
      "customer",
    ] as const) {
      expect(Object.keys(identityWriteGuard(via, "sub_1", "cus_1")).length).toBeGreaterThan(0);
    }
  });
});

describe("the webhook route is wired to the gate", () => {
  const ROUTE = join(process.cwd(), "app", "api", "webhooks", "lemonsqueezy", "route.ts");
  const source = () => readFileSync(ROUTE, "utf8");

  it("resolves identity through the audited helper rather than inline", () => {
    expect(source()).toContain("resolveWebhookCompany");
  });

  it("no longer returns the buyer-supplied company_id verbatim", () => {
    // The literal shape of the bug, so a well-meaning refactor cannot put it
    // back without this test objecting.
    expect(source()).not.toMatch(/return\s+fromCustom\s*;/);
  });

  it("qualifies the plan write with deletedAt: null and an identity guard", () => {
    const src = source();
    const update = src.slice(src.indexOf("company.updateMany"));
    expect(update).toContain("deletedAt: null");
    expect(update).toContain("identityWriteGuard");
  });

  it("answers a forged event with 400 and tags the Sentry boundary", () => {
    const src = source();
    expect(src).toContain("captureBillingForgery");
    expect(src).toMatch(/status:\s*400/);
  });
});
