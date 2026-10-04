/**
 * <MessageList> — the scroll decisions.
 *
 * READ THIS BEFORE CHANGING A TEST HERE: jsdom has no layout engine. Every
 * element reports `scrollHeight`, `clientHeight` and `offsetHeight` as 0, and
 * its native `scrollTop` setter is a no-op. So each test installs its own
 * `Object.defineProperty` stubs on the scroll container and drives them by
 * hand — the numbers below are a script, not a measurement.
 *
 * That means these tests pin the DECISION logic ("given the reader was at the
 * bottom and a message arrived, do we pin?") and NOT the browser's scrolling.
 * A regression in real smoothness, momentum or sub-pixel rounding will not be
 * caught here; it belongs in the puppeteer smoke.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageList } from "@/components/chat/message-list";
import type { MessageClient } from "@/lib/queries/chat";

// The read receipt is a real server action — stub it so the list's debounce
// logic can be observed without a Prisma write.
const markChannelReadAction = vi.fn();
vi.mock("@/lib/actions/chat", () => ({
  markChannelReadAction: (input: unknown) => markChannelReadAction(input),
}));

// ReactionBar belongs to the composer agent and talks to its own actions.
// The list only cares that a row renders, so it's stubbed out entirely.
vi.mock("@/components/chat/reaction-bar", () => ({
  ReactionBar: () => null,
}));

vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

const ME = "user-me";
const BASE = new Date("2026-09-25T10:00:00.000Z").getTime();

function msg(overrides: Partial<MessageClient> & { id: string }): MessageClient {
  return {
    channelId: "chan-1",
    authorId: "user-sara",
    authorName: "Sara Khan",
    authorAvatar: null,
    kind: "text",
    body: "hello",
    payload: null,
    parentId: null,
    replyCount: 0,
    segments: [{ type: "text", text: "hello" }],
    mentionedUserIds: [],
    reactions: [],
    createdAt: new Date(BASE).toISOString(),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  } as MessageClient;
}

/**
 * Install a fake layout on the scroll container. Returns handles so a test can
 * grow the content (as a new message would) and read back where the component
 * decided to scroll.
 */
function stubLayout(
  el: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number; scrollTop: number }
) {
  let scrollHeight = initial.scrollHeight;
  let scrollTop = initial.scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => initial.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (next: number) => {
      scrollTop = next;
    },
  });
  return {
    grow: (to: number) => {
      scrollHeight = to;
    },
    setScrollTop: (to: number) => {
      scrollTop = to;
    },
    read: () => scrollTop,
  };
}

function renderList(
  messages: MessageClient[],
  props: Partial<React.ComponentProps<typeof MessageList>> = {}
) {
  const onLoadOlder = vi.fn();
  const view = render(
    <MessageList
      channelId="chan-1"
      currentUserId={ME}
      messages={messages}
      hasMore={false}
      loadingOlder={false}
      onLoadOlder={onLoadOlder}
      readDebounceMs={0}
      {...props}
    />
  );
  const scroller = screen.getByRole("log", { name: /messages/i });
  return { ...view, scroller, onLoadOlder };
}

describe("MessageList (the conversation scrollport)", () => {
  beforeEach(() => {
    markChannelReadAction.mockReset();
    markChannelReadAction.mockResolvedValue({ success: true });
  });

  it("pins to the bottom when a message arrives and the reader is already at the bottom", async () => {
    // The default case: someone parked at the live edge should never have to
    // scroll to see what just landed.
    const first = [msg({ id: "m1" }), msg({ id: "m2" })];
    const { scroller, rerender } = renderList(first);
    const layout = stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    fireEvent.scroll(scroller); // 1000 - 600 - 400 = 0 px from the end

    layout.grow(1120);
    rerender(
      <MessageList
        channelId="chan-1"
        currentUserId={ME}
        messages={[...first, msg({ id: "m3", createdAt: new Date(BASE + 1000).toISOString() })]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        readDebounceMs={0}
      />
    );

    expect(layout.read()).toBe(1120);
    // No pill: nothing was missed, so nothing to announce.
    expect(screen.queryByRole("button", { name: /new message/i })).not.toBeInTheDocument();
  });

  it("shows the new-messages pill instead of jumping when the reader has scrolled up", async () => {
    // Yanking a reader out of the backlog is the single most hated thing a
    // chat client does. If this fails, we've become that client.
    const first = [msg({ id: "m1" }), msg({ id: "m2" })];
    const { scroller, rerender } = renderList(first);
    const layout = stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 200 });
    fireEvent.scroll(scroller); // 400 px from the end — reading history

    layout.grow(1120);
    rerender(
      <MessageList
        channelId="chan-1"
        currentUserId={ME}
        messages={[
          ...first,
          msg({ id: "m3", authorId: "user-ali", createdAt: new Date(BASE + 1000).toISOString() }),
        ]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        readDebounceMs={0}
      />
    );

    expect(layout.read()).toBe(200);
    const pill = await screen.findByRole("button", { name: /1 new message/i });

    // ...and the pill is the way back down.
    const user = userEvent.setup();
    await user.click(pill);
    expect(layout.read()).toBe(1120);
  });

  it("scrolls down for the reader's own message wherever they were reading", async () => {
    // You just pressed send. You expect to watch it land, even mid-backlog.
    const first = [msg({ id: "m1" }), msg({ id: "m2" })];
    const { scroller, rerender } = renderList(first);
    const layout = stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 200 });
    fireEvent.scroll(scroller);

    layout.grow(1120);
    rerender(
      <MessageList
        channelId="chan-1"
        currentUserId={ME}
        messages={[
          ...first,
          msg({
            id: "m3",
            authorId: ME,
            authorName: "Me",
            createdAt: new Date(BASE + 1000).toISOString(),
          }),
        ]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        readDebounceMs={0}
      />
    );

    expect(layout.read()).toBe(1120);
  });

  it("preserves the reader's position when an older page is prepended", async () => {
    // Loading history must not move the line you were reading. The restore is
    // newHeight - oldHeight + oldTop; a failure here scrolls the reader off to
    // somewhere they never asked to be.
    const first = [msg({ id: "m5" }), msg({ id: "m6" })];
    const { scroller, rerender } = renderList(first, { hasMore: true });
    const layout = stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 200 });
    fireEvent.scroll(scroller);

    layout.grow(1600); // 600 px of history inserted above
    rerender(
      <MessageList
        channelId="chan-1"
        currentUserId={ME}
        messages={[
          msg({ id: "m3", createdAt: new Date(BASE - 3000).toISOString() }),
          msg({ id: "m4", createdAt: new Date(BASE - 2000).toISOString() }),
          ...first,
        ]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        readDebounceMs={0}
      />
    );

    expect(layout.read()).toBe(800); // 1600 - 1000 + 200
  });

  it("renders a deleted message as a tombstone rather than removing the row", () => {
    // An absent row silently rewrites the conversation — replies end up
    // answering nothing. The row stays; only its body changes.
    //
    // The fixture blanks body/payload/segments/reactions exactly as the query
    // layer does: deleted text never ships in the RSC payload, so the tombstone
    // may lean on nothing but id, authorName, createdAt and deletedAt. If the
    // row ever starts reading `body` again, this fixture fails it.
    renderList([
      msg({ id: "m1", body: "first thing", segments: [{ type: "text", text: "first thing" }] }),
      msg({
        id: "m2",
        body: "",
        payload: null,
        segments: [],
        reactions: [],
        deletedAt: new Date(BASE + 500).toISOString(),
      }),
      msg({ id: "m3", body: "last thing", segments: [{ type: "text", text: "last thing" }] }),
    ]);

    expect(screen.getByText(/message deleted/i)).toBeInTheDocument();
    // The author and time survive the blanking, so the row keeps its identity.
    expect(screen.getAllByText("Sara Khan").length).toBeGreaterThan(0);
    expect(screen.getByText("first thing")).toBeInTheDocument();
    expect(screen.getByText("last thing")).toBeInTheDocument();
  });

  it("gives a mention of the current reader the self-mention emphasis", () => {
    // Everyone's mentions look the same otherwise, and "someone is talking to
    // ME" is the one thing a reader scans a channel for.
    renderList([
      msg({
        id: "m1",
        mentionedUserIds: [ME],
        segments: [
          { type: "text", text: "ping " },
          { type: "mention", slug: "me", userId: ME, name: "Me" },
          { type: "text", text: " and " },
          { type: "mention", slug: "ali-raza", userId: "user-ali", name: "Ali Raza" },
        ],
      }),
    ]);

    expect(screen.getByText("@Me").className).toContain("text-primary-strong");
    expect(screen.getByText("@Ali Raza").className).toContain("text-forest-strong");
  });

  it("collapses a follow-up from the same author into the previous row", () => {
    // Grouping is what keeps a burst of four messages from reading like four
    // separate people. The name renders once, not four times.
    renderList([
      msg({ id: "m1", createdAt: new Date(BASE).toISOString() }),
      msg({ id: "m2", createdAt: new Date(BASE + 30_000).toISOString() }),
      msg({ id: "m3", createdAt: new Date(BASE + 60_000).toISOString() }),
    ]);

    expect(screen.getAllByText("Sara Khan")).toHaveLength(1);
  });

  it("starts a fresh row once the grouping window has passed", () => {
    // Six minutes later is a new thought, not a continuation.
    renderList([
      msg({ id: "m1", createdAt: new Date(BASE).toISOString() }),
      msg({ id: "m2", createdAt: new Date(BASE + 6 * 60_000).toISOString() }),
    ]);

    expect(screen.getAllByText("Sara Khan")).toHaveLength(2);
  });

  it("tells the server the channel is read while the reader sits at the bottom", async () => {
    // Without this the unread pill never clears and the rail lies.
    renderList([msg({ id: "m1" })]);
    await waitFor(() =>
      expect(markChannelReadAction).toHaveBeenCalledWith({ channelId: "chan-1" })
    );
  });

  /*
   * THE PRODUCER HALF OF THE ff-chat-read CONTRACT.
   *
   * The sidebar's Chat badge listens for this event so it refreshes the moment a
   * channel is read, instead of up to thirty seconds later with the pill still
   * claiming unread messages the reader is looking at — the same "teaches people
   * to ignore the badge" failure chat-007 fixed one surface down, in the rail.
   *
   * tests/components/sidebar-chat-badge.test.tsx covers the LISTENER by
   * dispatching the event by hand, which passes whether or not anything ever
   * fires it. Without these two, deleting the dispatch below leaves a fully
   * green suite and a stale badge in the product.
   */
  it("announces the read so the sidebar's Chat badge can refresh at once", async () => {
    const seen: string[] = [];
    const onRead = () => seen.push("ff-chat-read");
    window.addEventListener("ff-chat-read", onRead);
    try {
      renderList([msg({ id: "m1" })]);
      await waitFor(() => expect(seen).toContain("ff-chat-read"));
    } finally {
      window.removeEventListener("ff-chat-read", onRead);
    }
  });

  it("stays quiet when the server refused the read", async () => {
    // A failed read receipt moved no watermark, so the count has not changed and
    // announcing one would spend a round trip to learn nothing. This is also the
    // shape the test mocks produce (`undefined`), which is why the dispatch is
    // guarded on a real success rather than on the promise merely settling.
    markChannelReadAction.mockResolvedValue({ success: false, error: "nope" });
    const seen: string[] = [];
    const onRead = () => seen.push("ff-chat-read");
    window.addEventListener("ff-chat-read", onRead);
    try {
      renderList([msg({ id: "m1" })]);
      await waitFor(() => expect(markChannelReadAction).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("ff-chat-read", onRead);
    }
  });

  /* ═══ chat-014 — a read receipt is not a scroll event ═════════════════════
   *
   * THE EFFECT'S DEPENDENCIES INCLUDE `atBottom`, so every transition INTO the
   * at-bottom state fires another receipt — and each one, server side, is a
   * membership read, a newest-message read, a two-column UPDATE and
   * `revalidatePath("/chat")` + `revalidatePath("/chat/<slug>")`. A reader
   * flicking up and down a long channel therefore generated a stream of
   * app-wide cache invalidations for a watermark that had not moved an inch.
   *
   * WHAT IS NOT DONE ABOUT IT, deliberately: a rate limiter. The exemption in
   * `markChannelReadAction`'s own header is correct and stays — a rejected read
   * receipt would spend the budget that the reader's next MESSAGE needs, and
   * `limiters.read` is already carrying the 5-second liveness poll, which fails
   * silently by design. Bounding a wasted revalidation by occasionally breaking
   * liveness is a worse trade than the one being fixed.
   *
   * What is done is cheaper and exact: the receipt is sent once per watermark.
   * Scrolling is free again, and the server has its own "did it actually move"
   * guard behind this for every other caller (tests/lib/actions/chat.test.ts).
   * ═══════════════════════════════════════════════════════════════════════════ */
  it("sends ONE receipt per watermark, however much the reader scrolls", async () => {
    const { scroller } = renderList([msg({ id: "m1" })]);
    await waitFor(() => expect(markChannelReadAction).toHaveBeenCalledTimes(1));

    const layout = stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    fireEvent.scroll(scroller); // scrolled up — not at the bottom any more
    layout.setScrollTop(600); // 1000 - 600 - 400 = 0 px from the end
    fireEvent.scroll(scroller); // and back at the bottom

    await new Promise((r) => setTimeout(r, 10));
    // Nothing new has been said, so there is nothing new to have read.
    expect(markChannelReadAction).toHaveBeenCalledTimes(1);
  });

  it("DOES send a second receipt once something new arrives", async () => {
    // Guards the guard: a once-per-mount latch would pass the case above and
    // leave the badge claiming unread messages the reader is looking at.
    const first = [msg({ id: "m1" })];
    const { rerender } = renderList(first);
    await waitFor(() => expect(markChannelReadAction).toHaveBeenCalledTimes(1));

    rerender(
      <MessageList
        channelId="chan-1"
        currentUserId={ME}
        messages={[...first, msg({ id: "m2", createdAt: new Date(BASE + 1000).toISOString() })]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        readDebounceMs={0}
      />
    );

    await waitFor(() => expect(markChannelReadAction).toHaveBeenCalledTimes(2));
  });

  it("retries after a refusal instead of latching on a write that never landed", async () => {
    // The guard remembers what it SENT successfully, not what it tried. A
    // failed receipt moved no watermark, so the badge is still wrong and the
    // next opportunity has to take it.
    markChannelReadAction.mockResolvedValue({ success: false, error: "nope" });
    const { scroller } = renderList([msg({ id: "m1" })]);
    await waitFor(() => expect(markChannelReadAction).toHaveBeenCalledTimes(1));

    markChannelReadAction.mockResolvedValue({ success: true });
    const layout = stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    fireEvent.scroll(scroller);
    layout.setScrollTop(600);
    fireEvent.scroll(scroller);

    await waitFor(() => expect(markChannelReadAction).toHaveBeenCalledTimes(2));
  });

  it("stays quiet when the server says the watermark did not move", async () => {
    // The sidebar badge refetches on `ff-chat-read`. The server now reports
    // whether anything changed — a public channel the reader never joined has
    // no watermark at all — and announcing a write that did not happen spends a
    // round trip to learn nothing (audit row A54).
    markChannelReadAction.mockResolvedValue({ success: true, data: { moved: false } });
    const seen: string[] = [];
    const onRead = () => seen.push("ff-chat-read");
    window.addEventListener("ff-chat-read", onRead);
    try {
      renderList([msg({ id: "m1" })]);
      await waitFor(() => expect(markChannelReadAction).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("ff-chat-read", onRead);
    }
  });

  it("still announces a read that DID move the watermark", async () => {
    markChannelReadAction.mockResolvedValue({ success: true, data: { moved: true } });
    const seen: string[] = [];
    const onRead = () => seen.push("ff-chat-read");
    window.addEventListener("ff-chat-read", onRead);
    try {
      renderList([msg({ id: "m1" })]);
      await waitFor(() => expect(seen).toContain("ff-chat-read"));
    } finally {
      window.removeEventListener("ff-chat-read", onRead);
    }
  });

  it("does not mark the channel read while the reader is scrolled up", async () => {
    // Scrolled-up reading is not "I've seen the newest message".
    const { scroller } = renderList([msg({ id: "m1" })]);
    await waitFor(() => expect(markChannelReadAction).toHaveBeenCalledTimes(1));
    markChannelReadAction.mockClear();

    stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    fireEvent.scroll(scroller);

    await new Promise((r) => setTimeout(r, 10));
    expect(markChannelReadAction).not.toHaveBeenCalled();
  });

  it("asks for the next older page when the reader reaches the top", () => {
    // The button is the explicit affordance; proximity to the top is the
    // implicit one. Both have to reach the same handler.
    const { scroller, onLoadOlder } = renderList([msg({ id: "m1" })], { hasMore: true });
    stubLayout(scroller, { scrollHeight: 1000, clientHeight: 400, scrollTop: 10 });
    fireEvent.scroll(scroller);
    expect(onLoadOlder).toHaveBeenCalled();
  });
});

/* ═════════ chat-010 — the message a notification was about ════════════════
 *
 * `sendMessageAction` writes `/chat/<slug>?message=<id>` into every mention and
 * DM notification, and lib/queries/search.ts writes the same shape for a chat hit
 * in the command palette. Nothing in the chat surface read it, so all of them
 * dropped the reader at the bottom of a busy room with nothing anchored.
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE. Per this file's header, jsdom has no
 * layout engine, so "did the viewport end up in the right place" is not
 * assertable here and belongs in the puppeteer smoke. What IS assertable, and is
 * the whole of the DOM contract, is that exactly one row is marked, that it is
 * the right one, that every row carries a stable id a link can point at, and that
 * the list asks the browser to bring that row into view instead of pinning to the
 * bottom as it does on an ordinary open.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("MessageList — the anchored message from a deep link (chat-010)", () => {
  beforeEach(() => {
    markChannelReadAction.mockReset();
    markChannelReadAction.mockResolvedValue({ success: true });
  });

  it("gives every row an id a deep link can point at", () => {
    renderList([msg({ id: "m1" }), msg({ id: "m2" })]);

    expect(document.getElementById("message-m1")).not.toBeNull();
    expect(document.getElementById("message-m2")).not.toBeNull();
  });

  it("marks the anchored row, and only that row", () => {
    renderList([msg({ id: "m1" }), msg({ id: "m2" }), msg({ id: "m3" })], {
      anchoredMessageId: "m2",
    });

    const marked = document.querySelectorAll('[data-anchored="true"]');
    expect(marked).toHaveLength(1);
    expect(document.getElementById("message-m2")).toHaveAttribute("data-anchored", "true");
  });

  it("marks nothing when the link named no message", () => {
    renderList([msg({ id: "m1" }), msg({ id: "m2" })]);

    expect(document.querySelectorAll('[data-anchored="true"]')).toHaveLength(0);
  });

  it("marks nothing when the anchored id is not in the loaded page", () => {
    // The paging is <ChatClient>'s job; this list must not guess. Marking a
    // neighbouring row would be worse than marking none — it would assert that
    // the wrong message was the one somebody was mentioned in.
    renderList([msg({ id: "m1" })], { anchoredMessageId: "m_elsewhere" });

    expect(document.querySelectorAll('[data-anchored="true"]')).toHaveLength(0);
  });

  it("asks the browser to bring the anchored row into view", () => {
    // `Element.prototype.scrollIntoView` is stubbed globally in tests/setup.ts —
    // jsdom does not implement it — so this spies on that stub. It asserts the
    // REQUEST, not the resulting position, which jsdom cannot have.
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    spy.mockClear();

    renderList([msg({ id: "m1" }), msg({ id: "m2" })], { anchoredMessageId: "m2" });

    expect(spy).toHaveBeenCalled();
    // `contains` rather than an id equality check: the list scrolls the row
    // WRAPPER (which also carries the day divider, so the date stays visible),
    // and `contains` includes the node itself, so this stays true if a later
    // implementation scrolls the <article> directly.
    const target = spy.mock.instances[0] as HTMLElement;
    expect(target.contains(document.getElementById("message-m2"))).toBe(true);
    spy.mockRestore();
  });

  it("still opens at the live edge when the anchored id is not in the loaded page", () => {
    // THE REGRESSION chat-010 SHIPPED, found by adversarial verification.
    //
    // The mount bottom-pin was suppressed on the RAW prop, while the anchor
    // scroll effect returns early on the DERIVED value — null whenever the id is
    // not in `messages`. So for three of this feature's own outcomes (a thread
    // reply, which is never in the timeline by design; a root older than the
    // loaded page; an id that resolves to nothing) neither ran, and the reader
    // landed at the TOP of the loaded history: no anchor, and not the live edge
    // they would have had with no link at all. Strictly worse than not shipping
    // the feature.
    //
    // OBSERVED AT THE PROTOTYPE, because the pin happens inside the FIRST layout
    // effect — before `renderList` has returned the element `stubLayout` would
    // attach to. My first attempt asserted the new-messages pill instead and was
    // VACUOUS: `atBottomRef` initialises to true, so the broken path also reports
    // "at the bottom" and no pill appears either way. It passed with the fix
    // reverted, which is the only reason I know.
    const writes: number[] = [];
    const scrollTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 999,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        writes.push(v);
      },
    });

    try {
      renderList([msg({ id: "m1" }), msg({ id: "m2" })], {
        anchoredMessageId: "m-not-in-this-page",
      });

      expect(
        writes,
        "the mount pin was skipped for an anchor that is not in the loaded page, so " +
          "nothing positioned the scrollport: the reader lands at the top of the " +
          "history with no anchor and not at the live edge either"
      ).toContain(999);
    } finally {
      if (scrollTopDesc) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDesc);
      if (scrollHeightDesc)
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    }
  });

  it("leaves the mount pin alone when the anchored id IS in the loaded page", () => {
    // The other side, so the fix is not "always pin" — which would undo the whole
    // feature by yanking a deep-linked reader to the live edge.
    const writes: number[] = [];
    const scrollTopDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    const scrollHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 999,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: (v: number) => {
        writes.push(v);
      },
    });

    try {
      renderList([msg({ id: "m1" }), msg({ id: "m2" })], { anchoredMessageId: "m1" });
      expect(writes).not.toContain(999);
    } finally {
      if (scrollTopDesc) Object.defineProperty(HTMLElement.prototype, "scrollTop", scrollTopDesc);
      if (scrollHeightDesc)
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDesc);
    }
  });

  it("does not ask for any scroll when there is no anchor", () => {
    // Guards the guard: an implementation that called scrollIntoView on mount
    // unconditionally would satisfy the case above and would fight rule 1 of
    // this component (a channel opens at the bottom).
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    spy.mockClear();

    renderList([msg({ id: "m1" }), msg({ id: "m2" })]);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
