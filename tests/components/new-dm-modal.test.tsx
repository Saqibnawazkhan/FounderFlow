/**
 * <NewDmModal> — the people picker behind the rail's "new direct message".
 *
 * Two behaviours here are load-bearing rather than cosmetic: a conversation
 * that already exists must open WITHOUT a write, and only one row may ever be
 * in flight. Both exist because `@@unique([companyId, dmKey])` is the last
 * line of defence against a pair ending up with two half-histories, and a
 * picker that POSTs on every click spends a write rate-limit token to learn a
 * slug the query layer already handed it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewDmModal } from "@/components/chat/new-dm-modal";
import type { DmCandidate } from "@/lib/queries/chat";

// Mock the server action — this is about which gestures reach it at all, not
// about the Prisma write or the P2002 recovery behind it.
const openDmAction = vi.fn();
vi.mock("@/lib/actions/chat", () => ({
  openDmAction: (input: unknown) => openDmAction(input),
  createChannelAction: vi.fn(),
  sendMessageAction: vi.fn(),
  toggleReactionAction: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const AYESHA: DmCandidate = {
  id: "cjld2cjxh0000qzrmn831i7rn",
  name: "Ayesha Khan",
  existingSlug: null,
};
const SAQIB: DmCandidate = {
  id: "cjld2cyuq0000t3rmniod1foy",
  name: "Saqib Nawaz",
  // Already talks to the viewer, so the picker has a slug and needs no write.
  existingSlug: "dm-cjld2cjxh0000qzrmn831i7rn_cjld2cyuq0000t3rmniod1foy",
};
const ZARA: DmCandidate = {
  id: "czzz2cyuq0000t3rmniod1foz",
  name: "Zara Iqbal",
  existingSlug: null,
};

function renderPicker(props: Partial<React.ComponentProps<typeof NewDmModal>> = {}) {
  const onClose = vi.fn();
  const onOpened = vi.fn();
  const utils = render(
    <NewDmModal
      open
      onClose={onClose}
      onOpened={onOpened}
      candidates={[AYESHA, SAQIB, ZARA]}
      {...props}
    />
  );
  return { onClose, onOpened, ...utils };
}

/**
 * The roster rows, in DOM order. Scoped to the list so the modal's own close
 * button and the search box are never mistaken for teammates.
 */
function rosterRows(): HTMLButtonElement[] {
  const list = screen.queryByRole("list");
  if (!list) return [];
  return Array.from(list.querySelectorAll("button"));
}

describe("NewDmModal (the teammate picker)", () => {
  beforeEach(() => {
    openDmAction.mockReset();
    openDmAction.mockResolvedValue({ success: true, data: { slug: "dm-new" } });
  });

  it("opens an existing conversation without calling the server", async () => {
    // WHAT BREAKS IN PRODUCTION: re-opening a conversation you already have is
    // a navigation, not a write. Route it through openDmAction and every
    // glance at an old thread costs a write rate-limit token, a round trip and
    // a revalidatePath — so a reader flicking between three DMs can rate-limit
    // themselves out of SENDING a message. The action is idempotent, which
    // makes this cheap rather than unsafe; that is exactly why it is the kind
    // of regression nobody notices without a test.
    const user = userEvent.setup();
    const { onOpened } = renderPicker();

    await user.click(screen.getByRole("button", { name: /Saqib Nawaz/ }));

    expect(openDmAction).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledWith(SAQIB.existingSlug);
  });

  it("starts a new conversation for a teammate with no existing thread", async () => {
    const user = userEvent.setup();
    const { onOpened } = renderPicker();

    await user.click(screen.getByRole("button", { name: /Ayesha Khan/ }));

    await waitFor(() => expect(openDmAction).toHaveBeenCalledTimes(1));
    // One id, never two: the other half of the pair is the session user and
    // the key is derived server-side.
    expect(openDmAction).toHaveBeenCalledWith({ userId: AYESHA.id });
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("dm-new"));
  });

  it("tells the reader which of the two is about to happen", () => {
    // "Open" goes somewhere that exists; "Message" creates it. Telling someone
    // they are about to start a chat they have had for months is a small lie
    // the query layer gave us the means to avoid.
    renderPicker();
    expect(screen.getByRole("button", { name: /Saqib Nawaz.*Open/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ayesha Khan.*Message/ })).toBeInTheDocument();
  });

  it("keeps the picker open and brings the rows back when the server refuses", async () => {
    openDmAction.mockResolvedValue({ success: false, error: "That teammate is no longer here" });
    const user = userEvent.setup();
    const { onOpened } = renderPicker();

    await user.click(screen.getByRole("button", { name: /Ayesha Khan/ }));

    await waitFor(() => expect(openDmAction).toHaveBeenCalled());
    // Nobody is navigated anywhere, and every row comes back to life so the
    // reader can try somebody else instead of reopening the picker.
    expect(onOpened).not.toHaveBeenCalled();
    await waitFor(() => {
      const rows = rosterRows();
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row).not.toBeDisabled());
    });
  });

  it("filters the roster as the reader types", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.type(screen.getByLabelText(/search teammates/i), "zar");

    // Asserted by iterating what survived, not by a count, so adding a fixture
    // above does not rewrite the expectation.
    const visible = rosterRows().map((row) => row.textContent ?? "");
    expect(visible.some((text) => text.includes(ZARA.name))).toBe(true);
    for (const gone of [AYESHA, SAQIB]) {
      expect(visible.some((text) => text.includes(gone.name))).toBe(false);
    }
  });

  it("matches a teammate whatever case the reader types", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.type(screen.getByLabelText(/search teammates/i), "AYESHA");

    const visible = rosterRows().map((row) => row.textContent ?? "");
    expect(visible.some((text) => text.includes(AYESHA.name))).toBe(true);
  });

  it("says plainly when nobody matches rather than showing an empty list", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.type(screen.getByLabelText(/search teammates/i), "nobody");

    expect(screen.getByText(/no teammates match that/i)).toBeInTheDocument();
    expect(rosterRows()).toHaveLength(0);
  });

  it("points a lone founder at the Team page instead of an empty roster", () => {
    renderPicker({ candidates: [] });
    expect(screen.getByText(/only person in this workspace/i)).toBeInTheDocument();
    // No search box either: a filter over an empty roster implies the list is
    // merely filtered down, which is the opposite of what happened.
    expect(screen.queryByLabelText(/search teammates/i)).toBeNull();
  });

  it("disables the list while one conversation is opening", async () => {
    // WHAT BREAKS IN PRODUCTION: two clicks racing is exactly the fork
    // @@unique([companyId, dmKey]) exists to catch, and the action's P2002
    // handler turns that race back into a successful open. That is a safety
    // net, not a licence to generate the race — and clicking a DIFFERENT
    // teammate mid-create leaves two conversations half-opened with the caller
    // navigated to whichever resolved last.
    let settle: (v: unknown) => void = () => {};
    openDmAction.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    const user = userEvent.setup();
    const { onOpened } = renderPicker();

    await user.click(screen.getByRole("button", { name: /Ayesha Khan/ }));

    // EVERY row goes dead, not just the pending one.
    await waitFor(() => {
      const rows = rosterRows();
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row).toBeDisabled());
    });
    // Exactly one row announces itself as busy, for a reader who cannot see
    // the spinner dim the rest.
    expect(document.querySelectorAll('li[aria-busy="true"]')).toHaveLength(1);

    // A second click, on a different teammate, lands on nothing.
    await user.click(screen.getByRole("button", { name: /Zara Iqbal/ }));
    expect(openDmAction).toHaveBeenCalledTimes(1);

    settle({ success: true, data: { slug: "dm-new" } });
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("dm-new"));
  });

  it("forgets the filter when the picker is closed", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();

    await user.type(screen.getByLabelText(/search teammates/i), "zar");
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    expect(onClose).toHaveBeenCalled();
    // Reopening to last session's half-typed "zar" and a one-row list reads
    // as a roster that lost people.
    await waitFor(() =>
      expect((screen.getByLabelText(/search teammates/i) as HTMLInputElement).value).toBe("")
    );
  });
});
