/**
 * <MessageRow> — the entry point into a thread.
 *
 * WHAT THIS FILE IS ABOUT (finding chat-001). Threading shipped as a closed
 * loop: the only control that called `onOpenThread` was the "N replies"
 * indicator, which is rendered `message.replyCount > 0`, and `replyCount` is
 * incremented only by `sendMessageAction` when a `parentId` is present — which
 * only the composer INSIDE the thread panel ever sets. So the first reply in
 * any thread could never be written, and `getThread` / `loadThreadAction` /
 * `<ThreadPanel>` / the one-level re-parenting rule / the reply-count
 * maintenance in the send and delete paths were all unreachable in the product.
 *
 * The assertions below are written in the reader's terms — "I can start a side
 * conversation off any message I could reply to" — not in terms of a prop being
 * passed, so they stay meaningful if the affordance is redrawn.
 *
 * ReactionBar is stubbed: it owns its own server action and its chips are not
 * what this file is about.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageRow } from "@/components/chat/message-row";
import type { MessageClient } from "@/lib/queries/chat";

vi.mock("@/components/chat/reaction-bar", () => ({
  ReactionBar: () => null,
}));

vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

const ME = "user-me";

function msg(overrides: Partial<MessageClient> = {}): MessageClient {
  return {
    id: "m1",
    channelId: "chan-1",
    authorId: "user-sara",
    authorName: "Sara Khan",
    authorAvatar: null,
    kind: "text",
    body: "shall we push the raise to Q4?",
    payload: null,
    card: null,
    parentId: null,
    replyCount: 0,
    segments: [{ type: "text", text: "shall we push the raise to Q4?" }],
    mentionedUserIds: [],
    reactions: [],
    createdAt: new Date("2026-09-25T10:00:00.000Z").toISOString(),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  } as MessageClient;
}

function renderRow(
  message: MessageClient,
  props: Partial<React.ComponentProps<typeof MessageRow>> = {}
) {
  const onOpenThread = vi.fn();
  const view = render(
    <MessageRow
      message={message}
      currentUserId={ME}
      grouped={false}
      onOpenThread={onOpenThread}
      {...props}
    />
  );
  return { ...view, onOpenThread };
}

describe("MessageRow — starting a thread (chat-001)", () => {
  it("offers a reply affordance on a message that has no replies yet", async () => {
    // The whole finding in one assertion: a zero-reply message is the ONLY
    // state a thread can start from, and it was the one state with no control.
    const { onOpenThread } = renderRow(msg({ replyCount: 0 }));

    const reply = screen.getByRole("button", { name: /reply in thread/i });
    await userEvent.click(reply);

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread.mock.calls[0][0]).toMatchObject({ id: "m1" });
  });

  it("still offers the reply-count indicator once a thread exists", async () => {
    const { onOpenThread } = renderRow(msg({ replyCount: 3 }));

    await userEvent.click(screen.getByRole("button", { name: /3 replies/i }));
    expect(onOpenThread).toHaveBeenCalledTimes(1);

    // And the way in is still there, so a fourth reply doesn't require
    // finding the count first.
    expect(screen.getByRole("button", { name: /reply in thread/i })).toBeInTheDocument();
  });

  it("offers no reply affordance on a deleted message", () => {
    // A tombstone keeps its row so replies still answer something, but there
    // is nothing left to reply TO — and sendMessageAction would refuse anyway.
    renderRow(msg({ deletedAt: new Date("2026-09-25T11:00:00.000Z").toISOString() }));

    expect(screen.queryByRole("button", { name: /reply in thread/i })).not.toBeInTheDocument();
  });

  it("offers no reply affordance when the channel is read-only", () => {
    // `disabled` is archived-or-cannot-post. Offering a composer the server
    // would refuse is the bug this row already avoids for reactions.
    renderRow(msg({ replyCount: 2 }), { disabled: true });

    expect(screen.queryByRole("button", { name: /reply in thread/i })).not.toBeInTheDocument();
    // Reading an existing thread is still allowed — archiving closes posting,
    // not reading (lib/auth/channel-permissions.ts).
    expect(screen.getByRole("button", { name: /2 replies/i })).toBeInTheDocument();
  });

  it("draws no reply affordance when there is nowhere to open a thread", () => {
    // Inside <ThreadPanel> there is no `onOpenThread`; a button that does
    // nothing is worse than no button.
    render(<MessageRow message={msg({ replyCount: 0 })} currentUserId={ME} grouped={false} />);

    expect(screen.queryByRole("button", { name: /reply in thread/i })).not.toBeInTheDocument();
  });

  it("offers a reply affordance on a runway card too", async () => {
    // A card is a message somebody said, not a widget that landed in the
    // timeline — the row's own header says so, and "let's talk about this
    // number" is the reason to post one.
    const { onOpenThread } = renderRow(
      msg({
        id: "m-card",
        kind: "card",
        body: "shared a runway snapshot",
        card: {
          v: 1,
          asOf: new Date("2026-09-25T10:00:00.000Z").toISOString(),
          currency: "PKR",
          runwayMonths: 7,
          cashOnHand: 1000,
          monthlyBurn: 140,
          redacted: false,
        },
      } as Partial<MessageClient>)
    );

    await userEvent.click(screen.getByRole("button", { name: /reply in thread/i }));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
  });
});
