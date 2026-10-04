/**
 * /chat/[slug] — Server Component for one channel.
 *
 * Fetches the session, the rail, the channel and the DM roster in one wave,
 * then the first page of messages once the channel's id is known (the message
 * query needs the id, so it cannot join the first Promise.all).
 *
 * `listDmCandidates` rides along in that wave rather than being awaited after
 * it: it depends on nothing the other three return, so in parallel it costs
 * no extra wall clock, and the "message a teammate" picker is then already in
 * the client island's hands the first time someone reaches for it — no
 * spinner, no second round trip on a click.
 *
 * WHY notFound() AND NEVER A 403: `getChannelBySlug` returns null both for a
 * channel that doesn't exist and for one the reader isn't allowed to see. A
 * 403 would confirm that a private channel named `#acquisition` exists, which
 * is exactly the thing its members are keeping quiet. One 404 for both.
 *
 * ── `?message=<id>` DECIDES WHICH PAGE THIS IS (chat-010) ─────────────────
 *
 * Every mention notification, every DM notification and every chat hit in the
 * command palette links to `/chat/<slug>?message=<id>`. The client island
 * marks that row and scrolls to it — but only if the row is in the page it was
 * handed, and this page always handed it the newest fifty roots. So a mention
 * read a day later, in a channel that has said anything since, was not in the
 * DOM to anchor and the reader got a toast pointing at "Load earlier messages"
 * instead of their message.
 *
 * The fix belongs HERE rather than in the island: fetch the right page once,
 * on the server. A client-side loop that paged backwards until the anchor
 * appeared was written for this, hung tests/components/chat-client.test.tsx,
 * and was deliberately removed (lib/chat/anchor.ts keeps the record).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getChannelBySlug,
  getMessagesPage,
  getMessagesPageAnchoredAt,
  listChannelsForUser,
  listDmCandidates,
} from "@/lib/queries/chat";
import { requireScopedSession } from "@/lib/queries/session";
import { conversationTitle } from "@/lib/chat/dm";
import { parseMessageAnchor } from "@/lib/chat/anchor";
import { ChatClient } from "./chat-client";

type Params = {
  params: { slug: string };
  /**
   * Optional because `generateMetadata` below is called with params alone, and
   * because a channel opened from the rail has no query at all. The only key
   * read is `message`, and it is read through `parseMessageAnchor` — the same
   * shape check the island applies to the address bar and `locateMessageAction`
   * applies to its payload. One spelling, every end.
   */
  searchParams?: { [key: string]: string | string[] | undefined };
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const channel = await getChannelBySlug(params.slug);
  if (!channel) return { title: "Chat" };
  return {
    // chat-008: this was `#${channel.name}` for EVERY kind, so a direct message
    // with Ahmed Khan put "#Ahmed Khan · FounderFlow" in the browser tab, the
    // history and every bookmark. `conversationTitle` is the one place that
    // decides, shared with the channel header and the composer placeholder.
    // `channel.name` is already the viewer-relative counterpart name for a DM.
    title: conversationTitle(channel.kind, channel.name),
    description: channel.topic ?? "Talk to your team in channels, without leaving your workspace.",
  };
}

export default async function ChannelPage({ params, searchParams }: Params) {
  const [session, channels, channel, dmCandidates] = await Promise.all([
    requireScopedSession(),
    listChannelsForUser(),
    getChannelBySlug(params.slug),
    listDmCandidates(),
  ]);

  if (!channel) notFound();

  const anchorId = parseMessageAnchor(searchParams?.message);
  // Null for a link whose id names nothing this reader may reach — a deleted
  // message, another workspace's id, a guess. The reader then lands at the live
  // edge and the island's `locateMessageAction` tells them the truth about the
  // link, which is strictly better than a window built around nothing.
  const anchored = anchorId ? await getMessagesPageAnchoredAt(channel.id, anchorId) : null;
  const page = anchored ?? (await getMessagesPage(channel.id));

  return (
    <ChatClient
      // Keyed on the channel so switching channels resets the loaded history
      // and the scroll state instead of carrying one channel's backlog into
      // the next one's list.
      //
      // AND ON THE ANCHOR, for the same reason one level down (chat-010).
      // `olderPages`, the paging cursor and the scroll position are all local
      // state in the island, seeded from these props exactly once. Moving
      // between a history window and the live edge — which is what the island's
      // own "Jump to latest" does — without a remount would leave one window's
      // cursor driving the other's "Load earlier messages", inserting rows
      // silently into the middle of the list. A key change is the whole of the
      // cleanup; see the island's "NO MANUAL CLEANUP" note.
      key={anchored ? `${channel.id}:${anchorId}` : channel.id}
      channels={channels}
      channel={channel}
      dmCandidates={dmCandidates}
      initialMessages={page.messages}
      initialCursor={page.nextCursor}
      currentUserId={session.userId}
      // True only for an anchored window that does NOT reach the newest
      // message. The island draws the way back out of history from this, and
      // it must not claim it when the window already holds the live edge.
      viewingHistory={anchored?.hasNewer ?? false}
    />
  );
}
