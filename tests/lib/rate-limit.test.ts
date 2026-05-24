import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rateLimiter, limiters } from "@/lib/rate-limit";

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
