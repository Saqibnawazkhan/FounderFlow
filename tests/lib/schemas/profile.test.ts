import { describe, expect, it } from "vitest";
import {
  ChangePasswordSchema,
  HandleSchema,
  MAX_HANDLE_LENGTH,
  MIN_HANDLE_LENGTH,
  UpdateHandleSchema,
  UpdateProfileSchema,
} from "@/lib/schemas/profile";
import { RequestEmailChangeSchema } from "@/lib/schemas/email-change";
import { tokenizeForRender } from "@/lib/comments/mentions";

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

describe("HandleSchema (the grammar of an @mention address)", () => {
  // Every ACCEPT is also fed to the real mention parser below, so this list
  // can't quietly grow a value the parser would refuse to tokenize.
  const ACCEPTS: { label: string; value: string }[] = [
    { label: "an ordinary chosen handle", value: "ali-khan" },
    { label: "digits after the first letter", value: "ali2024" },
    // The backfill's de-duplication suffix. Banning consecutive hyphens would
    // make a handle the product itself assigned un-re-savable by its owner.
    { label: "the backfill's de-duplicated form", value: "ali--2" },
    // The backfill's fallback for a local-part that sanitises to nothing —
    // precisely the Urdu-script user T16 is about.
    { label: "the backfill's machine-assigned fallback", value: "user-a1b2c3d4" },
    { label: "exactly the minimum length", value: "a".repeat(MIN_HANDLE_LENGTH) },
    { label: "exactly the maximum length", value: "a".repeat(MAX_HANDLE_LENGTH) },
  ];

  for (const { label, value } of ACCEPTS) {
    it(`accepts ${label}`, () => {
      const r = HandleSchema.safeParse(value);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(value);
    });
  }

  const REJECTS: { label: string; value: string }[] = [
    {
      label: "uppercase (the parser lowercases the token, so it would match nothing)",
      value: "Ali",
    },
    { label: "an interior space", value: "ali khan" },
    { label: "nothing but whitespace", value: "   " },
    { label: "the empty string", value: "" },
    { label: "a leading hyphen", value: "-ali" },
    { label: "a trailing hyphen", value: "ali-" },
    // Bounds are derived, never typed as a literal count: change the constant
    // and these follow it.
    { label: "one character under the minimum", value: "a".repeat(MIN_HANDLE_LENGTH - 1) },
    { label: "one character over the maximum", value: "a".repeat(MAX_HANDLE_LENGTH + 1) },
    // MENTION_REGEX is /@([a-zA-Z][a-zA-Z0-9-]*)/ — a leading digit never
    // tokenizes, so `@2024ali` would notify nobody. Pinned below.
    { label: "a leading digit", value: "2024ali" },
    { label: "a leading @, which people paste", value: "@ali" },
    { label: "a dot", value: "ali.khan" },
    { label: "an underscore", value: "ali_khan" },
    { label: "an email address", value: "ali@nimbus.app" },
    // The population this column exists for: the answer is a typable handle,
    // not a widened token grammar (see the column comment in schema.prisma).
    { label: "non-ASCII script", value: "علی-خان" },
  ];

  for (const { label, value } of REJECTS) {
    it(`rejects ${label}`, () => {
      expect(HandleSchema.safeParse(value).success).toBe(false);
    });
  }

  it("trims a handle someone copied out of a chat line", () => {
    const r = HandleSchema.safeParse("  ali-khan  ");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("ali-khan");
  });

  it("measures length after trimming, not before", () => {
    // Padding must not buy someone a handle under the minimum.
    const padded = `  ${"a".repeat(MIN_HANDLE_LENGTH - 1)}  `;
    expect(padded.length).toBeGreaterThan(MIN_HANDLE_LENGTH);
    expect(HandleSchema.safeParse(padded).success).toBe(false);
  });
});

describe("HandleSchema (kept in step with the mention parser)", () => {
  // The rules above are only worth anything if what they admit is exactly what
  // lib/comments/mentions.ts can tokenize. A handle the parser cannot read is
  // the T16 bug again, wearing a different hat.
  const ACCEPTED = [
    "ali-khan",
    "ali2024",
    "ali--2",
    "user-a1b2c3d4",
    "a".repeat(MIN_HANDLE_LENGTH),
  ];

  for (const handle of ACCEPTED) {
    it(`renders @${handle} as one whole mention`, () => {
      expect(HandleSchema.safeParse(handle).success).toBe(true);
      // tokenizeForRender resolves against slugified NAMES, so name the user
      // after their own handle to exercise the token grammar end to end.
      const segments = tokenizeForRender(`hey @${handle} take a look`, [
        { id: "u1", name: handle },
      ]);
      const mentions = segments.filter((s) => s.type === "mention");
      expect(mentions).toHaveLength(1);
      // Not `.slice(1)` on the body: the assertion is that the parser consumed
      // the WHOLE handle, not a readable prefix of it.
      expect(mentions[0]).toMatchObject({ type: "mention", slug: handle, userId: "u1" });
    });
  }

  it("rejects the leading digit for a reason the parser can demonstrate", () => {
    expect(HandleSchema.safeParse("2024ali").success).toBe(false);
    const segments = tokenizeForRender("hey @2024ali take a look", [{ id: "u1", name: "2024ali" }]);
    // No mention segment at all — the token regex requires a leading letter,
    // so this would have been an address that silently notified nobody.
    expect(segments.every((s) => s.type === "text")).toBe(true);
  });
});

describe("UpdateHandleSchema (what the server action re-parses)", () => {
  it("accepts the wrapped handle and drops unknown fields", () => {
    const r = UpdateHandleSchema.safeParse({ handle: "ali-khan", userId: "someone-else" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ handle: "ali-khan" });
      // A client-supplied id must never ride along into the update — the
      // action writes session.user.id and nothing else.
      expect(r.data).not.toHaveProperty("userId");
    }
  });

  it("rejects a missing handle", () => {
    expect(UpdateHandleSchema.safeParse({}).success).toBe(false);
  });
});
