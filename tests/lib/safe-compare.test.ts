import { describe, it, expect } from "vitest";
import { safeEqual } from "@/lib/safe-compare";

describe("safeEqual (constant-time string compare)", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("s3cr3t-token", "s3cr3t-token")).toBe(true);
  });

  it("returns false for same-length but different strings", () => {
    expect(safeEqual("s3cr3t-token", "s3cr3t-toXen")).toBe(false);
  });

  it("returns false for different-length strings (no length leak, just false)", () => {
    expect(safeEqual("short", "a-much-longer-secret")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });

  it("is byte-accurate for multibyte content", () => {
    expect(safeEqual("café", "café")).toBe(true);
    expect(safeEqual("café", "cafe")).toBe(false);
  });
});
