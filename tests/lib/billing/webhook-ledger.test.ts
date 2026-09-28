// @vitest-environment node
/**
 * The delivered-event ledger: bill-009 (there was no record that a billing
 * event had ever arrived) and bill-002 (replay protection was INFERRED from
 * state already on the Company row rather than enforced).
 *
 * These are BEHAVIOURAL, not source-text, assertions. The sibling
 * tests/lib/billing/webhook-route.test.ts reads the file because it pins
 * wiring; this file pins what a customer experiences, which source text cannot:
 * "the same signed body delivered twice changes the workspace once". The route
 * is reachable from a test the same way tests/lib/cron/purge-route.test.ts
 * reaches the purge cron — `vi.mock("@/lib/db")` replaces the client before the
 * module graph is built, so no Prisma client is ever constructed and no
 * database is touched.
 *
 * The fake `$transaction` ROLLS BACK on a throw (it snapshots and restores),
 * because that rollback is the entire mechanism under test: the ledger row and
 * the Company write have to commit together, so that a delivery is recorded as
 * applied if and only if its write landed.
 *
 * `// @vitest-environment node` because the route reads request bytes and hashes
 * them; jsdom's Buffer/TextEncoder realm games are not worth the risk.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const SECRET = "ls-webhook-secret-for-tests";

/* ── the fake database ─────────────────────────────────────────────────── */

interface CompanyRow {
  id: string;
  plan: string;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  billingSubscriptionId: string | null;
  billingCustomerId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

interface LedgerRow {
  eventId: string;
  eventName: string;
  subscriptionId: string | null;
  customerId: string | null;
  companyId: string | null;
  outcome: string;
  reason: string | null;
  payload: string | null;
}

interface Op {
  delegate: string;
  kind: string;
  /** Which transaction this ran inside, or null for an autocommit call. */
  tx: number | null;
}

let store: { companies: CompanyRow[]; events: LedgerRow[]; users: number };
let ops: Op[];
let txSeq: number;
let currentTx: number | null;

/** A Prisma unique-constraint violation, shaped the way the client throws it. */
class FakeUniqueViolation extends Error {
  code = "P2002";
  meta = { target: ["eventId"] };
  constructor() {
    super("Unique constraint failed on the fields: (`eventId`)");
    this.name = "PrismaClientKnownRequestError";
  }
}

function company(over: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: "cmp_1",
    plan: "free",
    subscriptionStatus: null,
    currentPeriodEnd: null,
    billingSubscriptionId: null,
    billingCustomerId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

function matches(row: CompanyRow, where: Record<string, unknown> = {}): boolean {
  const keys = Object.keys(where);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const want = where[key];
    const got = (row as unknown as Record<string, unknown>)[key];
    if (want === null) {
      if (got !== null) return false;
      continue;
    }
    if (want !== null && typeof want === "object") {
      const list = (want as { in?: unknown[] }).in;
      if (Array.isArray(list)) {
        if (list.indexOf(got) === -1) return false;
        continue;
      }
      return false;
    }
    if (got !== want) return false;
  }
  return true;
}

function record(delegate: string, kind: string) {
  ops.push({ delegate, kind, tx: currentTx });
}

const dbFake = {
  company: {
    findFirst: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
      record("company", "findFirst");
      return store.companies.filter((c) => matches(c, args?.where))[0] ?? null;
    }),
    findMany: vi.fn(
      async (args?: { where?: Record<string, unknown>; take?: number; orderBy?: unknown }) => {
        record("company", "findMany");
        const rows = store.companies
          .filter((c) => matches(c, args?.where))
          .slice()
          .sort((a, b) =>
            a.createdAt.getTime() === b.createdAt.getTime()
              ? a.id.localeCompare(b.id)
              : a.createdAt.getTime() - b.createdAt.getTime()
          );
        return typeof args?.take === "number" ? rows.slice(0, args.take) : rows;
      }
    ),
    updateMany: vi.fn(
      async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        record("company", "updateMany");
        const hits = store.companies.filter((c) => matches(c, args.where));
        for (let i = 0; i < hits.length; i += 1) Object.assign(hits[i], args.data);
        return { count: hits.length };
      }
    ),
  },
  user: {
    count: vi.fn(async () => {
      record("user", "count");
      return store.users;
    }),
  },
  inviteToken: {
    deleteMany: vi.fn(async () => {
      record("inviteToken", "deleteMany");
      return { count: 0 };
    }),
  },
  billingEvent: {
    create: vi.fn(async (args: { data: LedgerRow }) => {
      record("billingEvent", "create");
      if (store.events.some((e) => e.eventId === args.data.eventId))
        throw new FakeUniqueViolation();
      store.events.push({ ...args.data });
      return { id: `be_${store.events.length}`, ...args.data };
    }),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone({ companies: store.companies, events: store.events });
    txSeq += 1;
    const previous = currentTx;
    currentTx = txSeq;
    try {
      return await fn(dbFake);
    } catch (e) {
      store.companies = snapshot.companies;
      store.events = snapshot.events;
      throw e;
    } finally {
      currentTx = previous;
    }
  }),
};

vi.mock("@/lib/db", () => ({
  get db() {
    return dbFake;
  },
}));

/* ── the rest of the module graph ──────────────────────────────────────── */

const config = { storeId: "", variantId: "" };

vi.mock("@/lib/lemonsqueezy/config", () => ({
  get LS_STORE_ID() {
    return config.storeId;
  },
  get LS_VARIANT_ID_TEAM() {
    return config.variantId;
  },
  get LS_WEBHOOK_SECRET() {
    return SECRET;
  },
  APP_URL: "https://app.test",
  isBillingConfigured: () => true,
  isWebhookConfigured: () => true,
}));

const forgery = {
  captureBillingForgery: vi.fn(),
  reportOutOfScopeBillingEvent: vi.fn(),
  reportSkippedBillingWrite: vi.fn(),
  reportUnplaceableBillingEvent: vi.fn(),
};
vi.mock("@/lib/billing/billing-forgery", () => forgery);

const sentry = { captureServerError: vi.fn() };
vi.mock("@/lib/sentry-server", () => sentry);

const notify = {
  notifyWorkspaceAdmins: vi.fn(async () => ({ notified: 0 })),
  billingAlertForEvent: vi.fn(() => null),
};
vi.mock("@/lib/billing/billing-notify", () => notify);

/* ── delivering a signed webhook ───────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const future = new Date(NOW + 30 * DAY).toISOString();
const past = new Date(NOW - 5 * DAY).toISOString();

interface Delivered {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function deliver(raw: string): Promise<Delivered> {
  const signature = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  vi.resetModules();
  const mod = await import("@/app/api/webhooks/lemonsqueezy/route");
  const res = await mod.POST(
    new Request("https://app.test/api/webhooks/lemonsqueezy", {
      method: "POST",
      headers: { "x-signature": signature, "content-type": "application/json" },
      body: raw,
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, raw };
}

/** A subscription-shaped delivery. `webhookId: null` omits meta.webhook_id. */
function subBody(over: {
  eventName?: string;
  webhookId?: string | null;
  claim?: string | null;
  subscriptionId?: string | number;
  status?: string;
  customerId?: number | string;
  renewsAt?: string | null;
  endsAt?: string | null;
  updatedAt?: string;
}): string {
  const meta: Record<string, unknown> = { event_name: over.eventName ?? "subscription_created" };
  if (over.webhookId !== null) meta.webhook_id = over.webhookId ?? "wh_1";
  if (over.claim !== null && over.claim !== undefined)
    meta.custom_data = { company_id: over.claim };
  const attributes: Record<string, unknown> = {
    status: over.status ?? "active",
    customer_id: over.customerId ?? 900,
    store_id: 1,
    variant_id: 42,
    updated_at: over.updatedAt ?? new Date(NOW).toISOString(),
  };
  if (over.endsAt !== undefined && over.endsAt !== null) attributes.ends_at = over.endsAt;
  if (over.renewsAt !== null) attributes.renews_at = over.renewsAt ?? future;
  return JSON.stringify({ meta, data: { id: over.subscriptionId ?? 71, attributes } });
}

/** An invoice-shaped (`subscription_payment_*`) delivery. */
function invoiceBody(over: {
  eventName?: string;
  webhookId?: string | null;
  subscriptionId?: string | number | null;
  customerId?: number | string;
}): string {
  const meta: Record<string, unknown> = {
    event_name: over.eventName ?? "subscription_payment_failed",
  };
  if (over.webhookId !== null) meta.webhook_id = over.webhookId ?? "wh_inv";
  const attributes: Record<string, unknown> = {
    customer_id: over.customerId ?? 900,
    store_id: 1,
  };
  if (over.subscriptionId !== null) attributes.subscription_id = over.subscriptionId ?? 71;
  return JSON.stringify({ meta, data: { id: 5001, attributes } });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = { companies: [], events: [], users: 1 };
  ops = [];
  txSeq = 0;
  currentTx = null;
  config.storeId = "";
  config.variantId = "";
});

/* ── bill-009: every delivery leaves a record ──────────────────────────── */

describe("bill-009 — a delivery we act on is recorded", () => {
  it("writes one ledger row, in the SAME transaction as the Company update", async () => {
    // The support question after a dispute is "what arrived, and what did we do
    // about it". Before this the only answer was the CURRENT Company row plus
    // whatever Sentry had not yet aged out. And the row has to share the
    // Company write's transaction, or the two can disagree: a ledger row for a
    // write that rolled back is worse than no ledger at all.
    store.companies = [company({ id: "cmp_1" })];

    const { status, body } = await deliver(subBody({ claim: "cmp_1", webhookId: "wh_1" }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(store.companies[0].plan).toBe("team");
    expect(store.companies[0].billingSubscriptionId).toBe("71");

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      eventId: "wh_1",
      eventName: "subscription_created",
      subscriptionId: "71",
      customerId: "900",
      companyId: "cmp_1",
      outcome: "applied",
      reason: null,
    });

    const write = ops.filter((o) => o.delegate === "company" && o.kind === "updateMany")[0];
    const ledger = ops.filter((o) => o.delegate === "billingEvent" && o.kind === "create")[0];
    expect(write, "the Company update must happen").toBeTruthy();
    expect(ledger, "the ledger insert must happen").toBeTruthy();
    expect(write.tx, "the Company update must run inside a transaction").not.toBeNull();
    expect(ledger.tx, "the ledger insert must share that transaction").toBe(write.tx);
  });

  it("keeps the signed bytes verbatim, so the claim can be re-verified later", async () => {
    store.companies = [company({ id: "cmp_1" })];
    const { raw } = await deliver(subBody({ claim: "cmp_1" }));
    expect(store.events[0].payload).toBe(raw);
  });

  it("records a delivery it REFUSES, with the reason", async () => {
    // A refusal is the delivery most worth having a record of: it is the one
    // the customer will phone about.
    store.companies = [
      company({ id: "cmp_1", billingSubscriptionId: "71", subscriptionStatus: "cancelled" }),
    ];

    const { status, body } = await deliver(
      subBody({
        eventName: "subscription_updated",
        status: "active",
        updatedAt: new Date(NOW - 30 * DAY).toISOString(),
      })
    );

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, skipped: "stale-grant" });
    expect(store.companies[0].plan, "a stale grant must not upgrade anybody").toBe("free");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      outcome: "skipped",
      reason: "stale-grant",
      companyId: "cmp_1",
      subscriptionId: "71",
    });
  });

  it("records a delivery it could not place at all, with a null companyId", async () => {
    // "Money arrived and we could not say whose it was" is the state bill-008
    // found being answered with a cheerful 200 and no record anywhere.
    const { status, body } = await deliver(invoiceBody({ subscriptionId: 999 }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, ignored: "unknown-subscription" });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      eventName: "subscription_payment_failed",
      subscriptionId: "999",
      companyId: null,
      outcome: "skipped",
      reason: "unknown-subscription",
    });
  });

  it("does NOT record a delivery it is asking LemonSqueezy to retry", async () => {
    // The ledger row is an idempotency key, so writing one for a delivery we
    // answer 500 to would eat the retry we just asked for — the customer's
    // upgrade would be lost for good once the operator fixed the cause.
    config.storeId = "1";
    config.variantId = "42";

    const { status } = await deliver(subBody({ claim: null, customerId: 555 }));

    expect(status).toBe(500);
    expect(store.events, "a retryable refusal must leave the key free").toHaveLength(0);
  });
});

/* ── bill-002: a captured delivery is not a permanent licence ──────────── */

describe("bill-002 — the same signed body delivered twice changes the workspace once", () => {
  it("refuses a replay whose own dates are still current", async () => {
    // THE HOLE THE LEDGER CLOSES. The state-based rules catch a replay after a
    // TERMINAL status (expired/unpaid) and one whose paid-through date has
    // passed. They cannot catch this: the customer cancels, and the `active`
    // body captured a week earlier is re-POSTed while its renews_at is still in
    // the future. Nothing on the Company row says the delivery has been seen.
    store.companies = [company({ id: "cmp_1" })];

    const grant = subBody({ claim: "cmp_1", webhookId: "wh_1" });
    await deliver(grant);
    expect(store.companies[0].subscriptionStatus).toBe("active");

    await deliver(
      subBody({
        eventName: "subscription_cancelled",
        webhookId: "wh_2",
        status: "cancelled",
        endsAt: future,
      })
    );
    expect(store.companies[0].subscriptionStatus).toBe("cancelled");

    const replay = await deliver(grant);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, skipped: "replay" });
    expect(
      store.companies[0].subscriptionStatus,
      "a replayed grant must not un-cancel a cancelled subscription"
    ).toBe("cancelled");
    expect(store.events, "and it must not add a second row for one delivery").toHaveLength(2);
  });

  it("keys off the signed bytes when the payload carries no webhook id", async () => {
    // A nullable or freshly-minted key deduplicates nothing, so a payload with
    // no provider id must still produce a STABLE key — the hash of the exact
    // bytes the signature covers.
    store.companies = [company({ id: "cmp_1" })];

    const body = subBody({ claim: "cmp_1", webhookId: null });
    await deliver(body);

    expect(store.events).toHaveLength(1);
    expect(store.events[0].eventId).toMatch(/^sha256:[0-9a-f]{64}$/);

    const replay = await deliver(body);
    expect(replay.body).toEqual({ received: true, skipped: "replay" });
    expect(store.events).toHaveLength(1);
  });

  it("still lets a stale DOWNGRADE through — the asymmetry is deliberate", async () => {
    // Refusing an old downgrade would leave a workspace paid-for-free, which is
    // the failure that costs money. Age bounds GRANTS only.
    store.companies = [
      company({
        id: "cmp_1",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "71",
        currentPeriodEnd: new Date(NOW - 10 * DAY),
      }),
    ];

    const { status } = await deliver(
      subBody({
        eventName: "subscription_expired",
        status: "expired",
        endsAt: past,
        renewsAt: null,
        updatedAt: new Date(NOW - 30 * DAY).toISOString(),
      })
    );

    expect(status).toBe(200);
    expect(store.companies[0].plan).toBe("free");
    expect(store.events[0]).toMatchObject({ outcome: "applied", reason: null });
  });

  it("refuses a replayed payment event too", async () => {
    store.companies = [
      company({
        id: "cmp_1",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "71",
      }),
    ];

    const failure = invoiceBody({ subscriptionId: 71, webhookId: "wh_inv" });
    await deliver(failure);
    expect(store.companies[0].subscriptionStatus).toBe("past_due");
    expect(store.events).toHaveLength(1);

    const replay = await deliver(failure);
    expect(replay.body).toEqual({ received: true, skipped: "replay" });
    expect(store.events).toHaveLength(1);
  });
});

/* ── bill-012: one payer, two workspaces ───────────────────────────────── */

describe("bill-012 — a duplicated subscription binding is refused, not guessed at", () => {
  it("does not downgrade whichever workspace the query happened to return first", async () => {
    // `billingSubscriptionId` carries no unique constraint, so "prefer the
    // recorded binding" is only as good as that binding being unique. Two rows
    // holding one subscription id (a restore, a hand-written repair) turned
    // `findFirst` with no orderBy into a coin flip over which paying customer
    // gets downgraded — the same defect bill-012 fixed on billingCustomerId.
    store.companies = [
      company({
        id: "cmp_a",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "71",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
      company({
        id: "cmp_b",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "71",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ];

    const { status, body } = await deliver(
      subBody({
        eventName: "subscription_expired",
        status: "expired",
        endsAt: past,
        renewsAt: null,
      })
    );

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, ignored: "subscription-ambiguous" });
    expect(
      store.companies.map((c) => c.plan),
      "neither workspace may be guessed at"
    ).toEqual(["team", "team"]);
    expect(forgery.reportUnplaceableBillingEvent).toHaveBeenCalled();
    expect(store.events[0]).toMatchObject({
      outcome: "refused",
      reason: "subscription-ambiguous",
      companyId: null,
    });
  });

  it("applies the same rule on the payment path", async () => {
    store.companies = [
      company({
        id: "cmp_a",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "71",
      }),
      company({
        id: "cmp_b",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "71",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ];

    const { body } = await deliver(invoiceBody({ subscriptionId: 71 }));

    expect(body).toEqual({ received: true, ignored: "subscription-ambiguous" });
    expect(store.companies.map((c) => c.subscriptionStatus)).toEqual(["active", "active"]);
  });
});
