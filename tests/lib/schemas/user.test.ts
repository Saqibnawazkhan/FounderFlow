import { describe, it, expect } from "vitest";
import { AcceptInviteSchema, InviteUserSchema, UpdateRoleSchema } from "@/lib/schemas/user";

describe("InviteUserSchema", () => {
  const valid = {
    name: "Jane Doe",
    email: "jane@company.com",
    role: "cofounder" as const,
  };

  it("accepts cofounder + member roles (no password field)", () => {
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

  it("strips password field if accidentally included (admin no longer sets pw)", () => {
    // zod default behavior: extra fields pass but get dropped. The action
    // never reads input.password, so even if a stale client sends one it's
    // ignored.
    const result = InviteUserSchema.safeParse({ ...valid, password: "shouldnt-be-here" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).password).toBeUndefined();
    }
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

describe("AcceptInviteSchema", () => {
  const valid = { token: "abc123def456", password: "newpass123" };

  it("accepts a valid token + password", () => {
    expect(AcceptInviteSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty token", () => {
    expect(AcceptInviteSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });

  it("rejects passwords shorter than 6 chars", () => {
    const result = AcceptInviteSchema.safeParse({ ...valid, password: "abc" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/at least 6/);
    }
  });

  it("caps password length at 120 chars", () => {
    expect(AcceptInviteSchema.safeParse({ ...valid, password: "a".repeat(121) }).success).toBe(
      false
    );
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
