import { describe, it, expect } from "vitest";
import {
  FALLBACK_HANDLE,
  HANDLE_UNIQUE_INDEX,
  MAX_HANDLE_LENGTH,
  deriveHandle,
  isHandleConflict,
  uniqueHandle,
} from "@/lib/user/handle";

/**
 * The grammar a handle has to survive, copied from `MENTION_REGEX`'s capture
 * group in lib/comments/mentions.ts (`/@([a-zA-Z][a-zA-Z0-9-]*)/`, lowercased
 * because handles are). Asserted directly rather than imported because that
 * regex is module-private and `g`-flagged, so borrowing it would drag its
 * `lastIndex` state into these tests.
 *
 * This is the real contract: a handle outside this set is not addressable, and
 * an unaddressable handle is T16 with extra steps.
 */
const MENTION_TOKEN = /^[a-z][a-z0-9-]*$/;

/**
 * Inputs chosen to break the derivation rather than exercise it: scripts with
 * no ASCII, strings that are nothing but separators, an address whose local
 * part is missing entirely, and one long enough to hit the cap. Every
 * invariant below is driven by this table, so adding a case here extends all
 * of them at once.
 */
const ADVERSARIAL_INPUTS: readonly string[] = [
  "",
  "   ",
  "\n\t",
  "@",
  "@@",
  "@x.com",
  "@ali",
  "ali@",
  "...",
  "+++",
  "---",
  "-",
  "--@x.com",
  "...@x.com",
  "2024",
  "123@x.com",
  "🎉",
  "🎉🎉🎉@x.com",
  "。。。",
  "علی",
  "علی@x.com",
  "محمد.علی@founderflow.app",
  "ایک بہت لمبا نام@x.com",
  `${"a".repeat(200)}@x.com`,
  `${"a-".repeat(80)}@x.com`,
  `${"عل".repeat(50)}@x.com`,
];

describe("deriveHandle (the address a new account is born with)", () => {
  it("takes the local part of an email and drops the domain", () => {
    expect(deriveHandle("ali@founderflow.app")).toBe("ali");
  });

  it("lowercases what it is handed", () => {
    expect(deriveHandle("ALI@FounderFlow.app")).toBe("ali");
  });

  it("deletes separators instead of hyphenating them, the way the backfill did", () => {
    // The one deliberate divergence from `slugifyChannelName`, which would
    // answer "ali-khan" here. Five users are already in the unique index under
    // the migration's rule; a runtime handle has to look like a backfilled one
    // for the same address or nobody can guess a colleague's address.
    expect(deriveHandle("ali.khan@x.com")).toBe("alikhan");
  });

  it("derives the same handle from a name as from the matching address", () => {
    expect(deriveHandle("Ali Khan")).toBe(deriveHandle("ali.khan@x.com"));
  });

  it("collapses runs of hyphens and trims them off both ends", () => {
    expect(deriveHandle("--ali--khan--@x.com")).toBe("ali-khan");
  });

  it("prefixes a letter when the local part leads with a digit", () => {
    // `@2024ali` would not tokenize as a mention at all — the parser demands a
    // letter first — so a handle starting with a digit is as unaddressable as
    // an empty one.
    expect(deriveHandle("2024ali@x.com")).toBe("u2024ali");
  });

  it("falls back to a stem for a local part carrying no ASCII alphanumerics", () => {
    const unaddressable = ["علی@x.com", "🎉@x.com", "...@x.com", "+++@x.com"];
    for (const input of unaddressable) {
      expect(deriveHandle(input)).toBe(FALLBACK_HANDLE);
    }
  });

  it("agrees across addresses that differ only in case, punctuation or domain", () => {
    const variants = ["ali.khan@x.com", "Ali.Khan@y.com", "a.l.i.k.h.a.n@z.co", "ALIKHAN@w.io"];
    const derived = new Set(variants.map(deriveHandle));
    expect(derived.size).toBe(1);
  });

  it("caps a long local part and leaves no separator dangling at the cut", () => {
    const long = [
      `${"a".repeat(200)}@x.com`,
      `${"a-".repeat(80)}@x.com`,
      `${"ali-khan-".repeat(20)}@x.com`,
    ];
    for (const input of long) {
      const handle = deriveHandle(input);
      expect(handle.length).toBeLessThanOrEqual(MAX_HANDLE_LENGTH);
      expect(handle.endsWith("-")).toBe(false);
    }
  });

  it("never returns an empty handle for any input", () => {
    // THE invariant T16 exists to guarantee. `slugifyName` collapses a name in
    // a non-ASCII script to "" and that is precisely how a teammate became
    // unmentionable inside their own workspace; a handle that can do the same
    // has fixed nothing. Driven by the shared table so the guarantee widens
    // with it rather than with this assertion.
    for (const input of ADVERSARIAL_INPUTS) {
      expect(deriveHandle(input).length).toBeGreaterThan(0);
    }
  });

  it("only ever emits a token the mention parser can address", () => {
    // The stronger form of the same invariant: non-empty is not enough, the
    // result also has to start with a letter and stay inside [a-z0-9-], or the
    // parser will never produce it from an `@`.
    for (const input of ADVERSARIAL_INPUTS) {
      expect(deriveHandle(input)).toMatch(MENTION_TOKEN);
    }
  });

  it("never derives a base containing the de-duplication separator", () => {
    // What makes `--n` collision-free: if a derived base could contain "--",
    // then `ali--2` would be reachable as somebody's base and the numbered
    // series could hand the same handle to two people. The hyphen-run collapse
    // is what forbids it, so this pins the collapse from the other side.
    for (const input of [...ADVERSARIAL_INPUTS, "a--b@x.com", "a----b@x.com", "a - - b"]) {
      expect(deriveHandle(input)).not.toContain("--");
    }
  });
});

describe("uniqueHandle (de-colliding inside one workspace)", () => {
  it("hands back the base when nobody holds it", () => {
    expect(uniqueHandle("ali", [])).toBe("ali");
  });

  it("numbers from 2 when the base is taken", () => {
    expect(uniqueHandle("ali", ["ali"])).toBe("ali--2");
  });

  it("skips over an existing numbered sibling", () => {
    expect(uniqueHandle("ali", ["ali", "ali--2"])).toBe("ali--3");
  });

  it("fills the first gap in the series rather than always appending", () => {
    expect(uniqueHandle("ali", ["ali", "ali--3"])).toBe("ali--2");
  });

  it("ignores handles from another family", () => {
    expect(uniqueHandle("ali", ["zainab", "alia", "ali-khan"])).toBe("ali");
  });

  it("reads any iterable, not only an array", () => {
    // The signature is `Iterable<string>` so a caller can hand over a Set it
    // already built without flattening it first.
    expect(uniqueHandle("ali", new Set(["ali", "ali--2"]))).toBe("ali--3");
  });

  it("hands a fresh answer to every member of a crowded family", () => {
    const taken: string[] = [];
    for (let i = 0; i < 25; i++) {
      const next = uniqueHandle("ali", taken);
      expect(taken).not.toContain(next);
      taken.push(next);
    }
    expect(new Set(taken).size).toBe(taken.length);
  });

  it("keeps every answer addressable, even the fallback stem under collision", () => {
    const taken: string[] = [];
    for (let i = 0; i < 12; i++) {
      const next = uniqueHandle(deriveHandle("علی@x.com"), taken);
      expect(next).toMatch(MENTION_TOKEN);
      taken.push(next);
    }
  });

  it("still answers once the whole numbered series is spoken for", () => {
    // The bounded loop's exit, and the reason it is bounded: a workspace that
    // somehow holds the entire series gets a time-derived handle rather than a
    // hung request. Build the series by iterating, not by writing it out.
    const taken = ["ali"];
    for (let n = 2; n <= 1000; n++) taken.push(`ali--${n}`);

    const next = uniqueHandle("ali", taken);
    expect(taken).not.toContain(next);
    expect(next).toMatch(MENTION_TOKEN);
  });
});

describe("isHandleConflict (telling the handle index apart from the email one)", () => {
  it("recognises the constraint name reported as a string", () => {
    expect(isHandleConflict({ code: "P2002", meta: { target: HANDLE_UNIQUE_INDEX } })).toBe(true);
  });

  it("recognises the field name reported as an array", () => {
    expect(isHandleConflict({ code: "P2002", meta: { target: ["companyId", "handle"] } })).toBe(
      true
    );
  });

  it("refuses a duplicate email, which must never be retried under a new handle", () => {
    // A duplicate email means "an account with this email already exists" —
    // a specific answer the caller gives the user. Retrying it three times
    // under fresh handles would replace that answer with a generic failure.
    const emailConflicts = [
      { code: "P2002", meta: { target: "User_email_key" } },
      { code: "P2002", meta: { target: ["email"] } },
    ];
    for (const e of emailConflicts) {
      expect(isHandleConflict(e)).toBe(false);
    }
  });

  it("refuses anything it cannot attribute to the handle index", () => {
    const notHandleConflicts: unknown[] = [
      null,
      undefined,
      "P2002",
      new Error("connection lost"),
      { code: "P2025" },
      { code: "P2002" },
      { code: "P2002", meta: {} },
      { code: "P2002", meta: { target: 42 } },
      { code: "P2002", meta: { target: [] } },
    ];
    for (const e of notHandleConflicts) {
      expect(isHandleConflict(e)).toBe(false);
    }
  });
});
