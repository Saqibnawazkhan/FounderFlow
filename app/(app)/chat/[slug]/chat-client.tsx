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

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { ChannelHeader } from "@/components/chat/channel-header";
import { ChannelRail } from "@/components/chat/channel-rail";
import { MessageComposer } from "@/components/chat/message-composer";
import { MessageList } from "@/components/chat/message-list";
import { NewChannelModal } from "@/components/chat/new-channel-modal";
import { NewDmModal } from "@/components/chat/new-dm-modal";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { cn } from "@/lib/utils";
import { loadOlderMessagesAction, loadThreadAction } from "./actions";
import type {
  ChannelDetail,
  ChannelListItem,
  DmCandidate,
  MessageClient,
} from "@/lib/queries/chat";

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

  // Thread panel. `thread` holds the loaded conversation; `threadRootId` is
  // set the moment a reply indicator is clicked so the panel can open on a
  // spinner instead of waiting for the round-trip before reacting.
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ root: MessageClient; replies: MessageClient[] } | null>(
    null
  );

  const openThread = useCallback(
    async (message: MessageClient) => {
      setThreadRootId(message.id);
      setThread(null);
      const res = await loadThreadAction({ slug: channel.slug, rootId: message.id });
      if (!res.success) {
        toast.error(res.error);
        setThreadRootId(null);
        return;
      }
      setThread(res.data);
    },
    [channel.slug]
  );

  const closeThread = useCallback(() => {
    setThreadRootId(null);
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
  const handleSent = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

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

  const archived = channel.archivedAt !== null;
  const readOnly = archived || !channel.isMember;

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
                : "Join this channel to post in it."}
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
    </div>
  );
}
