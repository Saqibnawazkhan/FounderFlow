/**
 * /chat/[slug] — the server half of "a notification lands ON its message"
 * (chat-010, residual).
 *
 * WHAT WAS STILL BROKEN after the first pass at this finding. The client read
 * `?message=<id>`, marked the row and scrolled to it; a thread reply opened its
 * panel. But the page it did all that to was always `getMessagesPage(channel.id)`
 * — the newest 50 roots. So a mention older than that was not in the DOM to
 * anchor, and the reader got a one-line toast pointing at "Load earlier
 * messages" instead of the message they had been sent to. In a channel that does
 * fifty messages a day, that is every notification read after lunch.
 *
 * WHY THE DECISION IS HERE AND NOT IN THE ISLAND. The island must fetch the
 * right page ONCE, from the server. A client-side loop that paged backwards
 * until the anchor appeared was written, tested, and removed for hanging
 * tests/components/chat-client.test.tsx (lib/chat/anchor.ts records it). The
 * RSC already fetches the first page; the only change worth making is WHICH page
 * it fetches.
 *
 * These assertions read the element this async component returns rather than
 * rendering it: what is being pinned is which query ran and which props came out,
 * and rendering the real island would drag in next-auth, the rail and the
 * scrollport to answer a question none of them are involved in.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelDetail } from "@/lib/queries/chat";

const queries = vi.hoisted(() => ({
  getChannelBySlug: vi.fn(),
  getMessagesPage: vi.fn(),
  getMessagesPageAnchoredAt: vi.fn(),
  listChannelsForUser: vi.fn(),
  listDmCandidates: vi.fn(),
}));
vi.mock("@/lib/queries/chat", () => queries);
vi.mock("@/lib/queries/session", () => ({
  requireScopedSession: vi.fn(async () => ({
    userId: "u_me",
    userName: "Me",
    email: "me@example.com",
    companyId: "co-1",
    role: "member",
  })),
}));
vi.mock("@/app/(app)/chat/[slug]/chat-client", () => ({ ChatClient: () => null }));

function detail(overrides: Partial<ChannelDetail> = {}): ChannelDetail {
  return {
    id: "c1",
    slug: "general",
    name: "general",
    kind: "public",
    topic: null,
    memberCount: 4,
    unreadCount: 0,
    lastMessageAt: null,
    isMember: true,
    archivedAt: null,
    members: [],
    myChannelRole: "member",
    muted: false,
    ...overrides,
  } as ChannelDetail;
}

/** The newest page, as `getMessagesPage` would answer. */
const LIVE_EDGE = {
  messages: [{ id: "m_newest" }, { id: "m_newest_2" }],
  nextCursor: "cur_live",
};

/** A window built around an old root, as `getMessagesPageAnchoredAt` would. */
const WINDOW = {
  messages: [{ id: "m_before" }, { id: "m_old" }, { id: "m_after" }],
  nextCursor: "cur_window",
  anchorRootId: "m_old",
  hasNewer: true,
};

async function page(searchParams?: Record<string, string | string[] | undefined>) {
  const mod = await import("@/app/(app)/chat/[slug]/page");
  return (await mod.default({ params: { slug: "general" }, searchParams })) as {
    key: string | null;
    props: Record<string, unknown>;
  };
}

beforeEach(() => {
  queries.getChannelBySlug.mockReset();
  queries.getMessagesPage.mockReset();
  queries.getMessagesPageAnchoredAt.mockReset();
  queries.listChannelsForUser.mockReset();
  queries.listDmCandidates.mockReset();

  queries.getChannelBySlug.mockResolvedValue(detail());
  queries.listChannelsForUser.mockResolvedValue([]);
  queries.listDmCandidates.mockResolvedValue([]);
  queries.getMessagesPage.mockResolvedValue(LIVE_EDGE);
  queries.getMessagesPageAnchoredAt.mockResolvedValue(WINDOW);
});

describe("/chat/[slug] — a ?message= link is served the page that contains it", () => {
  it("serves the window around the named message instead of the newest page", async () => {
    const el = await page({ message: "m_old" });

    expect(queries.getMessagesPageAnchoredAt).toHaveBeenCalledWith("c1", "m_old");
    expect(el.props.initialMessages).toEqual(WINDOW.messages);
    expect(el.props.initialCursor).toBe("cur_window");
  });

  it("tells the island the live edge is NOT loaded, so it can offer the way back", async () => {
    // A window around a month-old mention does not contain the newest message.
    // Without this the room would sit there looking live and frozen: the
    // activity poll refreshes an anchored page into the same anchored page.
    const el = await page({ message: "m_old" });

    expect(el.props.viewingHistory).toBe(true);
  });

  it("claims no such thing when the window already reaches the live edge", async () => {
    // A mention from a minute ago. There is nothing to jump back to, and
    // drawing "you're viewing earlier messages" over the live edge would be a
    // false statement the reader can see is false.
    queries.getMessagesPageAnchoredAt.mockResolvedValue({ ...WINDOW, hasNewer: false });

    const el = await page({ message: "m_old" });

    expect(el.props.viewingHistory).toBe(false);
  });

  it("gives an anchored view its own island, so leaving it resets the history", async () => {
    // The island is keyed, and the key is what makes "Jump to latest" honest:
    // `olderPages`, the paging cursor and the scroll position are all local
    // state, and carrying one window's cursor into the live edge would make
    // "Load earlier messages" insert rows in the middle of the list.
    const anchored = await page({ message: "m_old" });
    const plain = await page();

    expect(anchored.key).not.toBe(plain.key);
    expect(String(anchored.key)).toContain("m_old");
  });

  it("falls back to the newest page when the id names nothing reachable", async () => {
    // A deleted message, another workspace's id, a channel this reader cannot
    // see: `getMessagesPageAnchoredAt` answers all three with null, and the
    // reader lands at the live edge while the client's `locateMessageAction`
    // tells them the truth about the link.
    queries.getMessagesPageAnchoredAt.mockResolvedValue(null);

    const el = await page({ message: "m_gone" });

    expect(queries.getMessagesPage).toHaveBeenCalledWith("c1");
    expect(el.props.initialMessages).toEqual(LIVE_EDGE.messages);
    expect(el.props.viewingHistory).toBe(false);
  });

  it("opens an ordinary channel at the live edge, with no anchored query at all", async () => {
    const el = await page();

    expect(queries.getMessagesPageAnchoredAt).not.toHaveBeenCalled();
    expect(queries.getMessagesPage).toHaveBeenCalledWith("c1");
    expect(el.props.initialMessages).toEqual(LIVE_EDGE.messages);
  });

  it("refuses a junk param without asking the database about it", async () => {
    // `parseMessageAnchor` is the SAME shape check the island and
    // `locateMessageAction` apply. One spelling, every end.
    const el = await page({ message: "<script>" });

    expect(queries.getMessagesPageAnchoredAt).not.toHaveBeenCalled();
    expect(el.props.initialMessages).toEqual(LIVE_EDGE.messages);
  });

  it("refuses a repeated ?message=a&message=b rather than picking one", async () => {
    // Next hands `string[]` for a repeated key. Two messages named, one
    // viewport: silently choosing one would scroll to a message the link did
    // not unambiguously ask for.
    const el = await page({ message: ["m_old", "m_other"] });

    expect(queries.getMessagesPageAnchoredAt).not.toHaveBeenCalled();
    expect(el.props.initialMessages).toEqual(LIVE_EDGE.messages);
  });
});
