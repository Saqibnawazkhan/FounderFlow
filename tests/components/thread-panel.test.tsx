/**
 * <ThreadPanel> — chat-009: an archived conversation is read-only IN THE THREAD TOO.
 *
 * WHAT WAS WRONG. `canPostInChannel` returns false on `archivedAt` for every actor
 * including the channel's owner, and <ChatClient> already computed `readOnly` from
 * it and swapped the timeline's composer for "This channel is archived — it's
 * read-only now." Then it rendered <ThreadPanel> and forwarded nothing. The panel
 * took no read-only prop at all, so its <MessageComposer> got the default
 * `disabled={false}` and every <ReactionBar> in it got the default too: an enabled
 * Send button and a live emoji picker, inside a conversation whose every write the
 * server refuses with "This channel is archived — nobody can post in it." The
 * optimistic reaction flips on under the cursor and rolls back.
 *
 * WHY IT IS WORTH FIXING BEFORE ARCHIVE HAS A BUTTON. `readOnly` is not only
 * archive. `canPostInChannel` is also false for a NON-MEMBER of a private channel
 * or a DM, and that state is reachable today: an admin can see a private channel
 * they were never added to (`canSeeChannel` lets them in via the company role, and
 * `getChannelBySlug` returns it), so they can open a thread in it right now and be
 * handed a composer the server will refuse. Archiving only widens it.
 *
 * WHAT IS REAL HERE AND WHAT IS STUBBED. <MessageComposer> and <ReactionBar> are
 * the REAL components, because the whole finding is whether this panel hands them
 * the flag — a stub would assert that the panel passes a prop to a stub. The two
 * server actions underneath them are mocked, and each test asserts the action was
 * never called, so "disabled" means "nothing was attempted", not merely "a class
 * was applied".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadPanel } from "@/components/chat/thread-panel";
import type { MessageClient } from "@/lib/queries/chat";

const actions = vi.hoisted(() => ({
  sendMessageAction: vi.fn(),
  toggleReactionAction: vi.fn(),
  postRunwayCardAction: vi.fn(),
}));
vi.mock("@/lib/actions/chat", () => actions);

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

function message(over: Partial<MessageClient> = {}): MessageClient {
  return {
    id: "m_root",
    channelId: "ch_growth",
    authorId: "u_creator",
    authorName: "Ayesha Raza",
    authorAvatar: null,
    kind: "text",
    body: "shipping friday",
    payload: null,
    card: null,
    parentId: null,
    replyCount: 1,
    segments: [{ type: "text", text: "shipping friday" }],
    mentionedUserIds: [],
    // A reaction on the ROOT, so there is a <ReactionBar> to assert on at all:
    // the panel renders one only for a message that already has chips.
    reactions: [{ emoji: "🚀", count: 1, mine: false }],
    createdAt: "2026-09-26T09:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    ...over,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof ThreadPanel>> = {}) {
  return render(
    <ThreadPanel
      root={message()}
      replies={[]}
      users={[{ id: "u_bilal", name: "Bilal Ahmed" }]}
      channelName="growth"
      channelKind="public"
      open
      onClose={vi.fn()}
      {...props}
    />
  );
}

beforeEach(() => {
  actions.sendMessageAction.mockReset();
  actions.toggleReactionAction.mockReset();
  actions.sendMessageAction.mockResolvedValue({
    success: true,
    data: {
      id: "m1",
      mentionedUserIds: [],
      notifiedCount: 0,
      mentionAttempted: 0,
      mentionPingsFailed: false,
    },
  });
  actions.toggleReactionAction.mockResolvedValue({ success: true, data: { reacted: true } });
});

describe("ThreadPanel — a read-only conversation (chat-009)", () => {
  it("offers no usable composer when the conversation is read-only", async () => {
    const user = userEvent.setup();
    renderPanel({ readOnly: true });

    // The textarea carries role="combobox" — it drives the @-mention listbox.
    expect(screen.getByRole("combobox")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /send reply/i }));
    // WHICH OF THESE TWO LINES IS THE DISCRIMINATOR, stated because the comment
    // here used to claim it was this one. It is not: <MessageComposer>'s Send is
    // `disabled={!canSend}` and this case never types, so Send is disabled for
    // lack of text whether or not the panel is read-only — the click cannot tell
    // the fixed component from the unfixed one. The `toBeDisabled()` on the
    // textarea above IS the red-first signal, and it is the thing a reader
    // experiences: a box they cannot type in, rather than one that accepts a
    // reply and loses it.
    //
    // This line stays as a cheap invariant — nothing ELSE in the panel may wire
    // Send to the action behind the composer's back — and not as proof of
    // read-only.
    expect(actions.sendMessageAction).not.toHaveBeenCalled();
  });

  it("offers no reaction control when the conversation is read-only", async () => {
    const user = userEvent.setup();
    renderPanel({ readOnly: true });

    // The "add one" affordance is absent, not disabled — that is <ReactionBar>'s
    // own choice and this asserts the flag reached it.
    expect(screen.queryByRole("button", { name: /add reaction/i })).not.toBeInTheDocument();

    const chip = screen.getByRole("button", { name: /react with 🚀/i });
    expect(chip).toBeDisabled();
    await user.click(chip);
    // The optimistic flip is what the reader sees before the rollback, so the
    // proof is that no toggle was ever sent.
    expect(actions.toggleReactionAction).not.toHaveBeenCalled();
  });

  it("disables the reaction bar on REPLIES too, not only the root", async () => {
    // The root is tinted and rule-separated, so it is the one a fix is likely to
    // reach and the replies are the ones it is likely to miss.
    renderPanel({
      readOnly: true,
      replies: [message({ id: "m_reply", parentId: "m_root", body: "on it" })],
    });

    const chips = screen.getAllByRole("button", { name: /react with 🚀/i });
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toBeDisabled();
  });

  /* GUARD THE GUARD (house rule 27). Every assertion above would also pass
   * against a panel that disabled the composer unconditionally — which would
   * break replying in every live channel in the product. These two pin the
   * other direction. */
  it("leaves the composer live when the conversation is NOT read-only", async () => {
    const user = userEvent.setup();
    renderPanel({ readOnly: false });

    const box = screen.getByRole("combobox");
    expect(box).not.toBeDisabled();
    await user.type(box, "on it");
    await user.keyboard("{Enter}");
    expect(actions.sendMessageAction).toHaveBeenCalledTimes(1);
    expect(actions.sendMessageAction.mock.calls[0][0]).toMatchObject({ parentId: "m_root" });
  });

  it("leaves the composer live when the caller passes no readOnly at all", () => {
    // The prop is optional so the existing call sites keep compiling. Absent
    // must mean "postable", or adding it would silently close every thread in
    // the app.
    renderPanel();

    expect(screen.getByRole("combobox")).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /add reaction/i })).toBeInTheDocument();
  });
});

/* ═════ chat-011 — "N replies" has to answer the click ══════════════════════
 *
 * <ChatClient> has said this in a comment since the panel was built:
 * "`threadRootId` is set the moment a reply indicator is clicked so the panel
 * can open on a spinner instead of waiting for the round-trip before reacting."
 * It did not. The panel was rendered `{thread && …}` — gated on the LOADED
 * conversation — and `root` was a required `MessageClient`, so the spinner the
 * comment described could not exist. On a slow connection the click looked
 * ignored, and the reader clicked again.
 *
 * A false comment about a state that cannot happen is the part worth fixing
 * even at P3: it is how the next person to touch this file is misled.
 *
 * THE PENDING STATE IS A NULL ROOT, not a flag. There is exactly one fact —
 * "has the thread arrived?" — and `root === null` already carries it; a
 * separate `loading` prop would be a second source of truth for it, able to
 * disagree. No timers, no animation anything has to wait on: these cases are
 * synchronous renders.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("ThreadPanel — the moment between the click and the thread (chat-011)", () => {
  it("is on screen before the thread has arrived", async () => {
    renderPanel({ root: null });

    // A dialog, with the focus trap and the Escape that <Modal> brings, so the
    // click is visibly acknowledged and the reader can back out of it.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("says it is loading rather than claiming an empty thread", async () => {
    // "No replies yet — be the first." is what the loaded-but-empty branch
    // says. Showing that while the request is still in flight would be a
    // statement about the conversation, and a wrong one.
    renderPanel({ root: null });

    // A sentence, not only a skeleton: three grey rectangles say nothing to a
    // screen reader. Matched specifically because the dialog's own description
    // says "Loading…" too, and /loading/i alone finds both.
    expect(await screen.findByText(/loading this thread/i)).toBeInTheDocument();
    expect(screen.queryByText(/no replies yet/i)).not.toBeInTheDocument();
  });

  it("offers nothing to type into until there is a thread to reply to", async () => {
    // The composer needs the root's id for `parentId` — a reply typed before
    // the root lands has nowhere to go, and a box that accepts a reply and
    // drops it is worse than no box.
    renderPanel({ root: null });

    await screen.findByRole("dialog");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(actions.sendMessageAction).not.toHaveBeenCalled();
  });

  it("still renders the thread once it is there", async () => {
    // Guards the guard: a panel stuck on the pending branch would pass all
    // three cases above and break every thread in the product.
    renderPanel({
      // `segments` as well as `body`: the panel renders the SEGMENTS (that is
      // where mention chips come from), so a fixture that overrides only the
      // body leaves the root's text on the reply.
      replies: [
        message({
          id: "m_reply",
          parentId: "m_root",
          body: "on it",
          segments: [{ type: "text", text: "on it" }],
        }),
      ],
    });

    expect(screen.getByText("shipping friday")).toBeInTheDocument();
    expect(screen.getByText("on it")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
