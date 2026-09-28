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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageRow } from "@/components/chat/message-row";
import type { MessageClient } from "@/lib/queries/chat";

vi.mock("@/components/chat/reaction-bar", () => ({
  ReactionBar: () => null,
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: toastMock }));

// Deliberately NOT mocking next/navigation: <MessageRow> must not take a
// router. `useRouter` throws "invariant expected app router to be mounted"
// outside an App Router context, which is every consumer's unit test — a first
// draft of the delete control did take one and broke all eleven tests in
// tests/components/message-list.test.tsx, a file this agent does not own. If
// this file ever needs that mock, the row has acquired a dependency its
// siblings under components/chat/ deliberately avoid.
const chatActions = vi.hoisted(() => ({ deleteMessageAction: vi.fn() }));
vi.mock("@/lib/actions/chat", () => chatActions);

// The real hook talks to a singleton host mounted in <Providers>, which is not
// in this tree; unmocked it falls back to window.confirm, which jsdom does not
// implement. `confirmed` is the answer the author gives the dialog.
const confirmMock = vi.hoisted(() => ({ confirmed: true, calls: [] as unknown[] }));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => (opts: unknown) => {
    confirmMock.calls.push(opts);
    return Promise.resolve(confirmMock.confirmed);
  },
}));

const ME = "user-me";

beforeEach(() => {
  toastMock.error.mockReset();
  toastMock.success.mockReset();
  chatActions.deleteMessageAction.mockReset();
  chatActions.deleteMessageAction.mockResolvedValue({ success: true, data: undefined });
  confirmMock.confirmed = true;
  confirmMock.calls.length = 0;
});

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

/* ══════════ deleting a message — reachability row 3 ═══════════════════════
 *
 * `lib/actions/chat.ts:deleteMessageAction` is complete: it re-checks
 * `canDeleteMessage`, writes the tombstone and the parent's `replyCount`
 * decrement in one transaction, and treats a second delete as a no-op. It has
 * never had a caller. tests/lib/actions/reachability.test.ts has failed on it
 * since before this wave — "You cannot delete a message" — and that test
 * deliberately has no allow-list: the choice is wire it or delete it.
 *
 * So these assertions are in the author's terms — "I can take back the thing I
 * just said in the wrong channel" — and the row is where the control belongs,
 * because it is the only component that knows which message the reader means.
 *
 * WHAT THE CLIENT GATE IS, AND WHY IT IS NARROWER THAN THE SERVER'S.
 * `canDeleteMessage` admits the author OR a company admin/cofounder. This row
 * is handed `currentUserId` and never a company role (MessageList does not
 * thread one), so the control is drawn for the AUTHOR only. That is the honest
 * subset: it never offers a write the server would refuse, which is the
 * direction that matters. Admin moderation of someone else's message needs a
 * role on the row and is reported as a follow-up, not faked here.
 */
describe("MessageRow — taking back your own message (reachability row 3)", () => {
  function mine(overrides: Partial<MessageClient> = {}) {
    return msg({ authorId: ME, authorName: "Me", ...overrides });
  }

  it("offers the author a way to delete their own message", () => {
    renderRow(mine());
    expect(screen.getByRole("button", { name: /delete message/i })).toBeInTheDocument();
  });

  it("deletes it, and the row becomes a tombstone rather than vanishing", async () => {
    renderRow(mine({ id: "m-oops", body: "wrong channel, sorry" }));

    await userEvent.click(screen.getByRole("button", { name: /delete message/i }));

    await waitFor(() =>
      expect(chatActions.deleteMessageAction).toHaveBeenCalledWith({ messageId: "m-oops" })
    );
    // A deleted message KEEPS its row — replies still answer it, and that is
    // the shape the server's own payload arrives in. So the assertion is the
    // tombstone, not the absence of a row.
    await waitFor(() => expect(screen.getByText(/message deleted/i)).toBeInTheDocument());
    expect(screen.queryByText(/wrong channel, sorry/i)).not.toBeInTheDocument();
    // And no second delete is on offer.
    expect(screen.queryByRole("button", { name: /delete message/i })).not.toBeInTheDocument();
  });

  it("asks first, and asks the server nothing when the author says no", async () => {
    confirmMock.confirmed = false;
    renderRow(mine());

    await userEvent.click(screen.getByRole("button", { name: /delete message/i }));

    expect(confirmMock.calls.length).toBe(1);
    expect(chatActions.deleteMessageAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/message deleted/i)).not.toBeInTheDocument();
  });

  it("surfaces a refusal instead of silently pretending it worked", async () => {
    chatActions.deleteMessageAction.mockResolvedValue({
      success: false,
      error: "Only the author or an admin can delete this message",
    });
    renderRow(mine());

    await userEvent.click(screen.getByRole("button", { name: /delete message/i }));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    // The message is still there, which is the truth: nothing was deleted.
    expect(screen.queryByText(/message deleted/i)).not.toBeInTheDocument();
  });

  it("offers nothing on somebody else's message", () => {
    // The server would refuse, and an admin's moderation control is a
    // different feature that needs a role this row is not handed.
    renderRow(msg({ authorId: "user-sara" }));
    expect(screen.queryByRole("button", { name: /delete message/i })).not.toBeInTheDocument();
  });

  it("offers nothing on a message that is already a tombstone", () => {
    renderRow(mine({ deletedAt: new Date("2026-09-25T11:00:00.000Z").toISOString() }));
    expect(screen.queryByRole("button", { name: /delete message/i })).not.toBeInTheDocument();
  });

  it("offers nothing in a read-only channel", () => {
    // Same rule the reaction bar and the reply affordance follow: an archived
    // channel is closed, and the notice above the composer says so.
    renderRow(mine(), { disabled: true });
    expect(screen.queryByRole("button", { name: /delete message/i })).not.toBeInTheDocument();
  });

  it("offers the author a way to take back a runway card too", () => {
    // The card is the one message kind that discloses figures, so being able
    // to retract it matters more here than for a line of text.
    renderRow(
      mine({
        id: "m-card",
        kind: "card",
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
    expect(screen.getByRole("button", { name: /delete message/i })).toBeInTheDocument();
  });
});
