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

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
