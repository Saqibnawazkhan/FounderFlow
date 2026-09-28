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
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { UserPlus } from "lucide-react";
import { ChannelHeader } from "@/components/chat/channel-header";
import { ChannelRail } from "@/components/chat/channel-rail";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { NewChannelModal } from "@/components/chat/new-channel-modal";
import { NewDmModal } from "@/components/chat/new-dm-modal";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { Modal } from "@/components/ui/modal";
import { addChannelMembersAction, pollChannelActivityAction } from "@/lib/actions/chat";
import { canPostInChannel } from "@/lib/auth/channel-permissions";
import { cn } from "@/lib/utils";
import { loadOlderMessagesAction, loadThreadAction } from "./actions";
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
};

export function ChatClient({
  channels,
  channel,
  dmCandidates,
  initialMessages,
  initialCursor,
  currentUserId,
}: Props) {
  const router = useRouter();
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
  // set the moment a reply indicator is clicked so the panel can open on a
  // spinner instead of waiting for the round-trip before reacting.
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

  const openThread = useCallback(
    async (message: MessageClient) => {
      setThreadRootId(message.id);
      threadRootIdRef.current = message.id;
      setThread(null);
      const res = await loadThreadAction({ slug: channel.slug, rootId: message.id });
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
   * The CLIENT gate is narrower than the server's on purpose. The server runs
   * `canManageChannel`, which also admits a company admin or cofounder; this
   * component is not handed the viewer's company role (ChannelDetail carries
   * `myChannelRole` and not `role`), so drawing the control for an owner only
   * is the honest subset — it never offers a write the server would refuse,
   * which is the direction that matters. Widening it to admins needs
   * `viewerRole` on ChannelDetail, a query this island does not own.
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
  const archived = channel.archivedAt !== null;
  const canManage = channel.myChannelRole === "owner" && channel.kind !== "dm" && !archived;
  const addable = useMemo(() => {
    const already = new Set(channel.members.map((m) => m.id));
    return dmCandidates.filter((c) => !already.has(c.id));
  }, [dmCandidates, channel.members]);

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

  const readOnly = !canPostInChannel({
    kind: channel.kind,
    isMember: channel.isMember,
    archivedAt: channel.archivedAt,
  });

  return (
    <div className="flex h-full min-h-0">
      <ChannelRail
        channels={channels}
        activeSlug={channel.slug}
        onNavigate={() => setRailOpen(false)}
        onNewChannel={() => setNewChannelOpen(true)}
        // Withheld — not disabled — in a workspace of one. The prop is
        // optional precisely so the rail can leave the control out rather
        // than offer a picker with nobody in it; a solo founder clicking
        // "message a teammate" into an empty list is a dead end, and there is
        // no useful empty copy for "you have no colleagues yet".
        onNewDm={dmCandidates.length > 0 ? () => setNewDmOpen(true) : undefined}
        className={cn(
          "w-full border-border md:block md:w-[220px] md:shrink-0 md:border-r",
          railOpen ? "block" : "hidden"
        )}
      />

      <div className={cn("min-w-0 flex-1 flex-col md:flex", railOpen ? "hidden" : "flex")}>
        <ChannelHeader channel={channel} onBack={() => setRailOpen(true)} />

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
          onOpenThread={openThread}
        />

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
              channelName={channel.name}
              parentId={null}
              users={channel.members}
              disabled={false}
              onSent={handleSent}
            />
          )}
        </div>
      </div>

      {thread && (
        <ThreadPanel
          root={thread.root}
          replies={thread.replies}
          users={channel.members}
          channelName={channel.name}
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
