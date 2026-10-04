"use client";

/**
 * <ChannelHeader> — the bar above the message list.
 *
 * Straight from the marketing mock: Hash icon, channel name in
 * `text-sm font-bold tracking-tight`, member count pushed to the far end in
 * mono. The mock's restraint is the point, and it is the reason the only two
 * additions here are things a reader cannot do anywhere else:
 *
 *   - the mobile back affordance — below `md` the rail and the conversation are
 *     mutually exclusive panes, so without it a phone user who opens a channel
 *     has no way back to the list;
 *   - the mute bell (chat-012) — `ChannelMember.mutedAt` was honoured by both
 *     notification fan-outs and written by nothing in the entire repo, so a
 *     member of a noisy channel could only stop its pings by turning mentions
 *     off everywhere in the workspace. This bar is where a per-conversation
 *     setting belongs; see `MUTE_TITLE` for what it must promise.
 *
 * DIRECTION (audit S20): inline offsets here are logical (`ms-`/`me-`), not
 * `ml-`/`mr-`. `border-b` stays as it is — that is a BLOCK edge, and block
 * direction does not mirror with `dir`, so `border-b` is already correct in
 * Urdu. Only the inline axis flips.
 *
 * chat-008 — A DM IS A PERSON, NOT A ROOM. The icon used to be picked with
 * `isPrivate ? Lock : Hash`, so `kind: "dm"` fell through to Hash and a direct
 * message with Ahmed Khan opened with a hash in front of his name. In this
 * product a hash means "a room", and a room means other people can be in it, so
 * that glyph misrepresented who could read the conversation — the same class of
 * mistake as drawing a Hash on a private channel. A DM now leads with the
 * counterpart's Avatar, and the member-count slot says what kind of
 * conversation it is instead of counting to two (it is always two, so the count
 * carried no information).
 *
 * The avatar does NOT mirror under `dir`, and neither does the Hash or the Lock
 * — mirroring a portrait is simply wrong, and a Lock is an object rather than a
 * direction. Only the back arrow is signage, and only it flips.
 */

import { ArrowLeft, Bell, BellOff, Hash, Lock } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { isDmKind, isPrivateKind } from "@/lib/chat/dm";
import type { ChannelDetail } from "@/lib/queries/chat";

type Props = {
  channel: ChannelDetail;
  /** Mobile only — swaps the conversation pane back to the rail. */
  onBack?: () => void;
  /**
   * Has the viewer silenced this conversation? (chat-012)
   *
   * Taken as a prop rather than read off `channel.muted` so the surface can
   * show the state it is about to write while the round trip is in flight —
   * and so this component has exactly one source for it. <ChatClient> seeds it
   * from `channel.muted`.
   */
  muted?: boolean;
  /**
   * Press-the-bell. ABSENT means there is no bell: a non-member has no
   * `ChannelMember` row for `mutedAt` to live on, and drawing a control whose
   * only possible outcome is a refusal is worse than drawing none.
   */
  onToggleMute?: () => void;
  /** True while the write is in flight — the control is disabled, not hidden. */
  mutePending?: boolean;
};

/**
 * WHAT THE MUTE CONTROL PROMISES, in one place so the label, the tooltip and
 * the marker cannot drift apart.
 *
 * A muted channel keeps its place in the rail, keeps counting unread messages
 * (`unreadChatTotal` counts muted channels deliberately) and stays completely
 * readable. The ONLY thing that stops is the notification fan-out. A bare bell
 * glyph reads as "hide this", so the tooltip has to say which of those it is —
 * otherwise someone mutes a channel to get it out of their list and then
 * reports that mute is broken.
 */
const MUTE_TITLE =
  "Stop notifications from this conversation. It stays in your list and still shows unread messages.";
const UNMUTE_TITLE = "Turn notifications from this conversation back on.";

export function ChannelHeader({
  channel,
  onBack,
  muted = false,
  onToggleMute,
  mutePending = false,
}: Props) {
  const dm = isDmKind(String(channel.kind));
  // `isPrivateKind` is IMPORTED, not re-spelled inline. This line used to be a
  // third private copy of the same substring test, beside the rail's copy and
  // the one in lib/chat/dm.ts, which is how the tab and the composer came to
  // call a private channel "#pvt-hiring" while this header drew a Lock.
  const isPrivate = isPrivateKind(String(channel.kind));
  const Icon = isPrivate ? Lock : Hash;
  // `channel.name` is ALREADY the viewer-relative counterpart name for a DM —
  // lib/queries/chat.ts swaps it in before the row reaches the client, because
  // only the server knows who the viewer is relative to the membership rows. Do
  // not re-derive it here.
  const trailing = dm
    ? "Direct message"
    : channel.memberCount === 1
      ? "1 member"
      : `${channel.memberCount} members`;

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
      {dm ? (
        <Avatar name={channel.name} size="xs" />
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
      )}
      <h1 className="truncate text-sm font-bold tracking-tight">{channel.name}</h1>
      {channel.archivedAt && (
        <span className="shrink-0 rounded-full bg-glass/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-muted">
          Archived
        </span>
      )}
      {/* chat-012. A VISIBLE state, beside the Archived pill it is modelled on,
          because a bell and a bell-with-a-slash are a pixel apart at this size
          and a tooltip is not a state. Rendered on the mute flag alone, so it
          is still legible for a reader who cannot reach the control (nothing
          takes the bell away from a member today, but the pill is about what is
          true, not about what is clickable). */}
      {muted && (
        <span className="shrink-0 rounded-full bg-glass/[0.08] px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-fg-muted">
          Muted
        </span>
      )}
      {/* `ms-auto`: "the far end of the bar", not "the right". */}
      <span className="ms-auto shrink-0 font-mono text-[10px] text-fg-muted">{trailing}</span>
      {onToggleMute && (
        <button
          type="button"
          onClick={onToggleMute}
          disabled={mutePending}
          // The accessible name carries the VERB, so a screen reader hears what
          // pressing it will do rather than the state it is in — the same rule
          // the rest of this product's toggles follow. The Bell glyphs are
          // aria-hidden and carry no name of their own.
          aria-label={muted ? "Unmute notifications" : "Mute notifications"}
          // `aria-pressed` as well as the label: the label says what happens
          // next, this says where the toggle is now.
          aria-pressed={muted}
          title={muted ? UNMUTE_TITLE : MUTE_TITLE}
          // `-me-1` bleeds the icon button into the header's `px-4` on the
          // reading-END edge, mirroring the back button's `-ms-1` on the start
          // edge, so both optically align with the bar's content.
          className="-me-1 shrink-0 rounded-md p-1 text-fg-muted transition-colors hover:bg-glass/[0.06] hover:text-fg disabled:opacity-50"
        >
          {/* Neither bell mirrors under `dir` — an object, not signage, exactly
              like the Hash and the Lock above. */}
          {muted ? (
            <BellOff className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Bell className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      )}
    </header>
  );
}
