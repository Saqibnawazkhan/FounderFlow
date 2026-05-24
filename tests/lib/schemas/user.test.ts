import { describe, it, expect } from "vitest";
import { InviteUserSchema, UpdateRoleSchema } from "@/lib/schemas/user";

describe("InviteUserSchema", () => {
  const valid = {
    name: "Jane Doe",
    email: "jane@company.com",
    password: "tmp-pass",
    role: "cofounder" as const,
  };

  it("accepts cofounder + member roles", () => {
    expect(InviteUserSchema.safeParse(valid).success).toBe(true);
    expect(InviteUserSchema.safeParse({ ...valid, role: "member" }).success).toBe(true);
  });

  it("rejects admin as an invite role — admin is minted by separate role-change action", () => {
    const result = InviteUserSchema.safeParse({ ...valid, role: "admin" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(InviteUserSchema.safeParse({ ...valid, role: "owner" }).success).toBe(false);
  });

  it("requires a password of at least 6 chars", () => {
    expect(InviteUserSchema.safeParse({ ...valid, password: "abc" }).success).toBe(false);
  });

  it("normalizes email to lowercase", () => {
    const result = InviteUserSchema.safeParse({ ...valid, email: "Jane@Company.COM" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("jane@company.com");
  });

  it("trims name", () => {
    const result = InviteUserSchema.safeParse({ ...valid, name: "  Jane  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Jane");
  });
});

describe("UpdateRoleSchema", () => {
  it("accepts admin / cofounder / member", () => {
    for (const role of ["admin", "cofounder", "member"] as const) {
      expect(UpdateRoleSchema.safeParse({ userId: "u1", role }).success).toBe(true);
    }
  });

  it("rejects empty userId", () => {
    expect(UpdateRoleSchema.safeParse({ userId: "", role: "member" }).success).toBe(false);
  });

  it("rejects unknown role values", () => {
    expect(UpdateRoleSchema.safeParse({ userId: "u1", role: "owner" }).success).toBe(false);
  });
});
