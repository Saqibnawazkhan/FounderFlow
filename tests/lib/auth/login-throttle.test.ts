/**
 * Regression tests for the login throttle — audit findings auth-001 + sec-008.
 *
 * THE BUG THESE LOCK DOWN: `limiters.auth.consume(ip)` lived only in
 * `loginAction`, the server action behind the login FORM. The endpoint the
 * browser actually posts to is `POST /api/auth/callback/credentials`, which
 * `auth.config.ts` marks PUBLIC and which needs nothing but a csrfToken from
 * the public `GET /api/auth/csrf`. That path reached `authorize()` — and
 * `bcrypt.compare` — with no bucket, no lockout and no captcha, so a known
 * founder's address could be guessed at as fast as the server answered.
 * lib/auth.ts even carried a comment asserting the limiter covered it.
 *
 * WHY THE ASSERTIONS LOOK LIKE THIS: a throttled attempt and a wrong password
 * both resolve to `null`, on purpose — same CredentialsSignin error, so no
 * account-enumeration oracle and no UI copy to change. `null` therefore proves
 * nothing by itself. These tests assert on the WORK NOT DONE: once the throttle
 * bites, `db.user.findFirst` is not reached and `bcrypt.compare` is not reached.
 * That is the property an attacker cares about (and the one that pays for the
 * ~250ms of bcrypt CPU each guess would otherwise buy), and it cannot pass
 * vacuously the way a bare `toBeNull()` can.
 *
 * These drive `authorizeCredentials` directly — the exact function the provider
 * is constructed with — because NextAuth hands out no other handle on it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted so the vi.mock factories below (which are themselves hoisted above
// the imports) can close over these without hitting a TDZ error.
const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  compare: vi.fn(),
  // Mutable so a test can hand every attempt a different source IP and
  // reproduce the realistic attack: a distributed spray at ONE known email.
  ip: { value: "198.51.100.1" },
  // Whatever lib/auth.ts hands to NextAuth(), captured so we can prove the
  // provider is wired to the same function the tests drive.
  nextAuthConfig: { value: undefined as unknown },
  credentialsOptions: { value: undefined as unknown },
}));

// next-auth is stubbed for TWO reasons, not one.
//  1. Mechanical: `next-auth/lib/env.js` does a bare `import "next/server"`,
//     which vitest cannot resolve (next ships it as `next/server.js` and the
//     export map only lines up under the Next bundler). Importing the real
//     package here fails at load, before a single assertion runs.
//  2. Useful: stubbing the factory lets us capture the config object and
//     assert the Credentials provider is constructed with the SAME function
//     these tests call. Without that link a green suite would only prove some
//     exported helper is throttled, not that the live endpoint is.
vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    h.nextAuthConfig.value = config;
    return { auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  },
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: (options: unknown) => {
    h.credentialsOptions.value = options;
    return { id: "credentials", type: "credentials", ...(options as object) };
  },
}));

// auth.config.ts pulls in next/server (NextResponse) for the middleware
// redirect, which hits the same resolution wall. Nothing on the authorize()
// path reads it, so a minimal stand-in is honest here.
vi.mock("@/auth.config", () => ({
  authConfig: {
    trustHost: true,
    session: { strategy: "jwt" },
    pages: { signIn: "/login" },
    providers: [],
    callbacks: {
      jwt: ({ token }: { token: unknown }) => token,
      session: ({ session }: { session: unknown }) => session,
      authorized: () => true,
    },
  },
}));

// Mock next/headers rather than @/lib/client-ip, so the real getClientIp() —
// including its "never trust the leftmost x-forwarded-for" rule — is part of
// what is under test. x-real-ip is the header Vercel's edge sets from the TCP
// peer, i.e. the value production actually keys on.
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => (name.toLowerCase() === "x-real-ip" ? h.ip.value : null),
  }),
}));

// @/lib/db MUST be mocked before lib/auth is imported: importing it for real
// constructs a PrismaClient, which reads DATABASE_URL from whatever env the
// runner happens to have. A unit test has no business opening a connection to
// anything — the root .env was emptied this session (enforced by
// tests/lib/env/no-prod-credentials.test.ts), but "the file is empty today" is
// not the reason this mock exists, and it must not become the reason.
vi.mock("@/lib/db", () => ({
  db: { user: { findFirst: h.findFirst, update: h.update, findUnique: h.findUnique } },
}));

vi.mock("bcryptjs", () => ({ default: { compare: h.compare } }));

vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));

import { authorizeCredentials } from "@/lib/auth";

const PASSWORD = "whatever-they-guessed";

// These mirror lib/rate-limit.ts. Retune the limiters, retune these.
const IP_LIMIT = 5; // credential checks per IP per minute
const EMAIL_FAILURE_LIMIT = 10; // FAILED checks per email address per 15 min

function fakeUser(email: string) {
  return {
    id: "user_1",
    name: "Nimbus Founder",
    email,
    companyId: "demo-nimbus",
    role: "admin",
    passwordHash: "$2a$12$abcdefghijklmnopqrstuv",
    sessionVersion: 0,
    deletedAt: null,
  };
}

/** One attempt down the provider path, arriving from `ip`. */
async function attempt(email: string, ip: string) {
  h.ip.value = ip;
  return authorizeCredentials({ email, password: PASSWORD });
}

describe("credentials provider path is throttled (auth-001 / sec-008)", () => {
  beforeEach(() => {
    // THE MECHANISM THAT WOULD MAKE THIS WHOLE FILE LIE: rateLimiter()
    // short-circuits to allowed:true when RATE_LIMIT_DISABLED === "true". If
    // that ever reaches the test env — a CI job, a stray shell export — every
    // assertion below goes vacuous while staying green, which is exactly how
    // this repo has already shipped two tests that passed over broken features.
    // Pin it off explicitly rather than trusting the ambient environment.
    vi.stubEnv("RATE_LIMIT_DISABLED", "");

    h.findFirst.mockReset();
    h.update.mockReset();
    h.compare.mockReset();
    // Default posture: the address exists (the attacker knows a real one) and
    // the password is wrong. That is the interesting case.
    h.findFirst.mockImplementation(async ({ where }: { where: { email: string } }) =>
      fakeUser(where.email)
    );
    h.compare.mockResolvedValue(false);
    h.update.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // Every test below uses its own email and its own IP range. The limiter
  // stores live on globalThis with no cross-file reset hook, so unique keys are
  // what keeps these independent — and it keeps this file honest, asserting on
  // observable behaviour instead of reaching into lib/rate-limit.ts internals.

  it("stops reaching bcrypt once one minute of per-IP budget is spent", async () => {
    const email = "ip-bucket@example.com";
    const ip = "198.51.100.10";

    for (let i = 0; i < IP_LIMIT; i++) {
      expect(await attempt(email, ip)).toBeNull(); // wrong password
    }
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);

    // The guess made after the budget is spent must cost us neither a DB round
    // trip nor a bcrypt compare. THIS is what failed before the fix.
    expect(await attempt(email, ip)).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);
    expect(h.findFirst).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it("counts a SUCCESSFUL credential check against the per-IP budget too", async () => {
    // Deliberate: the per-IP bucket prices the WORK, and we cannot know an
    // attempt will succeed until we have already paid for the lookup and the
    // bcrypt compare. Charging only failures would leave a valid-credential
    // flood as a free CPU sink.
    const email = "ip-success@example.com";
    const ip = "198.51.100.20";
    h.compare.mockResolvedValue(true);

    for (let i = 0; i < IP_LIMIT; i++) {
      expect(await attempt(email, ip)).not.toBeNull();
    }
    expect(await attempt(email, ip)).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it("is a throttle, not a lockout — per-IP budget refills as the window slides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
    const email = "ip-window@example.com";
    const ip = "198.51.100.30";

    for (let i = 0; i < IP_LIMIT; i++) await attempt(email, ip);
    await attempt(email, ip);
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);

    // A legitimate user who tripped it must get back in with no operator.
    vi.advanceTimersByTime(61_000);
    await attempt(email, ip);
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT + 1);
  });

  it("blocks a distributed spray at one known email though every attempt has a fresh IP", async () => {
    // The realistic attack on a named founder: one target address, a rented
    // proxy pool, one guess per IP. An IP-keyed bucket alone sees nothing here.
    const email = "ceo@example.com";

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      expect(await attempt(email, `203.0.113.${i + 1}`)).toBeNull();
    }
    expect(h.compare).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);

    // Fresh IP, so the per-IP bucket for it is empty — only the per-account
    // bucket can stop this one.
    expect(await attempt(email, "203.0.113.200")).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);
    expect(h.findFirst).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);
  });

  it("normalises the email key, so re-capitalising the address is not a fresh bucket", async () => {
    // The DB lookup lowercases (`email.toLowerCase()`), so if the bucket key
    // did not, `Founder@…` and `founder@…` would be two budgets for one
    // account and the per-account limit would be free to walk around itself.
    const email = "case-bypass@example.com";

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      await attempt(email, `192.0.2.${i + 1}`);
    }
    expect(h.compare).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);

    expect(await attempt("Case-Bypass@Example.COM", "192.0.2.200")).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);
  });

  it("throttles a spray at an address that does not exist, too", async () => {
    // Otherwise the cheapest probe is to guess addresses: findFirst is a real
    // query whether or not it matches, and a miss is the slowest kind to serve.
    const email = "nobody-here@example.com";
    h.findFirst.mockResolvedValue(null);

    for (let i = 0; i < EMAIL_FAILURE_LIMIT; i++) {
      expect(await attempt(email, `198.51.100.${100 + i}`)).toBeNull();
    }
    expect(h.findFirst).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);

    expect(await attempt(email, "198.51.100.199")).toBeNull();
    expect(h.findFirst).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT);
  });

  it("does not spend the per-account budget on a SUCCESSFUL sign-in", async () => {
    // Deliberate, and the opposite of the per-IP rule above: the per-account
    // bucket counts FAILURES only. A founder signing in from ten devices in an
    // afternoon must not walk themselves into a lockout, and an attacker who
    // already has the password has no use for this budget anyway.
    const email = "success-is-free@example.com";

    for (let i = 0; i < EMAIL_FAILURE_LIMIT - 1; i++) {
      await attempt(email, `198.18.0.${i + 1}`); // 9 failures
    }
    h.compare.mockResolvedValue(true);
    expect(await attempt(email, "198.18.0.50")).not.toBeNull(); // 1 success
    h.compare.mockResolvedValue(false);

    // The 10th FAILURE is still inside the budget, because the success above
    // did not consume any of it.
    expect(await attempt(email, "198.18.0.51")).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT + 1);

    // The 11th failure is over the line.
    expect(await attempt(email, "198.18.0.52")).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(EMAIL_FAILURE_LIMIT + 1);
  });

  it("is the function the Credentials provider itself is built with", async () => {
    // The load-bearing link. Everything above tests `authorizeCredentials`; this
    // asserts that `POST /api/auth/callback/credentials` — the public endpoint
    // from the audit finding — runs exactly that function, not a sibling copy
    // that someone could later let drift out from under the throttle.
    const options = h.credentialsOptions.value as { authorize?: unknown };
    expect(options?.authorize).toBe(authorizeCredentials);

    const config = h.nextAuthConfig.value as { providers: Array<{ authorize?: unknown }> };
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].authorize).toBe(authorizeCredentials);
  });

  it("keeps rejecting malformed credentials without touching the DB", async () => {
    // Unchanged behaviour, pinned so the new gate can never be ordered ahead of
    // the zod parse in a way that feeds unvalidated junk into the buckets.
    expect(await authorizeCredentials({ email: "not-an-email", password: "x" })).toBeNull();
    expect(await authorizeCredentials({ email: "a@b.com", password: "" })).toBeNull();
    expect(h.findFirst).not.toHaveBeenCalled();
  });
});
