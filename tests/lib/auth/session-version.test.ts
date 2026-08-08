import { describe, it, expect } from "vitest";
import { sessionTokenStillValid } from "@/lib/auth/session-version";

describe("sessionTokenStillValid", () => {
  it("honours a token whose version matches the live row", () => {
    expect(sessionTokenStillValid(3, { deletedAt: null, sessionVersion: 3 })).toBe(true);
  });

  it("invalidates a token when the live version has moved on (reset / forced logout)", () => {
    expect(sessionTokenStillValid(3, { deletedAt: null, sessionVersion: 4 })).toBe(false);
  });

  it("invalidates a tombstoned (soft-deleted) user even if versions match", () => {
    expect(sessionTokenStillValid(0, { deletedAt: new Date(), sessionVersion: 0 })).toBe(false);
  });

  it("invalidates when the user row is gone (hard-deleted / never existed)", () => {
    expect(sessionTokenStillValid(0, null)).toBe(false);
  });

  it("treats a missing token version as 0 so legacy tokens stay valid", () => {
    expect(sessionTokenStillValid(undefined, { deletedAt: null, sessionVersion: 0 })).toBe(true);
    expect(sessionTokenStillValid(undefined, { deletedAt: null, sessionVersion: 1 })).toBe(false);
  });
});
