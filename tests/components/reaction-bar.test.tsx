import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactionBar } from "@/components/chat/reaction-bar";
import { REACTION_EMOJI } from "@/lib/schemas/chat";

// Mock the server action — we're testing the optimistic apply and the
// rollback, not the Prisma upsert.
const toggleReactionAction = vi.fn();
vi.mock("@/lib/actions/chat", () => ({
  toggleReactionAction: (input: unknown) => toggleReactionAction(input),
  sendMessageAction: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

describe("ReactionBar (the emoji chips under a message)", () => {
  beforeEach(() => {
    toggleReactionAction.mockReset();
  });

  it("renders each existing reaction as a chip with its count", () => {
    render(
      <ReactionBar
        messageId="m1"
        reactions={[
          { emoji: "👀", count: 2, mine: false },
          { emoji: "🚀", count: 3, mine: false },
        ]}
      />
    );
    expect(screen.getByRole("button", { name: /👀.*2 total/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /🚀.*3 total/ })).toBeInTheDocument();
  });

  it("shows the reader's own reaction as pressed", () => {
    render(
      <ReactionBar
        messageId="m1"
        reactions={[
          { emoji: "👀", count: 2, mine: true },
          { emoji: "🚀", count: 3, mine: false },
        ]}
      />
    );
    // aria-pressed, not colour alone — a screen-reader user otherwise has no
    // way to tell whether they've already reacted, and double-reacts.
    expect(screen.getByRole("button", { name: /👀/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /🚀/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("adds the reader's reaction optimistically and rolls it back when the action fails", async () => {
    // Never resolves until we say so, so we can observe the optimistic state.
    let settle: (v: unknown) => void = () => {};
    toggleReactionAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    const user = userEvent.setup();
    render(<ReactionBar messageId="m1" reactions={[{ emoji: "👀", count: 2, mine: false }]} />);

    await user.click(screen.getByRole("button", { name: /👀/ }));

    // Optimistic: the count bumps and the chip reads as pressed before the
    // server has said anything.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /👀.*3 total/ })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );

    settle({ success: false, error: "Channel is archived" });

    // Rollback: exactly the chips that were on screen before the click. A
    // silent non-rollback leaves the count permanently wrong until a refresh,
    // and the reader blames themselves.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /👀.*2 total/ })).toHaveAttribute(
        "aria-pressed",
        "false"
      )
    );
  });

  it("removes the reader's own reaction and drops the chip at zero", async () => {
    toggleReactionAction.mockResolvedValue({ success: true, data: { reacted: false } });
    const user = userEvent.setup();
    render(<ReactionBar messageId="m1" reactions={[{ emoji: "🎉", count: 1, mine: true }]} />);

    await user.click(screen.getByRole("button", { name: /🎉/ }));

    // A chip that nobody holds any more must disappear, not sit at "0".
    await waitFor(() => expect(screen.queryByRole("button", { name: /🎉.*total/ })).toBeNull());
    expect(toggleReactionAction).toHaveBeenCalledWith({ messageId: "m1", emoji: "🎉" });
  });

  it("offers only emoji from the allow-list", async () => {
    const user = userEvent.setup();
    render(<ReactionBar messageId="m1" reactions={[]} />);
    await user.click(screen.getByRole("button", { name: /add reaction/i }));

    // The offer must equal the server's allow-list exactly. Anything wider is
    // a UI that hands the reader a choice the action will reject; anything
    // narrower silently hides a supported reaction.
    const picker = screen.getByRole("group", { name: /choose a reaction/i });
    const offered = buttonsIn(picker).map((b) => b.getAttribute("aria-label"));
    expect(offered).toEqual(REACTION_EMOJI.map((e) => `React with ${e}`));
    expect(offered).toHaveLength(8);
  });

  it("reconciles to the server's answer when it disagrees with the optimistic flip", async () => {
    // Someone else's write interleaved: we guessed "now reacted", the server
    // says otherwise. The chip must follow the row that actually exists.
    toggleReactionAction.mockResolvedValue({ success: true, data: { reacted: false } });
    const user = userEvent.setup();
    render(<ReactionBar messageId="m1" reactions={[{ emoji: "👍", count: 1, mine: false }]} />);

    await user.click(screen.getByRole("button", { name: /👍/ }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /👍.*1 total/ })).toHaveAttribute(
        "aria-pressed",
        "false"
      )
    );
  });

  it("offers no way in when the channel is archived", () => {
    render(
      <ReactionBar messageId="m1" reactions={[{ emoji: "👀", count: 2, mine: false }]} disabled />
    );
    expect(screen.getByRole("button", { name: /👀/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /add reaction/i })).toBeNull();
  });
});

/** Buttons inside a container, in DOM order. */
function buttonsIn(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}
