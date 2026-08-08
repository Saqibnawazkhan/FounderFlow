import { describe, it, expect } from "vitest";
import { RequestPasswordResetSchema, ResetPasswordSchema } from "@/lib/schemas/password-reset";

describe("RequestPasswordResetSchema", () => {
  it("accepts a valid email", () => {
    expect(RequestPasswordResetSchema.safeParse({ email: "founder@nimbus.app" }).success).toBe(
      true
    );
  });

  it("normalizes email to trimmed lowercase", () => {
    const result = RequestPasswordResetSchema.safeParse({ email: "  Founder@Nimbus.APP " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("founder@nimbus.app");
  });

  it("rejects a malformed email", () => {
    expect(RequestPasswordResetSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });
});

describe("ResetPasswordSchema", () => {
  const validToken = "a".repeat(12);

  it("accepts a long token with a policy-compliant password", () => {
    expect(ResetPasswordSchema.safeParse({ token: validToken, password: "Abcd1234" }).success).toBe(
      true
    );
  });

  it("rejects a too-short token", () => {
    expect(ResetPasswordSchema.safeParse({ token: "short", password: "Abcd1234" }).success).toBe(
      false
    );
  });

  it("enforces the shared password policy", () => {
    expect(ResetPasswordSchema.safeParse({ token: validToken, password: "weak" }).success).toBe(
      false
    );
  });
});
