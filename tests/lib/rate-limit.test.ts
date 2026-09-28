import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  rateLimiter,
  limiters,
  gateAuthAction,
  resetAuthGates,
  ipBucketKey,
  isTrustedIpKey,
  UNTRUSTED_CLIENT_IP,
} from "@/lib/rate-limit";

describe("rateLimiter (sliding window)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to `limit` requests in a window", () => {
    const rl = rateLimiter("t1", { limit: 3, windowMs: 1000 });
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
  });

  it("blocks the next request after limit is reached", () => {
    const rl = rateLimiter("t2", { limit: 3, windowMs: 1000 });
    rl.consume("k");
    rl.consume("k");
    rl.consume("k");
    const blocked = rl.consume("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.error).toMatch(/too many requests/i);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("evicts old timestamps once the window slides past them", () => {
    const rl = rateLimiter("t3", { limit: 2, windowMs: 1000 });
    rl.consume("k");
    rl.consume("k");
    expect(rl.consume("k").allowed).toBe(false);
    // Slide past the window — both timestamps roll off.
    vi.advanceTimersByTime(1100);
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(false);
  });

  it("decrements `remaining` correctly", () => {
    const rl = rateLimiter("t4", { limit: 3, windowMs: 1000 });
    expect(rl.consume("k").remaining).toBe(2);
    expect(rl.consume("k").remaining).toBe(1);
    expect(rl.consume("k").remaining).toBe(0);
  });

  it("buckets per key — different keys don't interfere", () => {
    const rl = rateLimiter("t5", { limit: 1, windowMs: 1000 });
    expect(rl.consume("alice").allowed).toBe(true);
    expect(rl.consume("alice").allowed).toBe(false);
    // bob's bucket is untouched
    expect(rl.consume("bob").allowed).toBe(true);
  });

  it("retryAfterMs counts down as time passes", () => {
    const rl = rateLimiter("t6", { limit: 1, windowMs: 1000 });
    rl.consume("k");
    const first = rl.consume("k");
    expect(first.retryAfterMs).toBeCloseTo(1000, -2); // ~1000ms ± rounding
    vi.advanceTimersByTime(400);
    const second = rl.consume("k");
    expect(second.retryAfterMs).toBeCloseTo(600, -2);
  });

  it("reset() empties all buckets", () => {
    const rl = rateLimiter("t7", { limit: 1, windowMs: 1000 });
    rl.consume("k");
    expect(rl.consume("k").allowed).toBe(false);
    rl.reset();
    expect(rl.consume("k").allowed).toBe(true);
  });
});

describe("preset limiters", () => {
  beforeEach(() => {
    limiters.auth.reset();
    limiters.write.reset();
  });

  it("auth limiter: 5 per minute per key", () => {
    for (let i = 0; i < 5; i++) {
      expect(limiters.auth.consume("1.2.3.4").allowed).toBe(true);
    }
    expect(limiters.auth.consume("1.2.3.4").allowed).toBe(false);
    // Different IP unaffected
    expect(limiters.auth.consume("5.6.7.8").allowed).toBe(true);
  });

  it("write limiter: 60 per minute per key", () => {
    for (let i = 0; i < 60; i++) {
      expect(limiters.write.consume("user-1").allowed).toBe(true);
    }
    expect(limiters.write.consume("user-1").allowed).toBe(false);
  });
});

/**
 * prodready-002 — RATE_LIMIT_DISABLED is a fail-open switch for every limiter
 * in this file, including the login bucket that is the app's only brute-force
 * threshold. scripts/vercel-build.mjs now refuses a production BUILD with it
 * set; these cases are the runtime half — the flag must not be able to take
 * effect in a production runtime even if it gets there some other way
 * (a var added after the build, a self-hosted `next start`, an inherited
 * shell env).
 */
describe("RATE_LIMIT_DISABLED cannot take effect in production (prodready-002)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps limiting on a production Vercel deploy even with the flag set, and says so", () => {
    // "with zero signal anywhere" was half of what made this a finding, so the
    // ignored flag has to leave a trace in the logs somebody can grep.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");
    vi.stubEnv("VERCEL_ENV", "production");
    const rl = rateLimiter("prodready-002-vercel", { limit: 2, windowMs: 60_000 });
    expect(rl.consume("1.2.3.4").allowed).toBe(true);
    expect(rl.consume("1.2.3.4").allowed).toBe(true);
    expect(rl.consume("1.2.3.4").allowed).toBe(false);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps limiting in a self-hosted production process with no VERCEL_ENV", () => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    const rl = rateLimiter("prodready-002-selfhost", { limit: 1, windowMs: 60_000 });
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(false);
  });

  it("still honours the flag on a preview deploy, where debugging a limiter is sanctioned", () => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");
    vi.stubEnv("VERCEL_ENV", "preview");
    const rl = rateLimiter("prodready-002-preview", { limit: 1, windowMs: 60_000 });
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
  });

  it("still honours the flag in local development", () => {
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    const rl = rateLimiter("prodready-002-dev", { limit: 1, windowMs: 60_000 });
    expect(rl.consume("k").allowed).toBe(true);
    expect(rl.consume("k").allowed).toBe(true);
  });
});

/**
 * auth-007 — ten server actions across five modules shared ONE 5-per-minute
 * bucket keyed on the client IP. Behind an office NAT that is one key for the
 * whole company, so a colleague clicking a verification link could be told
 * "Too many requests" because two other people had just signed in.
 *
 * These cases are written in the user's terms: what a team behind one
 * connection must be able to do at the same time.
 */
describe("the auth family is split by risk class (auth-007)", () => {
  const OFFICE = "203.0.113.40"; // one NAT, a whole company behind it

  beforeEach(() => {
    resetAuthGates();
  });

  it("a colleague's verification link is not refused because other people signed in", () => {
    // Five sign-ins from the office — the whole of the old shared budget.
    for (let i = 0; i < 5; i++) {
      limiters.credentials.consume(ipBucketKey(OFFICE, `dev${i}@acme.test`));
    }
    // Someone clicks the verification link in their email.
    expect(gateAuthAction({ kind: "tokenRedeem", ip: OFFICE }).allowed).toBe(true);
  });

  it("a burst of link clicks does not cost the office its sign-ins", () => {
    for (let i = 0; i < 30; i++) {
      expect(gateAuthAction({ kind: "tokenRedeem", ip: OFFICE }).allowed).toBe(true);
    }
    expect(gateAuthAction({ kind: "login", ip: OFFICE, email: "cto@acme.test" }).allowed).toBe(
      true
    );
  });

  it("a signup burst does not stop a colleague asking for a password-reset email", () => {
    for (let i = 0; i < 15; i++) {
      gateAuthAction({ kind: "signup", ip: OFFICE, email: `new${i}@acme.test` });
    }
    expect(
      gateAuthAction({ kind: "emailDispatch", ip: OFFICE, account: "cfo@acme.test" }).allowed
    ).toBe(true);
  });

  it("one person exhausting their resend budget does not touch a colleague's", () => {
    for (let i = 0; i < 5; i++) {
      expect(
        gateAuthAction({ kind: "emailDispatch", ip: OFFICE, account: "alice@acme.test" }).allowed
      ).toBe(true);
    }
    const alice = gateAuthAction({ kind: "emailDispatch", ip: OFFICE, account: "alice@acme.test" });
    expect(alice.allowed).toBe(false);
    expect(alice.error).toMatch(/too many requests/i);

    expect(
      gateAuthAction({ kind: "emailDispatch", ip: OFFICE, account: "bob@acme.test" }).allowed
    ).toBe(true);
  });

  it("an address cannot get a second mail budget by capitalising a letter", () => {
    for (let i = 0; i < 5; i++) {
      gateAuthAction({ kind: "emailDispatch", ip: OFFICE, account: "alice@acme.test" });
    }
    expect(
      gateAuthAction({ kind: "emailDispatch", ip: OFFICE, account: " Alice@Acme.test " }).allowed
    ).toBe(false);
  });

  it("deleting your own account is budgeted per person, not per office", () => {
    for (let i = 0; i < 5; i++) {
      expect(gateAuthAction({ kind: "destructive", ip: OFFICE, userId: "user-1" }).allowed).toBe(
        true
      );
    }
    expect(gateAuthAction({ kind: "destructive", ip: OFFICE, userId: "user-1" }).allowed).toBe(
      false
    );
    // A teammate on the same connection is unaffected.
    expect(gateAuthAction({ kind: "destructive", ip: OFFICE, userId: "user-2" }).allowed).toBe(
      true
    );
  });

  it("the login form still refuses once the credential budget for that IP is spent", () => {
    // This is what the Credentials provider's authorize() consumes per attempt
    // (lib/auth/login-throttle.ts). The form-side gate must only READ it —
    // consuming it twice would turn the advertised 5/min into 2/min.
    for (let i = 0; i < 5; i++) {
      limiters.credentials.consume(ipBucketKey(OFFICE, "cto@acme.test"));
    }
    const gate = gateAuthAction({ kind: "login", ip: OFFICE, email: "cto@acme.test" });
    expect(gate.allowed).toBe(false);
    expect(gate.error).toMatch(/too many requests/i);
  });

  it("the login form gate records nothing itself, so 5/min stays 5/min", () => {
    for (let i = 0; i < 20; i++) {
      gateAuthAction({ kind: "login", ip: OFFICE, email: "cto@acme.test" });
    }
    // Nothing was charged: the five real attempts are still available.
    for (let i = 0; i < 5; i++) {
      expect(limiters.credentials.consume(ipBucketKey(OFFICE, "cto@acme.test")).allowed).toBe(true);
    }
    expect(limiters.credentials.consume(ipBucketKey(OFFICE, "cto@acme.test")).allowed).toBe(false);
  });
});

/**
 * sec-001 (the half that survives a spoofed header being ignored) — when no
 * forwarding header can be trusted there is no client address, and the old
 * code keyed every one of those visitors on the literal string "unknown". One
 * attacker could then spend the single 5-per-minute bucket and lock every
 * customer out of login, password reset AND account deletion at once.
 */
describe("no trusted client IP must never mean one shared bucket (sec-001)", () => {
  beforeEach(() => {
    resetAuthGates();
  });

  it("recognises a real address as usable and the untrusted sentinel as not", () => {
    expect(isTrustedIpKey("203.0.113.7")).toBe(true);
    expect(isTrustedIpKey(UNTRUSTED_CLIENT_IP)).toBe(false);
    // "unknown" was the old shared bucket. If any caller, stale bundle or
    // copied snippet brings it back it must not become an address again.
    expect(isTrustedIpKey("unknown")).toBe(false);
    expect(isTrustedIpKey("")).toBe(false);
  });

  it("keys on the account instead of pooling everyone together", () => {
    expect(ipBucketKey(UNTRUSTED_CLIENT_IP, "alice@acme.test")).not.toBe(
      ipBucketKey(UNTRUSTED_CLIENT_IP, "bob@acme.test")
    );
  });

  it("an attacker cannot lock other customers out of login", () => {
    for (let i = 0; i < 5; i++) {
      limiters.credentials.consume(ipBucketKey(UNTRUSTED_CLIENT_IP, "attacker@evil.test"));
    }
    expect(
      gateAuthAction({
        kind: "login",
        ip: UNTRUSTED_CLIENT_IP,
        email: "victim@customer.test",
      }).allowed
    ).toBe(true);
  });

  it("but the attacker's own attempts are still throttled", () => {
    for (let i = 0; i < 5; i++) {
      limiters.credentials.consume(ipBucketKey(UNTRUSTED_CLIENT_IP, "attacker@evil.test"));
    }
    expect(
      gateAuthAction({
        kind: "login",
        ip: UNTRUSTED_CLIENT_IP,
        email: "attacker@evil.test",
      }).allowed
    ).toBe(false);
  });

  it("an attacker cannot lock other customers out of password-reset emails", () => {
    for (let i = 0; i < 20; i++) {
      gateAuthAction({
        kind: "emailDispatch",
        ip: UNTRUSTED_CLIENT_IP,
        account: "attacker@evil.test",
      });
    }
    expect(
      gateAuthAction({
        kind: "emailDispatch",
        ip: UNTRUSTED_CLIENT_IP,
        account: "victim@customer.test",
      }).allowed
    ).toBe(true);
  });

  it("an attacker cannot lock other customers out of account deletion", () => {
    for (let i = 0; i < 20; i++) {
      gateAuthAction({ kind: "destructive", ip: UNTRUSTED_CLIENT_IP, userId: "attacker" });
    }
    expect(
      gateAuthAction({ kind: "destructive", ip: UNTRUSTED_CLIENT_IP, userId: "victim" }).allowed
    ).toBe(true);
  });

  it("link redemption is never refused on someone else's behalf", () => {
    // A signed link is unforgeable (HS256 over AUTH_SECRET), so the IP bucket
    // here is a courtesy valve, not a security control. With no address to key
    // it on there is nothing to pool — and pooling would be a lockout weapon.
    for (let i = 0; i < 100; i++) {
      gateAuthAction({ kind: "tokenRedeem", ip: UNTRUSTED_CLIENT_IP });
    }
    expect(gateAuthAction({ kind: "tokenRedeem", ip: UNTRUSTED_CLIENT_IP }).allowed).toBe(true);
  });
});
