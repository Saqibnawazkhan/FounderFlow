/**
 * <NewChannelModal> — the caller that `createChannelAction` shipped without.
 *
 * The action went out fully implemented and completely unreachable: chat had
 * no "+" anywhere, so the only channels a workspace could ever hold were the
 * ones the seed wrote, and 568 passing unit tests said nothing about it. These
 * tests are about the WIRING — that the form reaches the action, that the
 * caller gets the slug back, and that a rejection does not cost the author
 * their typing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewChannelModal } from "@/components/chat/new-channel-modal";
import { CREATABLE_CHANNEL_KINDS } from "@/lib/schemas/chat";

// Mock the server action — these tests are about the form's behaviour, not
// the Prisma insert or the slug de-collision behind it.
const createChannelAction = vi.fn();
vi.mock("@/lib/actions/chat", () => ({
  createChannelAction: (input: unknown) => createChannelAction(input),
  openDmAction: vi.fn(),
  sendMessageAction: vi.fn(),
  toggleReactionAction: vi.fn(),
}));

// react-hot-toast is fire-and-forget; stub it so we don't render its portal.
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

function renderModal(props: Partial<React.ComponentProps<typeof NewChannelModal>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = render(<NewChannelModal open onClose={onClose} onCreated={onCreated} {...props} />);
  return { onClose, onCreated, ...utils };
}

/** The name field, by its visible label. */
function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}

describe("NewChannelModal (the form behind the rail's plus)", () => {
  beforeEach(() => {
    createChannelAction.mockReset();
    createChannelAction.mockResolvedValue({ success: true, data: { slug: "growth" } });
  });

  it("creates a public channel and hands the slug back to its caller", async () => {
    // WHAT BREAKS IN PRODUCTION: if onCreated never fires with the slug, the
    // author creates a channel and stays exactly where they were, with no way
    // to tell whether anything happened. That silence is how the feature sat
    // unreachable in the first place.
    const user = userEvent.setup();
    const { onCreated } = renderModal();

    await user.type(nameInput(), "Growth");
    await user.click(screen.getByRole("button", { name: /create channel/i }));

    await waitFor(() => expect(createChannelAction).toHaveBeenCalledTimes(1));
    expect(createChannelAction.mock.calls[0][0]).toMatchObject({
      name: "Growth",
      // Public by default — a workplace channel is a shared surface unless
      // someone deliberately says otherwise.
      kind: "public",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("growth"));
  });

  it("sends the topic the author typed", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(nameInput(), "Growth");
    await user.type(screen.getByLabelText("Topic"), "Experiments and results");
    await user.click(screen.getByRole("button", { name: /create channel/i }));

    await waitFor(() => expect(createChannelAction).toHaveBeenCalled());
    expect(createChannelAction.mock.calls[0][0].topic).toBe("Experiments and results");
  });

  it("keeps what the author typed when the server rejects the channel", async () => {
    // WHAT BREAKS IN PRODUCTION: "a channel with that name already exists" is
    // a one-word fix. Wiping the form on a server error makes the author retype
    // a name AND a topic to apply it — and losing someone's typing to a server
    // error is the thing users hate most about a form.
    createChannelAction.mockResolvedValue({
      success: false,
      error: "A channel with that name already exists",
    });
    const user = userEvent.setup();
    const { onCreated } = renderModal();

    await user.type(nameInput(), "Growth");
    await user.type(screen.getByLabelText("Topic"), "Experiments and results");
    await user.click(screen.getByRole("button", { name: /create channel/i }));

    await waitFor(() => expect(createChannelAction).toHaveBeenCalled());
    expect(nameInput().value).toBe("Growth");
    expect((screen.getByLabelText("Topic") as HTMLInputElement).value).toBe(
      "Experiments and results"
    );
    // And the caller is NOT told a channel appeared.
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("clears itself after a channel is created, so the next open starts blank", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(nameInput(), "Growth");
    await user.click(screen.getByRole("button", { name: /create channel/i }));

    await waitFor(() => expect(nameInput().value).toBe(""));
  });

  it("offers every creatable channel kind", async () => {
    // WHAT BREAKS IN PRODUCTION: the picker and CREATABLE_CHANNEL_KINDS are
    // two spellings of one allow-list. A kind the tuple permits but the picker
    // never offers is a feature nobody can reach — the failure this whole file
    // exists to stop repeating. Iterated over the tuple, never counted, so
    // widening it widens the guard.
    const user = userEvent.setup();
    renderModal();

    const group = screen.getByRole("radiogroup", { name: /type/i });
    expect(within(group).getAllByRole("radio")).toHaveLength(CREATABLE_CHANNEL_KINDS.length);

    for (const kind of CREATABLE_CHANNEL_KINDS) {
      const option = within(group).getByRole("radio", { name: new RegExp(kind, "i") });
      await user.click(option);
      // Selectable, and it says so through aria-checked rather than colour
      // alone — otherwise a keyboard reader cannot tell what they picked.
      expect(option).toHaveAttribute("aria-checked", "true");
    }
  });

  it("sends the kind the author picked rather than the default", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(nameInput(), "Hiring");
    await user.click(screen.getByRole("radio", { name: /private/i }));
    await user.click(screen.getByRole("button", { name: /create channel/i }));

    await waitFor(() => expect(createChannelAction).toHaveBeenCalled());
    // A private channel created as public is a privacy failure, not a form bug.
    expect(createChannelAction.mock.calls[0][0].kind).toBe("private");
  });

  it("refuses to submit a nameless channel", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("button", { name: /create channel/i }));

    // The client rejects it for exactly the reason the server would — both
    // sides parse NewChannelSchema, so the message cannot drift.
    expect(await screen.findByText(/channel name is required/i)).toBeInTheDocument();
    expect(createChannelAction).not.toHaveBeenCalled();
  });

  it("abandons the draft when the author cancels", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.type(nameInput(), "Half typed");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onClose).toHaveBeenCalled();
    expect(createChannelAction).not.toHaveBeenCalled();
    // Closing is a deliberate abandon — unlike a failed submit above, the
    // next open must not resurrect an hour-old draft.
    await waitFor(() => expect(nameInput().value).toBe(""));
  });
});
