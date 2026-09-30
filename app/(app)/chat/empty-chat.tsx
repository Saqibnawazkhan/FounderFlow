"use client";

/**
 * <EmptyChat> — the actionable half of the zero-channel state at /chat.
 *
 * WHY AN ISLAND AT ALL: /chat is a Server Component whose whole job is a
 * `redirect()` into the first channel. The empty state is the one branch that
 * renders, and the two things worth doing there — create a channel, open a DM
 * — are dialogs, which need state. Rather than turn the entire route into a
 * client component for a branch most workspaces never see, only this block
 * crosses the boundary.
 *
 * WHY IT EXISTS AT ALL: the copy it replaces read "Once someone on your team
 * creates a channel, your conversations will live here." — an empty state that
 * tells the reader to wait for somebody else, on a screen where the reader is
 * very often the somebody else. A brand-new workspace could reach chat and
 * find no way into it, because `createChannelAction` shipped with no caller.
 * This is that caller.
 *
 * THE DM BUTTON IS ALWAYS OFFERED — corrected after the product owner reported
 * "theres no option for dm in chat". It used to be hidden when the roster was
 * empty, on the reasoning that a workspace of one has nobody to message. Two
 * things were wrong with that. It is the branch a brand-new workspace is
 * ALWAYS in, so the reader most in need of being told that DMs exist was the
 * one reader guaranteed not to see them. And <NewDmModal> already has the
 * honest copy for it — "You're the only person in this workspace — invite
 * someone from the Team page" — which this gate, and the matching one in
 * chat-client.tsx, were the only things making unreachable. A control that
 * explains why it cannot help yet, and points at the page that fixes it, is a
 * next step; a control that is not there is silence.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus, Plus } from "lucide-react";
import { NewChannelModal } from "@/components/chat/new-channel-modal";
import { NewDmModal } from "@/components/chat/new-dm-modal";
import type { DmCandidate } from "@/lib/queries/chat";

type Props = {
  /** Everyone the reader could DM; empty in a workspace of one. */
  dmCandidates: DmCandidate[];
};

export function EmptyChat({ dmCandidates }: Props) {
  const router = useRouter();
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);

  /**
   * `router.push`, not `window.location`: the destination is a route in this
   * same app, so a client-side navigation keeps the shell and lets the /chat
   * RSC hand over to /chat/[slug] without a full reload. The reader lands
   * inside the conversation they just made, which is the only place they
   * wanted to be — this screen has nothing left to show them once a channel
   * exists.
   */
  const goToChannel = (slug: string) => {
    router.push(`/chat/${slug}`);
  };

  return (
    <>
      <p className="mt-2 max-w-sm text-sm text-fg-muted">
        Start the first channel — one per project, or a single #general to get everyone in the same
        room.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => setNewChannelOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New channel
        </button>

        {/* Unconditional. It used to be gated on `dmCandidates.length > 0`, so
            the first person into a brand-new workspace — who is very often
            alone in it — got no way to message a person at all, which is the
            bug that was reported. <NewDmModal> already carries the honest copy
            for an empty roster ("You're the only person in this workspace —
            invite someone from the Team page"), and this gate plus the matching
            one in chat-client.tsx were the only things keeping that branch
            unreachable. Offering a control that explains why it cannot help yet
            beats offering nothing and saying nothing. */}
        <button
          type="button"
          onClick={() => setNewDmOpen(true)}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-bg px-5 py-2.5 text-sm font-semibold text-fg transition-colors hover:border-primary/40 hover:text-primary-strong"
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          Message a teammate
        </button>
      </div>

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
    </>
  );
}
