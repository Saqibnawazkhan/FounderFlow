import { describe, it, expect } from "vitest";
import { DeleteAccountSchema, DeleteWorkspaceSchema } from "@/lib/schemas/account";

describe("DeleteAccountSchema", () => {
  it("requires a password (re-auth guard)", () => {
    expect(DeleteAccountSchema.safeParse({ password: "hunter2" }).success).toBe(true);
    expect(DeleteAccountSchema.safeParse({ password: "" }).success).toBe(false);
  });
});

describe("DeleteWorkspaceSchema", () => {
  it("requires both a password and the workspace name", () => {
    expect(
      DeleteWorkspaceSchema.safeParse({ password: "hunter2", workspaceName: "Nimbus" }).success
    ).toBe(true);
  });

  it("rejects a missing password", () => {
    expect(DeleteWorkspaceSchema.safeParse({ password: "", workspaceName: "Nimbus" }).success).toBe(
      false
    );
  });

  it("rejects a missing workspace name (the second confirmation guard)", () => {
    expect(
      DeleteWorkspaceSchema.safeParse({ password: "hunter2", workspaceName: "" }).success
    ).toBe(false);
  });
});
