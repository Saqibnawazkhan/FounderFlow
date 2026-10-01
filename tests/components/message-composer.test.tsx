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
// Hoisted into a handle rather than anonymous, because chat-005 is entirely
// about WHICH of these three the composer reaches for and with what words.
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: toastMock }));

const USERS = [
  { id: "u1", name: "Sara Ahmed" },
  { id: "u2", name: "Ali Khan" },
];

function ok(
  over: Partial<{
    notifiedCount: number;
    mentionedUserIds: string[];
    mentionAttempted: number;
    mentionPingsFailed: boolean;
  }> = {}
) {
  return {
    success: true as const,
    data: {
      id: "m1",
      mentionedUserIds: [],
      notifiedCount: 0,
      mentionAttempted: 0,
      mentionPingsFailed: false,
      ...over,
    },
  };
}

/** Every string this send put on screen, whichever of the three toasts it used. */
function toastTexts(): string[] {
  const out: string[] = [];
  for (const call of toastMock.mock.calls) out.push(String(call[0]));
  for (const call of toastMock.success.mock.calls) out.push(String(call[0]));
  for (const call of toastMock.error.mock.calls) out.push(String(call[0]));
  return out;
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
    toastMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
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

  it("still hashes a PUBLIC room in the placeholder and the label", () => {
    renderComposer({ channelKind: "public", channelName: "hiring" });
    expect(screen.getByRole("combobox", { name: "Message #hiring" })).toBeInTheDocument();
  });

  /* This case used to be spelled with `channelKind: "private"` and asserted
   * "Message #hiring" — it encoded the bug. A hash means "a room other people
   * can be in", and the Lock this very screen draws in its header says the
   * opposite, so the send box was contradicting the header in one viewport. See
   * `conversationTitle` in lib/chat/dm.ts for the rule. */
  it("does not hash a private channel in the placeholder or the label", () => {
    renderComposer({ channelKind: "private", channelName: "pvt-hiring" });
    expect(screen.getByRole("combobox", { name: "Message pvt-hiring" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Message pvt-hiring");
  });
});

/* ═════════ chat-005 — the composer must not invent a failed delivery ══════
 *
 * THE TOAST THE AUTHOR GOT, on a send in which nothing went wrong:
 *
 *     Sent — couldn't send mention pings (1 attempted). The team has been notified.
 *
 * It fired on `else if (mentionedUserIds.length > 0)`, the PARSED list, so it
 * fired whenever the server deliberately pinged nobody: in a private channel the
 * membership filter empties the recipients, so EVERY @-mention produced it. Both
 * halves of the sentence were false — nothing was attempted and nothing failed,
 * and nothing was reported to anyone, because `captureServerError` runs only in
 * the fan-out's catch.
 *
 * The composer now reads two more fields off the action (`mentionAttempted`,
 * `mentionPingsFailed`) and has three outcomes instead of two. The suppression
 * case gets an honest sentence rather than a warning, because the author typed a
 * name expecting a ping and silence would leave them believing one went.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("MessageComposer — what it says about mention pings (chat-005)", () => {
  // Its own reset: the `beforeEach` above belongs to the sibling describe, so
  // without this the toast calls accumulate across these cases and "says nothing"
  // reads the previous test's output.
  beforeEach(() => {
    sendMessageAction.mockReset();
    toastMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  async function send(result: ReturnType<typeof ok>) {
    sendMessageAction.mockResolvedValue(result);
    const user = userEvent.setup();
    const { box } = renderComposer();
    await user.type(box, "@ali thoughts?");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sendMessageAction).toHaveBeenCalled());
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  }

  it("does not claim a failed delivery when the ping was deliberately suppressed", async () => {
    // A private channel the mentioned teammate is not in: parsed 1, attempted 0.
    await send(ok({ mentionedUserIds: ["u2"], mentionAttempted: 0, notifiedCount: 0 }));

    const texts = toastTexts().join(" | ");
    expect(texts).not.toMatch(/couldn't send mention pings/i);
    // The second lie is the worse one: it promises an engineering follow-up that
    // was never filed.
    expect(texts).not.toMatch(/team has been notified/i);
  });

  it("explains truthfully why the mention did not ping, instead of staying silent", async () => {
    // The author typed a name expecting a ping. Silence would leave them
    // believing one went, so the suppression gets a sentence of its own — one
    // that covers both reasons the server suppresses (not a member here, or
    // muted), because the action does not distinguish them and the composer must
    // not guess.
    await send(ok({ mentionedUserIds: ["u2"], mentionAttempted: 0, notifiedCount: 0 }));

    const texts = toastTexts().join(" | ");
    expect(texts).toMatch(/no ping/i);
    expect(texts).toMatch(/not in this conversation|muted/i);
  });

  it("names the mentions that were dropped even when some others were pinged", async () => {
    // PARTIAL suppression, which said nothing at all until adversarial
    // verification found it. Mention three people in a private channel where one
    // is a member: the server filters two out before trying, so mentioned 3 /
    // attempted 1. The old branch required `mentionAttempted === 0`, so the two
    // people who got nothing were never mentioned to the author — the exact
    // outcome the sibling case above argues against.
    //
    // The count has to be the SUBTRACTION. `mentionedUserIds.length` is 3 and
    // would overstate it; `notifiedCount` cannot stand in either, because a
    // recipient with in-app off and push on is notified without incrementing it.
    await send(ok({ mentionedUserIds: ["u2", "u3", "u4"], mentionAttempted: 1, notifiedCount: 1 }));

    const texts = toastTexts().join(" | ");
    expect(texts, "partial suppression must not be silent").not.toBe("");
    expect(texts).toMatch(/2 got no ping/i);
    expect(texts).toMatch(/pinged 1/i);
    // Not the mention count, which is 3.
    expect(texts).not.toMatch(/3 got no ping/i);
  });

  it("still warns, and still says the team was told, when the fan-out really threw", async () => {
    await send(
      ok({
        mentionedUserIds: ["u2"],
        mentionAttempted: 1,
        notifiedCount: 0,
        mentionPingsFailed: true,
      })
    );

    const texts = toastTexts().join(" | ");
    expect(texts).toMatch(/couldn't send mention pings/i);
    expect(texts).toMatch(/1 attempted/);
    // True in this branch and only in this branch: the flag is set in the same
    // catch as the Sentry capture.
    expect(texts).toMatch(/team has been notified/i);
  });

  it("says nothing at all when the ping was attempted and reached nobody", async () => {
    // `notifiedCount` is the fan-out's `dispatched` — distinct people it SENT to.
    // Zero without a throw means everyone named has this event switched off on
    // all three channels, or was deactivated between the parse and the send.
    // Nothing failed, so there is nothing honest to say and nothing to report.
    await send(ok({ mentionedUserIds: ["u2"], mentionAttempted: 1, notifiedCount: 0 }));

    expect(toastTexts()).toEqual([]);
  });

  it("confirms the ping when it landed", async () => {
    await send(ok({ mentionedUserIds: ["u2"], mentionAttempted: 1, notifiedCount: 1 }));

    expect(toastTexts().join(" | ")).toMatch(/pinged 1/i);
  });

  it("says nothing for an ordinary message with no mentions", async () => {
    // A toast per message in a chat app is a plague. Guards the guard: a fix that
    // toasted on every send would satisfy the "explains truthfully" case above.
    await send(ok());

    expect(toastTexts()).toEqual([]);
  });
});
