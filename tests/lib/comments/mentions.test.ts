import { describe, expect, it } from "vitest";
import {
  extractMentions,
  findMentionQuery,
  mentionToken,
  normalizeHandle,
  slugifyName,
  tokenizeForRender,
  type MentionUser,
} from "@/lib/comments/mentions";

/**
 * One roster, exercised by iteration wherever a test is really asking "does
 * this hold for everyone?". Adding a teammate shape here is how you extend the
 * coverage — the loops pick them up, no count to bump.
 *
 * `u4` is the reason this file changed. Her name carries no ASCII letters, so
 * `slugifyName` reduces it to a lone hyphen and, before `User.handle` existed,
 * she could not be @mentioned anywhere inside her own workspace (FaultsAudit
 * T16). Her handle is what makes her addressable; the loops below assert she
 * is not a special case but an ordinary member of the roster.
 */
const ROSTER: MentionUser[] = [
  { id: "u1", name: "Ali Khan", handle: "ali-khan" },
  { id: "u2", name: "Fatima Noor", handle: "fatima" },
  { id: "u3", name: "Ahmed", handle: "ahmed" }, // single-word name
  { id: "u4", name: "مہوش زیدی", handle: "mahwish" }, // T16: no ASCII letters
];

describe("the roster fixture (the premise the suite rests on)", () => {
  it("contains a teammate whose name yields no token, or the suite proves nothing", () => {
    // Guards against the whole file passing vacuously: if someone "tidies"
    // u4's name into ASCII, the T16 cases below stop testing T16 and this
    // fails first, saying why.
    const tokenless = ROSTER.filter((u) => mentionToken({ id: u.id, name: u.name }) === "");
    expect(tokenless.map((u) => u.id)).toEqual(["u4"]);
  });

  it("gives every teammate a typable token once their handle is counted", () => {
    expect(ROSTER.map(mentionToken)).toEqual(ROSTER.map((u) => normalizeHandle(u.handle)));
    expect(ROSTER.filter((u) => mentionToken(u) === "")).toEqual([]);
  });
});

describe("slugifyName (the legacy, lossy name→token derivation)", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyName("Ali Khan")).toBe("ali-khan");
    expect(slugifyName("FATIMA NOOR")).toBe("fatima-noor");
  });

  it("discards every non-ASCII letter, which is why it is not the address of record", () => {
    // RULE: slugifyName is a best-effort rendering of a name into the ASCII
    // token grammar and is allowed to lose information. It is NOT allowed to
    // be the only way to address someone — that is what mentionToken is for.
    expect(slugifyName("Ali, Khan!")).toBe("ali-khan");
    expect(slugifyName("José")).toBe("jos"); // lossy: the accented letter goes
    expect(slugifyName("مہوش زیدی")).toBe("-"); // total loss: only the joining hyphen survives
    expect(slugifyName("احمد")).toBe(""); // and nothing at all without a space
  });

  it("handles single-word names", () => {
    expect(slugifyName("Ahmed")).toBe("ahmed");
  });

  it("collapses runs of whitespace", () => {
    expect(slugifyName("Ali    Khan")).toBe("ali-khan");
  });
});

describe("normalizeHandle (handle → lookup key)", () => {
  it("lowercases and trims so a token matches case-insensitively", () => {
    expect(normalizeHandle("  Ali-Khan  ")).toBe("ali-khan");
  });

  it("rejects a handle the token grammar could never produce", () => {
    // RULE: MENTION_REGEX is `@[a-zA-Z][a-zA-Z0-9-]*`. A handle outside that
    // shape is unreachable, so it contributes no lookup key at all rather than
    // sitting in the index as a promise nobody can redeem.
    expect(normalizeHandle("ali.khan")).toBe(""); // a dot ends the token
    expect(normalizeHandle("2024")).toBe(""); // must start with a letter
    expect(normalizeHandle("مہوش")).toBe(""); // not ASCII
    expect(normalizeHandle("")).toBe("");
    expect(normalizeHandle(null)).toBe("");
    expect(normalizeHandle(undefined)).toBe("");
  });
});

describe("mentionToken (what the composer offers and inserts)", () => {
  it("prefers the chosen handle over the derived name slug", () => {
    // RULE: offered === inserted === resolved. The composer must never show a
    // token the resolver would decide differently about.
    expect(mentionToken({ id: "x", name: "Ali Khan", handle: "ali" })).toBe("ali");
  });

  it("falls back to the name slug for a teammate with no handle", () => {
    expect(mentionToken({ id: "x", name: "Ali Khan" })).toBe("ali-khan");
    expect(mentionToken({ id: "x", name: "Ali Khan", handle: null })).toBe("ali-khan");
  });

  it("yields nothing rather than a lone hyphen for a two-word name in Urdu script", () => {
    // RULE: emptiness is the wrong test. "مہوش زیدی" slugifies to "-", which
    // is non-empty AND untypable; offering it would insert "@- ", a mention
    // that pings nobody and reads as a typo (T16, symptom 3).
    expect(slugifyName("مہوش زیدی")).toBe("-");
    expect(mentionToken({ id: "x", name: "مہوش زیدی" })).toBe("");
  });

  it("ignores a handle the token grammar cannot express and tries the name", () => {
    expect(mentionToken({ id: "x", name: "Ali Khan", handle: "ali.khan" })).toBe("ali-khan");
  });
});

describe("findMentionQuery (the in-progress-token detector)", () => {
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

describe("extractMentions (server-side mention resolution)", () => {
  it("addresses a teammate whose name is written in Urdu script", () => {
    // THE T16 CASE. `slugifyName` ends in `.replace(/[^a-z0-9-]/g, "")`, so
    // "مہوش زیدی" collapsed to "-" and u4 was indexed under a key the token
    // grammar cannot produce: no `@token` resolved to her, no mention
    // notification could reach her, and nothing in the UI said why. She was
    // structurally unaddressable inside her own workspace. Her handle fixes it.
    expect(extractMentions("@mahwish can you look at this?", ROSTER, "u1")).toEqual(["u4"]);
  });

  it("does not ping the wrong person when a name slug and a handle collide", () => {
    // RULE: the handle's owner takes the token, always. A handle is chosen and
    // unique per company; a name is derived and a third party can change
    // theirs at any moment. If a name slug could outrank a handle, a stranger
    // renaming themselves would silently steal — or blank out — an address
    // somebody else picked. The person who "lost" @ali is not stranded: they
    // keep their own handle, which nobody can take.
    const collide: MentionUser[] = [
      { id: "chose-it", name: "Zainab Raza", handle: "ali" },
      { id: "named-it", name: "Ali", handle: "ali-2" },
    ];
    expect(extractMentions("@ali", collide, "author")).toEqual(["chose-it"]);
    expect(extractMentions("@ali-2", collide, "author")).toEqual(["named-it"]);
  });

  it("resolves to nobody when two teammates share a name slug", () => {
    // RULE CHANGE: this used to be first-match-wins, where "first" meant
    // roster order, i.e. findMany order — something no writer can see or
    // reason about. Pinging a coin-flip colleague is worse than pinging
    // nobody, because nobody is visible (no chip renders) and recoverable
    // (each of them still has a unique handle).
    const namesakes: MentionUser[] = [
      { id: "first", name: "Ali Khan" },
      { id: "second", name: "Ali Khan" },
    ];
    expect(extractMentions("@Ali-Khan", namesakes, "author")).toEqual([]);
  });

  it("keeps both namesakes reachable through their own handles", () => {
    const namesakes: MentionUser[] = [
      { id: "first", name: "Ali Khan", handle: "ali" },
      { id: "second", name: "Ali Khan", handle: "ali-k" },
    ];
    expect(extractMentions("@ali and @ali-k", namesakes, "author")).toEqual(["first", "second"]);
    // ...while the slug they share still belongs to neither of them.
    expect(extractMentions("@ali-khan", namesakes, "author")).toEqual([]);
  });

  it("does not hand a contested handle down to a third person's name slug", () => {
    // The database forbids two rows sharing a handle in one company, but the
    // roster arrives as a plain array. If that invariant is ever broken, the
    // token dies rather than falling through to somebody whose NAME happens to
    // match — which would be the wrong-person ping by a second route.
    const broken: MentionUser[] = [
      { id: "a", name: "Zainab Raza", handle: "ali" },
      { id: "b", name: "Hina Shah", handle: "ali" },
      { id: "c", name: "Ali" },
    ];
    expect(extractMentions("@ali", broken, "author")).toEqual([]);
  });

  it("reaches every teammate through the token the composer would insert", () => {
    // The contract in one loop: offered === inserted === resolved, for
    // everyone on the roster, whatever alphabet their name is written in.
    const resolved = ROSTER.map((u) =>
      extractMentions(`ping @${mentionToken(u)}`, ROSTER, "nobody")
    );
    expect(resolved).toEqual(ROSTER.map((u) => [u.id]));
  });

  it("still reaches teammates by the legacy name slug, for bodies written before handles", () => {
    // Asking mentionToken about a handle-less copy of each teammate is the
    // same question as "does this name yield a typable slug?", without
    // re-deriving the token grammar here.
    const withNameSlug = ROSTER.filter((u) => mentionToken({ id: u.id, name: u.name }) !== "");
    const resolved = withNameSlug.map((u) =>
      extractMentions(`@${slugifyName(u.name)}`, ROSTER, "nobody")
    );
    expect(resolved).toEqual(withNameSlug.map((u) => [u.id]));
    // u4 is the exception the whole change is about — she never had one.
    expect(withNameSlug.map((u) => u.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("returns matched user IDs in first-appearance order", () => {
    const ids = extractMentions("@Fatima-Noor and @Ali-Khan please review", ROSTER, "author");
    expect(ids).toEqual(["u2", "u1"]);
  });

  it("is case-insensitive", () => {
    expect(extractMentions("@ali-khan", ROSTER, "author")).toEqual(["u1"]);
    expect(extractMentions("@MAHWISH", ROSTER, "author")).toEqual(["u4"]);
  });

  it("dedupes when a user is mentioned multiple times, including across both of their tokens", () => {
    // RULE: dedupe is by USER, not by token. u2 answers to both `@fatima`
    // (her handle) and `@fatima-noor` (her name slug), and a body using both
    // spellings of her fans out exactly one notification.
    expect(extractMentions("@Ali-Khan @ali-khan @Ali-Khan", ROSTER, "author")).toEqual(["u1"]);
    expect(extractMentions("@fatima then @Fatima-Noor", ROSTER, "author")).toEqual(["u2"]);
  });

  it("drops the author from their own mentions (no self-ping)", () => {
    const ids = extractMentions("@Ali-Khan @Fatima-Noor", ROSTER, "u1");
    expect(ids).toEqual(["u2"]);
  });

  it("ignores unknown tokens", () => {
    const ids = extractMentions("@nobody @Ali-Khan", ROSTER, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("ignores tokens starting with a digit (e.g. @2024)", () => {
    const ids = extractMentions("@2024 @Ali-Khan", ROSTER, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("strips trailing punctuation via the token regex", () => {
    const ids = extractMentions("Pinging @Ali-Khan, please?", ROSTER, "author");
    expect(ids).toEqual(["u1"]);
  });

  it("does not match inside an email-style string", () => {
    // `@nimbus.app` → token `nimbus` (the period stops it), which is nobody's.
    const ids = extractMentions("write to ali@nimbus.app", ROSTER, "author");
    expect(ids).toEqual([]);
  });

  it("handles single-word @Ahmed", () => {
    const ids = extractMentions("@Ahmed take a look", ROSTER, "author");
    expect(ids).toEqual(["u3"]);
  });

  it("returns empty array on no-match body", () => {
    const ids = extractMentions("just a regular comment", ROSTER, "author");
    expect(ids).toEqual([]);
  });

  it("resolves by name slug alone when the roster was loaded without handles", () => {
    // What a `select` missing `handle: true` costs: T16 comes back for that
    // one surface, silently, because MentionUser.handle is optional.
    const handleless = ROSTER.map((u) => ({ id: u.id, name: u.name }));
    expect(extractMentions("@mahwish", handleless, "author")).toEqual([]);
    expect(extractMentions("@ali-khan", handleless, "author")).toEqual(["u1"]);
  });
});

describe("tokenizeForRender (mention chips)", () => {
  it("produces alternating text + mention segments", () => {
    const segs = tokenizeForRender("Hey @Ali-Khan can you check this?", ROSTER);
    expect(segs).toEqual([
      { type: "text", text: "Hey " },
      { type: "mention", slug: "ali-khan", userId: "u1", name: "Ali Khan" },
      { type: "text", text: " can you check this?" },
    ]);
  });

  it("chips a handle with the owner's display name, whatever script it is in", () => {
    // Showing the resolved NAME is what makes the precedence rule auditable:
    // the writer sees which person @mahwish became in their own comment.
    const segs = tokenizeForRender("@mahwish ping", ROSTER);
    expect(segs).toEqual([
      { type: "mention", slug: "mahwish", userId: "u4", name: "مہوش زیدی" },
      { type: "text", text: " ping" },
    ]);
  });

  it("renders a deliberately-unresolved token as plain text, not as a chip", () => {
    // RULE: a token we refuse to resolve must LOOK unresolved. A chip pointing
    // at nobody, or at a guess, is the failure mode this whole precedence rule
    // exists to avoid.
    const namesakes: MentionUser[] = [
      { id: "first", name: "Ali Khan" },
      { id: "second", name: "Ali Khan" },
    ];
    expect(tokenizeForRender("ping @Ali-Khan", namesakes)).toEqual([
      { type: "text", text: "ping " },
      { type: "text", text: "@Ali-Khan" },
    ]);
  });

  it("agrees with extractMentions about every token on the roster", () => {
    // The chip and the notification are two readings of one decision; if they
    // ever disagree, someone gets pinged without a visible mention or sees a
    // mention that never pinged.
    const chipped = ROSTER.map((u) => {
      const segs = tokenizeForRender(`@${mentionToken(u)}`, ROSTER);
      return segs.map((s) => (s.type === "mention" ? s.userId : null));
    });
    expect(chipped).toEqual(ROSTER.map((u) => [u.id]));
  });

  it("falls back to plain text for unknown tokens", () => {
    const segs = tokenizeForRender("ping @nobody", ROSTER);
    expect(segs).toEqual([
      { type: "text", text: "ping " },
      { type: "text", text: "@nobody" },
    ]);
  });

  it("handles a body that is just one mention", () => {
    const segs = tokenizeForRender("@Ali-Khan", ROSTER);
    expect(segs).toEqual([{ type: "mention", slug: "ali-khan", userId: "u1", name: "Ali Khan" }]);
  });

  it("returns a single text segment when no @ tokens", () => {
    const segs = tokenizeForRender("just text", ROSTER);
    expect(segs).toEqual([{ type: "text", text: "just text" }]);
  });

  it("returns empty array on empty body", () => {
    expect(tokenizeForRender("", ROSTER)).toEqual([]);
  });
});
