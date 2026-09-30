/**
 * <ChannelRail> — the channel list's three load-bearing signals: what KIND of
 * channel a row is, whether it has anything waiting, and which one is open.
 * Each of those is a thing a reader acts on without reading the name, so each
 * gets a test.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelRail } from "@/components/chat/channel-rail";
import type { ChannelListItem } from "@/lib/queries/chat";

// next/link renders an <a> under the App Router's client runtime, which isn't
// present in jsdom. A plain anchor keeps role/aria assertions honest.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function channel(overrides: Partial<ChannelListItem> = {}): ChannelListItem {
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
    ...overrides,
  } as ChannelListItem;
}

describe("ChannelRail (the channel list)", () => {
  it("renders a lock for a private channel and a hash for a public one", () => {
    // Getting this backwards tells someone a private channel is public, which
    // is a privacy signal, not a styling detail.
    render(
      <ChannelRail
        activeSlug="general"
        channels={[
          channel({ id: "c1", slug: "general", name: "general", kind: "public" }),
          channel({ id: "c2", slug: "hiring", name: "hiring", kind: "private" }),
        ]}
      />
    );

    const publicRow = screen.getByRole("link", { name: /general/i });
    const privateRow = screen.getByRole("link", { name: /hiring/i });
    expect(publicRow).toContainElement(screen.getByLabelText("Public channel"));
    expect(privateRow).toContainElement(screen.getByLabelText("Private channel"));
  });

  it("shows the unread pill only on channels with unread messages", () => {
    // A pill on a read channel is a false alarm; a pill missing from an unread
    // one means the reader never learns there's something waiting.
    render(
      <ChannelRail
        activeSlug="general"
        channels={[
          channel({ id: "c1", slug: "general", name: "general", unreadCount: 0 }),
          channel({ id: "c2", slug: "finance", name: "finance", unreadCount: 3 }),
        ]}
      />
    );

    const pills = screen.getAllByLabelText(/unread messages$/);
    expect(pills).toHaveLength(1);
    expect(pills[0]).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: /finance/i })).toContainElement(pills[0]);
  });

  it("renders ninety-nine plus past the display cap", () => {
    // The query caps unreadCount at 99, so a bare "99" would quietly
    // under-report a channel with four hundred messages waiting.
    render(
      <ChannelRail
        activeSlug={null}
        channels={[channel({ id: "c9", slug: "loud", name: "loud", unreadCount: 99 })]}
      />
    );

    expect(screen.getByLabelText("99+ unread messages")).toHaveTextContent("99+");
  });

  it("marks the open channel as the current page", () => {
    // Colour alone leaves a screen-reader user with no idea which channel
    // they're in; aria-current is the part that actually carries it.
    render(
      <ChannelRail
        activeSlug="finance"
        channels={[
          channel({ id: "c1", slug: "general", name: "general" }),
          channel({ id: "c2", slug: "finance", name: "finance" }),
        ]}
      />
    );

    expect(screen.getByRole("link", { name: /finance/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /general/i })).not.toHaveAttribute("aria-current");
  });

  it("tells the host a channel was picked so the phone can swap panes", async () => {
    // Below md the rail and the conversation are the same real estate; without
    // this callback tapping a channel leaves the reader staring at the list.
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    render(
      <ChannelRail
        activeSlug="general"
        onNavigate={onNavigate}
        channels={[channel({ id: "c2", slug: "finance", name: "finance" })]}
      />
    );

    await user.click(screen.getByRole("link", { name: /finance/i }));
    expect(onNavigate).toHaveBeenCalled();
  });

  it("says so plainly when the workspace has no channels", () => {
    render(<ChannelRail activeSlug={null} channels={[]} />);
    expect(screen.getByText(/no channels yet/i)).toBeInTheDocument();
  });
});

/**
 * The Channels/Direct split and the two create controls — added with the DM
 * feature. A DM is addressed to a PERSON and a channel to a ROOM, so burying
 * one inside the other makes the reader scan names to work out which kind of
 * conversation they are about to open.
 */
describe("ChannelRail (direct messages and the create controls)", () => {
  const ROOM = channel({ id: "c1", slug: "general", name: "general", kind: "public" });
  const PRIVATE_ROOM = channel({ id: "c2", slug: "hiring", name: "hiring", kind: "private" });
  // lib/queries/chat.ts has ALREADY swapped Channel.name for the viewer-relative
  // counterpart name before this row reaches the client — the rail must not
  // re-derive it, because a second source of truth for "who is this DM with" is
  // exactly how the two drift.
  const DM = channel({ id: "c3", slug: "dm-cayesha_csaqib", name: "Ayesha Khan", kind: "dm" });

  it("lists direct messages apart from channels", () => {
    render(<ChannelRail activeSlug={null} channels={[ROOM, DM]} />);

    expect(screen.getByText("Channels")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();

    const lists = screen.getAllByRole("list");
    const roomList = lists.find((list) =>
      list.contains(screen.getByRole("link", { name: /general/i }))
    );
    const dmList = lists.find((list) =>
      list.contains(screen.getByRole("link", { name: /Ayesha Khan/i }))
    );
    expect(roomList).toBeTruthy();
    expect(dmList).toBeTruthy();
    // Filed under different headings, not one merged column.
    expect(dmList).not.toBe(roomList);
  });

  it("hides the Direct section entirely when there is nothing to put in it", () => {
    // An empty section with nothing to act on is noise. "Channels" always
    // shows, because its empty state is what tells a new workspace what to do.
    render(<ChannelRail activeSlug={null} channels={[ROOM]} />);
    expect(screen.queryByText("Direct")).toBeNull();
  });

  it("labels a direct message with the counterpart's name", () => {
    render(<ChannelRail activeSlug={null} channels={[ROOM, PRIVATE_ROOM, DM]} />);

    const dmRow = screen.getByRole("link", { name: /Ayesha Khan/i });
    expect(dmRow).toHaveAttribute("href", `/chat/${DM.slug}`);
    // A DM leads with the person, not a Hash or a Lock. Drawing a channel icon
    // on a two-person thread files it visually with the workspace-wide rooms,
    // which reads as "everyone can see this".
    expect(dmRow.querySelector('[aria-label="Public channel"]')).toBeNull();
    expect(dmRow.querySelector('[aria-label="Private channel"]')).toBeNull();
  });

  it("offers a control to create a channel when the caller passes one", async () => {
    const onNewChannel = vi.fn();
    const user = userEvent.setup();
    render(<ChannelRail activeSlug={null} channels={[ROOM]} onNewChannel={onNewChannel} />);

    // Icon-only, so aria-label is the ONLY accessible name it has.
    await user.click(screen.getByRole("button", { name: "New channel" }));
    expect(onNewChannel).toHaveBeenCalled();
  });

  it("renders no create-channel control when the caller passes none", () => {
    // Creating is the host's job, not the rail's — a read-only embedding
    // passes neither callback and no "+" appears.
    render(<ChannelRail activeSlug={null} channels={[ROOM]} />);
    expect(screen.queryByRole("button", { name: "New channel" })).toBeNull();
  });

  it("offers a control to start a direct message when the caller passes one", async () => {
    const onNewDm = vi.fn();
    const user = userEvent.setup();
    render(<ChannelRail activeSlug={null} channels={[ROOM]} onNewDm={onNewDm} />);

    await user.click(screen.getByRole("button", { name: "New direct message" }));
    expect(onNewDm).toHaveBeenCalled();
  });

  it("renders no create-direct-message control when the caller passes none", () => {
    render(<ChannelRail activeSlug={null} channels={[ROOM, DM]} />);
    expect(screen.queryByRole("button", { name: "New direct message" })).toBeNull();
  });

  it("repeats the create affordance as a labelled button in an empty workspace", () => {
    // A 12px "+" in the corner of an otherwise blank rail is precisely the
    // control the reader least likely to find it will not find.
    const onNewChannel = vi.fn();
    render(<ChannelRail activeSlug={null} channels={[]} onNewChannel={onNewChannel} />);
    expect(screen.getByRole("button", { name: /create a channel/i })).toBeInTheDocument();
  });

  it("keeps every conversation inside the one Channels landmark", () => {
    // WHAT BREAKS IN PRODUCTION: scripts/smoke-chat.mjs reads
    // `nav[aria-label="Channels"] a` and asserts that a private channel the
    // viewer is not a member of never appears there. That selector is only as
    // good as the promise that ONE nav wraps both sections. Split the rail into
    // a "Channels" nav and a "Direct" nav and the smoke assertion keeps passing
    // while silently covering half the rail — a leak in the half it stopped
    // looking at would ship green.
    const rail = [ROOM, PRIVATE_ROOM, DM];
    render(
      <ChannelRail activeSlug={null} channels={rail} onNewChannel={vi.fn()} onNewDm={vi.fn()} />
    );

    const navs = screen.getAllByRole("navigation", { name: "Channels" });
    expect(navs).toHaveLength(1);

    const anchors = Array.from(navs[0].querySelectorAll("a"));
    // Iterated over the rows handed in, never counted, so adding a kind of
    // conversation widens the guard instead of breaking it.
    for (const row of rail) {
      expect(anchors.some((a) => a.getAttribute("href") === `/chat/${row.slug}`)).toBe(true);
    }
    // And nothing links out of a conversation from outside that one landmark.
    expect(anchors).toHaveLength(document.querySelectorAll("a").length);
  });
  /* ── THE REPORTED BUG ──────────────────────────────────────────────────────
   * "The chat sidebar shows a CHANNELS heading with a + button and nothing
   * else. No DM section, no way to message a person."
   *
   * Reported from the running product. Before this fix, a reader with no DMs
   * yet got a Direct section consisting of a 9px mono label and a 12px
   * icon-only "+" — no words anywhere that say you can message a person. The
   * rail's OWN comment already conceded the point for the Channels section:
   * "the header's '+' is a 12px icon in the corner of an otherwise blank rail,
   * which is precisely the reader least likely to find it." The Direct section
   * never got the same treatment.
   * ─────────────────────────────────────────────────────────────────────────── */
  it("offers a labelled way to start a DM when there are no DMs yet", () => {
    render(<ChannelRail activeSlug={null} channels={[ROOM]} onNewDm={vi.fn()} />);
    // Words, not a bare glyph. `getByRole` here matches on the ACCESSIBLE NAME,
    // so this passes only if a human-readable label is actually rendered.
    expect(screen.getByRole("button", { name: /message a teammate/i })).toBeInTheDocument();
  });

  it("does not repeat that labelled control once a DM exists", () => {
    // Once the section has rows in it, the row IS the affordance and the "+"
    // in the header is enough. A permanent button below the list would be a
    // second thing to scan past on every render.
    render(<ChannelRail activeSlug={null} channels={[ROOM, DM]} onNewDm={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /message a teammate/i })).toBeNull();
  });

  it("clicking the labelled control asks the host to open the picker", async () => {
    const onNewDm = vi.fn();
    const user = userEvent.setup();
    render(<ChannelRail activeSlug={null} channels={[ROOM]} onNewDm={onNewDm} />);
    await user.click(screen.getByRole("button", { name: /message a teammate/i }));
    expect(onNewDm).toHaveBeenCalled();
  });
});
