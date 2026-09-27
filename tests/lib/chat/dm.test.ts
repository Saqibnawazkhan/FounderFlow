/**
 * lib/chat/dm.ts — the two derived facts about a direct message: the URL a
 * pair of people always resolves to, and the name that URL wears from the
 * side of whoever is reading it.
 *
 * Both are pure string work over ids, which is exactly why they can be pinned
 * here without a database — the same treatment lib/chat/slug.ts gets. The
 * addressing half is the part with teeth: `Channel.slug` is half of
 * `@@unique([companyId, slug])`, so a DM slug that a person could reach by
 * naming a channel is a private conversation somebody else can take over.
 */

import { describe, it, expect } from "vitest";
import { dmDisplayName, dmSlugFor } from "@/lib/chat/dm";
import { dmKeyFor } from "@/lib/auth/channel-permissions";
import { slugifyChannelName } from "@/lib/chat/slug";

// cuid-shaped, because that is what Prisma's @default(cuid()) writes and what
// OpenDmSchema accepts at the boundary. Lexical order is AYESHA < SAQIB < ZARA,
// which is the order dmKeyFor sorts them into.
const AYESHA = "cjld2cjxh0000qzrmn831i7rn";
const SAQIB = "cjld2cyuq0000t3rmniod1foy";
const ZARA = "czzz2cyuq0000t3rmniod1foz";

/** Every unordered pair over the three fixtures, as the caller would pass it. */
const PAIRS: readonly (readonly [string, string])[] = [
  [AYESHA, SAQIB],
  [AYESHA, ZARA],
  [SAQIB, ZARA],
];

describe("dmSlugFor (the URL a pair of people always lands on)", () => {
  it("produces the same slug whichever way round the pair is given", () => {
    // Composed through dmKeyFor rather than asserting on a literal, because
    // the guarantee is about the PIPELINE the action actually runs: sort the
    // pair, then spell it. If either half stops being order-independent,
    // "Ayesha opens a DM with Saqib" and "Saqib opens a DM with Ayesha" build
    // two different URLs, the unique index never sees a collision, and the
    // pair ends up with two conversations each holding half the history.
    for (const [a, b] of PAIRS) {
      expect(dmSlugFor(dmKeyFor(a, b))).toBe(dmSlugFor(dmKeyFor(b, a)));
    }
  });

  it("keeps both halves of the pair in the slug", () => {
    // Truncating either id would let two different pairs share one URL — the
    // exact fork @@unique([companyId, dmKey]) exists to stop.
    for (const [a, b] of PAIRS) {
      const slug = dmSlugFor(dmKeyFor(a, b));
      expect(slug).toContain(a);
      expect(slug).toContain(b);
    }
  });

  // ── LOAD-BEARING ──────────────────────────────────────────────────────────
  // WHAT BREAKS IN PRODUCTION: a DM slug and a named channel's slug share one
  // key, @@unique([companyId, slug]). If any channel NAME could ever slugify
  // onto a derived DM slug, then creating that channel either fails with a
  // unique-constraint error nobody can explain, or — worse — some future
  // upsert-shaped path hands a private two-person conversation's URL to a room
  // the whole workspace can read. The underscore is the entire defence:
  // slugifyChannelName collapses every run of non-[a-z0-9] to a hyphen, so it
  // can never emit "_". Swap dm.ts's separator to "-" and this is the only
  // test in the suite that notices.
  it("produces a slug that slugifyChannelName can never generate", () => {
    for (const [a, b] of PAIRS) {
      const slug = dmSlugFor(dmKeyFor(a, b));

      // The separator that puts DM slugs outside slugifyChannelName's range.
      expect(slug).toContain("_");

      // Feeding the DM slug itself back through the channel slugifier — the
      // closest a person could get by typing the URL in as a channel name —
      // does not reproduce it.
      expect(slugifyChannelName(slug)).not.toBe(slug);
      expect(slugifyChannelName(slug)).not.toContain("_");

      // Nor do the spellings someone would actually type to try.
      for (const attempt of [slug, slug.replace(/_/g, " "), slug.replace(/_/g, "-")]) {
        expect(slugifyChannelName(attempt)).not.toBe(slug);
      }
    }
  });

  it("keeps different pairs on different slugs", () => {
    const slugs = PAIRS.map(([a, b]) => dmSlugFor(dmKeyFor(a, b)));
    // Iterated against the fixture list rather than a hardcoded 3, so adding a
    // pair above widens the guard instead of breaking it.
    expect(Array.from(new Set(slugs))).toHaveLength(slugs.length);
  });
});

describe("dmDisplayName (the heading a DM wears from the viewer's side)", () => {
  it("names the counterpart rather than the viewer", () => {
    // WHAT BREAKS IN PRODUCTION: a DM's stored Channel.name is written once,
    // by whoever opened it, and reads wrong from the other end. Drop this
    // rename and Ayesha opens her rail to a conversation titled "Ayesha".
    const members = [
      { id: AYESHA, name: "Ayesha Khan" },
      { id: SAQIB, name: "Saqib Nawaz" },
    ];
    expect(dmDisplayName(members, AYESHA)).toBe("Saqib Nawaz");
    expect(dmDisplayName(members, SAQIB)).toBe("Ayesha Khan");
  });

  it("never puts the viewer's own name in the heading", () => {
    const members = [
      { id: AYESHA, name: "Ayesha Khan" },
      { id: SAQIB, name: "Saqib Nawaz" },
      { id: ZARA, name: "Zara Iqbal" },
    ];
    // Every member gets a turn as the viewer, so the invariant is checked
    // across the whole membership instead of one lucky arrangement.
    for (const viewer of members) {
      const heading = dmDisplayName(members, viewer.id);
      expect(heading).not.toBeNull();
      expect(heading).not.toContain(viewer.name);
    }
  });

  it("joins every remaining member rather than dropping one", () => {
    // A DM is a pair today, but a heading that silently swallows a
    // participant is a worse failure than one that is merely long.
    const members = [
      { id: AYESHA, name: "Ayesha Khan" },
      { id: SAQIB, name: "Saqib Nawaz" },
      { id: ZARA, name: "Zara Iqbal" },
    ];
    const heading = dmDisplayName(members, AYESHA);
    for (const member of members.filter((m) => m.id !== AYESHA)) {
      expect(heading).toContain(member.name);
    }
    expect(heading).toBe("Saqib Nawaz, Zara Iqbal");
  });

  it("returns null when the viewer is the only member", () => {
    // null, never "", is the caller's signal to fall back to the stored
    // Channel.name. An empty string renders as a blank heading and reads as a
    // failed load — which is what a half-written row or a tombstoned
    // counterpart would otherwise look like.
    expect(dmDisplayName([{ id: AYESHA, name: "Ayesha Khan" }], AYESHA)).toBeNull();
    expect(dmDisplayName([], AYESHA)).toBeNull();
  });

  it("trims the whitespace a stored name carries", () => {
    expect(
      dmDisplayName(
        [
          { id: AYESHA, name: "Ayesha Khan" },
          { id: SAQIB, name: "  Saqib Nawaz  " },
        ],
        AYESHA
      )
    ).toBe("Saqib Nawaz");
  });

  it("skips a member whose name is blank instead of joining an empty segment", () => {
    // Otherwise the heading reads ", Zara Iqbal" — a leading comma that looks
    // like a rendering bug rather than a missing name.
    const heading = dmDisplayName(
      [
        { id: AYESHA, name: "Ayesha Khan" },
        { id: SAQIB, name: "   " },
        { id: ZARA, name: "Zara Iqbal" },
      ],
      AYESHA
    );
    expect(heading).toBe("Zara Iqbal");
  });

  it("returns null when the only counterpart has a blank name", () => {
    expect(
      dmDisplayName(
        [
          { id: AYESHA, name: "Ayesha Khan" },
          { id: SAQIB, name: "" },
        ],
        AYESHA
      )
    ).toBeNull();
  });
});
