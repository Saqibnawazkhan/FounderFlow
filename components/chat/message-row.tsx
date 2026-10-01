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

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { MessageSquare, Reply, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { ReactionBar } from "@/components/chat/reaction-bar";
import { RunwayCard } from "@/components/chat/runway-card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { deleteMessageAction } from "@/lib/actions/chat";
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
  /**
   * Is this the message a `?message=<id>` deep link named (chat-010)?
   *
   * Drawn as a ring rather than as the mention wash: the two can be true at the
   * same time — following a mention notification lands on a message that
   * mentions you — and an outline plus a background is legible where two
   * backgrounds are one muddled tint. It is also not colour alone: `aria-current`
   * says the same thing to a screen reader, because "this is the one you were
   * sent here for" is the entire content of the highlight.
   */
  anchored?: boolean;
};

export function MessageRow({
  message,
  currentUserId,
  grouped,
  disabled = false,
  onOpenThread,
  anchored = false,
}: Props) {
  const confirmDelete = useConfirm();
  const [deleting, setDeleting] = useState(false);
  /**
   * Tombstoned by this reader, this second, before the server's own view of the
   * row has made its way back down. Reconciled by the effect below exactly the
   * way <ReactionBar> reconciles its chips: the next RSC payload replaces the
   * optimistic view with the canonical one, and `deletedAt` then carries it.
   */
  const [justDeleted, setJustDeleted] = useState(false);
  useEffect(() => setJustDeleted(false), [message.deletedAt]);

  const created = new Date(message.createdAt);
  const clock = format(created, "HH:mm");
  const full = created.toLocaleString();
  const mentionsMe = message.mentionedUserIds.includes(currentUserId);
  const deleted = message.deletedAt !== null || justDeleted;
  // Positive match only: an unrecognised kind is text, never a blank row.
  const isCard = message.kind === "card";

  /* ── TAKING A MESSAGE BACK ───────────────────────────────────────────────
   *
   * `deleteMessageAction` shipped complete and with no caller at all: it
   * re-checks `canDeleteMessage`, writes the tombstone and the parent's
   * `replyCount` decrement in one transaction, and treats a second delete as a
   * no-op — and nothing in lib/, app/ or components/ named it, so you could not
   * delete a message. `tests/lib/actions/reachability.test.ts` has failed on it
   * since before this fix wave; that file has no allow-list on purpose, because
   * the only two honest answers are "wire it" and "delete it".
   *
   * THE ROW IS WHERE THIS BELONGS. It is the only component that knows which
   * message the reader means, the same way it is the only one that can offer
   * "Reply in thread".
   *
   * THE CLIENT GATE IS NARROWER THAN THE SERVER'S, ON PURPOSE.
   * `canDeleteMessage` admits the author OR a company admin/cofounder. This row
   * is handed `currentUserId` and never a company role — <MessageList> does not
   * thread one — so the control is drawn for the AUTHOR only. That is the honest
   * subset: it never offers a write the server would refuse, which is the
   * direction that matters. Restating `role === "admin" || …` from a prop this
   * component does not have would be a second copy of a permission rule inside a
   * component; moderating somebody else's message needs a role on the row and is
   * a separate, reported change.
   *
   * WHY A LOCAL TOMBSTONE AND NOT `router.refresh()`. The first draft of this
   * called `useRouter().refresh()` here, and that broke all eleven tests in
   * tests/components/message-list.test.tsx — `useRouter` throws "invariant
   * expected app router to be mounted" wherever a row is rendered outside an
   * App Router context, which is every consumer's unit test. Nothing else under
   * components/chat/ takes a router for exactly this reason; <ReactionBar> holds
   * an optimistic view and lets the server refetch replace it, and this follows
   * that precedent.
   *
   * It is not merely a workaround. The row is NOT removed — it renders the same
   * "Message deleted" tombstone the server will send, because a deleted message
   * has to keep its place in the conversation (replies still answer it), and
   * that is the identical shape the RSC payload arrives in. `deleteMessageAction`
   * already calls `revalidatePath` for the channel, so the canonical row follows
   * on its own and the effect above stands down when it does.
   *
   * What this deliberately does not do is push the tombstone to OTHER readers
   * inside a poll interval: `Channel.lastMessageAt` is bumped by a send and not
   * by a delete, so they see it on their next refresh. Same trade as an edit or
   * a reaction, and stated in `pollChannelActivityAction`'s own header.
   *
   * The confirmation is `useConfirm`, the app's themed replacement for
   * `window.confirm`: this is destructive, irreversible from the UI, and one
   * stray tap away from a hover-revealed control.
   */
  const canDelete = !deleted && !disabled && currentUserId === message.authorId;

  async function handleDelete() {
    if (deleting) return;
    const ok = await confirmDelete({
      title: "Delete this message?",
      description:
        "Everyone in the conversation will see 'Message deleted' in its place. Replies stay where they are.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    const res = await deleteMessageAction({ messageId: message.id });
    setDeleting(false);
    if (!res.success) {
      // Surfaced, never swallowed: the server can legitimately refuse (the
      // message is gone, the channel is no longer visible), and a delete that
      // appeared to work and did not is how someone thinks a figure has been
      // retracted from a room that is still reading it.
      toast.error(res.error);
      return;
    }
    setJustDeleted(true);
  }

  return (
    <article
      // A STABLE ANCHOR ON EVERY ROW (chat-010), not only on the highlighted one:
      // <MessageList> finds the row to scroll to by this id, and it has to exist
      // before anything decides to look for it. The id is safe to interpolate
      // because `parseMessageAnchor` is the only thing that produces the value
      // being looked up and it refuses anything outside [A-Za-z0-9_-].
      id={`message-${message.id}`}
      data-anchored={anchored ? "true" : undefined}
      aria-current={anchored ? "true" : undefined}
      className={cn(
        "group flex gap-2.5 rounded-lg",
        // A message that names the reader gets a wash, same idea as the
        // comment thread's mention highlight — it must survive a fast scroll.
        mentionsMe && !deleted && "-mx-2 bg-primary/[0.06] px-2 py-1",
        // The deep-link ring. Persistent rather than a fading flash: the reader
        // arrived here from a notification and may take a moment to read the
        // surrounding conversation, and a highlight that has already faded by
        // then leaves them exactly where the missing feature did.
        anchored && "-mx-2 px-2 py-1 ring-1 ring-primary/60"
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
                // The mock renders this as a bare lime label; it is how you get
                // back into a thread that already has replies.
                <button
                  type="button"
                  onClick={() => onOpenThread?.(message)}
                  className="inline-flex items-center gap-1 rounded text-[10px] font-medium text-primary-strong transition-colors hover:text-fg"
                >
                  <MessageSquare className="h-3 w-3" aria-hidden="true" />
                  {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
                </button>
              )}
              {/* THE WAY IN (finding chat-001). The reply-count label above
                  cannot be the only entry point: it is drawn `replyCount > 0`,
                  and replyCount is only ever incremented by a send that
                  carries a parentId, which only the composer inside
                  <ThreadPanel> sets. That is a closed loop — replyCount can
                  never leave 0 — so until this control existed nobody could
                  start a thread at all, and getThread / loadThreadAction /
                  ThreadPanel / the one-level re-parenting rule were all
                  unreachable in the product.

                  Conditions, each for its own reason:
                   • `onOpenThread` — inside the panel itself there is nowhere
                     to open a thread, and a button that does nothing is worse
                     than no button. (The `deleted` branch above already
                     excludes a tombstone: there is nothing left to reply to,
                     and sendMessageAction would refuse the parent anyway.)
                   • `!disabled` — archived, or a channel this reader cannot
                     post in. Same rule the reaction bar follows: never offer
                     a write the server is going to refuse. Reading an
                     existing thread stays available, because archiving closes
                     posting and not reading.

                  Quiet on a pointer device, permanent on a touch one.
                  `group-hover` is how the grouped-row timestamp hides, and it
                  is fine for a timestamp that is merely nice to have — but an
                  affordance that is the ONLY route into a feature must not be
                  invisible on a phone, which has no hover. `max-md:opacity-100`
                  is the floor; `focus-visible` keeps it reachable by keyboard
                  at every width. */}
              {!disabled && onOpenThread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(message)}
                  className="inline-flex items-center gap-1 rounded text-[10px] font-medium text-fg-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
                >
                  <Reply className="h-3 w-3" aria-hidden="true" />
                  Reply in thread
                </button>
              )}
              {/* Same quiet-on-hover / always-on-touch treatment as the reply
                  affordance beside it, and for the same reason: there is no
                  hover on a phone, and a control nobody can find is a control
                  that does not exist. `danger` on hover so the destructive one
                  of the two reads differently from the safe one. */}
              {canDelete && (
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={deleting}
                  className="inline-flex items-center gap-1 rounded text-[10px] font-medium text-fg-muted opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 disabled:opacity-40 group-hover:opacity-100 max-md:opacity-100"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                  {deleting ? "Deleting…" : "Delete message"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}
