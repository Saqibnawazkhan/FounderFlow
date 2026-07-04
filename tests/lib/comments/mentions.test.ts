import { describe, expect, it } from "vitest";
import {
  extractMentions,
  findMentionQuery,
  slugifyName,
  tokenizeForRender,
} from "@/lib/comments/mentions";

const USERS = [
  { id: "u1", name: "Ali Khan" },
  { id: "u2", name: "Fatima Noor" },
  { id: "u3", name: "Ahmed" }, // single-word name
];

describe("slugifyName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyName("Ali Khan")).toBe("ali-khan");
    expect(slugifyName("FATIMA NOOR")).toBe("fatima-noor");
  });

  it("strips non-ASCII / punctuation", () => {
    expect(slugifyName("Ali, Khan!")).toBe("ali-khan");
    expect(slugifyName("José")).toBe("jos");
  });

  it("handles single-word names", () => {
    expect(slugifyName("Ahmed")).toBe("ahmed");
  });

  it("collapses runs of whitespace", () => {
    expect(slugifyName("Ali    Khan")).toBe("ali-khan");
  });
});

describe("findMentionQuery", () => {
  it("detects a token the caret sits inside", () => {
    const body = "hey @ali";
    expect(findMentionQuery(body, body.length)).toEqual({ from: 4, to: 8, query: "ali" });
  });

  it("detects a bare @ (empty query) so suggestions show immediately", () => {
    const body = "hey @";
    expect(findMentionQuery(body, body.length)).toEqual({ from: 4, to: 5, query: "" });
  });

  it("matches an @ at the very start of the text", () => {
    expect(findMentionQuery("@fat", 4)).toEqual({ from: 0, to: 4, query: "fat" });
  });

  it("returns null when the caret is past a completed mention + space", () => {
    const body = "@ali-khan ";
    expect(findMentionQuery(body, body.length)).toBeNull();
  });

  it("returns null for an @ glued to a preceding word (email-ish)", () => {
    const body = "mail me at foo@bar";
    expect(findMentionQuery(body, body.length)).toBeNull();
  });

  it("returns null when there's whitespace between @ and the caret", () => {
    const body = "@ali khan";
    expect(findMentionQuery(body, body.length)).toBeNull();
  });

  it("reads the query only up to the caret, not the whole token", () => {
    const body = "@alikhan";
    // caret after "@ali"
    expect(findMentionQuery(body, 4)).toEqual({ from: 0, to: 4, query: "ali" });
  });
});

describe("extractMentions", () => {
  it("returns matched user IDs in first-appearance order", () => {
    const ids = extractMentions("@Fatima-Noor and @Ali-Khan please review", USERS, "author");
    expect(ids).toEqual(["u2", "u1"]);
  });

  it("is case-insensitive", () => {
    const ids = extractMentions("@ali-khan", USERS, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("dedupes when a user is mentioned multiple times", () => {
    const ids = extractMentions("@Ali-Khan @ali-khan @Ali-Khan", USERS, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("drops the author from their own mentions (no self-ping)", () => {
    const ids = extractMentions("@Ali-Khan @Fatima-Noor", USERS, "u1");
    expect(ids).toEqual(["u2"]);
  });

  it("ignores unknown slugs", () => {
    const ids = extractMentions("@nobody @Ali-Khan", USERS, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("ignores tokens starting with a digit (e.g. @2024)", () => {
    const ids = extractMentions("@2024 @Ali-Khan", USERS, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("strips trailing punctuation via the token regex", () => {
    const ids = extractMentions("Pinging @Ali-Khan, please?", USERS, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("does not match inside an email-style string", () => {
    // `@nimbus.app` → slug `nimbus` (period stops the token), no match in USERS
    const ids = extractMentions("write to ali@nimbus.app", USERS, "author");
    expect(ids).toEqual([]);
  });

  it("handles single-word @Ahmed", () => {
    const ids = extractMentions("@Ahmed take a look", USERS, "author");
    expect(ids).toEqual(["u3"]);
  });

  it("returns empty array on no-match body", () => {
    const ids = extractMentions("just a regular comment", USERS, "author");
    expect(ids).toEqual([]);
  });

  it("first-match-wins on duplicate slugs", () => {
    const dupes = [
      { id: "first", name: "Ali Khan" },
      { id: "second", name: "Ali Khan" },
    ];
    const ids = extractMentions("@Ali-Khan", dupes, "author");
    expect(ids).toEqual(["first"]);
  });
});

describe("tokenizeForRender", () => {
  it("produces alternating text + mention segments", () => {
    const segs = tokenizeForRender("Hey @Ali-Khan can you check this?", USERS);
    expect(segs).toEqual([
      { type: "text", text: "Hey " },
      { type: "mention", slug: "ali-khan", userId: "u1", name: "Ali Khan" },
      { type: "text", text: " can you check this?" },
    ]);
  });

  it("falls back to plain text for unknown slugs", () => {
    const segs = tokenizeForRender("ping @nobody", USERS);
    expect(segs).toEqual([
      { type: "text", text: "ping " },
      { type: "text", text: "@nobody" },
    ]);
  });

  it("handles a body that is just one mention", () => {
    const segs = tokenizeForRender("@Ali-Khan", USERS);
    expect(segs).toEqual([{ type: "mention", slug: "ali-khan", userId: "u1", name: "Ali Khan" }]);
  });

  it("returns a single text segment when no @ tokens", () => {
    const segs = tokenizeForRender("just text", USERS);
    expect(segs).toEqual([{ type: "text", text: "just text" }]);
  });

  it("returns empty array on empty body", () => {
    expect(tokenizeForRender("", USERS)).toEqual([]);
  });
});
