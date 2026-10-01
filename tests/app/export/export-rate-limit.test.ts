// @vitest-environment node

/**
 * rep-010 — the heaviest and most sensitive read in the product is rate-limited.
 *
 * THE FINDING. `/api/export` had no limiter call of any kind. Every other
 * consequential operation in lib/actions/ passes through one, and
 * FaultsAudit.md described this endpoint as "admin-only, rate-limited" — the
 * rate limiting was never there.
 *
 * Two distinct costs, and the limiter is the answer to both:
 *
 *   • EXFILTRATION. A departing co-founder, or anyone who phishes an admin
 *     session, could pull every transaction, every email address, every comment
 *     and every time entry, repeatedly, at whatever rate they liked.
 *   • SELF-DoS. `workspaceExport` issues twelve unbounded `findMany` calls in one
 *     `Promise.all` and serializes the result into a single JSON document
 *     (`maxDuration = 60`). Unlimited repeats are the cheapest way to exhaust a
 *     serverless function budget, from a signed-in session, with no exploit.
 *
 * WHAT THIS FILE PINS, and the one assertion that carries the weight: a refused
 * request must reach the database ZERO TIMES. A 429 returned after the twelve
 * reads have already run would price nothing — the cost is the query, not the
 * response. So the refusal is asserted on the recorded Prisma calls, not on the
 * status code alone.
 *
 * WHY A BUCKET PER (scope, user) AND NOT ONE PER USER. lib/rate-limit.ts's own
 * doctrine, stated at `limiters.read`: "a rejection that lands on a DIFFERENT
 * action from the one that caused it is the worst class of bug this file can
 * cause". `scope=me` is one person's own rows and is open to every role;
 * `scope=workspace` is the twelve-table read. A member whose personal download
 * is refused because an admin has been exporting the workspace would have no way
 * to understand why.
 *
 * THE AUDIT-TRAIL HALF (sec-020) IS NOW HERE, in the last describe block. It was
 * deferred when rep-010 landed because writing the row needs
 * `"workspace_exported"` added to `ActivityType` in lib/types.ts and to
 * `ACTIVITY_META` in app/(app)/activities/activities-client.tsx, both owned by
 * other agents that wave. That client indexes `ACTIVITY_META[activity.type]` and
 * dereferences the result unguarded, so a row written before those two edits land
 * would crash /activities for the whole workspace — permanently, because the row
 * persists. The three edits arrived together in sec-020, which also covers the
 * credential paths (tests/security/credential-audit-trail.test.ts) and holds the
 * structural guard over the union and the icon map.
 *
 * THE ROW IS FAIL-CLOSED, which is the one place in this family that is. If the
 * INSERT fails the export does not go out: the twelve reads have happened but no
 * bytes have left, so refusing costs a retry and nothing else. The credential
 * paths are the opposite — their UPDATE has already landed by the time the row is
 * written, so there a failed row must not be reported as a failed password
 * change. lib/activity/security-log.ts carries both postures and the argument.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimiter } from "@/lib/rate-limit";
import type { ScopedSession } from "@/lib/queries/session";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const key = delegate + "." + method;
    if (answers.has(key)) return Promise.resolve(answers.get(key));
    return Promise.resolve(null);
  }

  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

const sentry = vi.hoisted(() => ({ captureServerError: vi.fn() }));

const session = vi.hoisted(() => ({
  scoped: {
    userId: "u_admin",
    userName: "Ayesha",
    email: "ayesha@nimbus.app",
    companyId: "c_nimbus",
    role: "admin",
  } as ScopedSession,
}));

vi.mock("@/lib/db", () => ({ db: prisma.db }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: sentry.captureServerError }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.scoped),
}));
vi.mock("@/lib/auth", () => ({
  auth: () =>
    Promise.resolve({
      user: {
        id: session.scoped.userId,
        companyId: session.scoped.companyId,
        role: session.scoped.role,
      },
    }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { GET } from "@/app/api/export/route";
import { EXPORT_LIMITER_NAME, EXPORT_RATE_LIMIT } from "@/app/api/export/rate-limit";

/** Same bucket the route uses — `rateLimiter` anchors stores on globalThis by
 *  name, so this instance clears the route's keys. The numbers here are
 *  irrelevant to `reset()`; the store is keyed by name alone. */
const bucket = rateLimiter(EXPORT_LIMITER_NAME, EXPORT_RATE_LIMIT);

function money(n: number) {
  return { toNumber: () => n } as unknown as { toNumber(): number };
}

function stockWorkspace() {
  prisma.answers.set("company.findFirst", {
    id: "c_nimbus",
    name: "Nimbus Labs",
    currency: "USD",
  });
  prisma.answers.set("user.findMany", [
    { id: "u_admin", email: "ayesha@nimbus.app", passwordHash: "$2b$x", deletedAt: null },
  ]);
  prisma.answers.set("user.findFirst", {
    id: "u_admin",
    email: "ayesha@nimbus.app",
    passwordHash: "$2b$x",
  });
  prisma.answers.set("transaction.findMany", [{ id: "t1", amount: money(50000) }]);
  prisma.answers.set("budget.findMany", [{ id: "b1", monthlyLimit: money(1000) }]);
  prisma.answers.set("recurringRule.findMany", [{ id: "r1", amount: money(99) }]);
  for (const d of [
    "project",
    "task",
    "timeEntry",
    "comment",
    "activity",
    "notification",
    "inviteToken",
    "notificationPreference",
  ]) {
    prisma.answers.set(`${d}.findMany`, []);
  }
}

function req(scope?: string): Request {
  const url = scope ? `https://app.test/api/export?scope=${scope}` : "https://app.test/api/export";
  return new Request(url);
}

function asUser(userId: string, role: ScopedSession["role"] = "admin") {
  session.scoped = {
    userId,
    userName: "Tester",
    email: `${userId}@nimbus.app`,
    companyId: "c_nimbus",
    role,
  };
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  sentry.captureServerError.mockClear();
  bucket.reset();
  asUser("u_admin");
  stockWorkspace();
  delete process.env.RATE_LIMIT_DISABLED;
});

describe("the limit is a real, usable budget", () => {
  it("allows several exports before refusing — retries and a second format are normal", () => {
    expect(EXPORT_RATE_LIMIT.limit).toBeGreaterThanOrEqual(3);
    expect(EXPORT_RATE_LIMIT.limit).toBeLessThanOrEqual(10);
    // Long enough that the budget is not trivially refilled by waiting a moment,
    // which is what makes it price repetition rather than merely pace it.
    expect(EXPORT_RATE_LIMIT.windowMs).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("serves the first workspace export normally", async () => {
    const res = await GET(req("workspace"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses at exactly the declared budget — the constant is in force, not just declared", async () => {
    // Measured rather than restated: counting the 200s until the first 429 is what
    // proves `EXPORT_RATE_LIMIT` is the number the route actually applies. An
    // assertion on the constant alone would pass with no limiter call at all.
    let served = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await GET(req("workspace"));
      if (res.status === 429) break;
      expect(res.status).toBe(200);
      served += 1;
    }
    expect(served).toBe(EXPORT_RATE_LIMIT.limit);
  });

  it("a bucket reset really frees the budget — guard the guard", async () => {
    // Every case below depends on beforeEach clearing the store. If `reset()` were
    // clearing a DIFFERENT store (a renamed bucket, a second globalThis), budgets
    // would leak between tests and the suite would go red in confusing places
    // rather than here.
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      await GET(req("workspace"));
    }
    expect((await GET(req("workspace"))).status).toBe(429);
    bucket.reset();
    expect((await GET(req("workspace"))).status).toBe(200);
  });

  it("serves every request inside the budget", async () => {
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      const res = await GET(req("workspace"));
      expect(res.status).toBe(200);
    }
  });
});

describe("rep-010 — past the budget the export is refused", () => {
  async function spendBudget() {
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      await GET(req("workspace"));
    }
  }

  it("answers 429 once the budget is gone", async () => {
    await spendBudget();
    const res = await GET(req("workspace"));
    expect(res.status).toBe(429);
  });

  it("does not touch the database on a refused request", async () => {
    // THE assertion. A 429 issued after the twelve findMany calls have run would
    // price nothing: the cost of this endpoint is the query, not the response.
    await spendBudget();
    prisma.calls.length = 0;
    const res = await GET(req("workspace"));
    expect(res.status).toBe(429);
    expect(prisma.calls).toHaveLength(0);
  });

  it("says when to come back, in the header a client can act on", async () => {
    await spendBudget();
    const res = await GET(req("workspace"));
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("returns JSON with an error, so /settings shows a toast and not raw HTML", async () => {
    // app/(app)/settings/settings-client.tsx guards on content-type: anything that
    // is not application/json is treated as a failed export.
    await spendBudget();
    const res = await GET(req("workspace"));
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("does not report the refusal to Sentry as a server error", async () => {
    // A limiter doing its job is not an exception. Reporting it would bury the
    // real 500s this route can produce.
    await spendBudget();
    await GET(req("workspace"));
    expect(sentry.captureServerError).not.toHaveBeenCalled();
  });
});

describe("rep-010 — the budget is per person and per scope", () => {
  it("does not spend one user's budget on another's exports", async () => {
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      await GET(req("workspace"));
    }
    expect((await GET(req("workspace"))).status).toBe(429);
    asUser("u_cofounder", "cofounder");
    expect((await GET(req("workspace"))).status).toBe(200);
  });

  it("does not let a spent workspace budget block a personal download", async () => {
    // lib/rate-limit.ts's rule: the rejection must land on the action that caused
    // it. `scope=me` is one person's own rows, and acct-009 exists precisely
    // because a member's only data operation used to be "delete my account".
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      await GET(req("workspace"));
    }
    expect((await GET(req("workspace"))).status).toBe(429);
    const mine = await GET(req("me"));
    expect(mine.status).toBe(200);
  });

  it("limits scope=me too, on its own bucket", async () => {
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit; i += 1) {
      expect((await GET(req("me"))).status).toBe(200);
    }
    expect((await GET(req("me"))).status).toBe(429);
  });
});

describe("the limiter sits after the cheap refusals, not before them", () => {
  it("does not charge a member for the 403 they were always going to get", async () => {
    // A member's workspace request is refused with zero database reads, so it
    // costs nothing to serve. Charging it would let an attacker with a member
    // session burn a budget they cannot use — and would make the 403 path's own
    // guarantee (no reads) harder to reason about, not easier.
    asUser("u_member", "member");
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit + 3; i += 1) {
      const res = await GET(req("workspace"));
      expect(res.status).toBe(403);
    }
    expect(prisma.calls).toHaveLength(0);
    // …and their personal export still works, at full budget.
    expect((await GET(req("me"))).status).toBe(200);
  });

  it("does not charge an unknown scope", async () => {
    for (let i = 0; i < EXPORT_RATE_LIMIT.limit + 2; i += 1) {
      expect((await GET(req("sideways"))).status).toBe(400);
    }
    expect((await GET(req("workspace"))).status).toBe(200);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* sec-020 — bulk egress leaves a trail                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("sec-020 — a workspace export is recorded in the activity feed", () => {
  /** The `data` of every Activity row written this run. */
  function activityRows(): Array<Record<string, unknown>> {
    return prisma.calls
      .filter((c) => c.delegate === "activity" && c.method === "create")
      .map((c) => ((c.args[0] as { data?: unknown })?.data ?? {}) as Record<string, unknown>);
  }

  it("writes one row naming who downloaded it", async () => {
    // The question that gets asked exactly once, after something has gone wrong:
    // "did someone export our books?" Before this, there was no data to answer
    // from — the heaviest and most sensitive read in the product was invisible.
    const res = await GET(req("workspace"));
    expect(res.status).toBe(200);

    const rows = activityRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("workspace_exported");
    expect(rows[0]!.companyId).toBe("c_nimbus");
    expect(rows[0]!.userId).toBe("u_admin");
    expect(String(rows[0]!.message)).toMatch(/export/i);
  });

  it("writes the row BEFORE the file is handed over", async () => {
    // Fail-closed: no trail, no bulk download. The reads have run but nothing has
    // left the building yet, so refusing costs a retry — whereas an export with
    // no row is unrecoverable, because the row is the only record it happened.
    // `record()` hands back `Promise.resolve(answer)`, and resolving a rejected
    // promise yields that same rejected promise — so this is the harness's way of
    // making one delegate call fail.
    const boom = Promise.reject(new Error("audit insert failed"));
    // Marked handled so the rejection cannot surface as an unhandled one if the
    // route ever stops awaiting it; the awaiter inside the route still sees it.
    void boom.catch(() => undefined);
    prisma.answers.set("activity.create", boom);

    const res = await GET(req("workspace"));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-disposition")).toBeNull();
  });

  it("does not record a refused export", async () => {
    // A member's workspace request never reads anything and never happened, so a
    // row for it would be a false history — and `prisma.calls` being empty is
    // the existing guarantee this must not weaken.
    asUser("u_member", "member");
    const res = await GET(req("workspace"));
    expect(res.status).toBe(403);
    expect(prisma.calls).toHaveLength(0);
  });

  it("does not record a personal download", async () => {
    // `scope=me` is bounded by the caller's own rows — not the bulk-egress event
    // this finding is about — and reporting a data-subject access request into an
    // admin-only feed is its own small privacy problem. The route's header states
    // the decision; this pins it so it is not "fixed" by accident.
    const res = await GET(req("me"));
    expect(res.status).toBe(200);
    expect(activityRows()).toEqual([]);
  });

  it("does not put the exported rows in the audit row", async () => {
    // The feed is prose a human reads. Copying payload into it would duplicate
    // every transaction into a second table and widen the leak it is recording.
    await GET(req("workspace"));
    const serialized = JSON.stringify(activityRows());
    expect(serialized).not.toContain("50000");
    expect(serialized).not.toContain("ayesha@nimbus.app");
  });
});
