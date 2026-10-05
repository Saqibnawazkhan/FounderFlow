/**
 * Behavioural tests for /api/cron/announce-broadcast — the one-shot the owner
 * fires by hand to put "Your FounderFlow just got cooler!" on a lock screen.
 *
 * Nothing here touches a database. `vi.mock("@/lib/db")` replaces the client
 * before the route's module graph is built, and `vi.mock("@/lib/push/config")`
 * replaces web-push, so the REAL `sendPushToUsers` runs against an in-memory
 * fake. That matters: the counts this route reports come out of the shared
 * sender, and a test that mocked the sender would assert the route's arithmetic
 * about a function it never called.
 *
 * The four properties the brief names, in order of how much damage they prevent:
 *
 *   1. DOUBLE-FIRE. The owner will trigger this by hand, possibly twice,
 *      possibly after giving up on a request that had already delivered. A push
 *      cannot be unsent, so the second fire must send nothing. What the latch
 *      can and cannot promise is argued in lib/announce/broadcast-latch.ts;
 *      these tests pin the half it can.
 *   2. UNCONFIGURED VAPID. `isPushConfigured()` is false when the keys are
 *      absent and every send then no-ops SILENTLY. VAPID appears zero times in
 *      scripts/vercel-build.mjs, so nothing in the deploy path requires or warns
 *      about it — which makes "sent 0, reported ok" the most likely outcome of a
 *      first real fire. The route has to refuse instead.
 *   3. DRY-RUN DEFAULT. `PURGE_ENABLED`'s precedent: counting is free, sending
 *      is irreversible, so the default counts.
 *   4. 401. An unauthenticated caller gets nothing and sends nothing.
 *
 * Plus the scope rule the sender exists to enforce (data-integrity-004): a
 * tombstoned user, a tombstoned workspace and the seeded demo workspace are all
 * outside the recipient set, and the assertion is on the DEVICES reached, not on
 * a `where` clause — a recipient list built upstream has forgotten that filter
 * before, and the response's own numbers are what the owner will read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "announce-secret-for-tests";
const URL_BASE = "https://app.test/api/cron/announce-broadcast";

/* ── the fake database ─────────────────────────────────────────────────── */

interface FakeUser {
  id: string;
  companyId: string;
  deletedAt: Date | null;
  /** The tombstone on this user's Company row, so the relation filter is real. */
  companyDeletedAt: Date | null;
}

interface FakeSub {
  id: string;
  userId: string;
  endpoint: string;
}

interface Harness {
  db: Record<string, unknown>;
  /** Every endpoint a send was actually attempted against, in order. */
  attempted: string[];
  /** Subscription ids deleted because the push service said 404/410. */
  pruned: string[];
  /** Prisma delegate calls, so a 401 can be proven to have read nothing. */
  reads: string[];
}

let harness: Harness;
/** Flipped per test; the config mock reads it, as the real module reads env. */
let pushConfigured = true;
/** endpoint → statusCode the push service throws with. */
let sendFailures: Record<string, number> = {};

const DEFAULT_USERS: FakeUser[] = [
  // Two real workspaces, five live people, four of them with a device.
  { id: "u-ali", companyId: "co-a", deletedAt: null, companyDeletedAt: null },
  { id: "u-sara", companyId: "co-a", deletedAt: null, companyDeletedAt: null },
  { id: "u-omar", companyId: "co-b", deletedAt: null, companyDeletedAt: null },
  { id: "u-zoya", companyId: "co-b", deletedAt: null, companyDeletedAt: null },
  { id: "u-nadir", companyId: "co-b", deletedAt: null, companyDeletedAt: null },
  // Deactivated inside a live workspace — data-integrity-004's exact shape.
  { id: "u-fired", companyId: "co-a", deletedAt: new Date("2026-09-01"), companyDeletedAt: null },
  // A whole workspace inside its 90-day recovery window.
  {
    id: "u-gone",
    companyId: "co-dead",
    deletedAt: new Date("2026-09-20"),
    companyDeletedAt: new Date("2026-09-20"),
  },
  // Seeded demo workspace.
  { id: "demo-ahmed", companyId: "demo-nimbus", deletedAt: null, companyDeletedAt: null },
];

const DEFAULT_SUBS: FakeSub[] = [
  { id: "s-ali-phone", userId: "u-ali", endpoint: "https://push.test/ali-phone" },
  { id: "s-ali-laptop", userId: "u-ali", endpoint: "https://push.test/ali-laptop" },
  { id: "s-sara", userId: "u-sara", endpoint: "https://push.test/sara" },
  { id: "s-omar", userId: "u-omar", endpoint: "https://push.test/omar" },
  // u-zoya and u-nadir never granted permission: no row at all.
  { id: "s-fired", userId: "u-fired", endpoint: "https://push.test/fired" },
  { id: "s-gone", userId: "u-gone", endpoint: "https://push.test/gone" },
  { id: "s-demo", userId: "demo-ahmed", endpoint: "https://push.test/demo" },
];

interface UserWhere {
  deletedAt?: null;
  companyId?: { notIn?: string[] };
  company?: { deletedAt?: null };
}

interface SubWhere {
  userId?: { in?: string[] };
  user?: { deletedAt?: null };
}

function buildHarness(users: FakeUser[] = DEFAULT_USERS, subs: FakeSub[] = DEFAULT_SUBS): Harness {
  const liveUsers = users.map((u) => ({ ...u }));
  const liveSubs = subs.map((s) => ({ ...s }));
  const attempted: string[] = [];
  const pruned: string[] = [];
  const reads: string[] = [];

  const db = {
    user: {
      findMany: vi.fn((args: { where?: UserWhere }) => {
        reads.push("user.findMany");
        const w = args.where ?? {};
        return Promise.resolve(
          liveUsers
            .filter((u) => (w.deletedAt === null ? u.deletedAt === null : true))
            .filter((u) =>
              w.company && w.company.deletedAt === null ? u.companyDeletedAt === null : true
            )
            .filter((u) => {
              const notIn = w.companyId && w.companyId.notIn;
              return notIn ? notIn.indexOf(u.companyId) === -1 : true;
            })
            .map((u) => ({ id: u.id }))
        );
      }),
    },
    pushSubscription: {
      findMany: vi.fn((args: { where?: SubWhere }) => {
        reads.push("pushSubscription.findMany");
        const w = args.where ?? {};
        const ids = (w.userId && w.userId.in) || null;
        return Promise.resolve(
          liveSubs
            .filter((s) => (ids ? ids.indexOf(s.userId) !== -1 : true))
            .filter((s) => {
              if (!w.user || w.user.deletedAt !== null) return true;
              const owner = liveUsers.filter((u) => u.id === s.userId)[0];
              return Boolean(owner) && owner.deletedAt === null;
            })
            .map((s) => ({
              id: s.id,
              userId: s.userId,
              endpoint: s.endpoint,
              p256dh: "p256dh-" + s.id,
              auth: "auth-" + s.id,
            }))
        );
      }),
      delete: vi.fn((args: { where: { id: string } }) => {
        pruned.push(args.where.id);
        const i = liveSubs.map((s) => s.id).indexOf(args.where.id);
        if (i !== -1) liveSubs.splice(i, 1);
        return Promise.resolve({ id: args.where.id });
      }),
    },
  };

  return { db, attempted, pruned, reads };
}

vi.mock("@/lib/db", () => ({
  get db() {
    return harness.db;
  },
}));

vi.mock("@/lib/push/config", () => ({
  isPushConfigured: () => pushConfigured,
  webpush: {
    sendNotification: (
      sub: { endpoint: string },
      _body: string
    ): Promise<{ statusCode: number }> => {
      harness.attempted.push(sub.endpoint);
      const status = sendFailures[sub.endpoint];
      if (status) {
        return Promise.reject(Object.assign(new Error("push rejected"), { statusCode: status }));
      }
      return Promise.resolve({ statusCode: 201 });
    },
  },
}));

const sentry = {
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureCheckIn: vi.fn(() => "check-in-id"),
  withScope: vi.fn((fn: (scope: unknown) => void) =>
    fn({ setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn(), setUser: vi.fn() })
  ),
};
vi.mock("@sentry/nextjs", () => sentry);

/* ── driving the route ─────────────────────────────────────────────────── */

type Body = Record<string, unknown>;

async function call(
  query = "",
  headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }
): Promise<{ status: number; body: Body }> {
  const mod = await import("@/app/api/cron/announce-broadcast/route");
  const res = await mod.POST(new Request(`${URL_BASE}${query}`, { method: "POST", headers }));
  return { status: res.status, body: (await res.json()) as Body };
}

function counts(body: Body): Record<string, number> {
  return body.counts as Record<string, number>;
}

beforeEach(() => {
  // A fresh module graph per test, so the one-shot latch starts unclaimed.
  // The double-fire test deliberately does NOT reset between its two calls.
  vi.resetModules();
  vi.clearAllMocks();
  harness = buildHarness();
  pushConfigured = true;
  sendFailures = {};
  process.env.CRON_SECRET = SECRET;
  delete process.env.ANNOUNCE_BROADCAST_ENABLED;
});

/* ── 1. the double-fire ────────────────────────────────────────────────── */

describe("firing it twice must not send twice", () => {
  it("sends on the first live fire and refuses the second", async () => {
    process.env.ANNOUNCE_BROADCAST_ENABLED = "true";

    const first = await call("?live=1");
    expect(first.status).toBe(200);
    expect(first.body.mode).toBe("live");
    expect(first.body.state).toBe("fired");
    expect(counts(first.body).sendsSucceeded).toBe(4);
    expect(harness.attempted.length).toBe(4);

    const second = await call("?live=1");
    expect(second.status).toBe(409);
    expect(second.body.state).toBe("already-fired");
    expect(counts(second.body).sendsAttempted).toBe(0);
    // The load-bearing assertion: no second delivery, not merely a 409.
    expect(harness.attempted.length).toBe(4);
  });

  it("a dry run stays repeatable and never claims the latch", async () => {
    await call();
    await call();
    const third = await call();
    expect(third.status).toBe(200);
    expect(third.body.state).toBe("not-fired");
    expect(harness.attempted).toEqual([]);
  });
});

/* ── 2. unconfigured VAPID ─────────────────────────────────────────────── */

describe("a run that cannot send must say so instead of reporting success", () => {
  it("refuses with 503 when the VAPID keys are absent, even in dry run", async () => {
    pushConfigured = false;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.pushConfigured).toBe(false);
    expect(String(res.body.verdict)).toMatch(/not configured/i);
    expect(harness.attempted).toEqual([]);
  });

  it("refuses an armed live fire too, and leaves the latch unclaimed", async () => {
    pushConfigured = false;
    process.env.ANNOUNCE_BROADCAST_ENABLED = "true";
    const refused = await call("?live=1");
    expect(refused.status).toBe(503);
    expect(harness.attempted).toEqual([]);

    // The point of not claiming: configure VAPID, fire again, and it works.
    pushConfigured = true;
    const live = await call("?live=1");
    expect(live.status).toBe(200);
    expect(counts(live.body).sendsSucceeded).toBe(4);
  });
});

/* ── 3. the dry-run default ────────────────────────────────────────────── */

describe("dry run by default", () => {
  it("counts without sending when nothing arms it", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("dry-run");
    expect(counts(res.body).usersTargeted).toBe(5);
    expect(counts(res.body).usersWithLiveSubscription).toBe(3);
    expect(counts(res.body).deviceSubscriptions).toBe(4);
    expect(counts(res.body).sendsAttempted).toBe(0);
    expect(harness.attempted).toEqual([]);
  });

  it("refuses ?live=1 while the env var is unset, and says why", async () => {
    const res = await call("?live=1");
    expect(res.body.mode).toBe("dry-run");
    expect((res.body.refused as string[]).join(" ")).toMatch(/ANNOUNCE_BROADCAST_ENABLED/);
    expect(harness.attempted).toEqual([]);
  });

  it("stays a dry run when the env var is set but ?live=1 is absent", async () => {
    process.env.ANNOUNCE_BROADCAST_ENABLED = "true";
    const res = await call();
    expect(res.body.mode).toBe("dry-run");
    expect(res.body.armed).toBe(true);
    expect(harness.attempted).toEqual([]);
  });

  it("reports an env value that is neither arming nor a documented off", async () => {
    process.env.ANNOUNCE_BROADCAST_ENABLED = "TRUE";
    const res = await call("?live=1");
    expect(res.body.mode).toBe("dry-run");
    expect(res.body.ignoredEnabledValue).toBe("TRUE");
    expect(harness.attempted).toEqual([]);
  });
});

/* ── 4. the auth gate ─────────────────────────────────────────────────── */

describe("an unauthenticated caller gets nothing and sends nothing", () => {
  it("answers 401 with no authorization header, and reads nothing", async () => {
    process.env.ANNOUNCE_BROADCAST_ENABLED = "true";
    const res = await call("?live=1", {});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(harness.reads).toEqual([]);
    expect(harness.attempted).toEqual([]);
  });

  it("refuses a wrong secret", async () => {
    const res = await call("?live=1", { authorization: "Bearer not-the-secret" });
    expect(res.status).toBe(401);
    expect(harness.reads).toEqual([]);
  });

  it("refuses a bare token without the Bearer scheme", async () => {
    const res = await call("?live=1", { authorization: SECRET });
    expect(res.status).toBe(401);
    expect(harness.reads).toEqual([]);
  });

  it("answers 500 and raises Sentry when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await call();
    expect(res.status).toBe(500);
    expect(sentry.captureException).toHaveBeenCalled();
    expect(harness.reads).toEqual([]);
  });

  it("guard-the-guard: the same request WITH the secret does run", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(harness.reads.length).toBeGreaterThan(0);
  });
});

/* ── 5. scope ─────────────────────────────────────────────────────────── */

describe("scope — real, live users only", () => {
  it("never reaches a deactivated user, a tombstoned workspace or the demo seed", async () => {
    process.env.ANNOUNCE_BROADCAST_ENABLED = "true";
    await call("?live=1");
    expect(harness.attempted.sort()).toEqual([
      "https://push.test/ali-laptop",
      "https://push.test/ali-phone",
      "https://push.test/omar",
      "https://push.test/sara",
    ]);
  });

  it("names the excluded workspace in the response rather than leaving it implied", async () => {
    const res = await call();
    expect((res.body.scope as { excludedCompanyIds: string[] }).excludedCompanyIds).toEqual([
      "demo-nimbus",
    ]);
  });
});

/* ── 6. honest failure counts ─────────────────────────────────────────── */

describe("the report distinguishes delivered from failed", () => {
  it("counts a dead subscription as failed and prunes it", async () => {
    sendFailures = { "https://push.test/ali-laptop": 410, "https://push.test/sara": 500 };
    process.env.ANNOUNCE_BROADCAST_ENABLED = "true";
    const res = await call("?live=1");
    expect(counts(res.body).sendsAttempted).toBe(4);
    expect(counts(res.body).sendsSucceeded).toBe(2);
    expect(counts(res.body).sendsFailed).toBe(2);
    expect(counts(res.body).subscriptionsPruned).toBe(1);
    expect(harness.pruned).toEqual(["s-ali-laptop"]);
    // A partially failed broadcast is not a clean run.
    expect(res.body.ok).toBe(false);
  });

  it("says so loudly when there is no device to reach at all", async () => {
    harness = buildHarness(DEFAULT_USERS, []);
    const res = await call();
    expect(res.status).toBe(200);
    expect(counts(res.body).deviceSubscriptions).toBe(0);
    expect(String(res.body.verdict)).toMatch(/0 device/i);
  });
});
