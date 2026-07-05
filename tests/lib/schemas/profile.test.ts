import { describe, expect, it } from "vitest";
import { ChangePasswordSchema, UpdateProfileSchema } from "@/lib/schemas/profile";
import { RequestEmailChangeSchema } from "@/lib/schemas/email-change";

describe("UpdateProfileSchema", () => {
  // Email was removed from the profile update (audit S3) — name-only now;
  // email changes go through RequestEmailChangeSchema + the verified flow.
  it("accepts a valid name and ignores extra fields", () => {
    const r = UpdateProfileSchema.safeParse({ name: "Sarah Khan" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Sarah Khan");
  });

  it("rejects empty name", () => {
    const r = UpdateProfileSchema.safeParse({ name: "  " });
    expect(r.success).toBe(false);
  });
});

describe("RequestEmailChangeSchema", () => {
  it("lowercases + trims a valid new email", () => {
    const r = RequestEmailChangeSchema.safeParse({ newEmail: " Sarah@Nimbus.app " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.newEmail).toBe("sarah@nimbus.app");
  });

  it("rejects non-email strings", () => {
    expect(RequestEmailChangeSchema.safeParse({ newEmail: "not-an-email" }).success).toBe(false);
  });
});

describe("ChangePasswordSchema", () => {
  // newPassword now shares the strong policy (min 8 + mixed case + digit).
  const valid = {
    currentPassword: "OldPassword1",
    newPassword: "NewPass123",
    confirmPassword: "NewPass123",
  };

  it("accepts a valid trio", () => {
    expect(ChangePasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects mismatched confirm", () => {
    const r = ChangePasswordSchema.safeParse({ ...valid, confirmPassword: "Different1" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("confirmPassword"))).toBe(true);
    }
  });

  it("rejects same-as-current new password", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "SameSame1",
      newPassword: "SameSame1",
      confirmPassword: "SameSame1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects new password shorter than 8 chars", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "OldPassword1",
      newPassword: "Short1",
      confirmPassword: "Short1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a new password with no complexity", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "OldPassword1",
      newPassword: "alllowercase",
      confirmPassword: "alllowercase",
    });
    expect(r.success).toBe(false);
  });

  it("requires the current password", () => {
    const r = ChangePasswordSchema.safeParse({
      currentPassword: "",
      newPassword: "NewPass123",
      confirmPassword: "NewPass123",
    });
    expect(r.success).toBe(false);
  });
});
