/**
 * bill-016 — the billing summary never carried an amount or a currency.
 *
 * WHAT THE CUSTOMER SAW. `BillingSummary` was (plan, status, currentPeriodEnd,
 * hasCustomer, configured). Settings → Plan & billing therefore rendered a plan
 * NAME and a date and nothing about money, while the Company card two sections
 * above it prints `currency: PKR` and LemonSqueezy — a merchant of record —
 * charges the card in USD. A Pakistani founder reading a USD line on a card
 * statement had nothing in the product to reconcile it against.
 *
 * WHERE THE NUMBER COMES FROM, AND WHY NOT THE OTHER TWO PLACES.
 *
 *   • NOT a live `getSubscription()` on render. That puts a third-party network
 *     call on the critical path of a page that currently needs none, and a
 *     LemonSqueezy outage (or an unconfigured deployment) would then degrade or
 *     fail the whole settings page. `createBillingPortalSessionAction` already
 *     makes that call — on a click, where a failure has a user to report it to.
 *   • NOT a hardcoded price. The landing page says "$10 /mo" (app/page.tsx
 *     TIERS) and the audit that raised this finding guessed "$29". Whichever is
 *     typed in becomes a lie on the day the LemonSqueezy variant price changes,
 *     and nothing in this repo would fail.
 *   • The stored webhook payload. `BillingEvent.payload` keeps the raw signed
 *     body of every delivery this app applied, verbatim, and
 *     `subscription_payment_success` / `_recovered` are invoice-shaped: they
 *     carry `total`, `currency` and `total_formatted`. That is the provider's
 *     own record of what it actually took, already on our disk, already indexed
 *     by `@@index([companyId, receivedAt])`, and it needs no schema change.
 *
 * So these tests pin three things the previous shape could not express: the
 * amount is READ and not invented, it is read from the ledger rather than the
 * network, and an unreadable payload degrades to "no amount" instead of to a
 * wrong one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: unknown[] }> = [];
  const results = new Map<string, unknown>();
  /** Per-path gate: a delegate awaits this before resolving. Lets one read be
   *  held open while the test checks whether the other was already issued. */
  const gates = new Map<string, Promise<void>>();

  const db: Record<string, unknown> = {};
  for (const model of ["company", "billingEvent"]) {
    const delegate: Record<string, (args?: unknown) => Promise<unknown>> = {};
    for (const op of ["findFirst", "findMany", "count"]) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: unknown) => {
        calls.push({ path, args: [args] });
        const gate = gates.get(path);
        if (gate) await gate;
        return results.get(path) ?? null;
      };
    }
    db[model] = delegate;
  }

  return {
    db,
    calls,
    results,
    gates,
    /** Spy on the LemonSqueezy SDK: a settings render must never reach it. */
    getSubscription: vi.fn(async () => ({ data: null, error: null })),
    configured: { value: true },
  };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
// The role is mutable so the A43 cases can sign in as someone else. It is
// reset to "admin" in beforeEach, so no case can leak a role into the next.
const session = vi.hoisted(() => ({ role: "admin" as "admin" | "cofounder" | "member" }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => ({
    userId: "u1",
    userName: "Ada",
    email: "ada@example.com",
    companyId: "c1",
    role: session.role,
  }),
}));
vi.mock("@/lib/lemonsqueezy/config", () => ({
  isBillingConfigured: () => H.configured.value,
  LS_STORE_ID: "42",
  LS_VARIANT_ID_TEAM: "777",
  APP_URL: "https://app.example.com",
}));
vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  lemonSqueezySetup: vi.fn(),
  getSubscription: H.getSubscription,
}));

import {
  DEFAULT_BILLING_CURRENCY,
  getBillingSummary,
  readInvoiceCharge,
  type BillingSummary,
} from "@/lib/queries/billing";

function callsTo(path: string): Array<{ path: string; args: unknown[] }> {
  return H.calls.filter((c) => c.path === path);
}

/**
 * A `subscription_payment_success` delivery, shaped the way LemonSqueezy sends
 * it: `data.attributes` is a subscription-INVOICE, so the money fields are
 * `total` (minor units, tax included), `currency` and `total_formatted`.
 *
 * The identifying fields are present on purpose — `user_email`, `card_brand`
 * and `card_last_four` really are in these bytes (see the comment on
 * `BillingEvent.payload`), and one of the tests below is that none of them
 * crosses into the summary that gets serialized to the browser.
 */
function invoicePayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    meta: { event_name: "subscription_payment_success", webhook_id: "wh_1" },
    data: {
      type: "subscription-invoices",
      id: "5001",
      attributes: {
        store_id: 42,
        subscription_id: 9001,
        customer_id: 7,
        user_email: "founder@example.com",
        user_name: "Ada Founder",
        card_brand: "visa",
        card_last_four: "4242",
        billing_reason: "renewal",
        status: "paid",
        currency: "USD",
        subtotal: 1000,
        discount_total: 0,
        tax: 0,
        total: 1000,
        total_usd: 1000,
        subtotal_formatted: "$10.00",
        total_formatted: "$10.00",
        created_at: "2026-09-12T10:00:00.000000Z",
        urls: { invoice_url: "https://app.lemonsqueezy.com/my-orders/abc123" },
        ...over,
      },
    },
  });
}

const PAID_COMPANY = {
  plan: "team",
  subscriptionStatus: "active",
  currentPeriodEnd: new Date("2026-10-12T10:00:00.000Z"),
  billingCustomerId: "7",
  billingSubscriptionId: "9001",
};

beforeEach(() => {
  session.role = "admin";
  H.calls.length = 0;
  H.results.clear();
  H.getSubscription.mockClear();
  H.configured.value = true;
  H.results.set("company.findFirst", PAID_COMPANY);
  H.results.set("billingEvent.findFirst", {
    payload: invoicePayload(),
    receivedAt: new Date("2026-09-12T10:00:04.000Z"),
  });
});

/**
 * `getBillingSummary()` now answers null to anyone who may not see money (A43),
 * so its return type is nullable and every case below has to say something about
 * that. This helper is what they say.
 *
 * NOT `summary!` at eighteen call sites. The non-null assertion would silence the
 * compiler and throw away the distinction that matters here: each of these cases
 * signs in as an admin, so a null is a broken FIXTURE, not a change in the
 * behaviour under test. Asserting it once, with a message naming the likely
 * cause, turns a confusing cascade of "cannot read property of null" into one
 * line that says which knob was left in the wrong position. The A43 cases at the
 * bottom of this describe deliberately do NOT use it — they want the null.
 */
async function summaryForFinanceRole(): Promise<BillingSummary> {
  const s = await getBillingSummary();
  expect(
    s,
    "getBillingSummary() returned null — this case signs in as a finance role, so " +
      "check `session.role` has not been left set by an earlier test"
  ).not.toBeNull();
  return s as BillingSummary;
}

describe("getBillingSummary() carries what the workspace was charged (bill-016)", () => {
  it("reports the amount, in the currency the card was actually charged in", async () => {
    const summary = await summaryForFinanceRole();
    // WHAT BREAKS IN PRODUCTION WITHOUT THIS: the only money-shaped thing on the
    // billing screen is the word "Team". A USD line on a Pakistani card
    // statement has nothing in the app to match it to.
    expect(summary.lastCharge).not.toBeNull();
    expect(summary.lastCharge?.amountMinor).toBe(1000);
    expect(summary.lastCharge?.currency).toBe("USD");
    // The provider's own rendering, so the screen never has to guess where the
    // symbol goes or how many minor units this currency has.
    expect(summary.lastCharge?.formatted).toBe("$10.00");
    // Dated from the INVOICE, not from when we happened to receive the webhook.
    expect(summary.lastCharge?.chargedAt).toBe("2026-09-12T10:00:00.000Z");
  });

  it("states the currency billing happens in even before any charge is on record", async () => {
    H.results.set("billingEvent.findFirst", null);
    const summary = await summaryForFinanceRole();
    // A workspace that has just upgraded, or is still deciding to, still needs
    // to know the charge will not be in its own reporting currency.
    expect(summary.billingCurrency).toBe(DEFAULT_BILLING_CURRENCY);
    expect(summary.lastCharge).toBeNull();
  });

  it("reads the newest APPLIED payment delivery for this workspace only", async () => {
    await getBillingSummary();
    const [call] = callsTo("billingEvent.findFirst");
    expect(call).toBeTruthy();
    const args = call.args[0] as {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.where.companyId).toBe("c1");
    // "applied" is the only outcome that means the money moved; a refused or
    // skipped delivery must never become a price on someone's screen.
    expect(args.where.outcome).toBe("applied");
    const names = (args.where.eventName as { in: string[] }).in;
    expect(names).toContain("subscription_payment_success");
    expect(names).toContain("subscription_payment_recovered");
    expect(args.orderBy).toEqual({ receivedAt: "desc" });
    // Only the two columns the amount needs. The payload is card-adjacent
    // customer data; a `select`-less read would drag the whole row around.
    expect(Object.keys(args.select).sort()).toEqual(["payload", "receivedAt"]);
  });

  it("never calls LemonSqueezy to render a settings page", async () => {
    await getBillingSummary();
    // A live getSubscription() here would make /settings fail whenever
    // LemonSqueezy is down or unconfigured.
    expect(H.getSubscription).not.toHaveBeenCalled();
  });

  it("leaks none of the payload's customer data into the summary", async () => {
    const summary = await summaryForFinanceRole();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("founder@example.com");
    expect(serialized).not.toContain("4242");
    expect(serialized).not.toContain("visa");
    // The hosted invoice URL is deliberately absent: LemonSqueezy's
    // `urls.invoice_url` is a short-lived link, so a stored copy rendered weeks
    // later is a dead end. The portal button is the durable route.
    expect(serialized).not.toContain("lemonsqueezy.com/my-orders");
  });

  it("reports no amount rather than a wrong one when the payload is unreadable", async () => {
    for (const payload of [
      null,
      "",
      "not json at all",
      JSON.stringify({ data: {} }),
      JSON.stringify({ data: { attributes: { total: 1000 } } }), // no currency
      JSON.stringify({ data: { attributes: { currency: "USD" } } }), // no total
      JSON.stringify({ data: { attributes: { total: "1000", currency: "USD" } } }),
      JSON.stringify({ data: { attributes: { total: -1000, currency: "USD" } } }),
      JSON.stringify({ data: { attributes: { total: 10.5, currency: "USD" } } }),
      JSON.stringify({ data: { attributes: { total: 1000, currency: 7 } } }),
    ]) {
      H.calls.length = 0;
      H.results.set("billingEvent.findFirst", {
        payload,
        receivedAt: new Date("2026-09-12T10:00:04.000Z"),
      });
      const summary = await summaryForFinanceRole();
      expect(summary.lastCharge, `payload: ${String(payload)}`).toBeNull();
      // Degrading to "no amount" must not also lose the currency statement.
      expect(summary.billingCurrency).toBe(DEFAULT_BILLING_CURRENCY);
    }
  });

  it("keeps a fully-discounted invoice, because zero is a real charge", async () => {
    H.results.set("billingEvent.findFirst", {
      payload: invoicePayload({ total: 0, total_formatted: "$0.00" }),
      receivedAt: new Date("2026-09-12T10:00:04.000Z"),
    });
    const summary = await summaryForFinanceRole();
    // `total: 0` is falsy; a truthiness check here would silently drop the one
    // invoice a customer is most likely to query.
    expect(summary.lastCharge?.amountMinor).toBe(0);
    expect(summary.lastCharge?.formatted).toBe("$0.00");
  });

  it("believes the invoice's own currency over the store default", async () => {
    H.results.set("billingEvent.findFirst", {
      payload: invoicePayload({ currency: "eur", total: 950, total_formatted: "€9.50" }),
      receivedAt: new Date("2026-09-12T10:00:04.000Z"),
    });
    const summary = await summaryForFinanceRole();
    expect(summary.lastCharge?.currency).toBe("EUR");
    // The screen must reconcile against what was really taken, not against a
    // constant in this file.
    expect(summary.billingCurrency).toBe("EUR");
  });

  it("falls back to the delivery timestamp when the invoice has no date", async () => {
    H.results.set("billingEvent.findFirst", {
      payload: invoicePayload({ created_at: "sometime last month" }),
      receivedAt: new Date("2026-09-12T10:00:04.000Z"),
    });
    const summary = await summaryForFinanceRole();
    expect(summary.lastCharge?.chargedAt).toBe("2026-09-12T10:00:04.000Z");
  });

  it("still answers when the workspace row is gone", async () => {
    H.results.set("company.findFirst", null);
    H.results.set("billingEvent.findFirst", null);
    const summary = await summaryForFinanceRole();
    expect(summary.plan).toBe("free");
    expect(summary.lastCharge).toBeNull();
    expect(summary.billingCurrency).toBe(DEFAULT_BILLING_CURRENCY);
  });

  it("issues the ledger read without waiting for the workspace read", async () => {
    // perf-001's lesson, applied to a query this finding ADDS: both reads are
    // keyed on the session's companyId, so chaining them would put a second
    // Supabase round trip on /settings for no reason. Hold the company read
    // open and check the ledger read has already gone out.
    let release = () => {};
    H.gates.set(
      "company.findFirst",
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const pending = getBillingSummary();
    // Let the synchronous part of the query run and both promises be created.
    await Promise.resolve();
    await Promise.resolve();
    expect(callsTo("company.findFirst").length).toBe(1);
    expect(callsTo("billingEvent.findFirst").length).toBe(1);

    release();
    H.gates.clear();
    const summary = await pending;
    // Narrowed in place rather than through the helper: this case deliberately
    // holds the promise itself to prove the two reads went out together, so it
    // cannot call a helper that awaits a fresh one.
    expect(summary).not.toBeNull();
    expect(summary?.lastCharge?.amountMinor).toBe(1000);
  });

  /* ── A43: who the CHARGE is allowed to reach ─────────────────────────── */

  it("answers null to a member, so the charge never enters their page payload", async () => {
    // THE FINDING. app/(app)/settings/page.tsx calls this unconditionally inside
    // a Promise.all and hands the result to SettingsClient, so whatever it
    // returns is serialised into the RSC flight payload for EVERY role — while
    // the card that reads it renders only for an admin. A member was therefore
    // shipped `lastCharge.amountMinor`, `currency`, `formatted` and `chargedAt`:
    // the workspace's real last invoice, in a file whose own header withholds
    // `currency` from members as "finance-adjacent context".
    session.role = "member";
    const summary = await getBillingSummary();
    expect(summary).toBeNull();
  });

  it("does not even read the ledger for a member", async () => {
    // Stronger than "returns null": the refusal is BEFORE the queries, so a
    // member's request costs no round trip either. If a later refactor moves the
    // role check below the Promise.all, this is the case that notices.
    session.role = "member";
    await getBillingSummary();
    expect(callsTo("company.findFirst")).toHaveLength(0);
    expect(callsTo("billingEvent.findFirst")).toHaveLength(0);
  });

  it("still answers a cofounder, because the finance boundary is the repo's, not the card's", async () => {
    // `canSeeFinances` is admin || cofounder (lib/auth/role-gates.ts) and this
    // deliberately uses it rather than `role === "admin"` to mirror the card.
    // A cofounder therefore gets the data and sees no card, which costs nothing;
    // inventing a third predicate shaped like one component's current visibility
    // is how this repo ended up with two seat gates that disagreed.
    session.role = "cofounder";
    const summary = await summaryForFinanceRole();
    expect(summary.lastCharge?.amountMinor).toBe(1000);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * `readInvoiceCharge`, called directly.
 *
 * WHY THIS BLOCK EXISTS. The function is exported with the comment "Exported so
 * the parse is unit-testable without a database", and until now nothing imported
 * it — every parse case above reaches it through the mocked db, so the export's
 * stated reason was false and the suite would not have noticed the export being
 * deleted. That is the "exported for a caller that does not exist" shape this
 * repo keeps producing, and no guard covers lib/queries.
 *
 * These cases are the ones the indirect route cannot reach cleanly: the receipt
 * date fallback, the casing rule, and the currency validation's real boundary.
 */
describe("readInvoiceCharge — the payload parse, on its own", () => {
  const RECEIVED = new Date("2026-09-12T10:00:04.000Z");
  const invoice = (attrs: Record<string, unknown>) =>
    JSON.stringify({ data: { attributes: attrs } });

  it("answers null for an absent payload rather than throwing", () => {
    expect(readInvoiceCharge(null, RECEIVED)).toBeNull();
    expect(readInvoiceCharge(undefined, RECEIVED)).toBeNull();
    expect(readInvoiceCharge("", RECEIVED)).toBeNull();
  });

  it("answers null for a payload that is not JSON", () => {
    expect(readInvoiceCharge("{not json", RECEIVED)).toBeNull();
    // Valid JSON, wrong shape — data.attributes is where the money lives.
    expect(readInvoiceCharge('{"data":{}}', RECEIVED)).toBeNull();
    expect(readInvoiceCharge('"a string"', RECEIVED)).toBeNull();
  });

  it("uppercases the currency, because the screen and the default are compared", () => {
    const c = readInvoiceCharge(invoice({ total: 1000, currency: "usd" }), RECEIVED);
    expect(c?.currency).toBe("USD");
  });

  it("dates the charge from the receipt when the invoice carries no usable date", () => {
    // Three ways to have no date, one answer: the webhook's own arrival time.
    for (const attrs of [
      { total: 1000, currency: "USD" },
      { total: 1000, currency: "USD", created_at: "sometime last month" },
      { total: 1000, currency: "USD", created_at: 42 },
    ]) {
      const c = readInvoiceCharge(invoice(attrs), RECEIVED);
      expect(c?.chargedAt, JSON.stringify(attrs)).toBe("2026-09-12T10:00:04.000Z");
    }
  });

  it("keeps zero, and refuses a total that is not whole minor units", () => {
    expect(readInvoiceCharge(invoice({ total: 0, currency: "USD" }), RECEIVED)?.amountMinor).toBe(
      0
    );
    for (const total of [10.5, -1, "1000", null]) {
      expect(readInvoiceCharge(invoice({ total, currency: "USD" }), RECEIVED)).toBeNull();
    }
  });

  it("reports no formatted string rather than an empty one", () => {
    expect(
      readInvoiceCharge(invoice({ total: 1000, currency: "USD", total_formatted: "" }), RECEIVED)
        ?.formatted
    ).toBeNull();
    expect(
      readInvoiceCharge(invoice({ total: 1000, currency: "USD", total_formatted: 10 }), RECEIVED)
        ?.formatted
    ).toBeNull();
  });

  it("accepts any non-empty currency string — a KNOWN gap, pinned so it is not a surprise", () => {
    // The check is `currency.length === 0`, not a three-letter shape, so "Q" and
    // "QQQQ" pass. That matters downstream: the value is interpolated into the
    // sentence on /settings, and Intl.NumberFormat only THROWS for a malformed
    // code — a well-formed-but-unknown one like "QQQ" formats happily with two
    // minor units assumed. Provider data makes this near-unreachable, so this
    // test documents the boundary rather than asserting a fix; if the validation
    // is ever tightened to /^[A-Za-z]{3}$/, this case is the one to change, and
    // it will say so by failing.
    expect(readInvoiceCharge(invoice({ total: 1000, currency: "Q" }), RECEIVED)?.currency).toBe(
      "Q"
    );
    expect(readInvoiceCharge(invoice({ total: 1000, currency: "" }), RECEIVED)).toBeNull();
    expect(readInvoiceCharge(invoice({ total: 1000, currency: 7 }), RECEIVED)).toBeNull();
  });
});
