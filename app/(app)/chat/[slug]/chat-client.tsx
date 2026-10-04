"use client";

/**
 * <ChatClient> — the client island for one open channel.
 *
 * The RSC above it server-renders the rail and the first page of messages and
 * passes them down as props; this component's job is the parts that need a
 * browser: which pane is showing on a phone, the older pages the reader has
 * pulled in, and re-fetching after a send.
 *
 * MESSAGE MERGE: `initialMessages` is always the FRESH newest page (a
 * `router.refresh()` after a send replaces it), while `olderPages` accumulates
 * what the reader scrolled back through. Merging through a Map keyed by id
 * means a refresh can overlap the loaded history without duplicating a row,
 * and the sort makes the list independent of whichever direction the query
 * layer happens to return a page in.
 *
 * MOBILE: below `md` the rail and the conversation are mutually exclusive
 * panes — a 220px rail beside a message column is unreadable on a phone. The
 * header's back button and a channel link are the two ways between them.
 *
 * CREATION LIVES HERE, NOT IN THE RAIL: the rail is a <nav> of links and
 * stays one — it raises `onNewChannel` / `onNewDm` and this island owns the
 * dialogs. Keeping the state one level up is what lets a modal opened from
 * the mobile rail pane sit above BOTH panes, and keeps the rail reusable by
 * any future surface that wants a channel list without a create flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import toast from "react-hot-toast";
import { ArrowDown, UserPlus } from "lucide-react";
import { ChannelHeader } from "@/components/chat/channel-header";
import { ChannelRail } from "@/components/chat/channel-rail";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { NewChannelModal } from "@/components/chat/new-channel-modal";
import { NewDmModal } from "@/components/chat/new-dm-modal";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { Modal } from "@/components/ui/modal";
import {
  addChannelMembersAction,
  pollChannelActivityAction,
  setChannelMuteAction,
} from "@/lib/actions/chat";
import {
  canManageChannel,
  canPostInChannel,
  canPostRunwayCard,
} from "@/lib/auth/channel-permissions";
import { nextAnchorStep, parseMessageAnchor } from "@/lib/chat/anchor";
import { cn } from "@/lib/utils";
import { loadOlderMessagesAction, loadThreadAction, locateMessageAction } from "./actions";
import type {
  ChannelDetail,
  ChannelListItem,
  DmCandidate,
  MessageClient,
} from "@/lib/queries/chat";

/**
 * How often an open channel asks whether anything was said in it (chat-004).
 *
 * Five seconds is the interval a reader reads as "live" without it being a
 * stream. It is affordable because a tick is NOT a refetch: it is
 * `pollChannelActivityAction`, one indexed single-column read, and a
 * `router.refresh()` is spent only when the watermark actually moved. An idle
 * channel therefore costs one cheap query per five seconds per open tab, and a
 * backgrounded tab costs nothing at all.
 */
const ACTIVITY_POLL_MS = 5_000;

type Props = {
  channels: ChannelListItem[];
  channel: ChannelDetail;
  /** Everyone the reader could DM, resolved by the RSC above. */
  dmCandidates: DmCandidate[];
  initialMessages: MessageClient[];
  initialCursor: string | null;
  currentUserId: string;
  /**
   * Is `initialMessages` a window around a `?message=` anchor that does NOT
   * reach the newest message? (chat-010)
   *
   * Only the server can answer it — the island cannot tell "this is the live
   * edge" from "this is fifty rows out of four hundred" by looking at the page
   * it was handed. It matters because the room really is frozen in that state:
   * the activity poll refreshes an anchored page into the same anchored page,
   * so without the control this flag draws, a reader who followed a month-old
   * mention would sit in history with no way back and no sign that newer
   * messages existed.
   *
   * Defaults to false: an ordinary channel open is never a history window, and
   * the honest default for "are you lost in the backlog" is no.
   */
  viewingHistory?: boolean;
};

export function ChatClient({
  channels,
  channel,
  dmCandidates,
  initialMessages,
  initialCursor,
  currentUserId,
  viewingHistory = false,
}: Props) {
  const router = useRouter();
  // chat-010. See the anchor effect below.
  const searchParams = useSearchParams();
  // The viewer's company role, for the Runway control only — see the long note
  // beside `canPostRunway` below.
  const { data: session } = useSession();
  const [, startTransition] = useTransition();

  const [olderPages, setOlderPages] = useState<MessageClient[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // On a phone the reader lands on the conversation, not the index.
  const [railOpen, setRailOpen] = useState(false);

  // The two creation dialogs. Opening one from the mobile rail must NOT run
  // the rail's `onNavigate` — that closes the rail pane, which would yank the
  // list out from under the dialog and leave the reader staring at whichever
  // conversation happened to be open behind it. A modal trigger is not a
  // navigation, so the rail raises these instead of calling `onNavigate`.
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  // ── chat-003: the "add people" dialog ────────────────────────────────────
  // A third dialog, here for the same reason as the two above: it has to be a
  // sibling of both panes so it survives the mobile rail swapping underneath
  // it. `selected` lives here rather than inside the dialog because the dialog
  // is driven by `open` and would otherwise keep a stale tick list.
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  // Thread panel. `thread` holds the loaded conversation; `threadRootId` is
  // set the moment a reply indicator is clicked, so the panel can open on a
  // skeleton instead of waiting for the round-trip before reacting.
  //
  // chat-011: THIS COMMENT WAS FALSE FOR AS LONG AS IT HAS EXISTED. The render
  // below was `{thread && …}` — gated on the LOADED data — and <ThreadPanel>'s
  // `root` was non-nullable, so the state described here could not be reached:
  // the window between the click and the response rendered nothing, and on a
  // slow connection "N replies" looked like a dead control. The render is gated
  // on `threadRootId` now and the panel takes `root: MessageClient | null`,
  // which is what makes the sentence above true.
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ root: MessageClient; replies: MessageClient[] } | null>(
    null
  );

  /**
   * Which thread is open, in a ref as well as in state.
   *
   * The poll below and the composer's `onSent` both need to know, and neither
   * wants the open thread in its dependency list: the poll's effect would tear
   * down and rebuild its interval every time a panel opened or closed. The ref
   * is the read path; the state is what renders.
   */
  const threadRootIdRef = useRef<string | null>(null);

  /**
   * Re-read the open thread from the server. Silent on failure, unlike
   * `openThread`: this runs on a timer and after a send, where the panel is
   * already on screen and showing the previous, correct content — a toast per
   * failed background refresh would be noise about nothing the reader did.
   */
  const reloadThread = useCallback(
    async (rootId: string) => {
      const res = await loadThreadAction({ slug: channel.slug, rootId });
      if (!res.success) return;
      setThread(res.data);
    },
    [channel.slug]
  );

  /**
   * Open the panel on a thread ROOT.
   *
   * Takes an id rather than a `MessageClient` (chat-010): the only field it ever
   * read was `.id`, and the deep-link path has a root id from
   * `locateMessageAction` and no row to go with it. A caller that has the row
   * passes `message.id`; nobody has to fabricate a MessageClient to open a panel.
   */
  const openThread = useCallback(
    async (rootId: string) => {
      setThreadRootId(rootId);
      threadRootIdRef.current = rootId;
      setThread(null);
      const res = await loadThreadAction({ slug: channel.slug, rootId });
      if (!res.success) {
        toast.error(res.error);
        setThreadRootId(null);
        threadRootIdRef.current = null;
        return;
      }
      setThread(res.data);
    },
    [channel.slug]
  );

  const closeThread = useCallback(() => {
    setThreadRootId(null);
    threadRootIdRef.current = null;
    setThread(null);
  }, []);

  const messages = useMemo(() => {
    const byId = new Map<string, MessageClient>();
    for (const m of olderPages) byId.set(m.id, m);
    for (const m of initialMessages) byId.set(m.id, m);
    // Map.forEach into a plain array rather than spreading or Array.from-ing
    // the iterator: this repo compiles with `downlevelIteration` off, where
    // iterating a Map's values is a TS2802.
    const merged: MessageClient[] = [];
    byId.forEach((m) => merged.push(m));
    // Ascending — oldest first, NEWEST LAST — which is both what
    // getMessagesPage returns and the order the list renders top to bottom.
    return merged.sort((a, b) => {
      const delta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      // Ties broken by id so the order is total and stable across renders.
      return delta !== 0 ? delta : a.id.localeCompare(b.id);
    });
  }, [olderPages, initialMessages]);

  /**
   * The merged timeline as of the last render.
   *
   * A ref BESIDE the memo, not instead of it: the deep-link effect below needs to
   * know whether the anchored message is on screen, and listing `messages` as a
   * dependency would re-run it on every page that lands and on every refresh from
   * the activity poll — which is how a one-shot becomes a loop.
   */
  const messagesRef = useRef<MessageClient[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const handleLoadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    const result = await loadOlderMessagesAction({ slug: channel.slug, cursor });
    setLoadingOlder(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    setOlderPages((prev) => [...result.data.messages, ...prev]);
    setCursor(result.data.nextCursor);
  }, [cursor, loadingOlder, channel.slug]);

  // The composer owns the write; we only need the newest page back. A
  // transition keeps the current list on screen while the RSC re-runs.
  //
  // `openThread` is re-run when a thread is open so the reply the reader just
  // wrote lands in the panel too. The panel holds its conversation in local
  // state loaded through `loadThreadAction`, so a `router.refresh()` alone
  // updates the timeline's reply count and leaves the open panel stale.
  const handleSent = useCallback(() => {
    startTransition(() => router.refresh());
    const rootId = threadRootIdRef.current;
    if (rootId) void reloadThread(rootId);
  }, [router, reloadThread]);

  /* ── chat-004: the room keeps itself current ───────────────────────────
   *
   * Before this, the ONLY refetch in the chat surface was `handleSent` above,
   * fired by the reader's own composer. So a teammate's message never appeared
   * in an open channel: two people in a DM each saw a one-sided conversation
   * until one of them reloaded, and MessageList's whole arrival machinery (the
   * `unseen` counter, the "N new messages" pill) could only ever be triggered
   * by the reader's own writes.
   *
   * WHAT THIS IS, AND WHAT IT COSTS. A visibility-aware 5s poll of
   * `pollChannelActivityAction`, which returns `Channel.lastMessageAt` and
   * nothing else, and a `router.refresh()` only when that watermark has moved
   * past the one this render was built from. So:
   *   • idle channel, tab open   → one single-column indexed read / 5s
   *   • a teammate posts          → one refresh, within ~5s
   *   • tab in the background     → nothing; no query, no render
   * The refresh is what lights the rail's unread badge too, because it re-runs
   * `listChannelsForUser` alongside the message page.
   *
   * WHY NOT A SOCKET OR SSE. Stated explicitly because it is a real trade, not
   * an oversight: this app deploys to Vercel serverless, where a WebSocket has
   * nowhere to live, and an SSE stream is a function invocation held open per
   * reader per channel with a platform-capped duration — so it would drop on a
   * timer and need this same reconnect-and-catch-up logic underneath it anyway.
   * Real push needs infrastructure (a hosted realtime service, or Supabase
   * Realtime with a second client and RLS policies this app does not have), and
   * that is a decision to take deliberately rather than a patch to a P1.
   * Polling that works is worth more than realtime that cannot ship.
   *
   * WHY THE WATERMARK IS READ FROM THE PROP and not written by the poll: the
   * prop is what this render actually SHOWS. If a refresh is slow or fails, the
   * prop does not advance, so the next tick tries again — retry for free. A ref
   * updated by the poll itself would swallow the very message it detected.
   */
  const seenActivity = useRef<string | null>(channel.lastMessageAt);
  useEffect(() => {
    seenActivity.current = channel.lastMessageAt;
  }, [channel.lastMessageAt]);

  const checkForActivity = useCallback(async () => {
    // A backgrounded tab is not reading anything, so it should not be paying
    // for a query — nor holding a connection open on a laptop lid that is shut.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const res = await pollChannelActivityAction({ channelId: channel.id });
    if (!res.success) return; // Silent: a failed probe is a missed tick, not an error worth a toast.
    if (res.data.lastMessageAt === seenActivity.current) return;
    startTransition(() => router.refresh());
    const rootId = threadRootIdRef.current;
    if (rootId) void reloadThread(rootId);
  }, [channel.id, router, reloadThread]);

  useEffect(() => {
    const timer = setInterval(() => void checkForActivity(), ACTIVITY_POLL_MS);
    // Coming back to the tab must not mean waiting out an interval: someone who
    // has just looked at the window wants the room current now.
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkForActivity();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkForActivity]);

  /**
   * Land on a channel that has just been created, or a DM that has just been
   * opened.
   *
   * `router.push`, never `window.location`: this is a client-side navigation,
   * so the RSC above re-runs, the rail comes back with the new channel already
   * in it, and the app shell is never torn down and rebuilt.
   *
   * NO MANUAL CLEANUP: the parent keys <ChatClient> on `channel.id`, so
   * arriving at a different channel remounts this whole island — loaded
   * history, cursor, open thread and scroll position all reset to the new
   * channel's own state. That is exactly what we want, and it is why nothing
   * here clears `olderPages` or `thread` by hand.
   *
   * The one thing the remount cannot do is close the mobile rail when the
   * target IS the channel already on screen (a DM you're already reading,
   * reached from the picker): same id, same island, no remount. Closing the
   * pane explicitly covers that case and is a no-op in every other one.
   */
  const goToChannel = useCallback(
    (slug: string) => {
      setRailOpen(false);
      router.push(`/chat/${slug}`);
    },
    [router]
  );

  /* ── chat-002: who may post ─────────────────────────────────────────────
   *
   * This used to be `archived || !channel.isMember`, which made every channel
   * except #general read-only for everyone but its creator — and then told the
   * reader to "Join this channel to post in it" when there is no join control
   * anywhere in the product (no joinChannelAction, no join route, no button;
   * the only three writers of a ChannelMember row are createChannelAction,
   * openDmAction and lib/chat/bootstrap.ts). A new team's first act in chat —
   * "let's make a #growth channel" — produced a room only its creator could
   * write in, and everyone else got an instruction they physically could not
   * follow.
   *
   * `canPostInChannel` is the rule, and now the only copy of it. It says a
   * public channel is postable by every company member, joined or not
   * (membership governs the unread badge, not access), while private and DM are
   * members-only and archived is read-only for everybody including its owner.
   * Restating that here — the `kind === "public" || isMember` form — would be a
   * second copy of a permission rule inside a component, which is what the
   * predicate module's own header forbids; the server checks the identical
   * function, so the two cannot drift.
   */
  /* ── chat-003: who can be added, and by whom ────────────────────────────
   *
   * `createChannelAction` wrote exactly ONE ChannelMember — the creator — and
   * nothing anywhere else in the product ever added a second. So "private —
   * invite-only; membership IS the permission" described a room that could only
   * ever hold one person, while the dialog creating it said "Only people you
   * add can see this channel". A founder who picked Private to talk about a
   * raise got a channel their cofounder could not see, with nothing to click.
   *
   * THE GATE IS `canManageChannel`, NOT A NARROWER COPY OF IT. This used to
   * read `channel.myChannelRole === "owner"`, with a comment explaining that the
   * component "is not handed the viewer's company role" — which was already
   * false when it was written: `useSession()` is read a screenful below for the
   * Runway control, and <Providers> has always put `session.user.role` in the
   * browser. So the honest-subset argument did not apply, and the cost was not
   * cosmetic: there is no other membership write anywhere in the product, so an
   * admin INVITED into a private channel, or one who inherited a channel whose
   * creator has since been deactivated, could never add anybody to it again and
   * the "Only people you add can see this channel" promise became permanently
   * unfulfillable for that channel. Importing the predicate also settles it the
   * way lib/auth/channel-permissions.ts's own header demands — half a copy of a
   * permission rule inside a component is still a copy.
   *
   * FAIL-CLOSED WHILE THE SESSION RESOLVES, exactly like `canPostRunway`: an
   * unknown role is not an admin, so the control appears a frame late rather
   * than in front of somebody the server would refuse.
   *
   * The kind and archived checks stay here beside it. They are not a second
   * copy of a ROLE rule — they are the two flat refusals the action spells out
   * for itself ("a direct message is between two people", "un-archive it
   * first"), and drawing a control whose only possible outcome is that toast
   * would be worse than not drawing it.
   *
   * DMs and archived channels are excluded here as well as server-side: a DM's
   * pair IS its identity (`dmKeyFor` + the unique index), and an archived
   * channel is closed.
   *
   * The roster comes from `dmCandidates` — every LIVE teammate except the
   * viewer, already resolved by the RSC above for the DM picker — minus whoever
   * is in the channel already. No new query, and the tombstone filter that
   * query documents is inherited for free.
   */
  // The viewer's company role, as the browser already has it — see the long
  // note beside `canPostRunway` below for why `useSession()` and not a prop.
  // Read here rather than there because two gates now need it.
  const viewerRole = session?.user?.role;
  const archived = channel.archivedAt !== null;
  const canManage =
    channel.kind !== "dm" &&
    !archived &&
    // `?? "member"` is the fail-closed default AND the no-flicker one, in one
    // move: "member" is the least-privileged role in the union, so an unresolved
    // session can only ever be granted by the predicate's OTHER arm —
    // `channelRole === "owner"` — which is a server-rendered prop that is
    // correct on the first paint. The channel's own creator therefore sees the
    // control immediately, exactly as before, and the admin/cofounder widening
    // waits for the session rather than guessing at it.
    canManageChannel({ role: viewerRole ?? "member", channelRole: channel.myChannelRole });
  const addable = useMemo(() => {
    const already = new Set(channel.members.map((m) => m.id));
    return dmCandidates.filter((c) => !already.has(c.id));
  }, [dmCandidates, channel.members]);

  /* ── chat-006: the roster the @-picker offers ────────────────────────────
   *
   * The composer used to be handed `channel.members`, i.e. the ChannelMember
   * rows. In a private channel or a DM that is the right set and must stay the
   * right set: membership IS the permission there, `sendMessageAction`
   * intersects mention recipients against the member list for every non-public
   * kind, and offering an outsider would render a chip that notified nobody.
   *
   * In a PUBLIC channel it was the wrong set, in the direction that silently
   * loses a message. The action parses mentions against the whole live company
   * roster and skips the membership intersection entirely for a public channel —
   * "anyone in the company can already read them" — so a freshly created public
   * channel offered its one creator while the server stood ready to notify the
   * whole workspace. Whoever the server would fan out to is who the picker has
   * to offer.
   *
   * `dmCandidates` IS that set and is already in this island's props for the DM
   * picker: every live teammate except the viewer, with `listDmCandidates`'
   * `deletedAt: null` filter inherited for free. No new query, and no new
   * disclosure — the same list is already used to populate the "Add people" and
   * "Message a teammate" dialogs on this page.
   *
   * Keyed through a Set rather than concatenated blind: in #general everyone is
   * both a member and a candidate, and two identical rows in an autocomplete is
   * how a picker starts inserting the wrong token.
   */
  const mentionRoster = useMemo<{ id: string; name: string }[]>(() => {
    const members = channel.members.map((m) => ({ id: m.id, name: m.name }));
    if (channel.kind !== "public") return members;
    const already = new Set(members.map((m) => m.id));
    return members.concat(
      dmCandidates.filter((c) => !already.has(c.id)).map((c) => ({ id: c.id, name: c.name }))
    );
  }, [channel.kind, channel.members, dmCandidates]);

  /* ── chat-012: THE MUTE LEVER ────────────────────────────────────────────
   *
   * `ChannelMember.mutedAt` has been in the schema since the chat migration and
   * BOTH notification fan-outs honour it — `sendMessageAction` and
   * `postRunwayCardAction` each drop `mutedAt: { not: null }` members from their
   * recipients. Nothing in the repo ever WROTE it: no action, no route, no
   * control. The suppression was complete, tested and unreachable, which is this
   * codebase's signature defect, and the only thing missing was the lever.
   *
   * WHY LOCAL STATE AND NOT `channel.muted` DIRECTLY. The write is a round trip
   * and the control has to answer the click; seeded from the prop and updated
   * from the SERVER'S answer (never from the click), so a refusal leaves the
   * bell where it was rather than lying about a write that did not happen. The
   * island is keyed on the channel, so this cannot outlive the channel it
   * describes — and the action revalidates both chat paths, so the next render
   * of this island starts from the database again.
   */
  const [muted, setMuted] = useState(channel.muted);
  const [mutePending, setMutePending] = useState(false);

  const toggleMute = useCallback(async () => {
    if (mutePending) return;
    setMutePending(true);
    // The DESIRED state, not a toggle verb: the server is idempotent on an
    // absolute value, so a double tap or a second tab cannot land the opposite
    // of what the reader last pressed. See `SetChannelMuteSchema`.
    const res = await setChannelMuteAction({ channelId: channel.id, muted: !muted });
    setMutePending(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    setMuted(res.data.muted);
    // The copy says what mute did NOT do, which is the half people get wrong: a
    // muted channel keeps its place in the rail and keeps counting unread
    // messages (`unreadChatTotal` counts muted channels deliberately). Somebody
    // who muted it to make it go away should hear that here rather than
    // discover it.
    toast.success(
      res.data.muted
        ? "Muted. It stays in your list and still shows unread messages — you just won't be notified."
        : "Unmuted. You'll be notified about this conversation again."
    );
    // The header's own state comes from the RSC on the next render; refresh so
    // a reload is not what it takes for the two to agree.
    startTransition(() => router.refresh());
  }, [mutePending, muted, channel.id, router]);

  const closeAdd = useCallback(() => {
    setAddOpen(false);
    setSelected([]);
  }, []);

  const toggleCandidate = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.concat(id)));
  }, []);

  const submitAdd = useCallback(async () => {
    if (selected.length === 0 || adding) return;
    setAdding(true);
    const res = await addChannelMembersAction({ channelId: channel.id, userIds: selected });
    setAdding(false);
    if (!res.success) {
      // Surfaced, never swallowed: the server can legitimately refuse (a
      // revoked owner role, an id that left the workspace mid-dialog), and a
      // dialog that closed cheerfully on a refusal is how "private" came to
      // mean "nobody else is in here" without anyone noticing.
      toast.error(res.error);
      return;
    }
    toast.success(res.data.added === 1 ? "1 person added" : `${res.data.added} people added`);
    closeAdd();
    // The member list, the header's count and the rail all come from the RSC.
    startTransition(() => router.refresh());
  }, [selected, adding, channel.id, router, closeAdd]);

  /* ── chat-010: FOLLOWING A MENTION BACK TO ITS MESSAGE ───────────────────
   *
   * `sendMessageAction` has always written `/chat/<slug>?message=<id>` into every
   * mention and DM notification, and lib/queries/search.ts writes the same shape
   * for a chat hit in the command palette. Nothing in this surface read the
   * parameter, so every one of those links dropped the reader at the bottom of a
   * busy room with nothing anchored — while `?taskId=` and `?transactionId=` are
   * both honoured on their own surfaces, which makes it read as arbitrary rather
   * than as a rule.
   *
   * THE DECISION IS NOT HERE. `nextAnchorStep` owns it, in lib/chat/anchor.ts,
   * because none of it is observable from jsdom and all of it is worth pinning.
   * This effect is the plumbing.
   *
   * THE COMMON CASE COSTS NOTHING. A mention from a minute ago is in the first
   * page by definition, so the step is `highlight`, the effect returns, and the
   * render below hands the id to <MessageList>, which marks the row and scrolls
   * to it. No round trip, no state machine.
   *
   * AND SO DOES THE OLD CASE, NOW — BUT NOT FROM HERE. An anchor further back
   * than the newest page used to end in `not-loaded` and a toast, because this
   * island could not reach it. It is served upstream instead:
   * `app/(app)/chat/[slug]/page.tsx` reads the same parameter and asks
   * `getMessagesPageAnchoredAt` for the window CONTAINING the anchor, so by the
   * time this effect runs the row is in `initialMessages` and the step is
   * `highlight` exactly like a fresh mention. One fetch, on the server, with no
   * loop — see the paragraph below for why that distinction is load-bearing.
   *
   * ONE SHOT, AND ONE ROUND TRIP AT MOST. `handledAnchor` latches per anchor id:
   * this island re-renders every five seconds from the activity poll, and an
   * effect that re-derived its work each time would reopen a panel the reader had
   * just closed. An earlier draft re-evaluated the step after every page that
   * landed, so it could page backwards to an older root on the reader's behalf.
   * Its own cases passed in isolation and it wedged this test file whenever the
   * blocks above it had run first — a hang, not a failure, so no timeout fired.
   * Removing the re-running loop fixed it; the precise mechanism (a re-entrant
   * effect racing the panel-opening path inside testing-library's act queue) I
   * narrowed but did not isolate. That loop is still not coming back: the page
   * above fetches the right window ONCE, before this component exists, which is
   * the same outcome with no client state machine to wedge.
   *
   * WHY `useSearchParams` AND NOT THE RSC'S `searchParams`. The house pattern —
   * tasks-client and expenses-client both read their deep link this way — and it
   * keeps the anchor a client concern: following a second notification while the
   * tab is open is a client-side navigation that never re-runs the page.
   */
  const anchorId = useMemo(() => parseMessageAnchor(searchParams.get("message")), [searchParams]);
  const handledAnchor = useRef<string | null>(null);

  useEffect(() => {
    if (!anchorId || handledAnchor.current === anchorId) return;

    const loadedIds = messagesRef.current.map((m) => m.id);
    const first = nextAnchorStep({ anchorId, loadedIds, located: false, rootId: null });
    // Already on screen: the render is the whole of the fix for this case.
    if (first.kind !== "locate") return;

    // Latched only once there is actually a round trip to make, so a render that
    // happened before the first page arrived cannot burn the one shot.
    handledAnchor.current = anchorId;

    let alive = true;
    void (async () => {
      const res = await locateMessageAction({ slug: channel.slug, messageId: anchorId });
      // Unmounted while the lookup was in flight — a channel switch remounts this
      // island, and finishing the work would set state on a component that is
      // gone and act on a conversation nobody is looking at any more.
      if (!alive) return;
      if (!res.success) {
        toast(res.error, { icon: "ℹ️" });
        return;
      }
      const step = nextAnchorStep({
        anchorId,
        loadedIds: messagesRef.current.map((m) => m.id),
        located: true,
        rootId: res.data.rootId,
      });
      if (step.kind === "open-thread") {
        // A reply has `parentId != null` and `getMessagesPage` filters those out,
        // so the panel is the ONLY place it renders. This is the case that could
        // not work at all before, at any scroll position.
        void openThread(step.rootId);
        return;
      }
      if (step.kind === "not-loaded") {
        // THE FALLBACK, not the ordinary path any more. The page above serves
        // the window containing the anchor, so reaching here means the server
        // render and this lookup disagreed about where the message is — the
        // window was not built (and `locateMessageAction` would then have
        // failed, taking the branch above), or the timeline moved underneath a
        // tab that had been open a while. Kept because the alternative is a
        // link that lands somewhere and explains nothing, which is the bug this
        // whole finding is about, and because it points at a control that
        // genuinely exists three lines up the page.
        toast("That message is further back — load earlier messages to reach it.", {
          icon: "ℹ️",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [anchorId, channel.slug, openThread, messagesRef]);

  const readOnly = !canPostInChannel({
    kind: channel.kind,
    isMember: channel.isMember,
    archivedAt: channel.archivedAt,
  });

  /* ── THE RUNWAY CARD GETS AN ENTRY POINT ─────────────────────────────────
   *
   * `postRunwayCardAction` — posting the workspace's cash / burn / runway
   * snapshot into a conversation, and the product's own differentiator — was
   * complete, unit-tested, server-gated, imported and CALLED by
   * <MessageComposer>, and still unreachable: the button behind it is drawn only
   * when `canPostRunway` is true, the prop defaults to false (correctly,
   * fail-closed), and NO caller in the app ever passed it. So the feature had a
   * component, an action, a permission predicate, green tests and no way in.
   * `tests/lib/actions/reachability.test.ts` fails on exactly that, in two
   * places, and has since before this fix wave.
   *
   * THE PREDICATE IS THE RULE, and it is imported rather than restated:
   * `canPostRunwayCard` delegates to `canSeeFinances`, so "who may disclose the
   * company balance in a room every role can read" is answered in one place and
   * the server re-asks the identical function. `readOnly` above is derived the
   * same way for the same reason.
   *
   * WHY THE ROLE COMES FROM `useSession()` RATHER THAN A SERVER-RENDERED PROP.
   * The prop's own doc prefers server-rendered, and threading `viewerRole` down
   * from the RSC would be marginally better — one fewer frame before the control
   * appears. It needs a line in `app/(app)/chat/[slug]/page.tsx`, which this
   * island does not own, and that change is reported rather than made. Reading
   * it here is not a new disclosure: <Providers> already wraps the app in
   * next-auth's <SessionProvider>, and components/providers.tsx already reads
   * `session.user.role` out of it to hydrate the store — the role is in the
   * browser either way. What matters is that this is NOT the gate: the action
   * re-checks `canPostRunwayCard(session.role)` server-side before it computes a
   * single figure, so a tampered client draws a button whose click is refused.
   *
   * FAIL-CLOSED WHILE THE SESSION RESOLVES. An unknown role is not an admin, so
   * the worst case is a control that appears a moment late rather than one shown
   * to a member.
   */
  const canPostRunway = viewerRole ? canPostRunwayCard(viewerRole) : false;

  return (
    <div className="flex h-full min-h-0">
      <ChannelRail
        channels={channels}
        activeSlug={channel.slug}
        onNavigate={() => setRailOpen(false)}
        onNewChannel={() => setNewChannelOpen(true)}
        /* ── THE REPORTED BUG: "theres no option for dm in chat" ─────────────
         *
         * This was `dmCandidates.length > 0 ? … : undefined`. The reasoning was
         * that a picker with nobody in it is a dead end — but withholding the
         * trigger made the rail's ENTIRE Direct section vanish, so in a
         * workspace of one there was no control anywhere that said "message a
         * person", which is exactly what was reported.
         *
         * And the premise was wrong in a second way: <NewDmModal> already has
         * honest copy for an empty roster ("You're the only person in this
         * workspace — invite someone from the Team page"), and withholding the
         * trigger from both callers was the ONLY thing making that branch
         * unreachable. A hidden control and a control that explains itself are
         * not the same trade. Passed unconditionally now. */
        onNewDm={() => setNewDmOpen(true)}
        className={cn(
          "w-full border-border md:block md:w-[220px] md:shrink-0 md:border-e",
          railOpen ? "block" : "hidden"
        )}
      />

      <div className={cn("min-w-0 flex-1 flex-col md:flex", railOpen ? "hidden" : "flex")}>
        <ChannelHeader
          channel={channel}
          onBack={() => setRailOpen(true)}
          muted={muted}
          // chat-012. Passed ONLY to a member: `mutedAt` is a column on the
          // caller's own `ChannelMember` row, and a public channel's non-member
          // reader does not have one. Creating one here would silence them and
          // also subscribe them to this channel's unread badge for good, which
          // is the stealth-join `markChannelReadAction` refuses for the same
          // reason. Their answer is the workspace notification preferences.
          onToggleMute={channel.isMember ? () => void toggleMute() : undefined}
          mutePending={mutePending}
        />

        {/* Membership strip. Rendered ONLY when there is something to do here,
            so an ordinary reader never pays a row of chrome for a control they
            cannot use. It sits below the header rather than inside it because
            <ChannelHeader> is the marketing mock's bar, kept deliberately bare.
            The nudge for a one-person private channel is the case the finding
            is actually about: the creator has been told people can be added and
            has had nowhere to do it. */}
        {canManage && (
          <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5">
            {channel.kind === "private" && channel.memberCount === 1 && (
              <p className="truncate text-[11px] text-fg-muted">
                Only you can see this private channel — add the people who should.
              </p>
            )}
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="ms-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
            >
              <UserPlus className="h-3 w-3" aria-hidden="true" />
              Add people
            </button>
          </div>
        )}

        <MessageList
          channelId={channel.id}
          currentUserId={currentUserId}
          messages={messages}
          hasMore={cursor !== null}
          loadingOlder={loadingOlder}
          onLoadOlder={handleLoadOlder}
          disabled={readOnly}
          onOpenThread={(message) => void openThread(message.id)}
          // chat-010. The id straight from the URL: <MessageList> decides for
          // itself whether that row is on screen yet, and marks nothing when it
          // is not, so this island does not have to keep a second answer to the
          // same question.
          anchoredMessageId={anchorId}
        />

        {/* ── chat-010: THE WAY BACK OUT OF HISTORY ────────────────────────
            Drawn only for an anchored window that does not reach the newest
            message. It is not decoration: in this state the room really is
            frozen — the activity poll refreshes an anchored page into the same
            anchored page — so a reader who followed a month-old mention would
            otherwise sit in the backlog with no sign that newer messages
            existed. It says so, rather than leaving them to notice.

            `goToChannel` pushes `/chat/<slug>` with no query, which drops the
            anchor; the page above keys the island on the anchor, so this
            remounts at the live edge with a fresh cursor and scroll position
            instead of carrying this window's into it. */}
        {viewingHistory && (
          <div className="flex shrink-0 items-center gap-3 border-t border-border bg-glass/[0.04] px-4 py-1.5">
            <p className="truncate text-[11px] text-fg-muted">
              You&rsquo;re reading earlier messages — new ones won&rsquo;t show up here.
            </p>
            <button
              type="button"
              onClick={() => goToChannel(channel.slug)}
              className="ms-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted transition-colors hover:text-fg"
            >
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        )}

        <div className="shrink-0 border-t border-border p-3">
          {readOnly ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-2 text-center text-xs text-fg-muted">
              {archived
                ? "This channel is archived — it's read-only now."
                : // The only remaining read-only-and-not-archived case is a
                  // non-member of a private channel or a DM, and for them the
                  // truth is that there is nothing to click: membership is the
                  // permission, and it is granted by someone who is already in.
                  // The old copy here said "Join this channel to post in it.",
                  // which named an action the product does not have.
                  "Only members of this conversation can post in it."}
            </p>
          ) : (
            <MessageComposer
              channelId={channel.id}
              // chat-008. The composer cannot tell "Message #general" from
              // "Message Ahmed Khan" without the kind, and it had neither — so
              // every DM invited the reader to message a hash.
              channelKind={channel.kind}
              channelName={channel.name}
              parentId={null}
              // chat-006 — NOT `channel.members`. See `mentionRoster` above.
              users={mentionRoster}
              disabled={false}
              canPostRunway={canPostRunway}
              onSent={handleSent}
            />
          )}
        </div>
      </div>

      {/* chat-011: gated on the REQUEST (`threadRootId`), not on the response
          (`thread`). That is the whole fix: `openThread` sets the id, clears
          the old conversation and only then awaits `loadThreadAction`, so this
          renders the panel on a skeleton the moment the reader clicks and swaps
          in the thread when it arrives. A failure clears the id again, so the
          panel never sits there spinning forever — see `openThread`. */}
      {threadRootId !== null && (
        <ThreadPanel
          root={thread?.root ?? null}
          replies={thread?.replies ?? []}
          users={mentionRoster}
          channelName={channel.name}
          channelKind={channel.kind}
          // chat-009. THE SAME `readOnly` the timeline above uses, forwarded
          // rather than recomputed: the panel has no channel facts of its own
          // (`MessageClient` carries no kind, isMember or archivedAt), and this
          // island already derived it from `canPostInChannel`. Omitting it left
          // an archived — or non-member — conversation with an enabled Send
          // button and a live emoji picker whose every click the server refuses.
          readOnly={readOnly}
          open={threadRootId !== null}
          onClose={closeThread}
        />
      )}

      {/* Siblings of both panes, so a dialog raised from the mobile rail
          renders above it rather than inside the pane that is about to be
          replaced. Both stay mounted and are driven by `open` — the dialogs
          own their own field state and reset it on close. */}
      <NewChannelModal
        open={newChannelOpen}
        onClose={() => setNewChannelOpen(false)}
        onCreated={(slug) => {
          setNewChannelOpen(false);
          goToChannel(slug);
        }}
      />

      <NewDmModal
        open={newDmOpen}
        onClose={() => setNewDmOpen(false)}
        candidates={dmCandidates}
        onOpened={(slug) => {
          setNewDmOpen(false);
          goToChannel(slug);
        }}
      />

      {/* chat-003. Not extracted into components/chat/: that directory belongs
          to the chat component set and this island is the only caller, so a
          separate file would be indirection without reuse. <Modal> brings the
          focus trap, focus return, Escape and role="dialog" the same way
          <ThreadPanel> leans on it. */}
      <Modal
        open={addOpen}
        onClose={closeAdd}
        title={`Add people to ${channel.kind === "private" ? "" : "#"}${channel.name}`}
        description={
          channel.kind === "private"
            ? "Only members can see this channel and its history."
            : "Members get an unread badge for this channel. Anyone in the workspace can already read it."
        }
      >
        {addable.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-fg-muted">
            Everyone in the workspace is already in this channel.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {addable.map((person) => (
                <li key={person.id}>
                  {/* A real <label> around a real checkbox: that is what gives
                      the row its accessible name and makes the whole line a hit
                      target without a click handler on a <div>. */}
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-glass/[0.06]">
                    <input
                      type="checkbox"
                      checked={selected.includes(person.id)}
                      onChange={() => toggleCandidate(person.id)}
                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                    />
                    <span className="truncate text-sm text-fg">{person.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={closeAdd}
                className="rounded-full px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitAdd()}
                disabled={selected.length === 0 || adding}
                className="rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-fg transition-opacity disabled:opacity-50"
              >
                {/* "Add" while nothing is ticked — deliberately NOT "Add
                    people", which is the trigger's label: two controls with one
                    accessible name is how a click lands on the wrong one. */}
                {selected.length === 0
                  ? "Add"
                  : selected.length === 1
                    ? "Add 1 person"
                    : `Add ${selected.length} people`}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
