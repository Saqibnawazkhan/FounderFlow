// @vitest-environment node

/**
 * prodready-018 — the app must be able to say "I am up and I can reach the
 * database" to something that is not a customer.
 *
 * THE FINDING. Every route under `app/api` required a session, a CRON_SECRET
 * bearer or a provider HMAC, so there was no URL an uptime monitor, a status
 * page or a Vercel health check could poll. Mean time to detection for a bad
 * migration, an exhausted pooler or an expired credential was "until somebody
 * who pays us notices". `scripts/qa-production-readiness.mjs` has probed
 * `/api/health` for longer than the route existed and reported it missing on
 * every run.
 *
 * WHAT THIS FILE PINS, and why each one is here rather than being obvious:
 *
 *   1. REACHABILITY IS TWO LAYERS, not one. CLAUDE.md's repo conventions say the
 *      middleware gate and the handler must agree. The middleware matcher in
 *      middleware.ts matches `/api/health` (it has no dot in it), so a route
 *      that is not in `authorized()`'s public allow-list answers a 302 to
 *      /login — which an uptime monitor records as "up". A health endpoint that
 *      is accidentally private is worse than none, because it reports green
 *      while telling you nothing. So the matcher is read from source and the
 *      allow-list is driven for real.
 *   2. IT REVEALS NOTHING BUT LIVENESS. The probe's failure path is the one
 *      place an unauthenticated response could echo a Prisma error, and Prisma's
 *      connection errors quote the HOST and port they failed to reach. The
 *      failure test throws a message shaped exactly like the real one and
 *      asserts no fragment of it reaches the body.
 *   3. IT NEVER WRITES, AND NEVER READS A TENANT'S ROWS. The whole Prisma client
 *      is a recorder; the assertion is on what was asked, so a future "while
 *      we're here, count the companies" cannot slip in.
 *   4. A FLOOD CANNOT AMPLIFY ONTO THE POOLER. The route is public and touches
 *      the database, which is an amplification surface; the handler memoises its
 *      probe for a short window so the DB round-trips are bounded by time rather
 *      than by request rate.
 *   5. A HUNG DATABASE STILL ANSWERS. The failure this endpoint exists to report
 *      is usually a hang, not a throw — a pooler with no free connections leaves
 *      the query pending. A probe that waits as long as the connection does
 *      reports nothing at all.
 *
 * Nothing here touches a database: `vi.mock("@/lib/db")` replaces the client
 * before the route's module graph is built.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authConfig } from "@/auth.config";

/* ─────────────────────────── the fake Prisma client ─────────────────────── */

/**
 * The message is shaped like the real one on purpose. Prisma's P1001 reads
 * "Can't reach database server at `<host>`:`<port>`", so the actual host of the
 * production database is in the exception this route catches. Point 2 above is
 * asserted against this string.
 *
 * Written out TWICE — here and inside the `vi.hoisted` block below — because
 * that block is lifted above every module-scope binding, so it cannot close
 * over this one. A leak assertion against a message the fake no longer throws
 * would pass for no reason at all, so the first test of the failure suite drives
 * the fake and demands the two copies still agree.
 */
const PRISMA_P1001 =
  "Can't reach database server at `db.qrstuvwxyzabcdef.supabase.co`:`5432`\n" +
  "Please make sure your database server is running at ...";

type Mode = "ok" | "throw" | "hang";

const prisma = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = [];
  const behaviour = { mode: "ok" as "ok" | "throw" | "hang" };
  const P1001 =
    "Can't reach database server at `db.qrstuvwxyzabcdef.supabase.co`:`5432`\n" +
    "Please make sure your database server is running at ...";

  function queryRaw(...args: unknown[]) {
    calls.push({ method: "$queryRaw", args });
    if (behaviour.mode === "throw") return Promise.reject(new Error(P1001));
    // A pending promise, never settled — exactly what an exhausted pgbouncer
    // pool does to a query. This is why the handler needs its own clock.
    if (behaviour.mode === "hang") return new Promise(() => {});
    return Promise.resolve([{ one: 1 }]);
  }

  // A Proxy rather than `{ $queryRaw }`, for the reason given in
  // tests/lib/auth/finance-gate.test.ts: a literal fake only knows the members
  // that existed the day it was written, so a model delegate added to this
  // route later would throw here instead of being RECORDED and failing the
  // "asks for nothing but SELECT 1" assertion with a useful message.
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "$queryRaw") return queryRaw;
        return new Proxy(
          {},
          {
            get(_t, method) {
              if (typeof method !== "string") return undefined;
              return (...args: unknown[]) => {
                calls.push({ method: `${prop}.${method}`, args });
                return Promise.resolve(null);
              };
            },
          }
        );
      },
    }
  );

  return { calls, behaviour, db };
});

vi.mock("@/lib/db", () => ({ db: prisma.db }));

/* ──────────────────────────────── helpers ───────────────────────────────── */

const ROUTE_PATH = join(process.cwd(), "app", "api", "health", "route.ts");

type Route = { GET: () => Promise<Response> };

/**
 * A FRESH module instance. The handler keeps its memo on module scope (point 4),
 * so every test that is not about the memo has to start with a cold one.
 */
async function load(): Promise<Route> {
  vi.resetModules();
  return (await import("@/app/api/health/route")) as unknown as Route;
}

async function read(route: Route) {
  const res = await route.GET();
  const text = await res.text();
  return {
    status: res.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
    header: (name: string) => res.headers.get(name),
  };
}

function setMode(mode: Mode) {
  prisma.behaviour.mode = mode;
}

/** Every `$queryRaw` the handler issued, as flat SQL text. */
function sqlIssued(): string[] {
  return prisma.calls
    .filter((c) => c.method === "$queryRaw")
    .map((c) => {
      const first = c.args[0];
      // A Prisma tagged template hands the strings array through as arg 0.
      return (Array.isArray(first) ? first.join(" ? ") : String(first)).trim();
    });
}

beforeEach(() => {
  prisma.calls.length = 0;
  setMode("ok");
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ─────────── 1. an external monitor can actually reach the route ────────── */

describe("the health route is reachable without a session", () => {
  type AuthorizedFn = NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>;
  type AuthorizedArg = Parameters<AuthorizedFn>[0];

  async function ask(path: string) {
    const authorized = (authConfig.callbacks as { authorized: AuthorizedFn }).authorized;
    return authorized({
      auth: null,
      request: { nextUrl: new URL("https://app.founderflow.test" + path) },
    } as unknown as AuthorizedArg);
  }

  /** The middleware matcher, read from middleware.ts rather than restated. */
  function matcher(): RegExp {
    const source = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
    const hit = /matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/.exec(source);
    if (!hit) throw new Error("could not read the matcher out of middleware.ts");
    return new RegExp("^" + hit[1].replace(/\\\\/g, "\\") + "$");
  }

  it("is a path the middleware actually inspects, so the allow-list below matters", () => {
    expect(matcher().test("/api/health")).toBe(true);
  });

  it("lets an anonymous request through", async () => {
    await expect(ask("/api/health")).resolves.toBe(true);
  });

  it("does not make a neighbouring path public along with it", async () => {
    await expect(ask("/api/healthcheck")).resolves.toBe(false);
    await expect(ask("/api/health/details")).resolves.toBe(false);
  });

  it("is kept out of the crawlable surface", async () => {
    const robots = (await import("@/app/robots")).default;
    const rules = robots().rules;
    const disallowed = (Array.isArray(rules) ? rules : [rules]).flatMap((r) => {
      const d = r.disallow;
      return d === undefined ? [] : Array.isArray(d) ? d : [d];
    });
    expect(
      disallowed.some((p) => "/api/health".startsWith(p)),
      "robots.txt invites crawlers to /api/health — a public endpoint that opens a database " +
        "connection should not be in a search index. Disallowed: " +
        disallowed.join(", ")
    ).toBe(true);
  });
});

/* ───────────────────── 2. what it reports when all is well ──────────────── */

describe("a healthy deployment", () => {
  it("answers 200 with the liveness facts a status page needs", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef");
    const res = await read(await load());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.commit).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef");
    expect(typeof res.body.ms).toBe("number");
  });

  it("reports the commit as null rather than inventing one when it is unset", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    const res = await read(await load());
    expect(res.body.commit).toBeNull();
  });

  it("asks the database for nothing but SELECT 1, and writes nothing", async () => {
    await read(await load());
    expect(sqlIssued()).toEqual(["SELECT 1"]);
    expect(
      prisma.calls.filter((c) => c.method !== "$queryRaw").map((c) => c.method),
      "the liveness probe reached a model delegate — it must not read or write any tenant row"
    ).toEqual([]);
  });

  it("is never cached, so a monitor cannot be served a stale 200 during an outage", async () => {
    const res = await read(await load());
    expect(res.header("cache-control")).toMatch(/no-store/);
  });
});

/* ────────────────── 3. what it reports when the DB is gone ──────────────── */

describe("a deployment that cannot reach its database", () => {
  it("is driven by the Prisma message the leak assertions are written against", async () => {
    // The drift guard for the duplicated PRISMA_P1001 (see its comment). Without
    // it, renaming the host inside the hoisted fake would leave the leak test
    // searching the body for a string nothing ever produces — green, and
    // checking nothing.
    setMode("throw");
    const queryRaw = (prisma.db as Record<string, (...a: unknown[]) => Promise<unknown>>).$queryRaw;
    await expect(queryRaw(["SELECT 1"])).rejects.toThrow(PRISMA_P1001);
  });

  it("answers 503, not 200", async () => {
    setMode("throw");
    const res = await read(await load());
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it("leaks no part of the Prisma error — not the host, not the message", async () => {
    setMode("throw");
    const res = await read(await load());
    expect(res.text).not.toContain("supabase");
    expect(res.text).not.toContain("Can't reach database server");
    expect(res.text).not.toContain("5432");
    // And nothing resembling a whole connection string.
    expect(res.text).not.toMatch(/postgres(ql)?:\/\//);
    // The message of the real exception, in full, must be nowhere in the body.
    expect(res.text.includes(PRISMA_P1001)).toBe(false);
  });

  it("answers at all when the query hangs instead of failing", async () => {
    setMode("hang");
    const route = await load();
    // `now` explicitly: vitest sets no default, so @sinonjs/fake-timers installs
    // at epoch 0 and every `Date.now()` the handler takes jumps BACKWARDS by
    // fifty-six years. That makes elapsed-time arithmetic negative, which is
    // exactly the kind of green-for-the-wrong-reason this suite is guarding.
    vi.useFakeTimers({ now: Date.now() });
    const pending = route.GET();
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("gives up quickly — the probe's own deadline is short", () => {
    const source = readFileSync(ROUTE_PATH, "utf8");
    const hit = /const DB_TIMEOUT_MS = ([0-9_]+);/.exec(source);
    expect(
      hit,
      "DB_TIMEOUT_MS is gone from the health route — the hang test below is derived " +
        "from it, so re-point this at the new name rather than inlining a number"
    ).not.toBeNull();
    const ms = Number((hit as RegExpExecArray)[1].replace(/_/g, ""));
    expect(ms).toBeGreaterThan(0);
    expect(
      ms,
      "a liveness probe that waits longer than ten seconds is a probe the monitor times out on " +
        "first, which turns a precise 503 into an indistinguishable timeout"
    ).toBeLessThanOrEqual(10_000);
  });
});

/* ──────── 4. a public endpoint must not be an amplifier onto the DB ─────── */

describe("the probe is bounded by time, not by request rate", () => {
  it("serves a burst of requests from one database round-trip", async () => {
    const route = await load();
    await read(route);
    await read(route);
    await read(route);
    expect(
      sqlIssued().length,
      "every poll of this unauthenticated route opened its own database round-trip, so anyone " +
        "can turn request rate into pooler load on the live database"
    ).toBe(1);
  });

  it("collapses simultaneous polls into one round-trip, before any memo exists", async () => {
    // Distinct from the burst above, which is sequential and therefore covered
    // by the memo. These three start before the first probe has settled, so
    // nothing is memoised yet — without in-flight deduplication a concurrent
    // flood opens one connection per request no matter how long the memo lives.
    const route = await load();
    const all = await Promise.all([route.GET(), route.GET(), route.GET()]);
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(sqlIssued().length).toBe(1);
  });

  it("re-checks once the memo is stale, so recovery and failure are both seen", async () => {
    const route = await load();
    await read(route);
    const source = readFileSync(ROUTE_PATH, "utf8");
    const hit = /const MEMO_TTL_MS = ([0-9_]+);/.exec(source);
    expect(hit, "MEMO_TTL_MS is gone from the health route").not.toBeNull();
    const ttl = Number((hit as RegExpExecArray)[1].replace(/_/g, ""));
    expect(
      ttl,
      "a memo longer than fifteen seconds means a status page can report green a quarter of a " +
        "minute after the database went away"
    ).toBeLessThanOrEqual(15_000);

    vi.useFakeTimers({ now: Date.now() });
    await vi.advanceTimersByTimeAsync(ttl + 1);
    setMode("throw");
    const res = await read(route);
    expect(sqlIssued().length).toBe(2);
    expect(res.status).toBe(503);
  });
});
