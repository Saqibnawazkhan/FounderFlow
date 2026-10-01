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
// The query string, as the island's `useSearchParams` sees it (chat-010). The
// same seam tests/app/expenses-deep-link.test.tsx uses for `?transactionId=`.
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => nav.params,
}));

// The DEFAULT export is callable as well as carrying .error/.success — chat-010
// uses the plain form for its "couldn't jump there" notice, so the stub has to be
// a function and not an object.
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
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
  locateMessageAction: vi.fn(),
}));
vi.mock("@/app/(app)/chat/[slug]/actions", () => pageActions);

// Children, reduced to the props this island decides.
// `onNewDm` is surfaced as an attribute rather than swallowed: whether this
// island passes it at all is the whole of the reported "no way to message a
// person" bug, and a stub that drops the prop cannot see the difference.
vi.mock("@/components/chat/channel-rail", () => ({
  ChannelRail: ({ onNewDm }: { onNewDm?: () => void }) => (
    <nav aria-label="Channels" data-has-new-dm={onNewDm ? "true" : "false"} />
  ),
}));
vi.mock("@/components/chat/channel-header", () => ({
  ChannelHeader: ({ channel }: { channel: { name: string } }) => <header>{channel.name}</header>,
}));
// `onOpenThread` is exercised rather than dropped: it is the only way into
// <ThreadPanel>, and chat-009 is entirely about what that panel is handed.
vi.mock("@/components/chat/message-list", () => ({
  MessageList: ({
    disabled,
    messages,
    onOpenThread,
    anchoredMessageId,
  }: {
    disabled?: boolean;
    messages?: { id: string }[];
    onOpenThread?: (m: { id: string }) => void;
    // chat-010: WHICH message this island tells the list to anchor is the whole
    // of the finding on this side of the boundary.
    anchoredMessageId?: string | null;
  }) => (
    <div
      data-testid="message-list"
      data-disabled={disabled ? "true" : "false"}
      data-anchor={anchoredMessageId ?? ""}
    >
      <button type="button" onClick={() => onOpenThread?.((messages ?? [])[0] ?? { id: "m_root" })}>
        Open thread
      </button>
    </div>
  ),
}));
// `canPostRunway` is surfaced as an attribute rather than swallowed, because
// whether this island passes it is the whole of reachability row 4.
vi.mock("@/components/chat/message-composer", () => ({
  MessageComposer: ({
    onSent,
    canPostRunway,
    channelKind,
    users,
  }: {
    onSent?: () => void;
    canPostRunway?: boolean;
    // chat-008: the composer cannot decide "Message #general" vs "Message Ahmed
    // Khan" without the kind, so whether this island forwards it is a fact
    // worth asserting rather than a detail the stub drops.
    channelKind?: string;
    // chat-006: the @-autocomplete roster. Surfaced rather than swallowed for
    // the same reason as `canPostRunway` — WHICH list this island hands down is
    // the whole of the finding, and a stub that drops the prop cannot tell a
    // one-person channel from the workspace.
    users?: { id: string; name: string }[];
  }) => (
    <button
      type="button"
      data-testid="composer"
      data-can-post-runway={canPostRunway ? "true" : "false"}
      data-channel-kind={channelKind ?? ""}
      data-mention-roster={(users ?? []).map((u) => u.name).join("|")}
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
  // chat-009: `readOnly` is surfaced as an attribute rather than swallowed. The
  // finding is precisely that this island computed `readOnly` for the timeline
  // and forwarded nothing to the panel, so a stub that drops the prop cannot
  // tell the fix from the bug.
  ThreadPanel: ({ open, readOnly }: { open: boolean; readOnly?: boolean }) =>
    open ? (
      <div role="dialog" data-read-only={readOnly === undefined ? "absent" : String(readOnly)}>
        Thread
      </div>
    ) : null,
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
  nav.params = new URLSearchParams();
  router.refresh.mockReset();
  router.push.mockReset();
  toastMock.mockReset();
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

  it("offers nothing while the session is still resolving", () => {
    // `beforeEach` leaves the session at status "loading", so this is the
    // fail-closed case: an unknown company role is not an admin, and the worst
    // outcome is a control that appears a frame late rather than one drawn for
    // somebody the server would refuse.
    renderClient(channel({ kind: "private", isMember: true, myChannelRole: "member" }));

    expect(screen.queryByRole("button", { name: /add people/i })).not.toBeInTheDocument();
  });

  it("offers nothing to a plain member who does not own the channel", () => {
    signedInAs("member");
    renderClient(channel({ kind: "private", isMember: true, myChannelRole: "member" }));

    expect(screen.queryByRole("button", { name: /add people/i })).not.toBeInTheDocument();
  });

  /* ── THE RESIDUAL HALF OF chat-003 ──────────────────────────────────────
   *
   * `addChannelMembersAction` gates on `canManageChannel`, which admits a
   * company admin or cofounder for ANY channel in the workspace as well as the
   * channel's own owner. This island drew the control for `myChannelRole ===
   * "owner"` alone — a second, NARROWER copy of a rule that lives in
   * lib/auth/channel-permissions.ts, which is exactly what that module's header
   * forbids ("If you find yourself writing `if (role === "admin")` … the rule
   * belongs here instead", and the same goes for writing half of one).
   *
   * The consequence is not cosmetic. There is no other membership write in the
   * product: no join action, no route, no second dialog. So an admin who was
   * INVITED into a private channel, or who inherited one whose creator has since
   * been deactivated, had no way to add anybody to it ever again — and the
   * channel's "Only people you add can see this channel" promise became
   * unfulfillable for that channel permanently.
   *
   * The role is already in this component's hands: it reads `useSession()` for
   * the Runway gate on the very next screenful. The comment claiming otherwise
   * ("this component is not handed the viewer's company role") was stale.
   */
  it("lets a company admin add people to a private channel they did not create", async () => {
    signedInAs("admin");
    renderClient(channel({ kind: "private", isMember: true, myChannelRole: "member" }));

    expect(screen.getByRole("button", { name: /add people/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add people/i }));
    expect(await screen.findByRole("checkbox", { name: /bilal ahmed/i })).toBeInTheDocument();
  });

  it("lets a cofounder do the same, because the predicate admits cofounders", () => {
    signedInAs("cofounder");
    renderClient(channel({ kind: "private", isMember: true, myChannelRole: "member" }));

    expect(screen.getByRole("button", { name: /add people/i })).toBeInTheDocument();
  });

  it("does not hand an admin a way around a DM's two-person identity", () => {
    signedInAs("admin");
    renderClient(channel({ kind: "dm", isMember: true, myChannelRole: "member", memberCount: 2 }));

    expect(screen.queryByRole("button", { name: /add people/i })).not.toBeInTheDocument();
  });

  it("does not hand an admin a way into an archived channel", () => {
    signedInAs("admin");
    renderClient(
      channel({
        kind: "private",
        isMember: true,
        myChannelRole: "member",
        archivedAt: "2026-09-01T00:00:00.000Z",
      })
    );

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

/* ═════════ chat-006 — who the @-picker offers in a channel ════════════════
 *
 * The composer's autocomplete was fed `channel.members`, which is the
 * ChannelMember rows. For a PRIVATE channel or a DM that is exactly right:
 * membership is the permission, and `sendMessageAction` intersects mention
 * recipients against the member list for any non-public kind, so offering an
 * outsider would render a chip that notified nobody.
 *
 * For a PUBLIC channel it is wrong in the direction that loses a message. The
 * action parses mentions against the whole live company roster
 * (`db.user.findMany({ companyId, deletedAt: null })`) and skips the membership
 * filter entirely when `channel.kind === "public"` — "anyone in the company can
 * already read them". So in a freshly created public channel, whose only
 * ChannelMember row is its creator, the picker offered one name while the server
 * stood ready to notify the whole workspace. The roster the picker offers and
 * the roster the server fans out to have to be the same set.
 *
 * `dmCandidates` is that set, already in this island's props and already
 * tombstone-filtered by `listDmCandidates` — so this costs no new query.
 */
describe("ChatClient — the @-mention roster (chat-006)", () => {
  it("offers everyone in the workspace in a public channel, not just its members", () => {
    renderClient(channel({ kind: "public", isMember: false, memberCount: 1 }));

    expect(screen.getByTestId("composer")).toHaveAttribute(
      "data-mention-roster",
      "Ayesha Raza|Bilal Ahmed"
    );
  });

  it("offers only the members of a private channel", () => {
    renderClient(
      channel({ kind: "private", isMember: true, myChannelRole: "owner", memberCount: 1 })
    );

    expect(screen.getByTestId("composer")).toHaveAttribute("data-mention-roster", "Ayesha Raza");
  });

  it("offers only the two participants of a DM", () => {
    renderClient(
      channel({
        kind: "dm",
        isMember: true,
        myChannelRole: "member",
        memberCount: 2,
        members: [
          { id: ME, name: "Saqib Nawaz" },
          { id: "u_bilal", name: "Bilal Ahmed" },
        ],
      })
    );

    expect(screen.getByTestId("composer")).toHaveAttribute(
      "data-mention-roster",
      "Saqib Nawaz|Bilal Ahmed"
    );
  });

  it("never offers the same person twice when they are already a member", () => {
    // Ayesha is both a ChannelMember and a DM candidate. A naive concat would
    // list her twice, and two identical rows in an autocomplete is how a picker
    // starts inserting the wrong token.
    renderClient(channel({ kind: "public", isMember: true, memberCount: 1 }));

    const roster = screen.getByTestId("composer").getAttribute("data-mention-roster") ?? "";
    const names = roster.split("|");
    expect(new Set(names).size).toBe(names.length);
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

/* ══ THE REPORTED BUG — "no option for dm in chat" ═══════════════════════════
 *
 * Reported from the running product, with a screenshot of a rail showing a
 * CHANNELS heading and nothing else.
 *
 * `onNewDm` was passed as `dmCandidates.length > 0 ? … : undefined`, so in a
 * workspace of one the rail's whole Direct section vanished and there was no
 * control anywhere that said "message a person". The reasoning in the comment
 * was that a picker with nobody in it is a dead end — but <NewDmModal> ALREADY
 * has the honest copy for that case ("You're the only person in this workspace
 * — invite someone from the Team page"), and withholding the trigger was the
 * only thing making that branch unreachable. A hidden control and a control
 * that explains itself are not the same trade.
 * ─────────────────────────────────────────────────────────────────────────── */
describe("ChatClient — the way to start a direct message is always there", () => {
  it("offers the DM control when there are teammates to message", () => {
    renderClient(channel({ kind: "public", isMember: true }));
    expect(screen.getByRole("navigation", { name: "Channels" })).toHaveAttribute(
      "data-has-new-dm",
      "true"
    );
  });

  it("STILL offers it in a workspace of one, and lets the picker explain", () => {
    renderClient(channel({ kind: "public", isMember: true }), { dmCandidates: [] });
    expect(screen.getByRole("navigation", { name: "Channels" })).toHaveAttribute(
      "data-has-new-dm",
      "true"
    );
  });
});

/* ══ chat-008 — the composer has to know what it is talking to ═══════════════ */
describe("ChatClient — the conversation's kind reaches the composer", () => {
  it("forwards a room's kind", () => {
    renderClient(channel({ kind: "public", isMember: true }));
    expect(screen.getByTestId("composer")).toHaveAttribute("data-channel-kind", "public");
  });

  it("forwards a DM's kind, which is what stops 'Message #Ahmed Khan'", () => {
    renderClient(
      channel({
        kind: "dm",
        slug: "dm-u_me_u_bilal",
        name: "Bilal Ahmed",
        isMember: true,
        memberCount: 2,
      })
    );
    expect(screen.getByTestId("composer")).toHaveAttribute("data-channel-kind", "dm");
  });
});

/* ═════════ chat-009 — an archived conversation is read-only in the thread ══
 *
 * This island already computed `readOnly` from `canPostInChannel` and swapped the
 * timeline's composer for "This channel is archived — it's read-only now." Then it
 * rendered <ThreadPanel> and forwarded nothing, so the panel's composer and every
 * reaction bar in it fell back to `disabled={false}`: an enabled Send button and a
 * live emoji picker inside a conversation whose every write the server refuses. The
 * optimistic reaction flips on and rolls back under the cursor.
 *
 * `readOnly` is FORWARDED, never recomputed inside the panel — `MessageClient`
 * carries no `kind`, `isMember` or `archivedAt`, so a second copy of the rule there
 * would be derived from a subset of the facts. These assertions are therefore about
 * the wiring, which is the half that was missing; what the flag then DOES is pinned
 * in tests/components/thread-panel.test.tsx against the real composer.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("ChatClient — the thread panel inherits read-only (chat-009)", () => {
  const openThread = async () => {
    const user = userEvent.setup();
    pageActions.loadThreadAction.mockResolvedValue({
      success: true,
      data: {
        root: { id: "m_root", channelId: "ch_growth", reactions: [], segments: [] },
        replies: [],
      },
    });
    await user.click(screen.getByRole("button", { name: /open thread/i }));
    return screen.findByRole("dialog");
  };

  beforeEach(() => {
    pageActions.loadThreadAction.mockReset();
  });

  it("tells the panel the conversation is read-only when the channel is archived", async () => {
    renderClient(channel({ isMember: true, archivedAt: "2026-09-20T00:00:00.000Z" }));

    expect(await openThread()).toHaveAttribute("data-read-only", "true");
  });

  it("tells the panel the conversation is read-only for a non-member of a private channel", async () => {
    // Reachable today, without archive having a button: an admin may SEE a
    // private channel they were never added to (`canSeeChannel` lets the company
    // role through) and so can open a thread in it, while `canPostInChannel`
    // refuses the write.
    signedInAs("admin");
    renderClient(channel({ kind: "private", isMember: false }));

    expect(await openThread()).toHaveAttribute("data-read-only", "true");
  });

  it("leaves the panel postable in a live channel", async () => {
    // Guards the guard: forwarding a hard-coded `true` would pass both cases
    // above and break replying everywhere in the product.
    renderClient(channel({ kind: "public", isMember: true }));

    expect(await openThread()).toHaveAttribute("data-read-only", "false");
  });
});

/* ═════════ chat-010 — a mention notification lands ON its message ══════════
 *
 * `sendMessageAction` writes `/chat/<slug>?message=<id>` into every mention and
 * DM notification and lib/queries/search.ts writes the same shape for a chat hit
 * in the command palette. No file under app/(app)/chat/** or components/chat/**
 * read the parameter, so each of those links dropped the reader at the bottom of
 * a busy room with nothing anchored — and `?taskId=` and `?transactionId=` are
 * both honoured on their own surfaces, which makes it look arbitrary rather than
 * like a rule.
 *
 * THE CASE THE TIMELINE CANNOT SERVE AT ALL: a reply inside a thread has
 * `parentId != null` and `getMessagesPage` excludes it, so the panel is the only
 * place it renders. Before this, the notification that took someone to a thread
 * reply was the one link that could not work at any scroll position.
 *
 * The decision itself is `nextAnchorStep` in lib/chat/anchor.ts and is pinned
 * there; what is asserted here is that this island acts on it, and that it acts
 * at most once per anchor — this component re-renders every five seconds from the
 * activity poll.
 * ════════════════════════════════════════════════════════════════════════════ */
describe("ChatClient — the ?message= deep link (chat-010)", () => {
  const timeline = [
    { id: "m1", channelId: "ch_growth", createdAt: "2026-09-26T08:00:00.000Z" },
    { id: "m2", channelId: "ch_growth", createdAt: "2026-09-26T08:05:00.000Z" },
  ] as unknown as MessageClient[];

  beforeEach(() => {
    pageActions.loadThreadAction.mockReset();
    pageActions.loadOlderMessagesAction.mockReset();
    pageActions.locateMessageAction.mockReset();
  });

  it("anchors the named message when it is already in the loaded page", () => {
    nav.params = new URLSearchParams("message=m2");
    renderClient(channel({ isMember: true }), { initialMessages: timeline });

    expect(screen.getByTestId("message-list")).toHaveAttribute("data-anchor", "m2");
    // The common case — a mention from a minute ago is in the first page by
    // definition — must cost no round trip at all.
    expect(pageActions.locateMessageAction).not.toHaveBeenCalled();
  });

  it("anchors nothing when the link named no message", () => {
    renderClient(channel({ isMember: true }), { initialMessages: timeline });

    expect(screen.getByTestId("message-list")).toHaveAttribute("data-anchor", "");
    expect(pageActions.locateMessageAction).not.toHaveBeenCalled();
  });

  it("ignores a junk message param instead of passing it on", () => {
    // `parseMessageAnchor` refuses anything that is not an id shape, so nothing
    // downstream — a DOM id, a server action — has to think about it.
    nav.params = new URLSearchParams("message=%3Cscript%3E");
    renderClient(channel({ isMember: true }), { initialMessages: timeline });

    expect(screen.getByTestId("message-list")).toHaveAttribute("data-anchor", "");
    expect(pageActions.locateMessageAction).not.toHaveBeenCalled();
  });

  it("asks the server where an unloaded message lives, exactly once", async () => {
    nav.params = new URLSearchParams("message=m_elsewhere");
    pageActions.locateMessageAction.mockResolvedValue({ success: true, data: { rootId: null } });

    renderClient(channel({ isMember: true }), { initialMessages: timeline });

    await waitFor(() => expect(pageActions.locateMessageAction).toHaveBeenCalled());
    expect(pageActions.locateMessageAction).toHaveBeenCalledTimes(1);
    expect(pageActions.locateMessageAction.mock.calls[0][0]).toMatchObject({
      messageId: "m_elsewhere",
      slug: "growth",
    });
  });

  it("opens the thread panel when the named message is a REPLY", async () => {
    // The case no amount of paging or scrolling could ever serve: the timeline
    // excludes `parentId != null`, so before this the mention that took someone to
    // a thread reply was the one link that could not work.
    nav.params = new URLSearchParams("message=m_reply");
    pageActions.locateMessageAction.mockResolvedValue({
      success: true,
      data: { rootId: "m_root" },
    });
    pageActions.loadThreadAction.mockResolvedValue({
      success: true,
      data: {
        root: { id: "m_root", channelId: "ch_growth", reactions: [], segments: [] },
        replies: [],
      },
    });

    renderClient(channel({ isMember: true }), { initialMessages: timeline });

    await waitFor(() => expect(pageActions.loadThreadAction).toHaveBeenCalled());
    expect(pageActions.loadThreadAction.mock.calls[0][0]).toMatchObject({ rootId: "m_root" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("points the reader at the control that would reach an older root", async () => {
    // Not silence. A link that lands somewhere and explains nothing is the bug
    // being closed, and "Load earlier messages" is a button that already exists
    // three lines up the page.
    nav.params = new URLSearchParams("message=m_old");
    pageActions.locateMessageAction.mockResolvedValue({ success: true, data: { rootId: null } });

    renderClient(channel({ isMember: true }), {
      initialMessages: timeline,
      initialCursor: "cur1",
    });

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(String(toastMock.mock.calls[0][0])).toMatch(/load earlier messages/i);
    // It does NOT fetch on the reader's behalf. That was tried, and it is recorded
    // as scoped-out rather than left in half-working.
    expect(pageActions.loadOlderMessagesAction).not.toHaveBeenCalled();
  });

  it("tells the reader when the message cannot be found at all", async () => {
    // A deleted message, or an id from another workspace, or a channel this
    // reader cannot see — `locateMessageAction` answers all three the same way.
    nav.params = new URLSearchParams("message=m_gone");
    pageActions.locateMessageAction.mockResolvedValue({
      success: false,
      error: "That message is no longer here",
    });

    renderClient(channel({ isMember: true }), { initialMessages: timeline });

    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(String(toastMock.mock.calls[0][0])).toMatch(/no longer here/i);
    expect(pageActions.loadThreadAction).not.toHaveBeenCalled();
  });
});
