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
import {
  composerPlaceholder,
  conversationTitle,
  dmDisplayName,
  dmSlugFor,
  isDmKind,
  DM_UNNAMED_COUNTERPART,
} from "@/lib/chat/dm";
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
    // null, never "", is the caller's signal that there is nobody to name — the
    // caller then renders DM_UNNAMED_COUNTERPART (see the describe at the foot
    // of this file for why NOT the stored Channel.name). An empty string would
    // render as a blank heading and read as a failed load, which is what a
    // half-written row would otherwise look like.
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

/* ───────────────────────────────────────────────────────────────────────────
 * chat-008: A DM IS A PERSON, NOT A ROOM.
 *
 * `#Ayesha Khan` is not a cosmetic slip. Three surfaces addressed a two-person
 * conversation as a channel — the browser tab (`generateMetadata` titled every
 * kind `#${name}`), the composer's placeholder and its sr-only label
 * (`Message #${channelName}`, unconditional), and the channel header (an icon
 * picked with `isPrivate ? Lock : Hash`, so `kind: "dm"` fell through to Hash).
 * A reader who sees a hash in front of a colleague's name has been told the
 * workspace can read it.
 *
 * The three fixes therefore share ONE pure decision rather than each spelling
 * `kind === "dm" ? name : "#" + name` locally, which is how two of them end up
 * disagreeing the day a fourth surface appears.
 * ─────────────────────────────────────────────────────────────────────────── */

describe("isDmKind (one spelling of the kind check, for every surface)", () => {
  it("recognises a direct message whatever case the column holds", () => {
    // `Channel.kind` is a plain String column, so the casing is whatever the
    // writer stored. Reading "DM" as a room files a private two-person thread
    // under the workspace-wide rooms.
    for (const kind of ["dm", "DM", "Dm"]) expect(isDmKind(kind)).toBe(true);
  });

  it("does not mistake a room for a direct message", () => {
    for (const kind of ["public", "private", "PRIVATE", "", "dmz"]) {
      expect(isDmKind(kind)).toBe(false);
    }
  });
});

describe("conversationTitle (how a conversation is addressed in prose)", () => {
  it("hashes a public room", () => {
    expect(conversationTitle("public", "general")).toBe("#general");
  });

  it("never hashes a direct message", () => {
    // WHAT THE USER SAW: a browser tab reading "#Ahmed Khan · FounderFlow".
    expect(conversationTitle("dm", "Ahmed Khan")).toBe("Ahmed Khan");
    expect(conversationTitle("DM", "Ahmed Khan")).toBe("Ahmed Khan");
  });
});

/* ── A PRIVATE CHANNEL IS NOT A HASH ROOM ─────────────────────────────
 *
 * The assertion `conversationTitle("private", "hiring") === "#hiring"` used to
 * live in "hashes a room" above, and it encoded the bug rather than the
 * contract — this repo's most recurrent defect class.
 *
 * Every ICON surface in chat already disagreed with it. ChannelRail and
 * ChannelHeader draw a Lock for a private channel and a Hash only for a public
 * one, and ChatClient's own "Add people to …" dialog title drops the hash for
 * a private channel. Only the prose surfaces that route through this function
 * — the browser tab, the composer placeholder and the composer's sr-only label
 * — still claimed "#pvt-hiring". In this product a hash means "a room other
 * people can be in", which is the opposite of what a private channel promises,
 * so the tab and the send box were contradicting the Lock next to them in the
 * same viewport.
 *
 * The rule the fix installs: a hash appears in prose exactly where a Hash icon
 * appears beside the name.
 * ───────────────────────────────────────────────────────────────── */
describe("conversationTitle — a private channel is not a hash room", () => {
  it("does not hash a private channel", () => {
    expect(conversationTitle("private", "pvt-hiring")).toBe("pvt-hiring");
  });

  it("is as casing-defensive about private as isDmKind is about dm", () => {
    // `Channel.kind` is a plain String column, so the casing is whatever the
    // writer stored — and `isPrivateKind` normalises it. That predicate used to
    // be a private copy inside channel-rail.tsx, which the same change that added
    // this case deleted; the one spelling now lives in lib/chat/dm.ts and every
    // surface calls it. A privacy claim that depends on how a row happened to be
    // spelled is not a claim at all.
    for (const kind of ["private", "PRIVATE", "Private"]) {
      expect(conversationTitle(kind, "raise")).toBe("raise");
    }
  });

  it("withholds the hash from a kind it does not recognise", () => {
    // Fail-closed on the PRIVACY claim, not on the render. A hash asserts
    // "other people can be in here"; a kind this module has never heard of is
    // not grounds to assert that on the app's behalf.
    expect(conversationTitle("announcement", "launch")).toBe("launch");
  });

  it("still hashes a public room whatever the casing", () => {
    for (const kind of ["public", "PUBLIC", "Public"]) {
      expect(conversationTitle(kind, "general")).toBe("#general");
    }
  });
});

describe("composerPlaceholder (what the send box invites you to do)", () => {
  it("names a public room with its hash", () => {
    expect(composerPlaceholder("public", "finance")).toBe("Message #finance");
  });

  it("names a person without one", () => {
    expect(composerPlaceholder("dm", "Ahmed Khan")).toBe("Message Ahmed Khan");
  });

  it("names a private channel without one", () => {
    // The composer uses this string TWICE — placeholder and sr-only label — so
    // this is also the wording a screen-reader user hears about the privacy of
    // the room they are typing into.
    expect(composerPlaceholder("private", "pvt-hiring")).toBe("Message pvt-hiring");
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * A DM WITH A DEACTIVATED TEAMMATE MUST DEGRADE HONESTLY.
 *
 * Tier 3 tombstones users (`User.deletedAt`) rather than deleting them, and
 * nothing clears their `ChannelMember` rows — so the counterpart of a DM with
 * a deactivated colleague still resolves, and the conversation silently reads
 * exactly like a live one. The reader types into a room nobody will ever open
 * again and is told nothing.
 *
 * The annotation lives in this one pure function on purpose: the rail, the
 * channel header, the browser tab and the composer placeholder all render
 * `ChannelListItem.name` / `ChannelDetail.name`, so annotating the NAME reaches
 * every one of them at once. A separate `deactivated` boolean on the DTO would
 * need four independent renders, which is four chances for one to ship
 * unreached — the defect this codebase has produced four times this week.
 * ─────────────────────────────────────────────────────────────────────────── */
describe("dmDisplayName (a counterpart who has left the workspace)", () => {
  it("says so when the only counterpart is deactivated", () => {
    expect(
      dmDisplayName(
        [
          { id: AYESHA, name: "Ayesha Khan" },
          { id: SAQIB, name: "Saqib Nawaz", deletedAt: new Date("2026-09-01T00:00:00Z") },
        ],
        AYESHA
      )
    ).toBe("Saqib Nawaz (deactivated)");
  });

  it("still names them, rather than blanking the conversation", () => {
    // A blank heading reads as a failed load, and the history of a DM with a
    // departed colleague stays readable by design — so the name is kept and
    // qualified, never dropped.
    const heading = dmDisplayName(
      [
        { id: AYESHA, name: "Ayesha Khan" },
        { id: SAQIB, name: "Saqib Nawaz", deletedAt: new Date() },
      ],
      AYESHA
    );
    expect(heading).toContain("Saqib Nawaz");
  });

  it("annotates only the members who actually left", () => {
    const heading = dmDisplayName(
      [
        { id: AYESHA, name: "Ayesha Khan" },
        { id: SAQIB, name: "Saqib Nawaz", deletedAt: new Date() },
        { id: ZARA, name: "Zara Iqbal", deletedAt: null },
      ],
      AYESHA
    );
    expect(heading).toBe("Saqib Nawaz (deactivated), Zara Iqbal");
  });

  it("leaves a live counterpart unqualified whether deletedAt is null or absent", () => {
    // The field is optional so every existing caller keeps compiling; absent
    // and null must mean the same thing, or the annotation appears at random
    // depending on which query populated the row.
    expect(
      dmDisplayName(
        [
          { id: AYESHA, name: "Ayesha Khan" },
          { id: SAQIB, name: "Saqib Nawaz", deletedAt: null },
        ],
        AYESHA
      )
    ).toBe("Saqib Nawaz");
    expect(
      dmDisplayName(
        [
          { id: AYESHA, name: "Ayesha Khan" },
          { id: SAQIB, name: "Saqib Nawaz" },
        ],
        AYESHA
      )
    ).toBe("Saqib Nawaz");
  });
});

describe("DM_UNNAMED_COUNTERPART (the fallback when there is nobody to name)", () => {
  it("is neutral text, never the viewer's own name", () => {
    // WHY THE STORED Channel.name IS NOT THE FALLBACK: `openDmAction` writes
    // it as "Saqib Nawaz & Ahmed Khan", which contains the VIEWER. Falling
    // back to it in the one case the viewer-relative rename could not resolve
    // re-introduces the exact bug `dmDisplayName` exists to prevent — Saqib
    // opening a conversation with his own name in the heading.
    expect(DM_UNNAMED_COUNTERPART.length).toBeGreaterThan(0);
    expect(DM_UNNAMED_COUNTERPART).not.toContain("&");
  });
});
