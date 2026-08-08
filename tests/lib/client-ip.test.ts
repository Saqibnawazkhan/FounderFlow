import { describe, it, expect, beforeEach, vi } from "vitest";

// Mutable header store shared with the mocked next/headers module.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => store.get(k) ?? null }),
}));

import { getClientIp } from "@/lib/client-ip";

describe("getClientIp", () => {
  beforeEach(() => store.clear());

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

  it("returns 'unknown' when no IP headers are present", async () => {
    expect(await getClientIp()).toBe("unknown");
  });
});
