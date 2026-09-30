"use client";

/**
 * <ChannelRail> — the channel list, pinned to the conversation's reading-start
 * edge (left in English, right in Urdu — see the mirror note further down).
 *
 * Element vocabulary is lifted verbatim from the marketing mock
 * (components/landing/channel-panel.tsx): a mono section label, rows of
 * `flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs` with a leading
 * Hash/Lock, a truncating name, and an end-pushed unread pill. The mock also
 * splits the rail into "Channels" and "Direct", which is the split this
 * component now implements: a DM is addressed to a person, a channel to a
 * room, and burying one inside the other makes the reader scan names to work
 * out which kind of conversation they are about to open.
 *
 * What deliberately DIFFERS from the mock: width. The mock's rail is 132px
 * because it is a scaled graphic; at real size that truncates "investors" to
 * "invest…". The real rail is sized by its parent (~220px) — this component
 * stays layout-agnostic and takes the width through `className`.
 *
 * The rail is a <nav> of links, not buttons: each channel is a real URL, so
 * back/forward, middle-click and deep links all work, and the open channel
 * is marked `aria-current="page"` rather than only styled. That holds for DMs
 * too — they are Channel rows with a `dm` kind, not a separate surface — so
 * there is exactly ONE <nav aria-label="Channels"> wrapping both sections and
 * every conversation in the rail is an <a> inside it. The chat smoke test
 * leans on that: it reads `nav[aria-label="Channels"] a` and asserts a private
 * channel the viewer is not a member of never appears. Split the nav in two
 * and that assertion silently stops covering half the rail.
 *
 * Creating is the host's job, not the rail's: the rail raises `onNewChannel` /
 * `onNewDm` and the page owns the modals. Both are optional, so a read-only
 * embedding of the rail simply passes neither and no "+" renders.
 *
 * DIRECTION (audit S20): every inline offset in here is logical — `ms-`/`me-`,
 * never `ml-`/`mr-` — because the rail is a column the conversation sits beside,
 * and in Urdu that column is on the right. Logical utilities are preferred over
 * an `rtl:` override even where one would work: Tailwind emits `rtl:` AFTER the
 * responsive variants, so `md:ml-auto rtl:mr-auto` loses at every breakpoint and
 * fails silently in the direction nobody tests. `ms-auto` needs no variant.
 * tests/lib/layout/rtl.test.ts scans this directory and fails on a physical one.
 */

import Link from "next/link";
import { Hash, Lock, MessageSquarePlus, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
// `isDmKind` is IMPORTED, not re-spelled here. It used to be a local copy, and
// that is how chat-008 happened: the rail learned that a DM is a person while
// the channel header, the browser tab and the composer placeholder kept drawing
// a hash. One spelling, four surfaces.
import { isDmKind } from "@/lib/chat/dm";
import { cn } from "@/lib/utils";
import type { ChannelListItem } from "@/lib/queries/chat";

/**
 * The server caps `unreadCount` at 99, so 99 is "99 or more" — never a literal
 * ninety-nine. Rendering a bare "99" would quietly under-report a channel with
 * four hundred unread messages, so the cap value renders as "99+".
 */
export const UNREAD_DISPLAY_CAP = 99;

export function unreadLabel(count: number): string {
  return count >= UNREAD_DISPLAY_CAP ? `${UNREAD_DISPLAY_CAP}+` : String(count);
}

/**
 * `kind` is normalised rather than compared literally: the query layer may
 * hand back either the Prisma enum casing ("PRIVATE") or a lowercased union
 * ("private"), and picking the wrong icon on a private channel is a privacy
 * signal we'd be getting wrong, not a cosmetic slip.
 */
function isPrivateKind(kind: ChannelListItem["kind"]): boolean {
  return String(kind).toLowerCase().includes("private");
}

type Props = {
  channels: ChannelListItem[];
  /** Slug of the open channel, or null on the index route. */
  activeSlug: string | null;
  /** Mobile only: the rail and the conversation are mutually exclusive panes. */
  onNavigate?: () => void;
  /** Opens the host's new-channel modal. Omit it and no "+" renders. */
  onNewChannel?: () => void;
  /** Opens the host's new-DM modal. Omit it and the Direct "+" never renders. */
  onNewDm?: () => void;
  className?: string;
};

/**
 * The mono label, plus an optional "+" pushed to the far edge.
 *
 * The button is icon-only, so `aria-label` is not a nicety — it is the only
 * accessible name the control has. Its focus treatment mirrors hover so the
 * target is legible while the keyboard is on it; the emerald ring itself comes
 * from the global `:focus-visible` rule in app/globals.css, which is why
 * nothing here sets `outline-none`.
 *
 * `-me-1` (not `-mr-1`) cancels the row's `px-1` against whichever edge the
 * `justify-between` actually pushed the button to, so the "+" optically lines
 * up with the rail's trailing edge in both directions.
 */
function SectionHeader({
  label,
  actionLabel,
  onAction,
}: {
  label: string;
  actionLabel: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">{label}</p>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          aria-label={actionLabel}
          className="-me-1 rounded-md p-1 text-fg-muted transition-colors hover:bg-glass/[0.06] hover:text-fg focus-visible:bg-glass/[0.06] focus-visible:text-fg"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * One row, whether it is a room or a DM — the two differ only in what leads
 * the row, so they share everything else (truncation, unread pill, active
 * marking) by construction rather than by two copies kept in step by hand.
 *
 * For a DM, `channel.name` is ALREADY the viewer-relative counterpart name:
 * lib/queries/chat.ts replaces the stored `Channel.name` with it before the
 * row ever reaches the client, because only the server knows who the viewer
 * is relative to the membership rows. Do not re-derive it here — a second
 * source of truth for "who is this DM with" is exactly how the two drift.
 *
 * WHAT MIRRORS AND WHAT DOES NOT. The unread pill does: it is "the far end of
 * this row", a position relative to the reading order, so `ms-auto` moves it to
 * whichever end that is. The leading Hash/Lock does NOT, and neither does a DM's
 * Avatar — flipping them is the classic over-mirror. A Lock is an object, not a
 * direction: a backwards padlock reads as a rendering fault, and the shackle
 * leaning the wrong way carries no meaning to recover. A Hash is symmetric
 * enough that a flip is invisible, so rotating it buys nothing and costs a
 * class. An avatar is a portrait; mirroring a face is simply wrong. The rule
 * that separates them: mirror POSITION and direction-of-travel signage, never
 * iconography that depicts a thing. (The one arrow in this feature, the mobile
 * back button in channel-header.tsx, is signage and does flip.)
 */
function ChannelRow({
  channel,
  active,
  onNavigate,
}: {
  channel: ChannelListItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const dm = isDmKind(String(channel.kind));
  const isPrivate = isPrivateKind(channel.kind);
  const Icon = isPrivate ? Lock : Hash;

  return (
    <li>
      <Link
        href={`/chat/${channel.slug}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors",
          active
            ? "bg-primary/15 font-semibold text-primary-strong"
            : "text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
        )}
      >
        {dm ? (
          <Avatar name={channel.name} size="xs" />
        ) : (
          <Icon
            role="img"
            aria-label={isPrivate ? "Private channel" : "Public channel"}
            className="h-3 w-3 shrink-0"
          />
        )}
        <span className="truncate">{channel.name}</span>
        {channel.unreadCount > 0 && (
          <span
            aria-label={`${unreadLabel(channel.unreadCount)} unread messages`}
            className="ms-auto shrink-0 rounded-full bg-primary px-1.5 font-mono text-[9px] font-bold text-primary-fg"
          >
            {unreadLabel(channel.unreadCount)}
          </span>
        )}
      </Link>
    </li>
  );
}

export function ChannelRail({
  channels,
  activeSlug,
  onNavigate,
  onNewChannel,
  onNewDm,
  className,
}: Props) {
  // One pass each rather than a reduce: two named lists read better at the
  // call sites below, and the rail is a few dozen rows at most.
  const rooms = channels.filter((channel) => !isDmKind(String(channel.kind)));
  const dms = channels.filter((channel) => isDmKind(String(channel.kind)));

  // An empty section with nothing to act on is noise, so "Direct" appears only
  // once it has something in it or a way to start one. "Channels" always shows,
  // because its empty state is the thing that tells a new workspace what to do.
  const showDirect = dms.length > 0 || Boolean(onNewDm);

  return (
    <nav
      aria-label="Channels"
      className={cn("flex h-full flex-col overflow-y-auto bg-surface p-3", className)}
    >
      <SectionHeader label="Channels" actionLabel="New channel" onAction={onNewChannel} />

      {rooms.length === 0 ? (
        /* The old copy here read "an admin can create the first one", which was
         * simply false: createChannelAction has no role gate — every member of
         * the workspace can start a conversation — so the rail was talking
         * members out of something they are allowed to do. When the host wires
         * `onNewChannel` we also repeat the affordance as a labelled button:
         * the header's "+" is a 12px icon in the corner of an otherwise blank
         * rail, which is precisely the reader least likely to find it. */
        <div className="mt-3 space-y-2 px-1.5">
          <p className="text-xs text-fg-muted">
            No channels yet — anyone in the workspace can start the first one.
          </p>
          {onNewChannel && (
            <button
              type="button"
              onClick={onNewChannel}
              className="flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-xs font-semibold text-primary-strong transition-colors hover:bg-primary/25"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Create a channel
            </button>
          )}
        </div>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {rooms.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.slug === activeSlug}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}

      {showDirect && (
        <>
          <div className="mt-4">
            <SectionHeader label="Direct" actionLabel="New direct message" onAction={onNewDm} />
          </div>
          {dms.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {dms.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.slug === activeSlug}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          ) : (
            /* ── THE REPORTED BUG ────────────────────────────────────────────
             * "The chat sidebar shows a CHANNELS heading with a + button and
             * nothing else. No DM section, no way to message a person."
             *
             * A reader with no DMs yet got this section as a 9px mono label and
             * a 12px icon-only "+" — no words anywhere saying you can message a
             * person. This file's OWN comment already conceded the point for the
             * Channels section ("a 12px icon in the corner of an otherwise blank
             * rail, which is precisely the reader least likely to find it") and
             * repeated the affordance there as a labelled button. Direct never
             * got the same treatment. It does now, on exactly the same terms:
             * only while the section is empty, because once it has rows the rows
             * ARE the affordance and a permanent button is one more thing to
             * scan past on every render. */
            onNewDm && (
              <button
                type="button"
                onClick={onNewDm}
                className="mt-2 flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-xs font-semibold text-primary-strong transition-colors hover:bg-primary/25"
              >
                <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
                Message a teammate
              </button>
            )
          )}
        </>
      )}
    </nav>
  );
}
