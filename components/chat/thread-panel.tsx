"use client";

/**
 * <ThreadPanel> — the root message, its replies, and a composer pinned to the
 * thread. The "N replies" link that opens it lives on the message row in the
 * main timeline, not here; this component only renders once it's open.
 *
 * Built on <Modal> rather than a hand-rolled side drawer. The drawer reads
 * better on a wide screen, but Modal already brings the four things a thread
 * panel must not get wrong — focus trap, focus return on close, Escape, and
 * role="dialog" + aria-modal (audit flaw #14) — and it already becomes a
 * full-height bottom sheet under `sm`, which is exactly the narrow-screen
 * behaviour we wanted. Re-implementing that to win a slide-in animation would
 * be trading a11y for polish.
 *
 * DIRECTION (audit S20): this file is deliberately untouched by the RTL sweep,
 * and that is a result, not an oversight. Choosing Modal over the drawer is why
 * — a drawer would have had to pick an edge to fly in from, and every such edge
 * is a physical property waiting to be mirrored. A centred dialog has no edge,
 * so the only axis left here is block flow (`mt-*`, `border-t`, `space-y-*`),
 * which does not mirror with `dir`. The inline offsets are `gap-*`, already
 * logical. tests/lib/layout/rtl.test.ts scans this directory and will fail the
 * day someone reintroduces a physical one.
 */

import { formatDistanceToNow } from "date-fns";
import { Avatar } from "@/components/ui/avatar";
import { Modal } from "@/components/ui/modal";
import { MessageComposer } from "@/components/chat/message-composer";
import { ReactionBar } from "@/components/chat/reaction-bar";
import type { MessageClient } from "@/lib/queries/chat";
import { cn } from "@/lib/utils";

type Props = {
  root: MessageClient;
  replies: MessageClient[];
  users: { id: string; name: string }[];
  open: boolean;
  onClose: () => void;
  /**
   * Optional — only used for the composer's placeholder. MessageClient does
   * not carry the channel's name, so a caller that has it should pass it.
   */
  channelName?: string;
  /**
   * The conversation's `Channel.kind`, for the same reason (chat-008): without
   * it the thread composer said "Reply in the thread in #Ahmed Khan" inside a
   * direct message. Optional to match `channelName` — a caller that knows one
   * knows both — and defaulted to "public" only because the fallback label
   * below ("thread") is not a person either way.
   */
  channelKind?: string;
  /**
   * Is this conversation closed to posting (chat-009)?
   *
   * The SAME value <ChatClient> derives from `canPostInChannel` for the
   * timeline, forwarded rather than re-derived: the panel has no channel facts
   * of its own — `MessageClient` carries no `kind`, `isMember` or `archivedAt`
   * — and a second copy of the rule computed from a subset of the facts is how
   * the timeline and the thread come to disagree about who may write.
   *
   * OPTIONAL, defaulting to postable, unlike <MessageComposer>'s required
   * `channelKind`. The two directions of fail-open are not equivalent: a
   * missing `channelKind` produces a WRONG STRING, while a missing `readOnly`
   * that defaulted to true would silently close every thread in the product.
   * The one caller in the app passes it, and
   * tests/components/chat-client.test.tsx asserts that it does, so the default
   * is not what anything real relies on.
   */
  readOnly?: boolean;
};

export function ThreadPanel({
  root,
  replies,
  users,
  open,
  onClose,
  channelName,
  channelKind,
  readOnly = false,
}: Props) {
  // The panel is genuinely absent when closed — the signature promises null,
  // and an unmounted Modal is also one fewer focus trap competing for the tab
  // order behind the timeline.
  if (!open) return null;

  const channel = channelName ?? "thread";

  return (
    <Modal
      open
      onClose={onClose}
      title="Thread"
      description={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {/* Root — tinted and rule-separated so it reads as the thing being
            replied to, not just the first reply. */}
        <ThreadMessage message={root} isRoot readOnly={readOnly} />

        <div className="border-t border-border" />

        <div className="space-y-4" aria-live="polite">
          {replies.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border bg-bg/40 p-6 text-center text-sm text-fg-muted">
              No replies yet — be the first.
            </p>
          ) : (
            replies.map((m) => <ThreadMessage key={m.id} message={m} readOnly={readOnly} />)
          )}
        </div>

        {/* parentId pins every send in here to the thread instead of the
            channel timeline.

            chat-009: `disabled` is FORWARDED, not omitted. It used to be left
            off, so an archived conversation drew an enabled Send button whose
            every click the server refused with "This channel is archived —
            nobody can post in it." The read-only notice the timeline shows in
            its place is deliberately NOT repeated here: the panel is a dialog
            opened over a timeline that is already saying it, and the composer's
            own dimmed, non-typable state is the answer at the point of the
            attempt. */}
        <MessageComposer
          channelId={root.channelId}
          channelKind={channelKind ?? "public"}
          channelName={channel}
          parentId={root.id}
          users={users}
          disabled={readOnly}
        />
      </div>
    </Modal>
  );
}

/**
 * Named ThreadMessage, not MessageRow: `components/chat/message-row.tsx` is a
 * different component owned by the timeline, and two `MessageRow`s in one
 * feature is a rename waiting to go wrong.
 */
function ThreadMessage({
  message,
  isRoot = false,
  readOnly = false,
}: {
  message: MessageClient;
  isRoot?: boolean;
  /** chat-009. Reaches every <ReactionBar> in the panel, root and replies
   *  alike — the replies being the ones a partial fix misses. */
  readOnly?: boolean;
}) {
  const created = new Date(message.createdAt);
  const deleted = message.deletedAt !== null;
  return (
    <article className={cn("flex gap-2.5", isRoot && "rounded-xl bg-bg/40 p-3")}>
      <Avatar name={message.authorName} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className="text-xs font-bold text-fg">{message.authorName}</span>
          <time
            dateTime={message.createdAt}
            title={created.toLocaleString()}
            className="font-mono text-[9px] uppercase tracking-wider text-fg-muted"
          >
            {formatDistanceToNow(created, { addSuffix: true })}
          </time>
        </p>
        {deleted ? (
          // Tombstone, not an absent row — the thread must not rewrite its own
          // history while someone is reading it.
          <p className="mt-0.5 text-[13px] italic leading-snug text-fg-muted">
            This message was deleted.
          </p>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-fg">
            {message.segments.map((seg, i) =>
              seg.type === "text" ? (
                <span key={i}>{seg.text}</span>
              ) : (
                <span
                  key={i}
                  title={seg.name ? `Mentioned ${seg.name}` : undefined}
                  className="rounded bg-forest/20 px-1 font-medium text-forest-strong"
                >
                  @{seg.name ?? seg.slug}
                </span>
              )
            )}
          </p>
        )}
        {!deleted && message.reactions.length > 0 && (
          <div className="mt-2">
            <ReactionBar messageId={message.id} reactions={message.reactions} disabled={readOnly} />
          </div>
        )}
      </div>
    </article>
  );
}
