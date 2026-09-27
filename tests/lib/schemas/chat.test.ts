import { describe, expect, it } from "vitest";
import {
  CHANNEL_KINDS,
  CHANNEL_ROLES,
  CREATABLE_CHANNEL_KINDS,
  DeleteMessageSchema,
  MESSAGE_KINDS,
  MarkChannelReadSchema,
  NewChannelSchema,
  OpenDmSchema,
  PostRunwayCardSchema,
  REACTION_EMOJI,
  RUNWAY_CARD_VERSION,
  RunwayPayloadSchema,
  SendMessageSchema,
  ToggleReactionSchema,
} from "@/lib/schemas/chat";

// These schemas used to validate ids with `z.string().cuid()`, on the stated
// ground that "ids are cuids". They are not, and it shipped a real bug: every
// seeded teammate has an id like `demo-ahmed`, which zod's cuid regex rejects
// for containing a hyphen — so opening a DM with anyone in the demo workspace
// failed with "Pick a teammate" before the action ever ran.
const CHANNEL_ID = "cjld2cjxh0000qzrmn831i7rn";
const MESSAGE_ID = "cjld2cyuq0000t3rmniod1foy";

/**
 * Every id shape this system really mints. The tests that iterate it are the
 * ones that would have caught the cuid bug on the day it was written.
 */
const REAL_ID_SHAPES: { id: string; origin: string }[] = [
  { id: "cmugkfd560001v21ss2bd76dw", origin: "Prisma @default(cuid())" },
  { id: "chgen_c7b9eec3728cc9c54801", origin: "chat migration backfill (#general)" },
  { id: "chmem_9f2c1ab77d0e4c135a62", origin: "chat migration backfill (membership)" },
  { id: "demo-ahmed", origin: "prisma/seed.ts — hyphenated, and the bug" },
  { id: "demo-nimbus", origin: "prisma/seed.ts — the demo company" },
];

/** Values that could not be an id under any shape above. */
const NOT_AN_ID = ["", "   ", "x".repeat(65)];

describe("CHANNEL_KINDS (the persisted Channel.kind union)", () => {
  it("covers the three kinds the visibility rules branch on", () => {
    expect(CHANNEL_KINDS).toEqual(["public", "private", "dm"]);
  });
});

describe("CHANNEL_ROLES (the persisted ChannelMember.role union)", () => {
  it("covers owner and member", () => {
    expect(CHANNEL_ROLES).toEqual(["owner", "member"]);
  });
});

describe("MESSAGE_KINDS (the persisted Message.kind union)", () => {
  it("covers plain text and the structured card", () => {
    expect(MESSAGE_KINDS).toEqual(["text", "card"]);
  });
});

describe("REACTION_EMOJI (the fixed reaction allow-list)", () => {
  it("is a closed set, not an open picker", () => {
    expect(REACTION_EMOJI).toEqual(["👍", "🎉", "👀", "🚀", "❤️", "😄", "🙏", "✅"]);
  });

  // A duplicate would make the same reaction addressable twice while
  // @@unique([messageId, userId, emoji]) still treats it as one row — the chip
  // would render twice and toggle once.
  it("holds no duplicates", () => {
    expect(new Set(REACTION_EMOJI).size).toBe(REACTION_EMOJI.length);
  });
});

describe("NewChannelSchema (the create-channel form)", () => {
  const minimal = { name: "launch-plans", kind: "public" as const };

  it("accepts the minimal valid payload", () => {
    const r = NewChannelSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    // An absent topic normalises to undefined (not ""), so SQL stores NULL.
    if (r.success) expect(r.data.topic).toBeUndefined();
  });

  it("trims and rejects an empty name", () => {
    expect(NewChannelSchema.safeParse({ ...minimal, name: "   " }).success).toBe(false);
  });

  it("rejects a name over 60 characters", () => {
    expect(NewChannelSchema.safeParse({ ...minimal, name: "x".repeat(61) }).success).toBe(false);
  });

  it("accepts a name of exactly 60 characters", () => {
    expect(NewChannelSchema.safeParse({ ...minimal, name: "x".repeat(60) }).success).toBe(true);
  });

  it("accepts each creatable kind", () => {
    for (const kind of CREATABLE_CHANNEL_KINDS) {
      expect(NewChannelSchema.safeParse({ ...minimal, kind }).success).toBe(true);
    }
  });

  // DMs are opened by openDmAction, which derives the dmKey from the pair.
  // Letting the form post kind:"dm" would create a "DM" with one participant
  // and no key — a private channel wearing the wrong label.
  it("rejects kind dm — a direct message is opened by openDmAction, not created here", () => {
    expect(NewChannelSchema.safeParse({ ...minimal, kind: "dm" as never }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(NewChannelSchema.safeParse({ ...minimal, kind: "broadcast" as never }).success).toBe(
      false
    );
  });

  it("rejects a topic over 200 characters", () => {
    expect(NewChannelSchema.safeParse({ ...minimal, topic: "x".repeat(201) }).success).toBe(false);
  });

  it("coerces a blank topic to undefined (so SQL stores NULL)", () => {
    const r = NewChannelSchema.safeParse({ ...minimal, topic: "   " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.topic).toBeUndefined();
  });
});

describe("SendMessageSchema (the composer)", () => {
  const minimal = { channelId: CHANNEL_ID, body: "ship it" };

  it("accepts the minimal valid payload", () => {
    const r = SendMessageSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    // No parentId = a new root in the channel timeline.
    if (r.success) expect(r.data.parentId).toBeUndefined();
  });

  it("accepts a threaded reply carrying a parentId", () => {
    const r = SendMessageSchema.safeParse({ ...minimal, parentId: MESSAGE_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.parentId).toBe(MESSAGE_ID);
  });

  it("trims and rejects an empty body", () => {
    expect(SendMessageSchema.safeParse({ ...minimal, body: "   " }).success).toBe(false);
  });

  it("rejects a body over 4,000 characters", () => {
    expect(SendMessageSchema.safeParse({ ...minimal, body: "x".repeat(4001) }).success).toBe(false);
  });

  it("accepts a body of exactly 4,000 characters", () => {
    expect(SendMessageSchema.safeParse({ ...minimal, body: "x".repeat(4000) }).success).toBe(true);
  });

  it("rejects a channelId that could not be an id at all", () => {
    for (const off of NOT_AN_ID) {
      expect(SendMessageSchema.safeParse({ ...minimal, channelId: off }).success).toBe(false);
    }
  });

  // A channel slug is itself a plausible id string, and the schema
  // deliberately does not try to tell them apart. "Is this a real channel you
  // may post in" is the query's question, and it re-verifies against the
  // caller's companyId regardless of what shape the id had.
  it("accepts every id shape the system actually mints", () => {
    for (const { id, origin } of REAL_ID_SHAPES) {
      expect(
        SendMessageSchema.safeParse({ ...minimal, channelId: id }).success,
        `${origin} produced ${id}, which the boundary rejected`
      ).toBe(true);
    }
  });

  it("rejects a missing channelId", () => {
    const { channelId: _omit, ...withoutChannel } = minimal;
    expect(SendMessageSchema.safeParse(withoutChannel).success).toBe(false);
  });

  it("rejects a parentId that could not be an id at all", () => {
    for (const off of NOT_AN_ID) {
      expect(SendMessageSchema.safeParse({ ...minimal, parentId: off }).success).toBe(false);
    }
  });
});

describe("ToggleReactionSchema (the reaction chips)", () => {
  const minimal = { messageId: MESSAGE_ID, emoji: "👍" as const };

  it("accepts the minimal valid payload", () => {
    expect(ToggleReactionSchema.safeParse(minimal).success).toBe(true);
  });

  // Iterated, not counted: the assertion is "every emoji on the list is
  // accepted", which stays true when the list grows.
  it("accepts every emoji on the allow-list", () => {
    for (const emoji of REACTION_EMOJI) {
      expect(ToggleReactionSchema.safeParse({ ...minimal, emoji }).success).toBe(true);
    }
  });

  // The whole reason REACTION_EMOJI is a closed tuple. If this passes, the
  // column has become free text and the rail can be fed anything.
  it("rejects an emoji that is not on the allow-list", () => {
    for (const off of ["🔥", "💩", "", "thumbsup"]) {
      expect(ToggleReactionSchema.safeParse({ ...minimal, emoji: off as never }).success).toBe(
        false
      );
    }
  });

  it("rejects a messageId that could not be an id at all", () => {
    for (const off of NOT_AN_ID) {
      expect(ToggleReactionSchema.safeParse({ ...minimal, messageId: off }).success).toBe(false);
    }
  });
});

describe("MarkChannelReadSchema (the read watermark)", () => {
  it("accepts every id shape the system actually mints", () => {
    for (const { id, origin } of REAL_ID_SHAPES) {
      expect(
        MarkChannelReadSchema.safeParse({ channelId: id }).success,
        `${origin} produced ${id}, which the boundary rejected`
      ).toBe(true);
    }
  });

  it("rejects an empty channelId", () => {
    expect(MarkChannelReadSchema.safeParse({ channelId: "" }).success).toBe(false);
  });
});

describe("DeleteMessageSchema (the tombstone path)", () => {
  it("accepts every id shape the system actually mints", () => {
    for (const { id, origin } of REAL_ID_SHAPES) {
      expect(
        DeleteMessageSchema.safeParse({ messageId: id }).success,
        `${origin} produced ${id}, which the boundary rejected`
      ).toBe(true);
    }
  });

  it("rejects an empty messageId", () => {
    expect(DeleteMessageSchema.safeParse({ messageId: "" }).success).toBe(false);
  });
});

describe("OpenDmSchema (the teammate picker behind a direct message)", () => {
  const TEAMMATE_ID = "cjld2cjxh0000qzrmn831i7rn";

  // THE REGRESSION TEST. Every teammate in the demo workspace has a
  // hyphenated id, and `z.string().cuid()` rejected all of them — so the DM
  // picker answered "Pick a teammate" no matter which teammate you picked.
  it("accepts the hyphenated teammate ids the seeded workspace actually has", () => {
    for (const { id, origin } of REAL_ID_SHAPES) {
      expect(
        OpenDmSchema.safeParse({ userId: id }).success,
        `${origin} produced ${id}, which the boundary rejected`
      ).toBe(true);
    }
  });

  it("accepts a cuid userId", () => {
    const r = OpenDmSchema.safeParse({ userId: TEAMMATE_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.userId).toBe(TEAMMATE_ID);
  });

  // WHY ONE ID AND NOT TWO: the other half of the pair is the SESSION user,
  // and openDmAction derives the pair's identity server-side with
  // dmKeyFor(session.user.id, userId). A schema carrying both ids would let a
  // caller name two OTHER people, open the conversation between them — and
  // then read it, because opening makes you a member. The only id a client is
  // trusted with here is the one it is addressing. Widen this object to two
  // fields and the read boundary on private conversations is gone.
  it("names exactly one person — the other half of the pair is the session", () => {
    const r = OpenDmSchema.safeParse({ userId: TEAMMATE_ID });
    expect(r.success).toBe(true);
    // Iterated over the parsed result rather than asserting a count, so the
    // failure message names the field that appeared.
    if (r.success) expect(Object.keys(r.data)).toEqual(["userId"]);
  });

  it("rejects an empty userId", () => {
    expect(OpenDmSchema.safeParse({ userId: "" }).success).toBe(false);
  });

  // What the boundary can honestly reject is "this could not be an id at
  // all". Whether it names YOUR teammate is a question only the database can
  // answer, and openDmAction re-verifies it against the caller's companyId
  // before writing anything.
  it("rejects a userId that could not be an id at all", () => {
    for (const off of NOT_AN_ID) {
      expect(OpenDmSchema.safeParse({ userId: off }).success).toBe(false);
    }
  });

  it("rejects a missing userId", () => {
    expect(OpenDmSchema.safeParse({}).success).toBe(false);
  });
});

/* ── Runway card ──────────────────────────────────────────────────────── */

describe("RunwayPayloadSchema (the frozen snapshot stored on the message)", () => {
  // The whole payload, in one place, so each case below can knock exactly one
  // field out of a known-good object and the failure names the field.
  const PAYLOAD = {
    v: RUNWAY_CARD_VERSION,
    type: "runway",
    asOf: "2026-09-25T03:40:00.000Z",
    runwayMonths: 11.4,
    cashOnHand: 5_471_390,
    monthlyBurn: 482_700,
    currency: "PKR",
  };

  it("accepts a whole payload", () => {
    const r = RunwayPayloadSchema.safeParse(PAYLOAD);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.cashOnHand).toBe(PAYLOAD.cashOnHand);
  });

  // `v` is a LITERAL, not `z.number()`, and that is the forward-compatibility
  // contract: a reader meeting a version it does not know refuses to render
  // the figures rather than guessing which field is money and which is months.
  // Loosen this to a number and a v2 payload — different field meanings, same
  // field names — parses clean and renders wrong, quietly, in a thread someone
  // is making a funding decision in.
  it("rejects a version literal this build does not know", () => {
    for (const v of [
      RUNWAY_CARD_VERSION + 1,
      RUNWAY_CARD_VERSION - 1,
      String(RUNWAY_CARD_VERSION),
      null,
    ]) {
      expect(RunwayPayloadSchema.safeParse({ ...PAYLOAD, v }).success).toBe(false);
    }
  });

  // Every field is required. A payload missing one is a half-card, and a card
  // that renders "—" where the burn should be reads as "zero burn" to anyone
  // skimming — the wrong answer in the reassuring direction.
  it("rejects a payload missing any one field", () => {
    let checked = 0;
    for (const key of Object.keys(PAYLOAD)) {
      const partial: Record<string, unknown> = { ...PAYLOAD };
      delete partial[key];
      expect(RunwayPayloadSchema.safeParse(partial).success, `missing "${key}" parsed`).toBe(false);
      checked += 1;
    }
    // Iterated over the payload itself, so a new field is covered the day it
    // is added rather than the day somebody remembers to update a count.
    expect(checked).toBe(Object.keys(PAYLOAD).length);
  });

  // `runwayMonths: null` is the JSON spelling of the dashboard's `Infinity` —
  // nothing was spent, so there is no burn to divide the balance by. JSON has
  // no Infinity (`JSON.stringify(Infinity)` already yields null), so refusing
  // null here would make an un-storable card out of the perfectly ordinary
  // workspace that has raised money and not spent it yet.
  it("accepts a null runwayMonths as the wire spelling of no burn", () => {
    const r = RunwayPayloadSchema.safeParse({ ...PAYLOAD, runwayMonths: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.runwayMonths).toBeNull();
  });

  // Null means "no burn recorded". It does not mean "no figure at all" — a
  // nullable balance would let a card exist with nothing in it.
  it("does not extend that nullability to the money fields", () => {
    for (const key of ["cashOnHand", "monthlyBurn"]) {
      expect(RunwayPayloadSchema.safeParse({ ...PAYLOAD, [key]: null }).success).toBe(false);
    }
  });

  // A workspace that has spent more than it raised has a negative balance, and
  // refusing to post that card would hide exactly the number worth talking
  // about.
  it("accepts a negative balance", () => {
    expect(RunwayPayloadSchema.safeParse({ ...PAYLOAD, cashOnHand: -120_000 }).success).toBe(true);
  });
});

describe("PostRunwayCardSchema (naming a channel and nothing else)", () => {
  it("accepts a channelId", () => {
    const r = PostRunwayCardSchema.safeParse({ channelId: CHANNEL_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.channelId).toBe(CHANNEL_ID);
  });

  it("rejects a channelId that could not be an id at all", () => {
    for (const off of NOT_AN_ID) {
      expect(PostRunwayCardSchema.safeParse({ channelId: off }).success).toBe(false);
    }
  });

  it("rejects a missing channelId", () => {
    expect(PostRunwayCardSchema.safeParse({}).success).toBe(false);
  });

  // WHY THE FIGURES ARE NOT IN THE SCHEMA: every number on a Runway card is
  // computed server-side at post time from the CALLER'S OWN company. A schema
  // that accepted a figure would let any client post any figure it liked,
  // stamped with the company's name and the poster's face, into a channel the
  // whole team reads — "we have 14 months of runway" from someone who does not
  // have the balance, and no reader could tell the difference. The same
  // reasoning as OpenDmSchema above: the only thing a client is trusted with
  // is the id it is addressing.
  //
  // The schema is not `.strict()`, so a smuggled figure is STRIPPED rather
  // than rejected — and stripping is the safer failure, because the action
  // builds its payload from the parsed result. The assertion is therefore that
  // no figure SURVIVES the parse, which is the property the action depends on.
  // If this ever fails, someone widened the object and the action is now
  // reading numbers a client supplied.
  it("drops every figure a client tries to supply, so only the channel id survives", () => {
    const smuggled = {
      channelId: CHANNEL_ID,
      cashOnHand: 5_471_390,
      monthlyBurn: 482_700,
      runwayMonths: 11.4,
      currency: "USD",
      asOf: "2020-01-01T00:00:00.000Z",
    };
    const r = PostRunwayCardSchema.safeParse(smuggled);
    expect(r.success).toBe(true);
    if (!r.success) return;

    // Iterated over the parsed result, so the failure names the field that got
    // through instead of asserting a count that a new field would satisfy.
    expect(Object.keys(r.data)).toEqual(["channelId"]);
    for (const key of Object.keys(smuggled)) {
      if (key === "channelId") continue;
      expect(
        (r.data as Record<string, unknown>)[key],
        `"${key}" survived the parse`
      ).toBeUndefined();
    }
  });

  // No `parentId` either. A runway snapshot is an announcement to the room,
  // not a reply buried inside somebody else's thread; threading a card is a
  // product decision, not a quietly optional field.
  it("drops a parentId, so a card cannot be buried in someone else's thread", () => {
    const r = PostRunwayCardSchema.safeParse({ channelId: CHANNEL_ID, parentId: MESSAGE_ID });
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data)).toEqual(["channelId"]);
  });
});
