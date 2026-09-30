/**
 * THE CONFIDENTIALITY PROMISE OF A PRIVATE CHANNEL, TESTED AT THE QUERY LAYER.
 *
 * The product owner reported that a private channel they created "stays
 * visible to everyone". `lib/auth/channel-permissions.ts` already has twelve
 * green cases over `canSeeChannel` and `visibleChannelWhere`, and
 * `tests/lib/queries/search-scoping.test.ts` covers the raw-SQL translation of
 * the same rule — but NOTHING covered the four Prisma read paths in
 * lib/queries/chat.ts that the rail, the URL and the pickers actually go
 * through. A predicate with no test on its call sites is precisely this
 * codebase's most expensive recurring defect (`canManageChannel` shipped with
 * twelve green cases and zero callers), and here the call site is the one that
 * would leak: the rail runs a query, not a per-row predicate.
 *
 * HOW THIS TESTS BEHAVIOUR AND NOT SHAPE. vitest has no database, so the usual
 * move is to assert that the recorded `where` deep-equals some object — which
 * proves the code still says what it said, and proves nothing about who can
 * read what. Instead the recorded `where` is EVALUATED, here in the test, over
 * a fixture channel table with two workspaces and a private channel exactly one
 * person is in. The assertion is then the one the reader cares about: "#layoffs
 * is not in the list Bob's rail asked for".
 *
 * `evaluate` THROWS on any key or operator it does not know. That is the
 * load-bearing detail, lifted from `assertArmShape` in lib/queries/search.ts: a
 * mini-evaluator that silently ignores a filter it has not learned reports a
 * NARROWED query as passing, which is the direction that leaks. A new condition
 * in the query layer fails this file loudly instead.
 *
 * lib/auth/** is deliberately not mocked — `visibleChannelWhere` is the real
 * rule here, for the reason search-scoping.test.ts gives: mocking it would
 * assert that the query calls a stub.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelBySlug, listChannelOptions, listChannelsForUser } from "@/lib/queries/chat";
import type { ScopedSession } from "@/lib/queries/session";

/* ─────────────────────────── the recorder ─────────────────────────────── */

const prisma = vi.hoisted(() => {
  const calls: { delegate: string; method: string; args: unknown[] }[] = [];
  const answers = new Map<string, unknown>();

  function record(delegate: string, method: string, args: unknown[]) {
    calls.push({ delegate, method, args });
    const keyed = answers.get(`${delegate}.${method}`);
    if (keyed !== undefined) return Promise.resolve(keyed);
    return Promise.resolve([]);
  }

  const delegates = new Map<string, unknown>();
  function delegateFor(name: string) {
    const existing = delegates.get(name);
    if (existing) return existing;
    const made = new Proxy(
      {},
      {
        get(_t, method) {
          if (typeof method !== "string") return undefined;
          return (...args: unknown[]) => record(name, method, args);
        },
      }
    );
    delegates.set(name, made);
    return made;
  }

  const db = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        return delegateFor(prop);
      },
    }
  );

  return { calls, answers, db };
});

vi.mock("@/lib/db", () => ({ db: prisma.db }));

const session = vi.hoisted(() => ({
  current: {} as ScopedSession,
}));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: () => Promise.resolve(session.current),
}));

/* ─────────────────────────── the fixture world ─────────────────────────── */

const ALICE = "cme00000000000000000alice";
const BOB = "cme000000000000000000bob";
const RIVAL = "crival00000000000000000r";

const NIMBUS = "c_nimbus";
const RIVAL_CO = "c_rival";

type Row = {
  id: string;
  companyId: string;
  slug: string;
  kind: string;
  archivedAt: Date | null;
  memberIds: string[];
};

/**
 * Five rows chosen so that every arm of the rule has something to be wrong
 * about: a public channel Bob is in, a PRIVATE channel he is not, someone
 * else's DM, an archived channel, and a public channel in another workspace.
 */
const WORLD: Row[] = [
  {
    id: "ch_general",
    companyId: NIMBUS,
    slug: "general",
    kind: "public",
    archivedAt: null,
    memberIds: [ALICE, BOB],
  },
  {
    id: "ch_layoffs",
    companyId: NIMBUS,
    slug: "layoffs",
    kind: "private",
    archivedAt: null,
    memberIds: [ALICE],
  },
  {
    id: "ch_dm",
    companyId: NIMBUS,
    slug: "dm-alice-carol",
    kind: "dm",
    archivedAt: null,
    memberIds: [ALICE, "cme0000000000000000carol"],
  },
  {
    id: "ch_retro",
    companyId: NIMBUS,
    slug: "retro-2025",
    kind: "public",
    archivedAt: new Date("2026-01-01T00:00:00.000Z"),
    memberIds: [ALICE, BOB],
  },
  {
    id: "ch_rival",
    companyId: RIVAL_CO,
    slug: "general",
    kind: "public",
    archivedAt: null,
    memberIds: [RIVAL],
  },
];

function signedInAs(userId: string, companyId: string): void {
  session.current = {
    userId,
    userName: "Tester",
    email: "tester@nimbus.app",
    companyId,
    role: "admin",
  } as ScopedSession;
}

/* ───────────────────────── the where evaluator ─────────────────────────── */

/**
 * Apply a recorded Prisma `where` to one fixture row.
 *
 * Every branch is explicit and the fallthrough THROWS. An evaluator that
 * shrugged at an unknown key would report a query it does not understand as
 * "lets this row through", i.e. it would grade the leaking direction as a pass.
 */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    switch (key) {
      case "companyId":
        if (row.companyId !== value) return false;
        break;
      case "id":
        if (row.id !== value) return false;
        break;
      case "slug":
        if (row.slug !== value) return false;
        break;
      case "archivedAt":
        if (value !== null) {
          throw new Error(`Unsupported archivedAt filter: ${JSON.stringify(value)}`);
        }
        if (row.archivedAt !== null) return false;
        break;
      case "kind": {
        if (typeof value === "string") {
          if (row.kind !== value) return false;
          break;
        }
        const op = value as { not?: unknown };
        if (typeof op?.not === "string") {
          if (row.kind === op.not) return false;
          break;
        }
        throw new Error(`Unsupported kind filter: ${JSON.stringify(value)}`);
      }
      case "members": {
        const some = (value as { some?: { userId?: unknown } }).some;
        if (!some || typeof some.userId !== "string" || Object.keys(some).length !== 1) {
          throw new Error(`Unsupported members filter: ${JSON.stringify(value)}`);
        }
        if (!row.memberIds.includes(some.userId)) return false;
        break;
      }
      case "OR": {
        const arms = value as Record<string, unknown>[];
        if (!Array.isArray(arms) || arms.length === 0) {
          throw new Error(`Unsupported OR: ${JSON.stringify(value)}`);
        }
        if (!arms.some((arm) => matches(row, arm))) return false;
        break;
      }
      default:
        throw new Error(
          `tests/lib/queries/channel-visibility.test.ts cannot evaluate the ` +
            `channel filter "${key}". lib/queries/chat.ts grew a condition this ` +
            `guard does not understand; teach it rather than deleting this throw, ` +
            `because an ignored filter reads as "this row is visible".`
        );
    }
  }
  return true;
}

/** The slugs a recorded `channel` query would actually have returned. */
function visibleSlugs(where: Record<string, unknown>): string[] {
  return WORLD.filter((row) => matches(row, where)).map((row) => row.slug);
}

function lastChannelWhere(method: "findMany" | "findFirst"): Record<string, unknown> {
  const hit = [...prisma.calls]
    .reverse()
    .find((c) => c.delegate === "channel" && c.method === method);
  if (!hit) throw new Error(`No channel.${method} was recorded — the query never ran.`);
  return (hit.args[0] as { where: Record<string, unknown> }).where;
}

beforeEach(() => {
  prisma.calls.length = 0;
  prisma.answers.clear();
  signedInAs(BOB, NIMBUS);
});

/* ═══════════════════════════ the guard's guard ════════════════════════════ */

describe("the evaluator itself", () => {
  it("admits the private channel for the one person who IS in it, and nobody else", () => {
    // Without this pair, an evaluator that returned false for everything would
    // make every leak assertion below pass while proving nothing.
    const membersOnly = (userId: string) => ({
      companyId: NIMBUS,
      kind: "private",
      OR: [{ members: { some: { userId } } }],
    });

    expect(visibleSlugs(membersOnly(ALICE))).toEqual(["layoffs"]);
    expect(visibleSlugs(membersOnly(BOB))).toEqual([]);
  });

  it("refuses a filter it has not been taught", () => {
    expect(() => visibleSlugs({ companyId: NIMBUS, topic: "anything" })).toThrow(
      /cannot evaluate the channel filter "topic"/
    );
  });

  it("has a world big enough for the rule to be wrong in", () => {
    expect(WORLD.length).toBeGreaterThanOrEqual(5);
    expect(new Set(WORLD.map((r) => r.kind))).toEqual(new Set(["public", "private", "dm"]));
  });
});

/* ══════════════════ the rail — the surface that was reported ═══════════════ */

describe("listChannelsForUser — the channel rail", () => {
  it("does not offer a private channel to someone who is not in it", async () => {
    await listChannelsForUser();

    expect(visibleSlugs(lastChannelWhere("findMany"))).not.toContain("layoffs");
  });

  it("does not offer somebody else's direct message", async () => {
    await listChannelsForUser();

    expect(visibleSlugs(lastChannelWhere("findMany"))).not.toContain("dm-alice-carol");
  });

  it("still offers the public channel, and the archived one is dropped", async () => {
    await listChannelsForUser();

    expect(visibleSlugs(lastChannelWhere("findMany"))).toEqual(["general"]);
  });

  it("DOES offer the private channel to its member", async () => {
    signedInAs(ALICE, NIMBUS);

    await listChannelsForUser();

    expect(visibleSlugs(lastChannelWhere("findMany")).sort()).toEqual([
      "dm-alice-carol",
      "general",
      "layoffs",
    ]);
  });

  it("never reaches another workspace's public channel", async () => {
    await listChannelsForUser();

    // Same slug, different company: the only thing that can exclude it is the
    // companyId the fragment carries as a required argument.
    const slugs = WORLD.filter((r) => matches(r, lastChannelWhere("findMany"))).map(
      (r) => `${r.companyId}/${r.slug}`
    );
    expect(slugs).not.toContain(`${RIVAL_CO}/general`);
  });
});

/* ════════════════ the URL — the other way into a channel ═══════════════════ */

describe("getChannelBySlug — typing the URL by hand", () => {
  it("returns null for a private channel the caller is not a member of", async () => {
    // The row EXISTS and the fake hands it over; the only thing that can
    // withhold it is the membership probe. Returning null (rather than a 403)
    // is what keeps the channel's existence private — the page calls notFound().
    prisma.answers.set("channel.findFirst", {
      id: "ch_layoffs",
      slug: "layoffs",
      name: "layoffs",
      kind: "private",
      topic: null,
      archivedAt: null,
      lastMessageAt: null,
    });
    prisma.answers.set("channelMember.findUnique", null);

    await expect(getChannelBySlug("layoffs")).resolves.toBeNull();
  });

  it("scopes the lookup to the caller's own workspace", async () => {
    prisma.answers.set("channel.findFirst", null);

    await getChannelBySlug("general");

    expect(lastChannelWhere("findFirst")).toMatchObject({ companyId: NIMBUS, slug: "general" });
  });

  it("hands the channel over once the caller holds a membership row", async () => {
    prisma.answers.set("channel.findFirst", {
      id: "ch_layoffs",
      slug: "layoffs",
      name: "layoffs",
      kind: "private",
      topic: null,
      archivedAt: null,
      lastMessageAt: null,
    });
    prisma.answers.set("channelMember.findUnique", { id: "cm_1" });
    prisma.answers.set("channelMember.findMany", [
      {
        userId: BOB,
        role: "member",
        lastReadAt: new Date("2026-09-01T00:00:00.000Z"),
        user: { id: BOB, name: "Bob", handle: "bob", deletedAt: null },
      },
    ]);
    prisma.answers.set("message.count", 0);

    const channel = await getChannelBySlug("layoffs");

    expect(channel?.slug).toBe("layoffs");
    expect(channel?.isMember).toBe(true);
  });
});

/* ═════════════ the pickers — "share this into…" and the palette ════════════ */

describe("listChannelOptions — every channel picker in the app", () => {
  it("cannot offer a private channel the caller is not in", async () => {
    await listChannelOptions();

    expect(visibleSlugs(lastChannelWhere("findMany"))).not.toContain("layoffs");
  });

  it("offers it once they are in it, and never a DM", async () => {
    signedInAs(ALICE, NIMBUS);

    await listChannelOptions();

    expect(visibleSlugs(lastChannelWhere("findMany")).sort()).toEqual(["general", "layoffs"]);
  });
});
