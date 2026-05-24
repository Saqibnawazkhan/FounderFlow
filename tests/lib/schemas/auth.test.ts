import { describe, it, expect } from "vitest";
import { LoginSchema, SignupSchema } from "@/lib/schemas/auth";

describe("LoginSchema", () => {
  it("accepts a well-formed email + non-empty password", () => {
    const result = LoginSchema.safeParse({
      email: "demo@founderflow.app",
      password: "anything",
    });
    expect(result.success).toBe(true);
  });

  it("lowercases + trims email", () => {
    const result = LoginSchema.safeParse({
      email: "  Demo@FounderFlow.APP  ",
      password: "x",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("demo@founderflow.app");
  });

  it("rejects an invalid email shape", () => {
    const result = LoginSchema.safeParse({ email: "not-an-email", password: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects empty password", () => {
    const result = LoginSchema.safeParse({ email: "a@b.com", password: "" });
    expect(result.success).toBe(false);
  });
});

describe("SignupSchema", () => {
  const valid = {
    name: "Jane Doe",
    email: "jane@startup.com",
    password: "secret123",
    companyName: "Nimbus Labs",
    industry: "SaaS / B2B Software",
  };

  it("accepts a full valid payload", () => {
    expect(SignupSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects passwords shorter than 6 characters", () => {
    const result = SignupSchema.safeParse({ ...valid, password: "short" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/at least 6/);
    }
  });

  it("rejects empty name", () => {
    expect(SignupSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(SignupSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("rejects empty companyName after trim", () => {
    expect(SignupSchema.safeParse({ ...valid, companyName: "   " }).success).toBe(false);
  });

  it("caps password length at 120 chars", () => {
    const long = "a".repeat(121);
    expect(SignupSchema.safeParse({ ...valid, password: long }).success).toBe(false);
  });

  it("rejects invalid email", () => {
    expect(SignupSchema.safeParse({ ...valid, email: "no-at-sign" }).success).toBe(false);
  });
});
