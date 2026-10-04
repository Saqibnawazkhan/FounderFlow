/**
 * The residual half of chat-010: a notification read days later.
 *
 * WHAT WAS STILL BROKEN. `?message=<id>` was honoured end to end for a message
 * in the page the reader already had, and a thread reply opened its panel. But
 * `getMessagesPage` only ever walks BACKWARDS from the live edge, so a root
 * older than the newest 50 — a mention in a busy channel, opened on Monday from
 * Friday's email — was not on the page at all, and the surface fell back to a
 * one-line "that message is further back, load earlier messages" toast. The
 * reader was told where to look instead of being shown the message.
 *
 * WHAT THIS PINS. `getMessagesPageAnchoredAt` returns the WINDOW CONTAINING the
 * anchor: bounded context either side of it, ascending like every other page,
 * with `nextCursor` continuing further back and `hasNewer` saying whether the
 * live edge is outside the window. Two cursor reads of exactly the shape
 * `getMessagesPage` already uses — no unbounded `take`, and no client-side
 * paging loop (one was written, it hung tests/components/chat-client.test.tsx,
 * and it was removed on purpose; see lib/chat/anchor.ts).
 *
 * THE MOCK EMULATES PRISMA CURSOR PAGINATION rather than returning canned rows,
 * because the whole correctness of this query IS its `cursor` / `skip` / `take`
 * / `orderBy` arguments. Canned rows would pass whatever those said.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => {
  const calls: Array<{ path: string; args: Record<string, unknown> }> = [];
  const results = new Map<string, unknown>();

  const MODELS = ["channelMember", "message", "channel", "user"];
  const OPS = ["findMany", "count", "groupBy", "findFirst", "findUnique"];

  const db: Record<string, unknown> = {};
  for (const model of MODELS) {
    const delegate: Record<string, (args?: Record<string, unknown>) => Promise<unknown>> = {};
    for (const op of OPS) {
      const path = `${model}.${op}`;
      delegate[op] = async (args?: Record<string, unknown>) => {
        calls.push({ path, args: args ?? {} });
        const canned = results.get(path);
        if (typeof canned === "function") {
          return (canned as (a: Record<string, unknown>) => unknown)(args ?? {});
        }
        return canned ?? [];
      };
    }
    db[model] = delegate;
  }

  const session = {
    value: { user: { id: "me", companyId: "co-1", role: "member" } } as unknown,
  };
  return { db, calls, results, session };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: async () => {
    const s = H.session.value as { user: { id: string; companyId: string; role: string } } | null;
    if (!s) throw new Error("redirect(/login)");
    return {
      userId: s.user.id,
      userName: "Me",
      email: "me@example.com",
      companyId: s.user.companyId,
      role: s.user.role,
    };
  },
}));

import { getMessagesPageAnchoredAt } from "@/lib/queries/chat";

/* ───────────────────────────── the fake channel ──────────────────────────── */

type Root = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  authorAvatar: null;
  kind: string;
  body: string;
  payload: null;
  parentId: string | null;
  replyCount: number;
  mentions: string;
  createdAt: Date;
  editedAt: null;
  deletedAt: null;
  reactions: never[];
};

const BASE = new Date("2026-09-01T09:00:00.000Z").getTime();

/** `count` roots, OLDEST first, one minute apart: r1 … r<count>. */
function roots(count: number): Root[] {
  const out: Root[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({
      id: `r${i}`,
      channelId: "ch_1",
      authorId: "u_other",
      authorName: "Ayesha Raza",
      authorAvatar: null,
      kind: "text",
      body: `message ${i}`,
      payload: null,
      parentId: null,
      replyCount: 0,
      mentions: "[]",
      createdAt: new Date(BASE + i * 60_000),
      editedAt: null,
      deletedAt: null,
      reactions: [],
    });
  }
  return out;
}

/**
 * Prisma's cursor pagination, in nine lines: order the set, find the cursor row,
 * drop `skip` rows from it inclusive, take `take`.
 */
function servePage(all: Root[]) {
  return (args: Record<string, unknown>) => {
    const orderBy = args.orderBy as Array<Record<string, string>>;
    const desc = orderBy[0].createdAt === "desc";
    let list = desc ? [...all].reverse() : [...all];
    const cursor = args.cursor as { id: string } | undefined;
    if (cursor) {
      const at = list.findIndex((r) => r.id === cursor.id);
      if (at === -1) throw new Error("Prisma: cursor row not found in this where-set");
      list = list.slice(at + ((args.skip as number) ?? 0));
    }
    return list.slice(0, (args.take as number) ?? list.length);
  };
}

/** A visible channel plus a timeline of `count` roots. */
function channelWith(count: number): Root[] {
  const all = roots(count);
  H.results.set("channel.findFirst", { id: "ch_1" });
  H.results.set("message.findMany", servePage(all));
  H.results.set("user.findMany", []);
  return all;
}

function ids(messages: { id: string }[]): string[] {
  return messages.map((m) => m.id);
}

function findManyCalls() {
  return H.calls.filter((c) => c.path === "message.findMany").map((c) => c.args);
}

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = { user: { id: "me", companyId: "co-1", role: "member" } };
});

describe("getMessagesPageAnchoredAt — the page that CONTAINS the anchor (chat-010)", () => {
  it("returns a window around a root far older than the newest page", async () => {
    // 400 roots in the channel; the mention is number 40. The newest page would
    // start at 351, so before this the row was not on the page at any scroll
    // position and the reader got a toast instead of their message.
    channelWith(400);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r40");

    expect(page).not.toBeNull();
    expect(ids(page!.messages)).toContain("r40");
  });

  it("carries context on BOTH sides of the anchor, oldest first", async () => {
    // A mention is a question someone asked: the answer is usually the next
    // message, so a window that ends at the anchor would show the reader the
    // one row they already knew about and nothing that followed it.
    channelWith(400);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r40");
    const seen = ids(page!.messages);

    const at = seen.indexOf("r40");
    expect(at).toBeGreaterThan(0); // older rows above it
    expect(at).toBeLessThan(seen.length - 1); // newer rows below it
    // Ascending, newest LAST — the order every other page in this file returns
    // and the order the list renders top to bottom.
    const times = page!.messages.map((m) => new Date(m.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("holds the window to one page's worth of rows", async () => {
    // The shape the old comment in this file said was impossible ("an unbounded
    // take on a table that grows for years") is exactly what this must not be.
    channelWith(400);
    H.results.set("message.findFirst", { id: "r200", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r200");

    expect(page!.messages.length).toBeLessThanOrEqual(50);
    for (const args of findManyCalls()) {
      expect(args.take as number).toBeLessThanOrEqual(51);
    }
  });

  it("says the live edge is NOT in the window when newer roots exist", async () => {
    channelWith(400);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r40");

    // The surface needs this to offer a way back to the bottom of the room.
    expect(page!.hasNewer).toBe(true);
  });

  it("says the live edge IS in the window for a recent anchor", async () => {
    // A mention from a minute ago: the window reaches the newest root, so the
    // reader is not stranded in history and needs no "jump to latest".
    channelWith(20);
    H.results.set("message.findFirst", { id: "r19", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r19");

    expect(page!.hasNewer).toBe(false);
    expect(ids(page!.messages)).toContain("r20");
  });

  it("hands back a cursor that keeps walking BACKWARDS from the window", async () => {
    // The reader's "Load earlier messages" button has to continue from the top
    // of what they are looking at, not from the live edge they never loaded.
    channelWith(400);
    H.results.set("message.findFirst", { id: "r200", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r200");

    expect(page!.nextCursor).toBe(page!.messages[0].id);
  });

  it("has no cursor when the window already reaches the start of the channel", async () => {
    channelWith(20);
    H.results.set("message.findFirst", { id: "r3", parentId: null });

    const page = await getMessagesPageAnchoredAt("ch_1", "r3");

    expect(page!.nextCursor).toBeNull();
    expect(ids(page!.messages)[0]).toBe("r1");
  });

  it("builds the window around a REPLY's root, because the timeline excludes replies", async () => {
    // `getMessagesPage` filters `parentId: null`, so a reply is not in the
    // timeline at any depth. The panel renders it; this query puts the TIMELINE
    // where the conversation it belongs to is.
    channelWith(400);
    H.results.set("message.findFirst", (args: Record<string, unknown>) => {
      const where = args.where as { id: string };
      if (where.id === "r40_reply") return { id: "r40_reply", parentId: "r40" };
      if (where.id === "r40") return { id: "r40", parentId: null };
      return null;
    });

    const page = await getMessagesPageAnchoredAt("ch_1", "r40_reply");

    expect(page!.anchorRootId).toBe("r40");
    expect(ids(page!.messages)).toContain("r40");
    expect(ids(page!.messages)).not.toContain("r40_reply");
  });

  it("asks only for ROOTS, in this channel", async () => {
    channelWith(400);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    await getMessagesPageAnchoredAt("ch_1", "r40");

    for (const args of findManyCalls()) {
      expect(args.where).toMatchObject({ channelId: "ch_1", parentId: null });
    }
  });

  it("returns null — never a throw, never the newest page — for a message that is not there", async () => {
    // One answer for deleted-from-another-workspace, never-existed and
    // not-yours, for the same non-disclosure reason getChannelBySlug gives. The
    // caller falls back to the ordinary newest page and the client's
    // `locateMessageAction` then tells the reader the truth.
    channelWith(400);
    // A function, not a bare `null`: the shared harness reads a canned `null`
    // as "nothing canned" and falls back to `[]`, which a truthiness check
    // would wave straight through.
    H.results.set("message.findFirst", () => null);

    expect(await getMessagesPageAnchoredAt("ch_1", "r_nope")).toBeNull();
  });

  it("returns null for a channel this reader may not see, without reading a message", async () => {
    H.results.set("channel.findFirst", () => null);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    expect(await getMessagesPageAnchoredAt("ch_1", "r40")).toBeNull();
    expect(H.calls.filter((c) => c.path === "message.findFirst")).toHaveLength(0);
    expect(findManyCalls()).toHaveLength(0);
  });

  it("scopes the channel probe to the caller's own company", async () => {
    channelWith(400);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    await getMessagesPageAnchoredAt("ch_1", "r40");

    const probe = H.calls.find((c) => c.path === "channel.findFirst");
    expect(JSON.stringify(probe!.args)).toContain("co-1");
  });

  it("re-verifies tenancy on the message itself, not just the channel", async () => {
    // The id arrives from the address bar. The channel scope does not imply it:
    // a forged id from another workspace must simply not match.
    channelWith(400);
    H.results.set("message.findFirst", { id: "r40", parentId: null });

    await getMessagesPageAnchoredAt("ch_1", "r40");

    const lookup = H.calls.find((c) => c.path === "message.findFirst");
    expect(lookup!.args.where).toMatchObject({
      id: "r40",
      channelId: "ch_1",
      companyId: "co-1",
    });
  });
});
