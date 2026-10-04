/**
 * <ChannelHeader> — audit row chat-008: a DM rendered as a channel.
 *
 * WHAT THE PRODUCT OWNER SAW. A direct message with Ahmed Khan opened with a
 * Hash glyph in front of his name, a browser tab reading "#Ahmed Khan ·
 * FounderFlow", a composer inviting them to "Message #Ahmed Khan", and "2
 * members" in the corner. The header picked its icon with
 * `isPrivate ? Lock : Hash` (components/chat/channel-header.tsx:31), so
 * `kind: "dm"` fell through to Hash.
 *
 * That is not cosmetic. A hash in this product means "a room", and a room means
 * "other people can be in here". Putting one in front of a colleague's name
 * misrepresents who can read the conversation — the same class of mistake as
 * drawing a Hash on a private channel, which this suite already guards in
 * channel-rail.test.tsx.
 *
 * HOW THESE ASSERT. The Hash/Lock are `aria-hidden`, so they have no accessible
 * name to query for. The honest handle on "did it draw a channel glyph or a
 * person" is the Avatar, which renders `title={name}` — a real, queryable DOM
 * fact rather than an SVG path. The member-count slot is plain text.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelHeader } from "@/components/chat/channel-header";
import type { ChannelDetail } from "@/lib/queries/chat";

function detail(overrides: Partial<ChannelDetail> = {}): ChannelDetail {
  return {
    id: "c1",
    slug: "general",
    name: "general",
    kind: "public",
    topic: null,
    memberCount: 4,
    unreadCount: 0,
    lastMessageAt: null,
    isMember: true,
    archivedAt: null,
    members: [],
    myChannelRole: "member",
    ...overrides,
  } as ChannelDetail;
}

/** The DM as lib/queries/chat.ts hands it over: `name` is ALREADY the viewer's
 *  counterpart, resolved server-side by `dmDisplayName`. */
const DM = detail({
  id: "c9",
  slug: "dm-demo-ahmed_demo-saqib",
  name: "Ahmed Khan",
  kind: "dm",
  memberCount: 2,
  members: [
    { id: "demo-saqib", name: "Saqib Nawaz" },
    { id: "demo-ahmed", name: "Ahmed Khan" },
  ],
});

describe("ChannelHeader (a room)", () => {
  it("names the channel", () => {
    render(<ChannelHeader channel={detail()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("general");
  });

  it("counts the members", () => {
    render(<ChannelHeader channel={detail({ memberCount: 4 })} />);
    expect(screen.getByText("4 members")).toBeInTheDocument();
  });

  it("marks an archived channel", () => {
    render(<ChannelHeader channel={detail({ archivedAt: new Date().toISOString() })} />);
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });
});

describe("ChannelHeader (a direct message is a person, not a room) — chat-008", () => {
  it("leads with the counterpart's avatar rather than a channel glyph", () => {
    render(<ChannelHeader channel={DM} />);
    // The Avatar puts the person's name on `title`. Nothing else in this header
    // does, so its presence is exactly "a portrait was drawn here".
    const header = screen.getByRole("banner");
    expect(header.querySelector('[title="Ahmed Khan"]')).not.toBeNull();
  });

  it("still names the person in the heading", () => {
    render(<ChannelHeader channel={DM} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Ahmed Khan");
  });

  it("says what kind of conversation it is instead of counting to two", () => {
    // "2 members" frames a person as a room, and it is the same two every time,
    // so it carries no information. "Direct message" answers the question the
    // Hash used to answer wrongly.
    render(<ChannelHeader channel={DM} />);
    expect(screen.getByText(/direct message/i)).toBeInTheDocument();
    expect(screen.queryByText("2 members")).toBeNull();
  });

  it("keeps the mobile back affordance", () => {
    // The rail and the conversation are one pane below md; losing this on DMs
    // would strand a phone reader inside a DM with no way back to the list.
    render(<ChannelHeader channel={DM} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /back to channels/i })).toBeInTheDocument();
  });
});

/* ═══════════════ chat-012 — the mute lever exists at last ═══════════════════
 *
 * `ChannelMember.mutedAt` has been in the schema since the chat migration, and
 * BOTH notification fan-outs already honour it: `sendMessageAction` drops
 * `mutedAt: { not: null }` members from the recipient list, and so does the
 * Runway card. Nothing in the entire repo ever WROTE the column — no action, no
 * route, no control. So the suppression was built, tested and unreachable, and a
 * member of a noisy channel could only stop its pings by turning mentions off
 * everywhere in the workspace.
 *
 * That shape — complete server path, no entry point — is this repo's signature
 * defect, so these assertions are about the CONTROL: that a real, named,
 * clickable thing exists and calls back. The island's half (that the callback
 * reaches `setChannelMuteAction`) is pinned in
 * tests/components/chat-client.test.tsx, and
 * tests/lib/actions/reachability.test.ts fails on an action with no caller at
 * all. Those three together are the road, end to end.
 *
 * WHAT THE CONTROL HAS TO SAY, and why it is asserted here. A muted channel is
 * still in the rail, still shows its unread count (`unreadChatTotal` counts
 * muted channels deliberately) and is still perfectly readable; only the
 * notification fan-out stops. A bare bell glyph reads as "hide this", so the
 * copy has to say which of those it is.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("ChannelHeader — muting a noisy channel (chat-012)", () => {
  it("draws a mute control when the surface offers one", () => {
    render(<ChannelHeader channel={detail()} muted={false} onToggleMute={() => {}} />);
    expect(screen.getByRole("button", { name: /mute/i })).toBeInTheDocument();
  });

  it("calls back when it is pressed, which is the whole of the missing lever", async () => {
    const onToggleMute = vi.fn();
    render(<ChannelHeader channel={detail()} muted={false} onToggleMute={onToggleMute} />);

    await userEvent.click(screen.getByRole("button", { name: /mute/i }));

    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it("offers to UNMUTE a channel that is already muted", async () => {
    const onToggleMute = vi.fn();
    render(<ChannelHeader channel={detail()} muted onToggleMute={onToggleMute} />);

    const control = screen.getByRole("button", { name: /unmute/i });
    await userEvent.click(control);

    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it("says the channel is muted where the reader can see it, not only on hover", () => {
    // The state has to be legible without a tooltip: a bell-with-a-slash and a
    // bell are one pixel apart at this size, and getting it backwards means
    // silencing a channel you meant to listen to.
    render(<ChannelHeader channel={detail()} muted onToggleMute={() => {}} />);
    expect(screen.getByText(/^muted$/i)).toBeInTheDocument();
  });

  it("promises silence, NOT that the channel disappears", () => {
    // A muted channel keeps its place in the rail and keeps counting unreads.
    // If the control implies otherwise, the reader will mute a channel to get
    // it out of their list and then wonder why it is still there.
    render(<ChannelHeader channel={detail()} muted={false} onToggleMute={() => {}} />);
    const control = screen.getByRole("button", { name: /mute/i });
    expect(control.getAttribute("title") ?? "").toMatch(/unread/i);
  });

  it("draws nothing when the surface passes no handler", () => {
    // A non-member has no `ChannelMember` row for the flag to live on, so there
    // is nothing to toggle and a control whose only outcome is a refusal is
    // worse than no control.
    render(<ChannelHeader channel={detail({ isMember: false })} />);
    expect(screen.queryByRole("button", { name: /mute/i })).not.toBeInTheDocument();
  });

  it("does not disturb the member count beside it", () => {
    // The header is the marketing mock's bar and its restraint is the point;
    // adding a control must not cost the one fact it already carried.
    render(
      <ChannelHeader channel={detail({ memberCount: 4 })} muted={false} onToggleMute={() => {}} />
    );
    expect(screen.getByText("4 members")).toBeInTheDocument();
  });
});
