"use client";

/**
 * <ChannelHeader> — the bar above the message list.
 *
 * Straight from the marketing mock: Hash icon, channel name in
 * `text-sm font-bold tracking-tight`, member count pushed to the far end in
 * mono. Nothing else earns a place here — the mock's restraint is the point.
 *
 * The one addition the mock has no need for is the mobile back affordance:
 * below `md` the rail and the conversation are mutually exclusive panes, so
 * without it a phone user who opens a channel has no way back to the list.
 *
 * DIRECTION (audit S20): inline offsets here are logical (`ms-`/`me-`), not
 * `ml-`/`mr-`. `border-b` stays as it is — that is a BLOCK edge, and block
 * direction does not mirror with `dir`, so `border-b` is already correct in
 * Urdu. Only the inline axis flips.
 */

import { ArrowLeft, Hash, Lock } from "lucide-react";
import type { ChannelDetail } from "@/lib/queries/chat";

type Props = {
  channel: ChannelDetail;
  /** Mobile only — swaps the conversation pane back to the rail. */
  onBack?: () => void;
};

export function ChannelHeader({ channel, onBack }: Props) {
  const isPrivate = String(channel.kind).toLowerCase().includes("private");
  const Icon = isPrivate ? Lock : Hash;
  const members = channel.memberCount === 1 ? "1 member" : `${channel.memberCount} members`;

  return (
    <header
      className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5"
      title={channel.topic ?? undefined}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to channels"
          // `-ms-1` bleeds the icon button back into the header's `px-4` on the
          // reading-start edge, so it optically aligns with the title below it
          // whichever side that edge is.
          className="-ms-1 rounded-md p-1 text-fg-muted transition-colors hover:bg-glass/[0.06] hover:text-fg md:hidden"
        >
          {/* This arrow DOES mirror, unlike the Hash/Lock beside it. It is not a
              picture of an arrow, it is signage for "back the way you came", and
              the way you came is the reading-start edge. Left unrotated it points
              away from the rail in Urdu — the one direction it must never point.
              `rtl:rotate-180` rather than a logical utility because Tailwind has
              none for glyph orientation; the `rtl:`-after-`md:` ordering trap
              does not bite here because the two variants sit on different
              utilities (`rtl:rotate-180`, `md:hidden`) and never compete. */}
          <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" />
        </button>
      )}
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
      <h1 className="truncate text-sm font-bold tracking-tight">{channel.name}</h1>
      {channel.archivedAt && (
        <span className="shrink-0 rounded-full bg-glass/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-muted">
          Archived
        </span>
      )}
      {/* `ms-auto`: "the far end of the bar", not "the right". */}
      <span className="ms-auto shrink-0 font-mono text-[10px] text-fg-muted">{members}</span>
    </header>
  );
}
