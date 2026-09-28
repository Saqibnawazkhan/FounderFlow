/**
 * <ChatClient> — who may post, and whether the room is live.
 *
 * THREE FINDINGS LIVE HERE.
 *
 *  chat-002  Every channel except #general was read-only for everyone but its
 *            creator. `readOnly = archived || !channel.isMember` contradicts
 *            `canPostInChannel` ("public channel — every company member can
 *            read and post, joined or not"), and the copy shown instead told
 *            the reader to "Join this channel to post in it" when no join
 *            control exists anywhere in the product.
 *
 *  chat-003  A private channel could never have a second person in it. The
 *            creator is the only ChannelMember any code path ever writes, and
 *            the New-channel dialog promises "Only people you add can see this
 *            channel".
 *
 *  chat-004  Chat was not live. The only refetch was the composer's own
 *            `onSent`, so a teammate's message never appeared until the reader
 *            wrote something themselves or reloaded.
 *
 * WHAT IS MOCKED AND WHY. Every child component is stubbed down to the props
 * this island decides: the questions here are "is a composer offered?", "what
 * does the read-only notice say?", "is the reaction rail live?", "who can be
 * added?" and "does anything refetch on its own?" — all of which are
 * ChatClient's own decisions, and all of which get buried if the real rail,
 * header, list and composer render. `canPostInChannel` is deliberately NOT
 * mocked: it is the rule, and stubbing it would assert that the component calls
 * a stub rather than that it obeys the same predicate the server does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatClient } from "@/app/(app)/chat/[slug]/chat-client";
import type { ChannelDetail, ChannelListItem, MessageClient } from "@/lib/queries/chat";

/* ───────────────────────────── mocks ─────────────────────────────────── */

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: toastMock }));

/**
 * The viewer's company role, as the browser already has it.
 *
 * <Providers> wraps the whole app in next-auth's <SessionProvider> and
 * components/providers.tsx already reads `session.user.role` out of it to
 * hydrate the store, so the role is not a new thing shipped to the client — it
 * is a thing this island was not reading.
 */
const sessionMock = vi.hoisted(() => ({
  data: null as { user?: { id?: string; role?: string } } | null,
  status: "loading" as "loading" | "authenticated" | "unauthenticated",
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: sessionMock.data, status: sessionMock.status }),
}));

function signedInAs(role: "admin" | "cofounder" | "member") {
  sessionMock.data = { user: { id: "u_me", role } };
  sessionMock.status = "authenticated";
}

const chatActions = vi.hoisted(() => ({
  pollChannelActivityAction: vi.fn(),
  addChannelMembersAction: vi.fn(),
  markChannelReadAction: vi.fn(),
  toggleReactionAction: vi.fn(),
}));
vi.mock("@/lib/actions/chat", () => chatActions);

const pageActions = vi.hoisted(() => ({
  loadOlderMessagesAction: vi.fn(),
  loadThreadAction: vi.fn(),
}));
vi.mock("@/app/(app)/chat/[slug]/actions", () => pageActions);

// Children, reduced to the props this island decides.
vi.mock("@/components/chat/channel-rail", () => ({
  ChannelRail: () => <nav aria-label="Channels" />,
}));
vi.mock("@/components/chat/channel-header", () => ({
  ChannelHeader: ({ channel }: { channel: { name: string } }) => <header>{channel.name}</header>,
}));
vi.mock("@/components/chat/message-list", () => ({
  MessageList: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="message-list" data-disabled={disabled ? "true" : "false"} />
  ),
}));
// `canPostRunway` is surfaced as an attribute rather than swallowed, because
// whether this island passes it is the whole of reachability row 4.
vi.mock("@/components/chat/message-composer", () => ({
  MessageComposer: ({
    onSent,
    canPostRunway,
  }: {
    onSent?: () => void;
    canPostRunway?: boolean;
  }) => (
    <button
      type="button"
      data-testid="composer"
      data-can-post-runway={canPostRunway ? "true" : "false"}
      onClick={() => onSent?.()}
    >
      Send a message
    </button>
  ),
}));
vi.mock("@/components/chat/new-channel-modal", () => ({
  NewChannelModal: () => null,
}));
vi.mock("@/components/chat/new-dm-modal", () => ({
  NewDmModal: () => null,
}));
vi.mock("@/components/chat/thread-panel", () => ({
  ThreadPanel: ({ open }: { open: boolean }) => (open ? <div role="dialog">Thread</div> : null),
}));

/* ──────────────────────────── fixtures ──────────────────────────────── */

const ME = "u_me";
const LAST = "2026-09-26T09:00:00.000Z";

function channel(overrides: Partial<ChannelDetail> = {}): ChannelDetail {
  return {
    id: "ch_growth",
    slug: "growth",
    name: "growth",
    kind: "public",
    topic: null,
    memberCount: 1,
    unreadCount: 0,
    lastMessageAt: LAST,
    isMember: false,
    archivedAt: null,
    members: [{ id: "u_creator", name: "Ayesha Raza" }],
    myChannelRole: null,
    ...overrides,
  };
}

const rail: ChannelListItem[] = [];

function renderClient(
  ch: ChannelDetail,
  props: Partial<React.ComponentProps<typeof ChatClient>> = {}
) {
  return render(
    <ChatClient
      channels={rail}
      channel={ch}
      dmCandidates={[
        { id: "u_bilal", name: "Bilal Ahmed", existingSlug: null },
        { id: "u_creator", name: "Ayesha Raza", existingSlug: null },
      ]}
      initialMessages={[] as MessageClient[]}
      initialCursor={null}
      currentUserId={ME}
      {...props}
    />
  );
}

beforeEach(() => {
  router.refresh.mockReset();
  router.push.mockReset();
  toastMock.error.mockReset();
  chatActions.pollChannelActivityAction.mockReset();
  chatActions.addChannelMembersAction.mockReset();
  chatActions.pollChannelActivityAction.mockResolvedValue({
    success: true,
    data: { lastMessageAt: LAST },
  });
  chatActions.addChannelMembersAction.mockResolvedValue({ success: true, data: { added: 1 } });
  sessionMock.data = null;
  sessionMock.status = "loading";
});

/* ═════════════════ chat-002 — who may post in a channel ══════════════ */

describe("ChatClient — posting rights (chat-002)", () => {
  it("gives a non-member of a PUBLIC channel a composer", () => {
    // The finding, in the reader's terms: a teammate opens #growth, which
    // somebody else created, and can talk in it.
    renderClient(channel({ kind: "public", isMember: false }));

    expect(screen.getByRole("button", { name: /send a message/i })).toBeInTheDocument();
    expect(screen.queryByText(/join this channel/i)).not.toBeInTheDocument();
  });

  it("leaves the reaction rail live for a non-member of a public channel", () => {
    // `disabled` reached MessageList from the same wrong predicate, so every
    // reaction chip and the "add reaction" control were dead too.
    renderClient(channel({ kind: "public", isMember: false }));

    expect(screen.getByTestId("message-list")).toHaveAttribute("data-disabled", "false");
  });

  it("keeps an archived channel read-only even for a member", () => {
    renderClient(
      channel({ kind: "public", isMember: true, archivedAt: "2026-09-01T00:00:00.000Z" })
    );

    expect(screen.queryByRole("button", { name: /send a message/i })).not.toBeInTheDocument();
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
    expect(screen.getByTestId("message-list")).toHaveAttribute("data-disabled", "true");
  });

  it("never tells a reader to join a channel, because nothing can join one", () => {
    // A private non-member is the only remaining read-only-and-not-archived
    // case. The instruction they used to get was impossible to follow: there
    // is no joinChannelAction, no join route and no join button in the repo.
    renderClient(channel({ kind: "private", isMember: false }));

    expect(screen.queryByRole("button", { name: /send a message/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/join this channel/i)).not.toBeInTheDocument();
  });
});

/* ══════════════ chat-004 — a teammate's message arrives ══════════════ */

describe("ChatClient — the room is live (chat-004)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refetches on its own when a teammate posts, with nobody touching anything", async () => {
    chatActions.pollChannelActivityAction.mockResolvedValue({
      success: true,
      data: { lastMessageAt: "2026-09-26T09:00:30.000Z" },
    });

    renderClient(channel({ kind: "public", isMember: true }));
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(chatActions.pollChannelActivityAction).toHaveBeenCalled();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("costs one cheap query, not a render, while the channel is idle", async () => {
    // The activity probe answers with the SAME watermark the page was built
    // from, so there is nothing new and no RSC re-render is worth paying for.
    renderClient(channel({ kind: "public", isMember: true }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(chatActions.pollChannelActivityAction).toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("polls nothing at all while the tab is in the background", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      renderClient(channel({ kind: "public", isMember: true }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(chatActions.pollChannelActivityAction).not.toHaveBeenCalled();
      expect(router.refresh).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("catches the room up the moment the reader comes back to the tab", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderClient(channel({ kind: "public", isMember: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(chatActions.pollChannelActivityAction).not.toHaveBeenCalled();

    spy.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    // Immediately, not on the next tick: someone who has just looked back at
    // the window should not wait out a poll interval.
    await waitFor(() => expect(chatActions.pollChannelActivityAction).toHaveBeenCalled());
    spy.mockRestore();
  });
});

/* ═══════════ chat-003 — a private channel can hold two people ═════════ */

describe("ChatClient — adding people to a channel (chat-003)", () => {
  const mine = () =>
    channel({ kind: "private", isMember: true, myChannelRole: "owner", memberCount: 1 });

  it("offers the creator of a private channel a way to add their team", async () => {
    // The dialog that created this channel promised "Only people you add can
    // see this channel". Until now nothing in the product could add anybody.
    renderClient(mine());

    expect(screen.getByRole("button", { name: /add people/i })).toBeInTheDocument();
  });

  it("offers only teammates who are not already in the channel", async () => {
    // Ayesha is already a member (she made it); Bilal is not.
    renderClient(mine());

    await userEvent.click(screen.getByRole("button", { name: /add people/i }));

    expect(await screen.findByRole("checkbox", { name: /bilal ahmed/i })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /ayesha raza/i })).not.toBeInTheDocument();
  });

  it("adds the chosen teammate and brings the channel back with them in it", async () => {
    renderClient(mine());

    await userEvent.click(screen.getByRole("button", { name: /add people/i }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /bilal ahmed/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add 1 person$/i }));

    await waitFor(() => expect(chatActions.addChannelMembersAction).toHaveBeenCalledTimes(1));
    expect(chatActions.addChannelMembersAction.mock.calls[0][0]).toEqual({
      channelId: "ch_growth",
      userIds: ["u_bilal"],
    });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("surfaces a refusal instead of silently pretending it worked", async () => {
    chatActions.addChannelMembersAction.mockResolvedValue({
      success: false,
      error: "Only a channel's owner or an admin can add people",
    });
    renderClient(mine());

    await userEvent.click(screen.getByRole("button", { name: /add people/i }));
    await userEvent.click(await screen.findByRole("checkbox", { name: /bilal ahmed/i }));
    await userEvent.click(screen.getByRole("button", { name: /^add 1 person$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Only a channel's owner or an admin can add people"
      )
    );
  });

  it("offers nothing to someone who does not own the channel", () => {
    renderClient(channel({ kind: "private", isMember: true, myChannelRole: "member" }));

    expect(screen.queryByRole("button", { name: /add people/i })).not.toBeInTheDocument();
  });

  it("offers nothing on a direct message", () => {
    // A DM's identity IS its pair — dmKeyFor sorts two ids and the unique index
    // holds one row per pair. A third member would make the key a lie.
    renderClient(channel({ kind: "dm", isMember: true, myChannelRole: "member", memberCount: 2 }));

    expect(screen.queryByRole("button", { name: /add people/i })).not.toBeInTheDocument();
  });

  it("offers nothing on an archived channel", () => {
    renderClient(
      channel({
        kind: "private",
        isMember: true,
        myChannelRole: "owner",
        archivedAt: "2026-09-01T00:00:00.000Z",
      })
    );

    expect(screen.queryByRole("button", { name: /add people/i })).not.toBeInTheDocument();
  });
});

/* ═════ the Runway card has an entry point — reachability row 4 ════════════
 *
 * `postRunwayCardAction` is the product's differentiator: it posts the
 * workspace's cash / burn / runway snapshot into a conversation. It is
 * complete, unit-tested, re-checks `canPostRunwayCard(role)` server-side, and
 * HAS a caller — <MessageComposer> imports it and calls it. It has still never
 * been reachable, because the button is drawn only when `canPostRunway` is
 * true, the prop defaults to false, and no caller anywhere in the app passed
 * it. tests/lib/actions/reachability.test.ts fails on exactly that
 * ("<message-composer.tsx canPostRunway> is never passed"), and has since
 * before this wave.
 *
 * These assertions are about the CHANNEL composer, which is the only one that
 * can draw the control: <MessageComposer> hides it whenever `parentId` is set,
 * because `PostRunwayCardSchema` carries no parentId and a card posted from a
 * thread would land in the timeline instead — so <ThreadPanel> is not a
 * candidate entry point and is not asserted on here.
 *
 * WHY THE ROLE, AND NOT A BOOLEAN: `canPostRunwayCard` delegates to
 * `canSeeFinances`, and the one thing this island must not do is restate that
 * rule. It is deliberately NOT mocked, for the reason `canPostInChannel` is not
 * mocked above — stubbing the predicate would assert that the component calls a
 * stub, not that it agrees with the server.
 */
describe("ChatClient — the Runway control has an entry point (reachability row 4)", () => {
  const composer = () => screen.getByTestId("composer");

  it("offers the Runway control to an admin", () => {
    signedInAs("admin");
    renderClient(channel({ isMember: true }));
    expect(composer().getAttribute("data-can-post-runway")).toBe("true");
  });

  it("offers it to a cofounder, because the finance boundary says so", () => {
    signedInAs("cofounder");
    renderClient(channel({ isMember: true }));
    expect(composer().getAttribute("data-can-post-runway")).toBe("true");
  });

  it("never offers it to a member — chat is open to every role, the ledger is not", () => {
    // Members never see finance pages (audit-flow #1), and a Runway card in a
    // public channel is read by the whole company.
    signedInAs("member");
    renderClient(channel({ isMember: true }));
    expect(composer().getAttribute("data-can-post-runway")).toBe("false");
  });

  it("offers nothing while the session is still resolving", () => {
    // Fail-closed: an unknown role is not an admin. The worst outcome is a
    // control that appears a moment late.
    renderClient(channel({ isMember: true }));
    expect(composer().getAttribute("data-can-post-runway")).toBe("false");
  });
});
