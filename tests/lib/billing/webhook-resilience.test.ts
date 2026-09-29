// @vitest-environment node
/**
 * Two resilience properties of the money boundary, both BEHAVIOURAL.
 *
 * bill-010 — A DELIVERY WE CANNOT FULLY UNDERSTAND MUST NOT BECOME A POISON
 * MESSAGE. The original defect was `currentPeriodEnd: periodEnd ? new Date(
 * periodEnd) : null`: one badly formatted `renews_at` produced an Invalid Date,
 * Prisma threw, the route's catch answered 500, and LemonSqueezy re-delivered
 * the same unparseable bytes on a backoff for ever. `readPeriodEnd` closed that
 * half (see tests/lib/billing/subscription-write.test.ts) by treating an
 * unreadable date as ABSENT, so nothing throws and the rest of the event still
 * applies.
 *
 * The half this file adds is the other one the finding asks for: "with the
 * failure visible somewhere a human looks". Dropping the date silently means the
 * customer's paid-through date keeps a stale value, the cancellation email quotes
 * that stale date, and the ledger row for the delivery reads exactly like a clean
 * application. The ledger exists so that "money arrived and we could not place
 * it" is a recorded state rather than a cheerful 200; "money arrived and we could
 * not read when it was paid through" belongs in the same table.
 *
 * bill-011 — A TOMBSTONED WORKSPACE NEVER RECEIVES BILLING STATE, AND A LIVE ONE
 * IS NEVER REFUSED BECAUSE A DEAD ONE EXISTS. The security half is closed by
 * `decideWebhookCompany` (three `company-deleted` refusals) plus `deletedAt: null`
 * on every write; the guards below pin it so it cannot regress. What was NOT
 * closed is the mirror image: a tombstone standing in the way of the live
 * workspace behind the same payer, and a payment for a tombstoned workspace being
 * recorded as an unknown subscription rather than against the workspace it is
 * plainly about.
 *
 * The route is reachable the same way tests/lib/billing/webhook-ledger.test.ts
 * reaches it — `vi.mock("@/lib/db")` replaces the client before the module graph
 * is built, so no Prisma client is constructed and no database is touched. The
 * fake is duplicated rather than shared because that file's fake is shaped around
 * its own questions (op ordering inside transactions); this one needs `not: null`
 * matching, which that one has no reason to grow.
 *
 * `// @vitest-environment node` because the route reads request bytes and HMACs
 * them, and jsdom's Buffer/TextEncoder realms make that a coin flip.
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

let store: { companies: CompanyRow[]; events: LedgerRow[]; users: number };

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

/**
 * Supports the three `where` shapes this route uses: a scalar, `null`,
 * `{ in: [...] }` and `{ not: null }`. `{ not: null }` is the one the
 * tombstone lookups need, and a fake that silently ignored it would make those
 * lookups look like they matched everything.
 */
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
    if (typeof want === "object") {
      const list = (want as { in?: unknown[] }).in;
      if (Array.isArray(list)) {
        if (list.indexOf(got) === -1) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(want, "not")) {
        const not = (want as { not?: unknown }).not;
        if (not === null) {
          if (got === null) return false;
          continue;
        }
        if (got === not) return false;
        continue;
      }
      throw new Error(`fake db: unsupported filter on ${key}: ${JSON.stringify(want)}`);
    }
    if (got !== want) return false;
  }
  return true;
}

function sorted(rows: CompanyRow[]): CompanyRow[] {
  return rows
    .slice()
    .sort((a, b) =>
      a.createdAt.getTime() === b.createdAt.getTime()
        ? a.id.localeCompare(b.id)
        : a.createdAt.getTime() - b.createdAt.getTime()
    );
}

const dbFake = {
  company: {
    findFirst: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
      return sorted(store.companies.filter((c) => matches(c, args?.where)))[0] ?? null;
    }),
    findMany: vi.fn(async (args?: { where?: Record<string, unknown>; take?: number }) => {
      const rows = sorted(store.companies.filter((c) => matches(c, args?.where)));
      return typeof args?.take === "number" ? rows.slice(0, args.take) : rows;
    }),
    updateMany: vi.fn(
      async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = store.companies.filter((c) => matches(c, args.where));
        for (let i = 0; i < hits.length; i += 1) Object.assign(hits[i], args.data);
        return { count: hits.length };
      }
    ),
  },
  user: { count: vi.fn(async () => store.users) },
  inviteToken: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  billingEvent: {
    create: vi.fn(async (args: { data: LedgerRow }) => {
      if (store.events.some((e) => e.eventId === args.data.eventId))
        throw new FakeUniqueViolation();
      store.events.push({ ...args.data });
      return { id: `be_${store.events.length}`, ...args.data };
    }),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone({ companies: store.companies, events: store.events });
    try {
      return await fn(dbFake);
    } catch (e) {
      store.companies = snapshot.companies;
      store.events = snapshot.events;
      throw e;
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

interface Delivered {
  status: number;
  body: Record<string, unknown>;
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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function subBody(over: {
  eventName?: string;
  webhookId?: string;
  claim?: string | null;
  subscriptionId?: string | number;
  status?: string;
  customerId?: number | string;
  /** `null` omits the key entirely; a string is used verbatim, valid or not. */
  renewsAt?: string | null;
  endsAt?: string | null;
  updatedAt?: string;
}): string {
  const meta: Record<string, unknown> = {
    event_name: over.eventName ?? "subscription_updated",
    webhook_id: over.webhookId ?? "wh_1",
  };
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

function invoiceBody(over: {
  eventName?: string;
  webhookId?: string;
  subscriptionId?: string | number;
  customerId?: number | string;
}): string {
  return JSON.stringify({
    meta: {
      event_name: over.eventName ?? "subscription_payment_failed",
      webhook_id: over.webhookId ?? "wh_inv",
    },
    data: {
      id: 5001,
      attributes: {
        customer_id: over.customerId ?? 900,
        store_id: 1,
        subscription_id: over.subscriptionId ?? 71,
      },
    },
  });
}

/** A live workspace mid-subscription: the ordinary paying customer. */
function payingCompany(over: Partial<CompanyRow> = {}): CompanyRow {
  return company({
    id: "cmp_1",
    plan: "team",
    subscriptionStatus: "active",
    billingSubscriptionId: "71",
    billingCustomerId: "900",
    currentPeriodEnd: new Date(NOW + 20 * DAY),
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = { companies: [], events: [], users: 1 };
  config.storeId = "";
  config.variantId = "";
});

/* ── bill-010 ──────────────────────────────────────────────────────────── */

describe("bill-010 — an unreadable date is not a poison message", () => {
  it("answers 200 and still applies the rest of the event", async () => {
    // The closed half, kept as a regression guard: an Invalid Date used to reach
    // Prisma, throw, and be answered 500 — so LemonSqueezy re-delivered the same
    // bytes on a backoff for ever and the event never applied at all.
    store.companies = [payingCompany({ subscriptionStatus: "on_trial" })];

    const { status, body } = await deliver(subBody({ renewsAt: "later" }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true });
    expect(store.companies[0].subscriptionStatus).toBe("active");
  });

  it("leaves the stored paid-through date alone rather than nulling it", async () => {
    const held = new Date(NOW + 20 * DAY);
    store.companies = [payingCompany({ currentPeriodEnd: held })];

    await deliver(subBody({ renewsAt: "later" }));

    expect(store.companies[0].currentPeriodEnd).toEqual(held);
  });

  it("records on the ledger row that it could not read the date", async () => {
    // THE GAP. Support's question is "why does this workspace say it is paid
    // through a date that has passed?" and the ledger row for the delivery is
    // where they look. `reason: null` says the delivery was a clean application,
    // which is exactly the thing it was not: a field was dropped. Sentry ages
    // out; a billing dispute does not.
    store.companies = [payingCompany()];

    await deliver(subBody({ renewsAt: "later" }));

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      outcome: "applied",
      reason: "period-end-unreadable",
      companyId: "cmp_1",
    });
  });

  it("tells the operator once, because only a human can fix the sender", async () => {
    store.companies = [payingCompany()];

    await deliver(subBody({ renewsAt: "later" }));

    expect(sentry.captureServerError).toHaveBeenCalledTimes(1);
    const [, context] = sentry.captureServerError.mock.calls[0] as [
      unknown,
      { action?: string; companyId?: string },
    ];
    expect(context.action).toBe("lemonSqueezyWebhook.unreadablePeriodEnd");
    expect(context.companyId).toBe("cmp_1");
  });

  it("does not annotate a delivery whose date parsed perfectly well", async () => {
    // The annotation is only worth having if it is rare. A plain application
    // stays a plain application.
    store.companies = [payingCompany()];

    await deliver(subBody({ renewsAt: future }));

    expect(store.events[0]).toMatchObject({ outcome: "applied", reason: null });
    expect(sentry.captureServerError).not.toHaveBeenCalled();
    expect(store.companies[0].currentPeriodEnd).toEqual(new Date(future));
  });

  it("does not quietly substitute renews_at for an unreadable ends_at", async () => {
    // `ends_at` wins because it is only set once a subscription is CANCELLED, so
    // it is the date that bounds access. Falling back to the renewal date when it
    // is unreadable would extend access past the real end — so the date is
    // dropped, and the drop is what gets recorded.
    store.companies = [payingCompany({ currentPeriodEnd: new Date(NOW + 20 * DAY) })];

    await deliver(
      subBody({ eventName: "subscription_cancelled", status: "cancelled", endsAt: "soon" })
    );

    expect(store.companies[0].currentPeriodEnd).toEqual(new Date(NOW + 20 * DAY));
    expect(store.events[0]).toMatchObject({ outcome: "applied", reason: "period-end-unreadable" });
  });
});

/* ── bill-011 ──────────────────────────────────────────────────────────── */

describe("bill-011 — a tombstoned workspace receives no billing state", () => {
  it("writes nothing when a renewal arrives for a workspace the customer deleted", async () => {
    store.companies = [payingCompany({ deletedAt: new Date(NOW - DAY), plan: "team" })];

    const { status, body } = await deliver(subBody({ claim: null }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, ignored: "company-deleted" });
    expect(store.companies[0].subscriptionStatus).toBe("active");
    expect(store.events[0]).toMatchObject({ outcome: "skipped", reason: "company-deleted" });
  });

  it("refuses a claim that names a deleted workspace as forgery", async () => {
    // An unbound tombstone is the most attractive target there is: nothing to
    // collide with, and a resurrected paid plan on a workspace ops believes gone.
    store.companies = [
      company({ id: "cmp_dead", deletedAt: new Date(NOW - DAY), billingSubscriptionId: null }),
    ];

    const { status } = await deliver(subBody({ claim: "cmp_dead", subscriptionId: 99 }));

    expect(status).toBe(400);
    expect(store.companies[0].plan).toBe("free");
    expect(forgery.captureBillingForgery).toHaveBeenCalled();
  });
});

describe("bill-011 — a dead workspace does not block the live one beside it", () => {
  it("applies a plan change to the one LIVE workspace behind the payer", async () => {
    // THE GAP. The customer-id fallback is the only lookup whose key has no
    // unique constraint, so it refuses rather than guesses when two workspaces
    // match (bill-012). Counting a TOMBSTONED workspace towards that ambiguity
    // refuses the live one for no benefit: a tombstone can never be written to,
    // so it is not a candidate the fallback has to choose between. The shape is
    // ordinary — a founder deletes their first workspace and keeps the second —
    // and the cost is that their plan change never applies and nobody is billed
    // for what they are using.
    store.companies = [
      company({
        id: "cmp_dead",
        plan: "team",
        subscriptionStatus: "cancelled",
        billingSubscriptionId: "70",
        billingCustomerId: "900",
        deletedAt: new Date(NOW - 30 * DAY),
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
      company({
        id: "cmp_live",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "70b",
        billingCustomerId: "900",
        currentPeriodEnd: new Date(NOW + 10 * DAY),
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ];

    // No claim and an unrecorded subscription id: exactly what a plan change
    // made in the LemonSqueezy portal delivers.
    const { status, body } = await deliver(
      subBody({ claim: null, subscriptionId: 71, renewsAt: new Date(NOW + 40 * DAY).toISOString() })
    );

    expect(status).toBe(200);
    expect(body).toEqual({ received: true });
    const live = store.companies.filter((c) => c.id === "cmp_live")[0];
    expect(live.billingSubscriptionId).toBe("71");
    expect(live.plan).toBe("team");
    const dead = store.companies.filter((c) => c.id === "cmp_dead")[0];
    expect(dead.billingSubscriptionId, "the tombstone stays untouched").toBe("70");
    expect(store.events[0]).toMatchObject({ outcome: "applied", companyId: "cmp_live" });
  });

  it("still calls a payer with only a DELETED workspace deleted, not unresolvable", async () => {
    // The other side of the same coin, and the reason the fallback cannot simply
    // filter tombstones out and stop there. "Gone" and "never existed" are
    // different answers: `unresolvable` is the one reason this route answers 500
    // to (so LemonSqueezy retries while an operator fixes the cause), and a
    // workspace that was deliberately deleted is not a cause anybody will fix —
    // it would retry until the provider gave up.
    store.companies = [
      company({
        id: "cmp_dead",
        plan: "team",
        subscriptionStatus: "cancelled",
        billingSubscriptionId: "70",
        billingCustomerId: "900",
        deletedAt: new Date(NOW - 30 * DAY),
      }),
    ];

    const { status, body } = await deliver(subBody({ claim: null, subscriptionId: 71 }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, ignored: "company-deleted" });
    expect(store.companies[0].billingSubscriptionId).toBe("70");
    expect(store.events[0]).toMatchObject({ outcome: "skipped", reason: "company-deleted" });
  });

  it("still refuses when TWO LIVE workspaces share the payer", async () => {
    // bill-012 proper, and it must not soften: one person paying for two live
    // workspaces is an ordinary shape, and a cancellation for B must never
    // downgrade A on a coin flip.
    store.companies = [
      company({
        id: "cmp_a",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "70",
        billingCustomerId: "900",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      }),
      company({
        id: "cmp_b",
        plan: "team",
        subscriptionStatus: "active",
        billingSubscriptionId: "70b",
        billingCustomerId: "900",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ];

    const { status, body } = await deliver(subBody({ claim: null, subscriptionId: 71 }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, ignored: "customer-ambiguous" });
    expect(store.companies.map((c) => c.billingSubscriptionId)).toEqual(["70", "70b"]);
    expect(store.events[0]).toMatchObject({ outcome: "refused", reason: "customer-ambiguous" });
  });

  it("records a payment for a deleted workspace AGAINST that workspace", async () => {
    // THE OTHER GAP. The payment path filters `deletedAt: null` in SQL, so a
    // charge against a deleted workspace comes back as zero rows and is recorded
    // as `unknown-subscription` with a null companyId — the one row in the ledger
    // that exists to answer "whose money was this?" answers "no idea", about a
    // subscription we hold the binding for. No write is correct; losing the id is
    // not.
    store.companies = [payingCompany({ id: "cmp_dead", deletedAt: new Date(NOW - 2 * DAY) })];

    const { status, body } = await deliver(invoiceBody({ subscriptionId: 71 }));

    expect(status).toBe(200);
    expect(body).toEqual({ received: true, ignored: "company-deleted" });
    expect(
      store.companies[0].subscriptionStatus,
      "a tombstoned workspace is still never written to"
    ).toBe("active");
    expect(store.events[0]).toMatchObject({
      outcome: "skipped",
      reason: "company-deleted",
      companyId: "cmp_dead",
      subscriptionId: "71",
    });
  });

  it("keeps reporting a payment for a subscription nobody holds as unknown", async () => {
    // The distinction the case above draws only means something if the other
    // answer survives: a subscription id we have never seen is not a deleted
    // workspace, and must not start claiming to be one.
    const { body } = await deliver(invoiceBody({ subscriptionId: 999 }));

    expect(body).toEqual({ received: true, ignored: "unknown-subscription" });
    expect(store.events[0]).toMatchObject({
      outcome: "skipped",
      reason: "unknown-subscription",
      companyId: null,
    });
  });
});
