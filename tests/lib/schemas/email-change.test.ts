import { describe, it, expect } from "vitest";
import { RequestEmailChangeSchema, ConfirmEmailChangeSchema } from "@/lib/schemas/email-change";

describe("RequestEmailChangeSchema", () => {
  it("accepts a valid new email", () => {
    expect(RequestEmailChangeSchema.safeParse({ newEmail: "new@nimbus.app" }).success).toBe(true);
  });

  it("normalizes to trimmed lowercase", () => {
    const result = RequestEmailChangeSchema.safeParse({ newEmail: "  New@Nimbus.APP " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.newEmail).toBe("new@nimbus.app");
  });

  it("rejects a malformed email", () => {
    expect(RequestEmailChangeSchema.safeParse({ newEmail: "nope" }).success).toBe(false);
  });

  it("caps the email at 200 characters", () => {
    const huge = "a".repeat(200) + "@nimbus.app";
    expect(RequestEmailChangeSchema.safeParse({ newEmail: huge }).success).toBe(false);
  });
});

describe("ConfirmEmailChangeSchema", () => {
  it("requires a token of at least 10 characters", () => {
    expect(ConfirmEmailChangeSchema.safeParse({ token: "a".repeat(10) }).success).toBe(true);
    expect(ConfirmEmailChangeSchema.safeParse({ token: "short" }).success).toBe(false);
  });
});
