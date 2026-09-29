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
  // `null` means the header is absent, i.e. NO trusted client address — the
  // runtime every self-host, Docker and nginx deployment is in.
  ip: { value: "198.51.100.1" as string | null },
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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizeCredentials } from "@/lib/auth";
import { gateLoginAttempt, recordLoginFailure } from "@/lib/auth/login-throttle";
import { gateAuthAction, ipBucketKey, UNTRUSTED_CLIENT_IP } from "@/lib/rate-limit";

const PASSWORD = "whatever-they-guessed";

/**
 * Blank out every comment in JS/TS source, preserving newlines so nothing
 * shifts. Used by the two source sweeps in this file.
 *
 * A SCANNER, NOT THE TWO-REGEX VERSION in tests/lib/layout/rtl.test.ts, because
 * the obvious pair (block comments first via `\/\*[\s\S]*?\*\/`, then line
 * comments) is defeated by a LINE comment that happens to contain `/*`.
 * `scripts/qa-auth-and-sessions.mjs` has one — `// guard. /api/auth/* is public
 * in auth.config.ts` — and the non-greedy block match pairs that `/*` with the
 * next real block-comment terminator 130 lines below, blanking every line
 * between. The first draft of the probe sweep below did exactly that and
 * silently read its guess count off an unrelated loop in section 9 — which is
 * the failure mode this whole file exists to stop: a check that still passes
 * while measuring the wrong thing.
 *
 * Strings and template literals are tracked so a URL or a quoted `/*` survives.
 * Regex literals are NOT tracked: a literal would have to contain an unescaped
 * `/*` (e.g. `/[/*]/`) to be misread, which nothing under `lib/` or `scripts/`
 * does, and pretending to parse JS regex-vs-division here would be worse.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        i += 1;
        if (source[i - 1] === ch) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

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

/**
 * One attempt from a deployment where NO forwarding header can be trusted, so
 * `getClientIp()` returns the `UNTRUSTED_CLIENT_IP` sentinel. Dropping the
 * header is the honest way to produce that: it exercises the real
 * `getClientIpInfo()` "header-absent" branch rather than passing the sentinel
 * in by hand and assuming that is what production would do.
 */
async function attemptWithNoTrustedIp(email: string) {
  h.ip.value = null;
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

/* ─────────────────────────────────────────────────────────────────────────── */
/* No trusted client address — the per-IP bucket must not become a global one   */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("login throttle where there is no trusted client address (sec-001)", () => {
  /**
   * WHAT THESE ARE FOR. `getClientIp()` returns the sentinel
   * `UNTRUSTED_CLIENT_IP` whenever no forwarding header may be believed — every
   * self-hosted box, every Docker/nginx deployment, `vercel dev`, and any
   * production runtime we cannot identify (lib/client-ip.ts:88-100). A sentinel
   * used verbatim as a bucket key is a BUCKET: one 5-per-minute budget shared by
   * every visitor on earth, which an attacker empties on purpose to refuse
   * sign-in to every paying customer at once, from one machine, in one second.
   *
   * lib/rate-limit.ts already built the answer — `ipBucketKey(ip, identity)`
   * returns a trusted address verbatim and otherwise degrades to a per-ACCOUNT
   * key — and `gateAuthAction({ kind: "login" })` already uses it. The choke
   * point inside `authorize()`, which is the one that actually COUNTS, did not.
   *
   * Two distinct harms follow from that, and the two tests separate them.
   */

  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "");
    h.findFirst.mockReset();
    h.update.mockReset();
    h.compare.mockReset();
    h.findFirst.mockImplementation(async ({ where }: { where: { email: string } }) =>
      fakeUser(where.email)
    );
    h.compare.mockResolvedValue(false);
    h.update.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    h.ip.value = "198.51.100.1";
  });

  it("one attacker cannot spend every other customer's login budget", async () => {
    // HARM 1: denial of service against everybody. The attacker burns the whole
    // per-address minute on their own account; an unrelated customer's very
    // first attempt must still be served.
    const attacker = "untrusted-attacker@example.com";
    const bystander = "untrusted-bystander@example.com";

    for (let i = 0; i < IP_LIMIT; i++) {
      expect(await attemptWithNoTrustedIp(attacker)).toBeNull();
    }
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);

    // A different person, a different account, nothing of theirs spent. Asserted
    // on the WORK REACHED, like the rest of this file — a refused attempt and a
    // wrong password both return null, so null proves nothing.
    expect(await attemptWithNoTrustedIp(bystander)).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT + 1);
    expect(h.findFirst).toHaveBeenCalledTimes(IP_LIMIT + 1);
  });

  it("the budget is still per-account, not unlimited, without a trusted address", async () => {
    // The flip side, so the fix above cannot be mistaken for "stop counting".
    // The attacker's OWN account still runs out after IP_LIMIT.
    const target = "untrusted-own-budget@example.com";

    for (let i = 0; i < IP_LIMIT; i++) {
      expect(await attemptWithNoTrustedIp(target)).toBeNull();
    }
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);

    expect(await attemptWithNoTrustedIp(target)).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);
    expect(h.findFirst).toHaveBeenCalledTimes(IP_LIMIT);
  });

  it("the form's early rejection reads the same bucket the choke point wrote", async () => {
    // HARM 2, and the quieter one. `loginAction` calls
    // `gateAuthAction({ kind: "login" })` purely to produce a READABLE error,
    // because authorize() can only return null. That gate CHECKS
    // `ipBucketKey(ip, email)`. While authorize() consumed the raw sentinel
    // instead, the two layers addressed different keys, so the form-side gate
    // was reading a bucket nothing ever wrote — permanently inert in exactly the
    // deployments that have no trusted header, and silently so.
    const email = "untrusted-two-layers@example.com";

    for (let i = 0; i < IP_LIMIT; i++) {
      await attemptWithNoTrustedIp(email);
    }

    const verdict = gateAuthAction({ kind: "login", ip: UNTRUSTED_CLIENT_IP, email });
    expect(verdict.allowed).toBe(false);
    // And the copy the user sees comes from the bucket that actually refused.
    expect(verdict.error).toMatch(/Too many requests/);
  });

  it("a trusted address keys on the address itself, exactly as before", async () => {
    // The guard on the fix: this is what must NOT change. On Vercel x-real-ip is
    // always set from the TCP peer, so `ipBucketKey` returns it verbatim and the
    // key-space is byte-identical to the one before this change — a household or
    // office behind one address still shares the 5/min, which is the intended
    // behaviour there and not a bug to be "fixed" by this key.
    const first = "trusted-shared-a@example.com";
    const second = "trusted-shared-b@example.com";
    const ip = "198.51.100.77";
    expect(ipBucketKey(ip, first)).toBe(ip);

    for (let i = 0; i < IP_LIMIT; i++) {
      expect(await attempt(first, ip)).toBeNull();
    }
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);

    // Same address, different account: still refused, because a trusted address
    // is the dimension being priced.
    expect(await attempt(second, ip)).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* auth-011 — a registered address must not answer measurably slower           */
/* ─────────────────────────────────────────────────────────────────────────── */

describe("credential timing parity for an address with no row (auth-011)", () => {
  /**
   * WHAT THIS LOCKS DOWN. `authorizeCredentials` used to `return null` straight
   * after the lookup missed, so the two answers cost visibly different amounts
   * of wall clock: a registered address paid a bcrypt(12) compare (~250ms) and
   * an unregistered one paid a single indexed SELECT (~1ms). That difference is
   * an account-enumeration oracle on a PUBLIC endpoint — `POST
   * /api/auth/callback/credentials`, which auth.config.ts marks public and which
   * needs nothing but a csrfToken — and it is the same fact `/forgot-password`
   * works hard not to reveal (lib/actions/password-reset.ts:117). It leaked the
   * tombstone too: the lookup filters `deletedAt: null`, so a DELETED account
   * fell down the fast branch and was distinguishable from a live one.
   *
   * WHY THESE ASSERTIONS AND NOT A STOPWATCH. `bcryptjs` is mocked in this file,
   * so no duration measured here could mean anything — and a timing assertion on
   * a shared machine is a flake generator besides. What is checkable, and what
   * actually decides whether the two timings match in production, is:
   *
   *   1. the miss path REACHES `bcrypt.compare` at all;
   *   2. it compares against a real bcrypt digest whose COST FACTOR equals the
   *      cost every stored password hash in this repo is written at — a sentinel
   *      at cost 10 would still leave a ~4x split;
   *   3. the digest is a constant, not hashed per request (which would pay the
   *      bill twice and reopen the split with the sign flipped);
   *   4. the extra work is bought only by attempts the throttle already allowed,
   *      so closing the oracle cannot be turned into a CPU amplifier.
   *
   * The live end-to-end timing probe lives in scripts/qa-auth-and-sessions.mjs,
   * section 4a.
   */

  const UNKNOWN_PASSWORD = "whatever-they-guessed";

  /**
   * 60 chars: `$2<x>$<cc>$` + 22 salt + 31 digest, all in bcrypt's base64
   * alphabet. THIS is the sentinel's validity check — see the test below for
   * why `getRounds` is not, despite reading like one.
   */
  const BCRYPT_DIGEST = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

  /**
   * Every `bcrypt.hash(x, N)` cost factor in one file's CODE.
   *
   * COMMENTS ARE STRIPPED FIRST, and that is the whole point. lib/auth.ts:47
   * quotes `bcrypt.hash(password, 12)` inside its own doc comment, so a raw-text
   * sweep counts prose as a call site — which means the `costs.length > 0`
   * staleness guard below could be satisfied by a COMMENT ALONE. Refactor the
   * four real call sites into a shared helper and the sweep would still find the
   * quotation, stay green, and quietly stop watching the real cost factor.
   *
   * Split out of the sweep so the extraction rule itself is testable — see "a
   * bcrypt.hash() written only in prose is not a call site".
   */
  function hashCostsIn(source: string): number[] {
    const costs: number[] = [];
    // exec loop, not matchAll: tsconfig sets no `target`, so tsc defaults to
    // ES5 and `for…of` over a matchAll iterator fails typecheck while
    // passing vitest.
    const re = /bcrypt\.hash\(\s*[^,()]+,\s*(\d+)\s*\)/g;
    const code = stripComments(source);
    let m: RegExpExecArray | null = re.exec(code);
    while (m !== null) {
      costs.push(Number(m[1]));
      m = re.exec(code);
    }
    return costs;
  }

  /**
   * Every `bcrypt.hash(x, N)` cost factor under `lib/`, so the sentinel is
   * checked against the real thing rather than against a remembered number.
   */
  function storedHashCosts(): number[] {
    const costs: number[] = [];
    const stack: string[] = [join(process.cwd(), "lib")];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        costs.push(...hashCostsIn(readFileSync(full, "utf8")));
      }
    }
    return costs;
  }

  beforeEach(() => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "");
    h.findFirst.mockReset();
    h.update.mockReset();
    h.compare.mockReset();
    // The whole point of this block: the address has NO row. Either it was never
    // registered, or it is tombstoned and the `deletedAt: null` filter hid it.
    h.findFirst.mockResolvedValue(null);
    h.compare.mockResolvedValue(false);
    h.update.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    h.ip.value = "198.51.100.1";
  });

  it("still pays a bcrypt compare when the lookup finds nothing", async () => {
    h.ip.value = "198.19.0.1";
    const result = await authorizeCredentials({
      email: "no-row@example.com",
      password: UNKNOWN_PASSWORD,
    });
    expect(result).toBeNull();
    expect(h.findFirst).toHaveBeenCalledTimes(1);
    // THIS is the fix. Before it the count here was 0, and an unregistered
    // address answered ~250ms sooner than a registered one.
    expect(h.compare).toHaveBeenCalledTimes(1);
    // …and it is the SUBMITTED password that gets compared, not a constant on
    // both sides — `compare(constant, constant)` is the shape a future
    // "optimisation" could memoise away without changing this file.
    expect(h.compare.mock.calls[0][0]).toBe(UNKNOWN_PASSWORD);
  });

  it("compares against a real bcrypt digest at the cost this repo stores passwords with", async () => {
    h.ip.value = "198.19.0.2";
    await authorizeCredentials({ email: "cost-check@example.com", password: UNKNOWN_PASSWORD });

    const sentinel = h.compare.mock.calls[0]?.[1] as string;
    expect(typeof sentinel, "the miss path must reach bcrypt.compare").toBe("string");
    // The line that actually rejects an unusable sentinel. A syntactically
    // plausible but undecodable digest would make `compare` reject instantly,
    // and the split would be WIDER than before the fix.
    expect(sentinel).toMatch(BCRYPT_DIGEST);

    // The COST FACTOR, read by the real bcryptjs rather than by the `\d\d` in
    // that regex. `getRounds` is NOT a second validity check, whatever its name
    // suggests: bcryptjs 3.0.3 implements it as
    // `parseInt(hash.split("$")[2], 10)` and throws only when `hash` is not a
    // string. It answers 12 for `"$2b$12$" + "!".repeat(53)` without complaint —
    // pinned by "it is the shape regex, not getRounds, …" below, because this
    // comment previously credited it with the validation the regex does, and a
    // comment that overstates a check is this repo's most recurrent defect.
    const actual = (await vi.importActual("bcryptjs")) as {
      default?: { getRounds?: (hash: string) => number };
      getRounds?: (hash: string) => number;
    };
    const getRounds = actual.default?.getRounds ?? actual.getRounds;
    expect(typeof getRounds, "bcryptjs.getRounds is needed to validate the sentinel").toBe(
      "function"
    );
    const sentinelCost = (getRounds as (hash: string) => number)(sentinel);

    const costs = storedHashCosts();
    expect(
      costs.length,
      "no bcrypt.hash() call found under lib/ — has this sweep gone stale?"
    ).toBeGreaterThan(0);
    for (const cost of costs) {
      // A sentinel cheaper than a stored hash leaves the split it was meant to
      // close; a dearer one inverts it. Either way the oracle stays readable.
      expect(
        sentinelCost,
        `sentinel cost must equal every stored-hash cost under lib/ (found ${cost})`
      ).toBe(cost);
    }
  });

  it("it is the shape regex, not getRounds, that rejects an unusable digest", async () => {
    // Pins the correction made to the comment above. The claim used to be that
    // `getRounds` "throws on a digest bcrypt would refuse, so this doubles as
    // the validity check". It does not: bcryptjs 3.0.3's whole implementation is
    // `if (typeof hash !== "string") throw …; return parseInt(hash.split("$")[2], 10)`.
    // So the sweep's only real guard is the shape regex, and anyone deleting it
    // as redundant would silently remove the check entirely.
    const actual = (await vi.importActual("bcryptjs")) as {
      default?: { getRounds?: (hash: string) => number };
      getRounds?: (hash: string) => number;
    };
    const getRounds = (actual.default?.getRounds ?? actual.getRounds) as (h: string) => number;

    // Correct prefix and cost, but 53 characters bcrypt's base64 alphabet has no
    // symbol for — a digest `compare` would reject instantly.
    const unusable = "$2b$12$" + "!".repeat(53);
    expect(getRounds(unusable), "getRounds parses the cost and validates nothing").toBe(12);
    expect(unusable, "the shape regex is the thing that refuses it").not.toMatch(BCRYPT_DIGEST);

    // …and it throws on exactly one input: a non-string.
    expect(() => getRounds(undefined as unknown as string)).toThrow();
  });

  it("a bcrypt.hash() written only in prose is not a call site", () => {
    // `storedHashCosts()` regexes RAW source, and lib/auth.ts:47 quotes
    // `bcrypt.hash(password, 12)` inside its own doc comment. So the
    // `costs.length > 0` staleness guard above could be satisfied by a COMMENT:
    // refactor the four real call sites into a shared helper and the sweep would
    // still find the prose, stay green, and stop noticing the real cost drifting.
    const prose = [
      "/**",
      " * stored hash in this repo is written at 12 (`bcrypt.hash(password, 12)` in",
      " * lib/actions/auth.ts).",
      " */",
      "export const NOT_A_CALL_SITE = 1;",
      "// const legacy = await bcrypt.hash(pw, 4);",
    ].join("\n");
    expect(hashCostsIn(prose), "prose must not satisfy the staleness guard").toEqual([]);

    // …while real call sites still count, in both the shapes lib/ uses.
    expect(hashCostsIn("const h = await bcrypt.hash(password, 12);")).toEqual([12]);
    expect(hashCostsIn("await bcrypt.hash(newPassword, 12); // rotate")).toEqual([12]);
  });

  it("uses ONE constant digest rather than hashing something per request", async () => {
    // Hashing a throwaway string per attempt costs a bcrypt to build PLUS a
    // bcrypt to compare — twice the known-address path, so the split reopens with
    // the sign flipped and every unknown-address guess costs the server double.
    h.ip.value = "198.19.0.3";
    await authorizeCredentials({ email: "constant-a@example.com", password: UNKNOWN_PASSWORD });
    h.ip.value = "198.19.0.4";
    await authorizeCredentials({ email: "constant-b@example.com", password: UNKNOWN_PASSWORD });
    expect(h.compare).toHaveBeenCalledTimes(2);
    expect(h.compare.mock.calls[1][1]).toBe(h.compare.mock.calls[0][1]);
  });

  it("cannot be turned into a way in, even if that comparison returns true", async () => {
    // Defence in depth on the SHAPE of the fix: the dummy result is discarded, so
    // knowing the sentinel's plaintext buys nothing at all. If anyone ever wires
    // it into the control flow, this fails.
    h.ip.value = "198.19.0.5";
    h.compare.mockResolvedValue(true);
    const result = await authorizeCredentials({
      email: "no-row-but-true@example.com",
      password: UNKNOWN_PASSWORD,
    });
    expect(result).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("buys that bcrypt only for attempts the throttle has already allowed", async () => {
    // The price of closing the oracle is that a miss now burns ~250ms of CPU
    // where it used to burn ~1ms. What keeps that from being an amplifier is that
    // `gateLoginAttempt` runs BEFORE the lookup, so a refused guess pays neither
    // the SELECT nor the compare. Pinned, because a reordering that put the dummy
    // hash above the gate would look harmless in a diff.
    const email = "miss-path-budget@example.com";
    const ip = "198.19.0.10";

    for (let i = 0; i < IP_LIMIT; i++) {
      h.ip.value = ip;
      expect(await authorizeCredentials({ email, password: UNKNOWN_PASSWORD })).toBeNull();
    }
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);

    h.ip.value = ip;
    expect(await authorizeCredentials({ email, password: UNKNOWN_PASSWORD })).toBeNull();
    expect(h.compare).toHaveBeenCalledTimes(IP_LIMIT);
    expect(h.findFirst).toHaveBeenCalledTimes(IP_LIMIT);
  });
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* The live probe: scripts/qa-auth-and-sessions.mjs section 4 (auth-011)        */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * WHY A UNIT TEST OF A PUPPETEER SCRIPT, AND WHY IT LOOKS LIKE THIS.
 *
 * `scripts/qa-auth-and-sessions.mjs` cannot be imported here: its top level
 * opens a Prisma client, imports puppeteer-core and mkdir's an output tree, and
 * running it needs a dev server plus a browser. But two of its properties are
 * pure arithmetic, both were wrong when the probe was rebuilt for auth-011, and
 * neither failure is visible in a diff:
 *
 *  1. BUDGET. Every wrong guess the probe makes at the founder's address spends
 *     one of that account's 10-failures-per-15-minutes
 *     (`limiters.credentialsEmail`). That bucket is CHECKED before bcrypt, so
 *     once it is empty the CORRECT password is refused too — and sections 5 and
 *     6 of the same run both need a successful sign-in as that address. A probe
 *     that overspends does not fail itself; it fails two unrelated assertions
 *     much later, which reads as a product bug.
 *
 *  2. THE VERDICT. Its three-way classification is sliced out of the file
 *     between the TIMING-VERDICT markers and executed here against a grid of
 *     median pairs, INCLUDING the unfixed oracle it exists to catch. That is
 *     the only honest way to test it, and the reason it is worth testing is
 *     that the first version reported INCONCLUSIVE on exactly that input while
 *     printing two numbers that refuted its own message.
 *
 * Both tests read the script's real numbers out of its source, so re-pointing a
 * burn loop at the admin address or adding a round turns this red rather than
 * silently re-opening the hole.
 */
describe("the live probe's arithmetic (scripts/qa-auth-and-sessions.mjs, auth-011)", () => {
  const PROBE_PATH = join(process.cwd(), "scripts", "qa-auth-and-sessions.mjs");
  const probeSource = readFileSync(PROBE_PATH, "utf8");

  const probeCode = stripComments(probeSource);

  /** The first capture of `re` against the script's CODE, as a number. */
  function numberFromProbe(re: RegExp, what: string): number {
    const m = re.exec(probeCode);
    expect(
      m,
      `could not find ${what} in scripts/qa-auth-and-sessions.mjs — has the probe been restructured?`
    ).not.toBe(null);
    return Number((m as RegExpExecArray)[1]);
  }

  /**
   * The bcrypt floor the verdict compares against, read from the script so the
   * grid below cannot drift from it. Read without `expect` because this runs at
   * collection time; if the constant is ever renamed the verdict tests below
   * fail on the substance instead of on a missing regex match.
   */
  const floorMatch = /const BCRYPT_FLOOR_MS = (\d+);/.exec(probeCode);
  const FLOOR_MS = floorMatch ? Number(floorMatch[1]) : 80;

  beforeEach(() => {
    vi.useRealTimers();
    // A bypass would make every assertion below vacuous while staying green.
    vi.stubEnv("RATE_LIMIT_DISABLED", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves the founder enough failure budget for the sign-ins that follow it", () => {
    // The script's own numbers, read out of the script.
    const timingRounds = numberFromProbe(
      /for \(let round = 1; round <= (\d+); round\+\+\)/,
      "section 4a's round count"
    );
    const burnLoopBound = numberFromProbe(
      /for \(let i = 1; i <= (\d+) && burnedAt === null; i\+\+\)/,
      "section 4b's attempt bound"
    );
    const endpointGuesses = numberFromProbe(
      /for \(let i = 0; i < (\d+); i\+\+\)/,
      "section 4c's guess count"
    );
    const signInRetries = numberFromProbe(
      /for \(let attempt = 1; attempt <= (\d+); attempt\+\+\)/,
      "signIn()'s hydration-retry count"
    );

    // WHICH ADDRESS section 4b deliberately burns. This is the load-bearing
    // parse: 4b's assertion is about the per-IP bucket, and `ipBucketKey`
    // ignores the email when the client address is trusted, so 4b can spend ANY
    // account's failure budget. Spending the founder's is what starved sections
    // 5 and 6.
    const burnMatch = /attemptLogin\(burn, ([A-Za-z_][A-Za-z0-9_]*),/.exec(probeCode);
    expect(burnMatch, "could not find section 4b's attemptLogin call").not.toBe(null);
    const burnTarget = (burnMatch as RegExpExecArray)[1];

    const stamp = `${Date.now()}`;
    const ADMIN = `qa-auth-${stamp}@founderflow.test`;
    const FAKE = `qa-auth-nobody2-${stamp}@founderflow.test`;
    const BURN = burnTarget === "ADMIN_EMAIL" ? ADMIN : `qa-auth-burn-${stamp}@founderflow.test`;
    const IP = `10.99.${Number(stamp.slice(-3)) % 250}.7`;

    /** One attempt down the real gate; charges the account only if it got through. */
    function guess(ipKey: string, email: string): void {
      if (gateLoginAttempt(ipKey, email).allowed) recordLoginFailure(email); // wrong password
    }

    // ── 4a: one fresh per-IP key per round; warm-up + real + fake each time.
    for (let round = 1; round <= timingRounds; round++) {
      guess(`${IP}-t${round}`, FAKE); // warm-up, discarded
      guess(`${IP}-t${round}`, ADMIN); // the registered sample
      guess(`${IP}-t${round}`, FAKE); // the unregistered sample
    }

    // ── 4b: deliberately empties ONE per-IP budget, through the login form.
    for (let i = 1; i <= burnLoopBound; i++) guess(`${IP}-burn`, BURN);

    // ── 4c: more guesses from the same, now-empty, per-IP key.
    for (let i = 0; i < endpointGuesses; i++) guess(`${IP}-burn`, ADMIN);

    // ── 5: the pre-reset password is now wrong, and signIn() retries it.
    for (let i = 0; i < signInRetries; i++) guess(`${IP}-pw1`, ADMIN);

    // ── 5, the assertion that actually breaks: "the new password signs in".
    expect(
      gateLoginAttempt(`${IP}-pw2`, ADMIN).allowed,
      'section 5\'s "the new password signs in" is refused before bcrypt — section 4 spent the ' +
        "founder's 10-failures-per-15-minutes budget, so the probe reports a password-reset bug " +
        "that does not exist"
    ).toBe(true);

    // ── 6: "signing in again recovers the stuck tab", on the original context.
    expect(
      gateLoginAttempt(IP, ADMIN).allowed,
      'section 6\'s "signing in again recovers the stuck tab" is refused for the same reason'
    ).toBe(true);
  });

  /* ── the three-way verdict, executed from the script's own source ───────── */

  type Verdict = { kind: "ok" | "fail"; label: string; detail: string };

  /** The slice between the TIMING-VERDICT markers, as executable source. */
  function verdictSource(): string {
    const start = probeSource.indexOf("TIMING-VERDICT-START");
    const end = probeSource.indexOf("TIMING-VERDICT-END");
    expect(start, "TIMING-VERDICT-START marker is missing from the probe").toBeGreaterThan(-1);
    expect(end, "TIMING-VERDICT-END marker is missing from the probe").toBeGreaterThan(start);
    return probeSource.slice(
      probeSource.indexOf("*/", start) + 2,
      probeSource.lastIndexOf("/*", end)
    );
  }

  /** Run the probe's real verdict over one pair of medians. */
  function runVerdict(tReal: number, tFake: number): Verdict[] {
    const out: Verdict[] = [];
    const record = (kind: "ok" | "fail") => (label: string, detail?: string) => {
      out.push({ kind, label, detail: detail ?? "" });
    };
    const body = new Function(
      "tReal",
      "tFake",
      "BCRYPT_FLOOR_MS",
      "IP",
      "ok",
      "fail",
      verdictSource()
    );
    body(tReal, tFake, FLOOR_MS, "10.99.0.1", record("ok"), record("fail"));
    return out;
  }

  const GRID = [1, 4, 20, 79, FLOOR_MS, 120, 250, 300];

  it("calls the UNFIXED oracle a failure, not inconclusive", () => {
    // The measured unfixed state: a registered address paid a bcrypt(12) and an
    // unregistered one paid an indexed SELECT. This is the single input the
    // probe exists to catch, and it is the one the first version swallowed.
    const verdicts = runVerdict(250, 4);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].kind).toBe("fail");
    expect(verdicts[0].label, `a 250ms / 4ms split was reported as "${verdicts[0].label}"`).toMatch(
      /reveals whether an email is registered/i
    );
  });

  it("reports INCONCLUSIVE only when BOTH medians are under the bcrypt floor", () => {
    for (let i = 0; i < GRID.length; i++) {
      for (let j = 0; j < GRID.length; j++) {
        const tReal = GRID[i];
        const tFake = GRID[j];
        const verdicts = runVerdict(tReal, tFake);
        expect(verdicts, `exactly one verdict for ${tReal}ms / ${tFake}ms`).toHaveLength(1);
        if (!/inconclusive/i.test(verdicts[0].label)) continue;
        expect(
          Math.max(tReal, tFake),
          `INCONCLUSIVE for registered ${tReal}ms / unregistered ${tFake}ms, but the slower median ` +
            `is at or above the ${FLOOR_MS}ms bcrypt floor, so one of them DID run a bcrypt`
        ).toBeLessThan(FLOOR_MS);
      }
    }
  });

  it("never prints a verdict whose own numbers refute it", () => {
    // The old inconclusive branch printed "both medians are under 80ms
    // (registered 250ms, unregistered 4ms)". Any millisecond figure a verdict
    // cites has to be consistent with the claim it is making.
    for (let i = 0; i < GRID.length; i++) {
      for (let j = 0; j < GRID.length; j++) {
        const tReal = GRID[i];
        const tFake = GRID[j];
        const verdict = runVerdict(tReal, tFake)[0];
        if (!/inconclusive/i.test(verdict.label)) continue;
        const re = /(\d+)ms/g;
        let m: RegExpExecArray | null = re.exec(verdict.detail);
        while (m !== null) {
          expect(
            Number(m[1]),
            `the inconclusive verdict for ${tReal}ms / ${tFake}ms cites ${m[1]}ms while claiming ` +
              `neither answer ran a bcrypt: "${verdict.detail.slice(0, 160)}"`
          ).toBeLessThanOrEqual(FLOOR_MS);
          m = re.exec(verdict.detail);
        }
      }
    }
  });
});
