import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mutable header store shared with the mocked next/headers module.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => store.get(k) ?? null }),
}));

import { getClientIp } from "@/lib/client-ip";

describe("getClientIp", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.unstubAllEnvs());

  it("prefers x-real-ip (the unspoofable edge value)", async () => {
    store.set("x-real-ip", "203.0.113.7");
    store.set("x-forwarded-for", "1.1.1.1, 203.0.113.7");
    expect(await getClientIp()).toBe("203.0.113.7");
  });

  it("trims whitespace on x-real-ip", async () => {
    store.set("x-real-ip", "  203.0.113.7 ");
    expect(await getClientIp()).toBe("203.0.113.7");
  });

  it("falls back to the LAST x-forwarded-for hop, not the spoofable leftmost", async () => {
    // Client-supplied leftmost is attacker-controlled; the platform appends
    // the real IP as the last hop.
    store.set("x-forwarded-for", "9.9.9.9, 8.8.8.8, 203.0.113.7");
    expect(await getClientIp()).toBe("203.0.113.7");
  });

  it("returns the single x-forwarded-for value when there's only one hop", async () => {
    store.set("x-forwarded-for", "203.0.113.7");
    expect(await getClientIp()).toBe("203.0.113.7");
  });

  // ── sec-001: a forwarding header is only worth reading where something is
  // known to overwrite it. Off Vercel and with no proxy declared, both headers
  // are just strings the client typed, and reading one lets that client choose
  // which rate-limit bucket it lands in.
  describe("trust in forwarding headers (sec-001)", () => {
    it("ignores a client-supplied x-real-ip in a production runtime with no declared proxy", async () => {
      vi.stubEnv("NODE_ENV", "production"); // e.g. self-host / Docker / nginx
      store.set("x-real-ip", "6.6.6.6"); // attacker's chosen bucket
      expect(await getClientIp()).not.toBe("6.6.6.6");
    });

    it("ignores a client-supplied x-forwarded-for in a production runtime with no declared proxy", async () => {
      vi.stubEnv("NODE_ENV", "production");
      store.set("x-forwarded-for", "6.6.6.6");
      expect(await getClientIp()).not.toBe("6.6.6.6");
    });

    it("trusts x-real-ip on Vercel, where the edge sets it from the TCP peer", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VERCEL", "1");
      store.set("x-real-ip", "203.0.113.7");
      expect(await getClientIp()).toBe("203.0.113.7");
    });

    it("reads the header named by TRUSTED_PROXY_HEADER, and only that one", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
      store.set("cf-connecting-ip", "203.0.113.9");
      store.set("x-real-ip", "6.6.6.6"); // not the declared header — must be ignored
      expect(await getClientIp()).toBe("203.0.113.9");
    });

    it("rejects an absurdly long header value instead of making it a bucket key", async () => {
      store.set("x-real-ip", "9".repeat(200));
      expect(await getClientIp()).not.toContain("999");
    });
  });
});
