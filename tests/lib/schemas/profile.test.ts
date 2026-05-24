import { describe, expect, it } from "vitest";
import { ChangePasswordSchema, UpdateProfileSchema } from "@/lib/schemas/profile";

describe("UpdateProfileSchema", () => {
  it("accepts a valid name + email", () => {
    const r = UpdateProfileSchema.safeParse({
      name: "Sarah Khan",
      email: "Sarah@Nimbus.app",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // Email should be lowercased + trimmed by the transform.
      expect(r.data.email).toBe("sarah@nimbus.app");
      expect(r.data.name).toBe("Sarah Khan");
    }
  });

  it("rejects empty name", () => {
    const r = UpdateProfileSchema.safeParse({ name: "  ", email: "a@b.co" });
    expect(r.success).toBe(false);
  });

  it("rejects non-email strings", () => {
    const r = UpdateProfileSchema.safeParse({ name: "Ali", email: "not-an-email" });
    expect(r.success).toBe(false);
  });
});

describe("ChangePasswordSchema", () => {
  const valid = {
    currentPassword: "oldpassword",
    newPassword: "newpassword",
    confirmPassword: "newpassword",
  };

  it("accepts a valid trio", () => {
    expect(ChangePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects mismatched confirm", () => {
    const r = ChangePasswordSchema.safeParse({ ...valid, confirmPassword: "different" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("confirmPassword"))).toBe(true);
    }
  });

  it("rejects same-as-current new password", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "samesame",
      newPassword: "samesame",
      confirmPassword: "samesame",
    });
    expect(r.success).toBe(false);
  });

  it("rejects new password shorter than 6 chars", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "oldpassword",
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(r.success).toBe(false);
  });

  it("requires the current password", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "",
      newPassword: "newpassword",
      confirmPassword: "newpassword",
    });
    expect(r.success).toBe(false);
  });
});
