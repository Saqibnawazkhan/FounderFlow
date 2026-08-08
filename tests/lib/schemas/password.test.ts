import { describe, it, expect } from "vitest";
import { PasswordSchema } from "@/lib/schemas/password";

describe("PasswordSchema (new-password policy)", () => {
  it("accepts a password with lower + upper + digit and >= 8 chars", () => {
    expect(PasswordSchema.safeParse("Abcd1234").success).toBe(true);
  });

  it("rejects passwords shorter than 8 characters", () => {
    expect(PasswordSchema.safeParse("Ab1cde").success).toBe(false);
  });

  it("rejects passwords with no lowercase letter", () => {
    expect(PasswordSchema.safeParse("ABCD1234").success).toBe(false);
  });

  it("rejects passwords with no uppercase letter", () => {
    expect(PasswordSchema.safeParse("abcd1234").success).toBe(false);
  });

  it("rejects passwords with no digit", () => {
    expect(PasswordSchema.safeParse("Abcdefgh").success).toBe(false);
  });

  it("rejects passwords longer than 120 characters", () => {
    expect(PasswordSchema.safeParse("Aa1" + "x".repeat(120)).success).toBe(false);
  });
});
