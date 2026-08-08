import { describe, it, expect } from "vitest";
import { VerifyEmailSchema } from "@/lib/schemas/email-verification";

describe("VerifyEmailSchema", () => {
  it("accepts a token of at least 10 characters", () => {
    expect(VerifyEmailSchema.safeParse({ token: "a".repeat(10) }).success).toBe(true);
  });

  it("rejects a too-short token", () => {
    expect(VerifyEmailSchema.safeParse({ token: "abc" }).success).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(VerifyEmailSchema.safeParse({}).success).toBe(false);
  });
});
