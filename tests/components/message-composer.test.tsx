import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageComposer } from "@/components/chat/message-composer";

// Mock the server action — these tests are about the composer's keybindings
// and its failure behaviour, not the Prisma write. Each test sets the result.
const sendMessageAction = vi.fn();
vi.mock("@/lib/actions/chat", () => ({
  sendMessageAction: (input: unknown) => sendMessageAction(input),
  toggleReactionAction: vi.fn(),
}));

// react-hot-toast is fire-and-forget; stub it so we don't render its portal.
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const USERS = [
  { id: "u1", name: "Sara Ahmed" },
  { id: "u2", name: "Ali Khan" },
];

function ok(over: Partial<{ notifiedCount: number; mentionedUserIds: string[] }> = {}) {
  return {
    success: true as const,
    data: { id: "m1", mentionedUserIds: [], notifiedCount: 0, ...over },
  };
}

function renderComposer(props: Partial<React.ComponentProps<typeof MessageComposer>> = {}) {
  const onSent = vi.fn();
  const utils = render(
    <MessageComposer
      channelId="c1"
      channelKind="public"
      channelName="general"
      users={USERS}
      onSent={onSent}
      {...props}
    />
  );
  // The textarea carries role="combobox" (it drives the @-mention listbox),
  // so it is NOT reachable via getByRole("textbox").
  const box = screen.getByRole("combobox");
  return { onSent, box, ...utils };
}

describe("MessageComposer (the chat send box)", () => {
  beforeEach(() => {
    sendMessageAction.mockReset();
    sendMessageAction.mockResolvedValue(ok());
  });

  it("sends the message when the author presses Enter", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer();
    await user.type(box, "ship it");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(sendMessageAction).toHaveBeenCalledTimes(1));
    expect(sendMessageAction.mock.calls[0][0]).toMatchObject({
      channelId: "c1",
      body: "ship it",
    });
  });

  it("inserts a newline when the author presses Shift and Enter", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer();
    await user.type(box, "first");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(box, "second");

    // Shift+Enter must fall through to the browser's own newline insertion.
    // If this regresses to a send, a multi-paragraph message becomes
    // impossible to write and each line posts separately.
    expect((box as HTMLTextAreaElement).value).toBe("first\nsecond");
    expect(sendMessageAction).not.toHaveBeenCalled();
  });

  it("sends when the author presses Command or Control with Enter", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer();
    await user.type(box, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(box, "line two");
    await user.keyboard("{Control>}{Enter}{/Control}");

    // The documented escape hatch out of a multi-line draft.
    await waitFor(() => expect(sendMessageAction).toHaveBeenCalledTimes(1));
    expect(sendMessageAction.mock.calls[0][0].body).toBe("line one\nline two");
  });

  it("accepts the highlighted mention on Enter while the listbox is open, and does not send", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer();
    // This is THE keybinding conflict: comments bind Enter to "accept the
    // highlighted teammate", chat binds it to "send". If the priority order
    // ever inverts, picking a name from the popup fires a half-written
    // message at the whole channel.
    await user.type(box, "hey @sa");
    const option = await screen.findByRole("option", { name: /Sara Ahmed/ });
    expect(option).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Enter}");

    expect(sendMessageAction).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("hey @sara-ahmed ");
    // And the listbox is gone, so a SECOND Enter now sends.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sendMessageAction).toHaveBeenCalledTimes(1));
  });

  it("does not send mid-composition for an author using an input method editor", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer();
    await user.type(box, "こんにち");

    // An IME author presses Enter to COMMIT the candidate word, not to send.
    // user-event can't model composition, so dispatch the native flag the
    // browser would set. A failure here means Japanese/Korean/Chinese authors
    // post half-typed words every time they pick a candidate.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });

    expect(sendMessageAction).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("こんにち");
  });

  it("refuses to send an empty body", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer();
    await user.click(box);
    await user.keyboard("{Enter}");
    // Whitespace-only is empty too — trim happens before the guard.
    await user.type(box, "   ");
    await user.keyboard("{Enter}");

    expect(sendMessageAction).not.toHaveBeenCalled();
    // And the send button stays disabled so there's no second route in.
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
  });

  it("clears the composer after a successful send", async () => {
    const user = userEvent.setup();
    const { box, onSent } = renderComposer();
    await user.type(box, "done");
    await user.keyboard("{Enter}");

    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
    expect(onSent).toHaveBeenCalled();
  });

  it("keeps the typed body when the action fails", async () => {
    sendMessageAction.mockResolvedValue({ success: false, error: "Channel is archived" });
    const user = userEvent.setup();
    const { box, onSent } = renderComposer();
    await user.type(box, "a paragraph someone actually cared about");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(sendMessageAction).toHaveBeenCalled());
    // Losing a draft to a flaky network is the most infuriating bug a chat
    // product can ship. The body survives a failed send, full stop.
    expect((box as HTMLTextAreaElement).value).toBe("a paragraph someone actually cared about");
    expect(onSent).not.toHaveBeenCalled();
  });

  it("posts a thread reply with the parent id attached", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer({ parentId: "root1" });
    await user.type(box, "in the thread");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(sendMessageAction).toHaveBeenCalled());
    expect(sendMessageAction.mock.calls[0][0].parentId).toBe("root1");
  });

  it("refuses to send from an archived channel", async () => {
    const user = userEvent.setup();
    const { box } = renderComposer({ disabled: true });
    expect(box).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /send message/i }));
    expect(sendMessageAction).not.toHaveBeenCalled();
  });

  it("names the channel in its placeholder", () => {
    const { box } = renderComposer({ channelName: "finance" });
    expect(box).toHaveAttribute("placeholder", "Message #finance");
  });

  /* ── chat-008 ─────────────────────────────────────────────────────────────
   * The placeholder was `Message #${channelName}` UNCONDITIONALLY, so a direct
   * message with Ahmed Khan invited the reader to "Message #Ahmed Khan". The
   * product owner hit this in the running app. The kind has to reach the
   * composer for it to know the difference, which is why `channelKind` is a
   * REQUIRED prop and not an optional one defaulting to "public": a default
   * would let a future caller reintroduce the hash silently, and the fail-open
   * direction is the one that shipped this bug.
   * ───────────────────────────────────────────────────────────────────────── */
  it("does not hash a direct message in its placeholder", () => {
    const { box } = renderComposer({ channelKind: "dm", channelName: "Ahmed Khan" });
    expect(box).toHaveAttribute("placeholder", "Message Ahmed Khan");
  });

  it("does not hash a direct message in the send box's accessible name", () => {
    // The <label> is sr-only, so this is the only wording a screen-reader user
    // ever hears — getByRole matches on the accessible name, so a "#" leaking
    // back into the label fails here even if the placeholder is right.
    renderComposer({ channelKind: "dm", channelName: "Ahmed Khan" });
    expect(screen.getByRole("combobox", { name: "Message Ahmed Khan" })).toBeInTheDocument();
  });

  it("still hashes a room in the placeholder and the label", () => {
    renderComposer({ channelKind: "private", channelName: "hiring" });
    expect(screen.getByRole("combobox", { name: "Message #hiring" })).toBeInTheDocument();
  });
});
