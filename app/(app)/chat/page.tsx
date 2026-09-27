/**
 * /chat — Server Component. The route has no surface of its own: chat is
 * always "a channel is open", so this redirects to the first channel the
 * reader can see and lets /chat/[slug] do the work.
 *
 * A channel the reader has JOINED wins over one they can merely see, so
 * landing on /chat drops you somewhere you can actually type.
 *
 * The only thing rendered here is the zero-channel case, which a redirect
 * cannot express — bouncing to a slug that doesn't exist would 404 a
 * perfectly healthy brand-new workspace. That case is no longer a dead end:
 * <EmptyChat> carries the create-channel and open-DM entry points, so the
 * first person into a new workspace can start the conversation instead of
 * being told to wait for someone else to.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { listChannelsForUser, listDmCandidates } from "@/lib/queries/chat";
import { EmptyChat } from "./empty-chat";

export const metadata: Metadata = {
  title: "Chat",
  description: "Talk to your team in channels, without leaving your workspace.",
};

export default async function ChatIndexPage() {
  const channels = await listChannelsForUser();
  const landing = channels.find((c) => c.isMember) ?? channels[0];

  if (landing) redirect(`/chat/${landing.slug}`);

  // DELIBERATELY AFTER THE REDIRECT, AND DELIBERATELY NOT IN A Promise.all
  // WITH THE LINE ABOVE. Every visit to /chat runs this file, and almost all
  // of them are a bounce into a channel that never renders a picker. Hoisting
  // this into a parallel fetch "for symmetry" would add a roster query and a
  // DM-channel query to every single chat page load, to build a list thrown
  // away microseconds later by `redirect()`. Only the empty state — the rare
  // branch, in a workspace with no channels at all, where the extra round
  // trip is the whole point of the screen — pays for it.
  const dmCandidates = await listDmCandidates();

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
        <MessagesSquare className="h-7 w-7 text-primary-strong" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-semibold text-fg md:text-3xl">No channels yet</h1>
      <EmptyChat dmCandidates={dmCandidates} />
    </div>
  );
}
