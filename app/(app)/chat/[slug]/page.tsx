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
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getChannelBySlug,
  getMessagesPage,
  listChannelsForUser,
  listDmCandidates,
} from "@/lib/queries/chat";
import { requireScopedSession } from "@/lib/queries/session";
import { conversationTitle } from "@/lib/chat/dm";
import { ChatClient } from "./chat-client";

type Params = { params: { slug: string } };

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

export default async function ChannelPage({ params }: Params) {
  const [session, channels, channel, dmCandidates] = await Promise.all([
    requireScopedSession(),
    listChannelsForUser(),
    getChannelBySlug(params.slug),
    listDmCandidates(),
  ]);

  if (!channel) notFound();

  const page = await getMessagesPage(channel.id);

  return (
    <ChatClient
      // Keyed on the channel so switching channels resets the loaded history
      // and the scroll state instead of carrying one channel's backlog into
      // the next one's list.
      key={channel.id}
      channels={channels}
      channel={channel}
      dmCandidates={dmCandidates}
      initialMessages={page.messages}
      initialCursor={page.nextCursor}
      currentUserId={session.userId}
    />
  );
}
