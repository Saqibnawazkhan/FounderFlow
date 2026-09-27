"use client";

/**
 * <MessageRow> — one message in the list.
 *
 * Shape is the mock's `Message` (channel-panel.tsx / ThreadMock): a 24px
 * SQUARE `rounded-lg` initial avatar — deliberately NOT the app's round
 * <Avatar>, which is a person-chip and reads as a different object — a header
 * line of bold name + mono timestamp, and a MUTED `text-[13px]` body. The
 * name is the strong element and the body is secondary; that inversion is
 * what makes a dense thread scannable by author.
 *
 * Mention chips reuse the exact treatment from
 * components/comments/comment-thread.tsx so a mention looks identical
 * wherever it appears: self-mentions in primary, everyone else in forest.
 *
 * Two behaviours worth calling out:
 *  • A soft-deleted message keeps its ROW and renders a tombstone. Dropping
 *    the row would silently rewrite the conversation — replies would end up
 *    answering nothing.
 *  • Consecutive messages from the same author inside the grouping window
 *    collapse the avatar and header; the timestamp moves into the gutter and
 *    appears on hover, so it is never lost, only quiet.
 *
 * ON `kind`: a Runway card swaps the BODY for <RunwayCard> and nothing else.
 * The avatar, the header line, the grouping, the reaction bar and the thread
 * indicator are shared by both kinds on purpose — a card is a message somebody
 * said, not a widget that landed in the timeline, and giving it its own row
 * chrome would make it un-reactable and un-repliable for no reason anyone
 * asked for.
 *
 * The branch is `kind === "card"` and EVERYTHING ELSE falls through to text,
 * rather than a switch with no default. Half a deployment is a normal state:
 * a newer build can write a kind this bundle has never heard of, and such a
 * row must degrade to its plain body rather than render nothing at all, which
 * is how a message goes missing from a conversation without leaving a gap.
 *
 * The tombstone check stays FIRST and covers both kinds. `toMessageClient`
 * already blanks a deleted card — `card` and `payload` both come back null
 * regardless of the stored payload — so a deleted card has no figures to
 * render even if this branch ordering were ever reversed. Belt and braces, in
 * that order.
 */

import { format } from "date-fns";
import { MessageSquare } from "lucide-react";
import { ReactionBar } from "@/components/chat/reaction-bar";
import { RunwayCard } from "@/components/chat/runway-card";
import { cn } from "@/lib/utils";
import type { MessageClient } from "@/lib/queries/chat";

const TONE_BG = [
  "bg-primary text-primary-fg",
  "bg-forest text-primary-fg",
  "bg-mint text-primary-fg",
  "bg-slate text-primary-fg",
];

/** Stable per-author tint so the same person is the same colour every render. */
function toneFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return TONE_BG[Math.abs(hash) % TONE_BG.length];
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

type Props = {
  message: MessageClient;
  currentUserId: string;
  /** True when this row continues the previous author's run — no avatar/name. */
  grouped: boolean;
  /** Archived channel or non-member: reactions are read-only. */
  disabled?: boolean;
  /** Opens the thread panel. Absent inside the panel itself. */
  onOpenThread?: (message: MessageClient) => void;
};

export function MessageRow({
  message,
  currentUserId,
  grouped,
  disabled = false,
  onOpenThread,
}: Props) {
  const created = new Date(message.createdAt);
  const clock = format(created, "HH:mm");
  const full = created.toLocaleString();
  const mentionsMe = message.mentionedUserIds.includes(currentUserId);
  const deleted = message.deletedAt !== null;
  // Positive match only: an unrecognised kind is text, never a blank row.
  const isCard = message.kind === "card";

  return (
    <article
      className={cn(
        "group flex gap-2.5 rounded-lg",
        // A message that names the reader gets a wash, same idea as the
        // comment thread's mention highlight — it must survive a fast scroll.
        mentionsMe && !deleted && "-mx-2 bg-primary/[0.06] px-2 py-1"
      )}
    >
      {grouped ? (
        // Gutter keeps the 24px avatar column so bodies stay on one axis.
        <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-[9px] leading-4 text-fg-muted opacity-0 transition-opacity group-hover:opacity-100">
          {clock}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg font-mono text-[10px] font-bold",
            toneFor(message.authorId)
          )}
        >
          {initialOf(message.authorName)}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-1.5">
            <span className="text-xs font-bold text-fg">{message.authorName}</span>
            <time
              dateTime={created.toISOString()}
              title={full}
              className="font-mono text-[9px] text-fg-muted"
            >
              {clock}
            </time>
          </p>
        )}

        {deleted ? (
          <p
            className={cn("text-[13px] italic leading-snug text-fg-muted/70", !grouped && "mt-0.5")}
          >
            Message deleted
          </p>
        ) : (
          <>
            {isCard ? (
              // `message.card` is the render-ready, already-redacted form. The
              // raw `message.payload` is never read here — it exists for
              // debugging and a component that parsed it itself would be a
              // second, unreviewed copy of the redaction decision.
              <RunwayCard card={message.card} className={cn(!grouped && "mt-1")} />
            ) : (
              <p
                className={cn(
                  "whitespace-pre-wrap break-words text-[13px] leading-snug text-fg-muted",
                  !grouped && "mt-0.5"
                )}
              >
                {message.segments.map((seg, i) =>
                  seg.type === "text" ? (
                    <span key={i}>{seg.text}</span>
                  ) : (
                    <span
                      key={i}
                      title={seg.name ? `Mentioned ${seg.name}` : undefined}
                      className={cn(
                        "inline-flex items-center rounded px-1 font-semibold",
                        seg.userId === currentUserId
                          ? "bg-primary/20 text-primary-strong"
                          : "bg-forest/15 text-forest-strong"
                      )}
                    >
                      @{seg.name ?? seg.slug}
                    </span>
                  )
                )}
                {message.editedAt && (
                  <span className="ml-1 font-mono text-[9px] text-fg-muted/70">(edited)</span>
                )}
              </p>
            )}

            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <ReactionBar
                messageId={message.id}
                reactions={message.reactions}
                disabled={disabled}
              />
              {message.replyCount > 0 && (
                // The mock renders this as a bare lime label; it is the only
                // way into a thread, so it has to be a real control.
                <button
                  type="button"
                  onClick={() => onOpenThread?.(message)}
                  className="inline-flex items-center gap-1 rounded text-[10px] font-medium text-primary-strong transition-colors hover:text-fg"
                >
                  <MessageSquare className="h-3 w-3" aria-hidden="true" />
                  {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
