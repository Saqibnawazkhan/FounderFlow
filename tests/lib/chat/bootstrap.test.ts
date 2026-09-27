import { describe, it, expect } from "vitest";
import {
  GENERAL_CHANNEL_SLUG,
  ensureGeneralChannel,
  joinDefaultChannels,
} from "@/lib/chat/bootstrap";

/**
 * Chat bootstrap — the runtime creation of #general and the enrolment of new
 * people into it.
 *
 * The bug these cover was invisible for exactly one reason: the ONLY thing
 * that had ever created a #general was a migration backfill, which runs once
 * and says nothing about the future. So the interesting assertions here are
 * not "does it insert a row" but "does it insert a row the SECOND time" —
 * idempotency under a re-run, under a pre-existing backfilled channel, and
 * under a lost race with the unique index. A test that only ever exercises the
 * empty-workspace path would pass against a version that happily creates
 * `general-2`, which is the same shape of vacuous test this audit just found
 * elsewhere.
 *
 * Everything runs against a hand-rolled fake of the two Prisma models the
 * module is typed against (`Pick<typeof db, "channel" | "channelMember">`), so
 * there is no database and no `vi.mock` of lib/db: the structural tx type is
 * what makes that possible, and exercising it here is itself a check that the
 * signature stayed narrow.
 */

type ChannelRow = {
  id: string;
  companyId: string;
  slug: string;
  name: string;
  kind: string;
  topic: string | null;
  dmKey: string | null;
  createdBy: string;
  archivedAt: Date | null;
};

type MemberRow = {
  channelId: string;
  userId: string;
  role: string;
  /** Present only when a caller passed one — absent means "the column default". */
  lastReadAt?: Date;
};

/** Prisma's unique-constraint rejection, in the only shape the module inspects. */
function uniqueViolation(target: string) {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: "P2002" });
}

/**
 * A stand-in for the transaction client, holding rows in memory.
 *
 * `onCreateChannel` is the seam the race test needs: it fires before the row
 * would be written, so a test can have the "other" caller commit first and
 * then reject this insert exactly the way the index would.
 */
function fakeTx(
  seed: {
    channels?: ChannelRow[];
    members?: MemberRow[];
    onCreateChannel?: (store: ChannelRow[]) => void;
  } = {}
) {
  const channels: ChannelRow[] = [...(seed.channels ?? [])];
  const members: MemberRow[] = [...(seed.members ?? [])];
  const reads: string[] = [];
  /**
   * Every write ATTEMPT, logged before it is allowed to fail. Counting the
   * surviving rows alone cannot tell "took the cheap path" apart from "tried
   * to insert, was rejected by the index, recovered" — and that distinction is
   * the difference between an idempotent function and one that leans on an
   * exception every single signup.
   */
  const writeAttempts: string[] = [];
  let nextId = 1;

  const matches = (row: ChannelRow, where: Record<string, unknown>): boolean => {
    if (where.companyId !== undefined && row.companyId !== where.companyId) return false;
    if (typeof where.slug === "string" && row.slug !== where.slug) return false;
    const slugIn = (where.slug as { in?: string[] } | undefined)?.in;
    if (slugIn && !slugIn.includes(row.slug)) return false;
    if (where.kind !== undefined && row.kind !== where.kind) return false;
    if (where.archivedAt === null && row.archivedAt !== null) return false;
    return true;
  };

  const client = {
    channel: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        reads.push("channel.findFirst");
        return channels.find((c) => matches(c, args.where)) ?? null;
      },
      findMany: async (args: { where: Record<string, unknown> }) => {
        reads.push("channel.findMany");
        return channels.filter((c) => matches(c, args.where));
      },
      create: async (args: { data: Omit<ChannelRow, "id" | "archivedAt"> }) => {
        writeAttempts.push("channel.create");
        seed.onCreateChannel?.(channels);
        const clash = channels.find(
          (c) => c.companyId === args.data.companyId && c.slug === args.data.slug
        );
        if (clash) throw uniqueViolation("Channel_companyId_slug_key");
        const row: ChannelRow = {
          ...args.data,
          topic: args.data.topic ?? null,
          dmKey: args.data.dmKey ?? null,
          id: `ch${nextId++}`,
          archivedAt: null,
        };
        channels.push(row);
        return row;
      },
    },
    channelMember: {
      create: async (args: { data: MemberRow }) => {
        writeAttempts.push("channelMember.create");
        const clash = members.find(
          (m) => m.channelId === args.data.channelId && m.userId === args.data.userId
        );
        if (clash) throw uniqueViolation("ChannelMember_channelId_userId_key");
        members.push(args.data);
        return args.data;
      },
      createMany: async (args: { data: MemberRow[]; skipDuplicates?: boolean }) => {
        writeAttempts.push("channelMember.createMany");
        let count = 0;
        for (const row of args.data) {
          const clash = members.find(
            (m) => m.channelId === row.channelId && m.userId === row.userId
          );
          if (clash) {
            if (args.skipDuplicates) continue;
            throw uniqueViolation("ChannelMember_channelId_userId_key");
          }
          members.push(row);
          count++;
        }
        return { count };
      },
    },
  };

  return { client: client as never, channels, members, reads, writeAttempts };
}

function generalIn(companyId: string, overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: "existing-general",
    companyId,
    slug: GENERAL_CHANNEL_SLUG,
    name: "general",
    kind: "public",
    topic: null,
    dmKey: null,
    createdBy: "founder",
    archivedAt: null,
    ...overrides,
  };
}

describe("ensureGeneralChannel (the channel a workspace is born with)", () => {
  it("gives a brand-new workspace a general channel with its founder in it", async () => {
    const tx = fakeTx();

    const id = await ensureGeneralChannel(tx.client, "co1", "founder");

    expect(tx.channels).toHaveLength(1);
    const created = tx.channels[0];
    expect(created.id).toBe(id);
    expect(created.companyId).toBe("co1");
    expect(created.slug).toBe(GENERAL_CHANNEL_SLUG);
    expect(created.createdBy).toBe("founder");
    // Public, so the whole workspace can see it without being enrolled, and
    // dmKey NULL so it sits outside the anti-fork unique index.
    expect(created.kind).toBe("public");
    expect(created.dmKey).toBeNull();

    // The founder's membership lands with the channel, not after it: there is
    // no runtime path that would ever give it to them later.
    expect(tx.members).toEqual([{ channelId: id, userId: "founder", role: "owner" }]);
  });

  it("returns the existing channel instead of creating a second one", async () => {
    // The state every pre-2026-09-24 workspace is in: the add_chat migration
    // already backfilled its #general.
    const tx = fakeTx({ channels: [generalIn("co1")] });

    const id = await ensureGeneralChannel(tx.client, "co1", "someone-else");

    expect(id).toBe("existing-general");
    // Nothing written at all — not a channel, and not a membership either.
    // Enrolling a person is joinDefaultChannels' job.
    expect(tx.channels).toHaveLength(1);
    expect(tx.members).toHaveLength(0);
    // And nothing was even ATTEMPTED. Row counts alone would look identical
    // if the lookup were deleted and the function relied on the index
    // rejecting it, which would turn every re-entry into a poisoned
    // transaction for any Postgres caller.
    expect(tx.writeAttempts).toEqual([]);
  });

  it("refuses to fork a general channel that has been archived out of the way", async () => {
    // The unique index is on (companyId, slug) and does not care about
    // archivedAt, so a lookup that filtered it out would insert "general" a
    // second time and hit P2002 forever.
    const tx = fakeTx({ channels: [generalIn("co1", { archivedAt: new Date() })] });

    const id = await ensureGeneralChannel(tx.client, "co1", "founder");

    expect(id).toBe("existing-general");
    expect(tx.channels).toHaveLength(1);
    expect(tx.writeAttempts).toEqual([]);
  });

  it("keeps each workspace's general separate from every other workspace's", async () => {
    const tx = fakeTx({ channels: [generalIn("other-co")] });

    const id = await ensureGeneralChannel(tx.client, "co1", "founder");

    expect(id).not.toBe("existing-general");
    for (const row of tx.channels) {
      expect(row.slug).toBe(GENERAL_CHANNEL_SLUG);
    }
    // Both companies now hold a channel on the same slug, which is the point:
    // slugs are per-workspace.
    const companies = tx.channels.map((c) => c.companyId);
    expect(companies).toContain("co1");
    expect(companies).toContain("other-co");
  });

  it("survives two signups racing on the same slug", async () => {
    // The loser's lookup came back empty, then the winner committed, then the
    // loser's insert met the index. Modelled exactly that way round.
    const tx = fakeTx({
      onCreateChannel: (store) => {
        if (store.length === 0) store.push(generalIn("co1", { id: "winner" }));
      },
    });

    const id = await ensureGeneralChannel(tx.client, "co1", "loser");

    // The collision resolves to the winner's channel rather than an error:
    // both callers end up pointing at one room.
    expect(id).toBe("winner");
    expect(tx.channels).toHaveLength(1);
    // And it got there by re-reading, not by guessing — two lookups, the
    // cheap one and the post-race one.
    expect(tx.reads.filter((r) => r === "channel.findFirst")).toHaveLength(2);
  });

  it("reports a unique violation it cannot explain rather than inventing a channel", async () => {
    // P2002 with no row behind it afterwards is not the race. openDmAction
    // makes the same distinction; swallowing it here would return an id that
    // does not exist.
    const tx = fakeTx({
      onCreateChannel: () => {
        throw uniqueViolation("Channel_companyId_slug_key");
      },
    });

    await expect(ensureGeneralChannel(tx.client, "co1", "founder")).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("lets an error that is not a collision through untouched", async () => {
    const tx = fakeTx({
      onCreateChannel: () => {
        throw Object.assign(new Error("connection lost"), { code: "P1001" });
      },
    });

    await expect(ensureGeneralChannel(tx.client, "co1", "founder")).rejects.toMatchObject({
      code: "P1001",
    });
  });
});

describe("joinDefaultChannels (what a new teammate is enrolled in)", () => {
  it("joins a new teammate without fabricating unread history", async () => {
    const tx = fakeTx({ channels: [generalIn("co1")] });

    const joined = await joinDefaultChannels(tx.client, "co1", "newbie");

    expect(joined).toBe(1);
    expect(tx.members).toHaveLength(1);
    const row = tx.members[0];
    expect(row).toMatchObject({ channelId: "existing-general", userId: "newbie" });
    // "member", not "owner": a day-one hire does not get rename/archive
    // rights over the company-wide channel.
    expect(row.role).toBe("member");
    // No lastReadAt is written, deliberately. The column defaults to now(),
    // which is what stops the join greeting them with a badge for months of
    // conversation they were never part of. Passing a value here — even
    // `new Date()` — would be the module deciding something the schema
    // already decided, and a backdated one would be the bug itself.
    expect(row.lastReadAt).toBeUndefined();
  });

  it("stays quiet when the newcomer is already in the channel", async () => {
    const tx = fakeTx({
      channels: [generalIn("co1")],
      members: [{ channelId: "existing-general", userId: "newbie", role: "member" }],
    });

    const joined = await joinDefaultChannels(tx.client, "co1", "newbie");

    // 0 is an answer, not a failure — a double-submitted invite must not
    // throw a unique violation into the caller's transaction.
    expect(joined).toBe(0);
    expect(tx.members).toHaveLength(1);
  });

  it("creates nothing when the workspace has no general channel to join", async () => {
    const tx = fakeTx();

    const joined = await joinDefaultChannels(tx.client, "co1", "newbie");

    expect(joined).toBe(0);
    // Joining is not founding: it must not stamp the newest person in the
    // building as createdBy/owner of the company-wide channel.
    expect(tx.channels).toHaveLength(0);
    expect(tx.members).toHaveLength(0);
    // Not even an empty createMany, which Prisma would happily accept and
    // which would still cost the invite transaction a round trip.
    expect(tx.writeAttempts).toEqual([]);
  });

  it("skips an archived channel, which nobody could post in anyway", async () => {
    const tx = fakeTx({ channels: [generalIn("co1", { archivedAt: new Date() })] });

    expect(await joinDefaultChannels(tx.client, "co1", "newbie")).toBe(0);
    expect(tx.members).toHaveLength(0);
  });

  it("never auto-joins a private channel, whatever its slug is", async () => {
    // Membership IS the access decision for private channels
    // (canSeeChannel), so enrolling someone would be a permission grant
    // dressed up as onboarding.
    const tx = fakeTx({ channels: [generalIn("co1", { kind: "private" })] });

    expect(await joinDefaultChannels(tx.client, "co1", "newbie")).toBe(0);
    expect(tx.members).toHaveLength(0);
  });

  it("does not reach into another workspace's channels", async () => {
    const tx = fakeTx({ channels: [generalIn("other-co")] });

    expect(await joinDefaultChannels(tx.client, "co1", "newbie")).toBe(0);
    expect(tx.members).toHaveLength(0);
  });

  it("puts a founder and their first hire in the same room", async () => {
    // The two halves composed, which is the whole user-visible outcome: the
    // pair can actually talk to each other.
    const tx = fakeTx();
    const channelId = await ensureGeneralChannel(tx.client, "co1", "founder");
    await joinDefaultChannels(tx.client, "co1", "hire");

    expect(tx.channels).toHaveLength(1);
    for (const member of tx.members) {
      expect(member.channelId).toBe(channelId);
    }
    expect(tx.members.map((m) => m.userId).sort()).toEqual(["founder", "hire"]);
  });
});
