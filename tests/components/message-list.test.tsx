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
