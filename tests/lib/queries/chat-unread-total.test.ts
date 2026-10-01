/**
 * The sidebar's Chat badge, server half.
 *
 * WHAT WAS WRONG. Chat had no presence in the nav at all. A message arriving in
 * #general, in a private channel, or in a DM reached the reader one of two
 * ways: they were already looking at /chat, or a notification row appeared
 * under the bell — so the app's most conversational event was announced in the
 * same list as budget alerts and role changes, and the word "Chat" in the
 * sidebar never changed. The per-channel badges in the rail were already
 * correct and already tested; nothing totalled them.
 *
 * WHAT THESE TESTS PIN is the part a total can get wrong in ways the rail
 * cannot, because the rail renders one row per channel and a total renders one
 * number for all of them:
 *
 *   • it must agree with the rail, rule for rule — same membership gate, same
 *     "not my own messages", same archived exclusion. A nav badge saying 3 over
 *     a rail showing 1 is worse than no badge, and this session has repeatedly
 *     found fixes that made two surfaces disagree where they previously agreed.
 *   • it must be scoped to the caller's workspace on BOTH queries.
 *   • it must be two queries, not one per channel: this runs on a 30-second
 *     poll in every open tab (perf-004 is the same badge, one row down).
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

import { unreadChatTotal } from "@/lib/queries/chat";
import { UNREAD_CAP } from "@/lib/chat/unread";

function callsTo(path: string) {
  return H.calls.filter((c) => c.path === path);
}

/** The `where` the count ran with, as a loose record so the tests can read into it. */
function countWhere(): Record<string, unknown> {
  const call = callsTo("message.count")[0];
  return (call?.args.where ?? {}) as Record<string, unknown>;
}

const TWO_CHANNELS = [
  { channelId: "ch-general", lastReadAt: new Date("2026-09-30T10:00:00Z") },
  { channelId: "ch-dm", lastReadAt: new Date("2026-09-30T12:00:00Z") },
];

beforeEach(() => {
  H.calls.length = 0;
  H.results.clear();
  H.session.value = { user: { id: "me", companyId: "co-1", role: "member" } };
});

describe("unreadChatTotal — the number on the Chat row", () => {
  it("exists, so the sidebar has something to call", () => {
    expect(
      typeof unreadChatTotal,
      "with no total query the Chat pill can only ever show nothing"
    ).toBe("function");
  });

  it("counts messages newer than MY watermark in EACH channel I am in", async () => {
    H.results.set("channelMember.findMany", () => TWO_CHANNELS);
    H.results.set("message.count", () => 4);

    expect(await unreadChatTotal()).toBe(4);

    const where = countWhere();
    const or = where.OR as Array<Record<string, unknown>>;
    expect(
      or,
      "one clause per channel, each carrying that channel's own lastReadAt — a single shared threshold cannot express per-channel watermarks"
    ).toHaveLength(2);
    expect(or[0]).toEqual({
      channelId: "ch-general",
      createdAt: { gt: TWO_CHANNELS[0].lastReadAt },
    });
    expect(or[1]).toEqual({
      channelId: "ch-dm",
      createdAt: { gt: TWO_CHANNELS[1].lastReadAt },
    });
  });

  it("never counts my own messages as unread to me", async () => {
    H.results.set("channelMember.findMany", () => TWO_CHANNELS);
    H.results.set("message.count", () => 1);

    await unreadChatTotal();

    expect(
      countWhere().authorId,
      "without this every message you send badges your own Chat row"
    ).toEqual({ not: "me" });
  });

  it("never counts deleted messages", async () => {
    H.results.set("channelMember.findMany", () => TWO_CHANNELS);
    H.results.set("message.count", () => 1);

    await unreadChatTotal();

    expect(
      countWhere().deletedAt,
      "a badge pointing at a message that has been removed sends the reader to an empty channel"
    ).toBeNull();
  });

  it("scopes BOTH queries to my workspace", async () => {
    H.results.set("channelMember.findMany", () => TWO_CHANNELS);
    H.results.set("message.count", () => 1);

    await unreadChatTotal();

    const memberWhere = callsTo("channelMember.findMany")[0].args.where as Record<string, unknown>;
    const channel = memberWhere.channel as Record<string, unknown>;
    expect(memberWhere.userId).toBe("me");
    expect(
      channel.companyId,
      "a membership row carries no companyId of its own; without this the channelIds fed to the count are unscoped"
    ).toBe("co-1");
    expect(countWhere().companyId).toBe("co-1");
  });

  it("leaves archived channels out, exactly as the rail does", async () => {
    H.results.set("channelMember.findMany", () => TWO_CHANNELS);
    H.results.set("message.count", () => 1);

    await unreadChatTotal();

    const memberWhere = callsTo("channelMember.findMany")[0].args.where as Record<string, unknown>;
    const channel = memberWhere.channel as Record<string, unknown>;
    expect(
      channel.archivedAt,
      "listChannelsForUser filters archivedAt: null, so counting them here makes the total disagree with the rows it totals"
    ).toBeNull();
  });

  it("asks for no messages at all when I am in no channels", async () => {
    H.results.set("channelMember.findMany", () => []);

    expect(await unreadChatTotal()).toBe(0);
    expect(
      callsTo("message.count"),
      "an empty OR matches every message in the workspace — the count must not run at all"
    ).toHaveLength(0);
  });

  it("stays two queries whether I am in two channels or forty", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      channelId: `ch-${i}`,
      lastReadAt: new Date("2026-09-30T10:00:00Z"),
    }));
    H.results.set("channelMember.findMany", () => many);
    H.results.set("message.count", () => 12);

    await unreadChatTotal();

    expect(
      H.calls.length,
      "one count per channel would be 40 round trips every 30 seconds in every open tab"
    ).toBe(2);
  });

  it("caps at 99, so the badge cannot grow unbounded", async () => {
    H.results.set("channelMember.findMany", () => TWO_CHANNELS);
    H.results.set("message.count", () => 4321);

    expect(await unreadChatTotal()).toBe(UNREAD_CAP);
  });
});
