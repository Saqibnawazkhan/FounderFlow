"use client";

/**
 * <CommentThread> renders the conversation attached to a task or transaction
 * and an inline composer at the bottom. Designed to live inside a modal —
 * the parent owns the open/close state and the target descriptor.
 *
 * Server actions:
 *   • createCommentAction — write + mention fan-out
 *   • deleteCommentAction — author OR admin only (server re-checks)
 *
 * Data load: the parent passes a list-fetcher (typically a thin server
 * action wrapper around lib/queries/comments.listCommentsForTarget) so the
 * thread can re-fetch after writes without prop-drilling all the way up.
 *
 * a11y: textarea has an associated label, mention chips render with a
 * descriptive title, the "delete" button has a per-comment aria-label.
 */

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Send, Trash2, AtSign } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { createCommentAction, deleteCommentAction } from "@/lib/actions/comments";
import { cn } from "@/lib/utils";
import type { CommentClient, CommentTarget } from "@/lib/queries/comments";
import { commentHighlightState } from "@/components/comments/comment-deep-link";
import { useMentionAutocomplete } from "@/components/mentions/use-mention-autocomplete";
import type { MentionUser } from "@/lib/comments/mentions";
import { slugifyName } from "@/lib/comments/mentions";
import { useNumberFormat } from "@/lib/i18n/use-t";

type Props = {
  target: CommentTarget;
  initialComments: CommentClient[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  /** Roster powers the @-autocomplete and the slug hint under the composer. */
  companyUsers: MentionUser[];
  /**
   * Re-fetch trigger from the host — typically a router.refresh() wrapped
   * in a transition. The parent owns the data source.
   */
  onChanged?: () => void;
  /**
   * One comment to scroll to and flash — the `?comment=` half of a mention deep
   * link (tasks-and-comments-003). Null whenever the thread was opened by hand.
   * An id that is not in the loaded page gets a notice instead of silence; see
   * `commentHighlightState`.
   */
  highlightCommentId?: string | null;
};

export function CommentThread({
  target,
  initialComments,
  currentUserId,
  currentUserRole,
  companyUsers,
  onChanged,
  highlightCommentId = null,
}: Props) {
  const n = useNumberFormat();
  const [comments, setComments] = useState(initialComments);
  useEffect(() => setComments(initialComments), [initialComments]);

  /* ── SCROLL TO THE COMMENT THE MENTION POINTED AT (tasks-and-comments-003) ──
   *
   * The deep link opens the right thread; this puts the reader on the right
   * line of it. The decision — scroll, say it is gone, or do nothing — is
   * `commentHighlightState` in components/comments/comment-deep-link.ts, pure,
   * because its interesting case (the comment is NOT in the loaded page, because
   * the read returns only the newest COMMENT_THREAD_LIMIT) is invisible in a
   * rendered thread and a nuisance to reach with a click.
   *
   * ONE NODE PER COMMENT, so this needs none of the Set-of-nodes machinery the
   * ledger and board deep links carry: those render a desktop table and a phone
   * card list together and hide one with CSS, and `scrollIntoView` on a
   * `display:none` element silently does nothing. A comment renders as exactly
   * one `<article>`, so a single ref on the highlighted one is the whole of it.
   */
  const highlight = commentHighlightState({ requestedId: highlightCommentId, loaded: comments });
  const scrollToId = highlight.kind === "scroll" ? highlight.commentId : null;
  const highlightRef = useRef<HTMLElement | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollToId) return;
    setFlashId(scrollToId);
    // Next frame, not this commit: the article carrying the ref has not been
    // laid out yet while this effect runs on the render that introduced it.
    const frame = requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // The ring is a "here it is", not a permanent state — it would otherwise
    // still be on the comment an hour later, claiming an urgency that expired.
    const timer = setTimeout(() => setFlashId(null), 2500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [scrollToId]);

  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // @mention autocomplete (T6). The combobox behaviour — active token,
  // highlight, Arrow/Enter/Tab/Escape, caret restoration — lives in the shared
  // hook so comments and chat can never drift apart.
  const mentions = useMentionAutocomplete({
    value: body,
    onChange: setBody,
    users: companyUsers,
    excludeUserId: currentUserId,
    textareaRef,
  });

  // Roster slugs are useful in two places: rendering chip styling on
  // already-sent comments AND showing a tip under the composer for
  // first-time users who don't know the @first-last convention.
  const slugSuggestions = companyUsers
    .filter((u) => u.id !== currentUserId)
    .slice(0, 4)
    .map((u) => `@${slugifyName(u.name)}`);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    const result = await createCommentAction({ body: trimmed, ...target });
    setSubmitting(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    setBody("");
    mentions.dismiss();
    /* Honest count: `notifiedCount` comes from the actual fan-out result, so a
     * throw is not reported as success. `mentionedUserIds` is the PARSED list —
     * useful to know "we tried" — and `unreachableNames` is the third fact,
     * which the first version of this toast could not express.
     *
     * THE ORDER OF THESE BRANCHES IS THE POINT (tasks-and-comments-016). The
     * action no longer pings somebody who cannot open this thread — a member
     * named on a teammate's task, anyone but a founder named on a ledger row —
     * because that notification landed them on a page that provably did not
     * contain it. But a silent filter is the same defect as the silent fan-out
     * tasks-and-comments-001 was about, pointing the other way: the author sees
     * a green chip for a person who was never told. So the unreachable branch
     * comes FIRST and names them, even when other pings did land, because "we
     * pinged 2 teammates" is a true sentence that answers the wrong question
     * when a third was dropped.
     */
    const { notifiedCount, mentionedUserIds, unreachableNames } = result.data;
    if (unreachableNames.length > 0) {
      const who = unreachableNames.join(", ");
      const pinged =
        notifiedCount > 0 ? `pinged ${n.number(notifiedCount)} teammate(s), but ` : "but ";
      toast(
        `Posted — ${pinged}${who} can't open this thread, so ${
          unreachableNames.length === 1 ? "they weren't" : "they were not"
        } notified.`,
        { icon: "⚠️" }
      );
    } else if (notifiedCount > 0) {
      toast.success(`Posted — pinged ${n.number(notifiedCount)} teammate(s)`);
    } else if (mentionedUserIds.length > 0) {
      // Parsed mentions, everyone named can read this thread, and still nothing
      // landed → the fan-out itself failed.
      toast(
        `Posted — couldn't send mention pings (${n.number(
          mentionedUserIds.length
        )} attempted). The team has been notified.`,
        { icon: "⚠️" }
      );
    } else {
      toast.success("Comment posted");
    }
    startTransition(() => onChanged?.());
  }

  async function handleDelete(commentId: string) {
    const ok = await confirm({
      title: "Delete this comment?",
      description: "Cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const result = await deleteCommentAction({ commentId });
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    // Optimistic — drop the row immediately, then refresh for the canonical list.
    setComments((prev) => prev.filter((c) => c.id !== commentId));
    toast.success("Comment deleted");
    startTransition(() => onChanged?.());
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The comment this reader was sent to is not in the thread they were
          given. `role="status"` because it reports something already settled.
          Silence here is the original bug wearing a fix: they followed a ping
          and nothing was highlighted. */}
      {highlight.kind === "missing" && (
        <div
          role="status"
          className="rounded-xl border border-border bg-bg/40 px-4 py-2.5 text-xs text-fg-muted"
        >
          The comment you were linked to isn&apos;t in this thread any more — it may have been
          deleted, or the thread is long enough that it is older than the part shown here.
        </div>
      )}

      {/* Thread */}
      <div className="space-y-3" aria-live="polite">
        {comments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-bg/40 p-6 text-center">
            <MessageSquare className="mx-auto mb-2 h-6 w-6 text-fg-muted/40" aria-hidden="true" />
            <p className="text-sm text-fg-muted">No comments yet — start the thread.</p>
          </div>
        ) : (
          comments.map((c) => {
            const canDelete = c.authorId === currentUserId || currentUserRole === "admin";
            const mentionsCurrentUser = c.mentionedUserIds.includes(currentUserId);
            return (
              <article
                key={c.id}
                ref={c.id === scrollToId ? highlightRef : undefined}
                className={cn(
                  "group rounded-xl border bg-bg/40 p-4 transition-colors",
                  mentionsCurrentUser ? "border-primary/40 bg-primary/[0.04]" : "border-border",
                  // The deep-link flash. Last, so it wins over the mention
                  // border above — a mention of the reader is usually exactly
                  // the comment they were linked to, and without this the two
                  // states are indistinguishable.
                  c.id === flashId && "border-primary ring-2 ring-primary/40"
                )}
              >
                <header className="mb-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Avatar name={c.authorName} size="xs" />
                    <span className="text-sm font-semibold text-fg">{c.authorName}</span>
                    <time
                      dateTime={c.createdAt}
                      title={new Date(c.createdAt).toLocaleString()}
                      className="font-mono text-[10px] uppercase tracking-wider text-fg-muted"
                    >
                      {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                    </time>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDelete(c.id)}
                      aria-label={`Delete comment by ${c.authorName}`}
                      className="rounded-md p-1.5 text-fg-muted opacity-0 transition-all hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </header>
                <p className="whitespace-pre-wrap break-words text-sm text-fg">
                  {c.segments.map((seg, i) =>
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
                </p>
              </article>
            );
          })
        )}
      </div>

      {/* Composer */}
      <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-bg/40 p-3">
        <label htmlFor={textareaId} className="sr-only">
          Comment body
        </label>
        <div className="relative">
          <textarea
            id={textareaId}
            ref={textareaRef}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              mentions.refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={(e) => {
              mentions.handleKeyDown(e);
            }}
            onClick={(e) => mentions.refresh(body, e.currentTarget.selectionStart ?? body.length)}
            onSelect={(e) => mentions.refresh(body, e.currentTarget.selectionStart ?? body.length)}
            onBlur={mentions.dismiss}
            placeholder={`Write a comment… use ${slugSuggestions[0] ?? "@name"} to mention someone`}
            rows={3}
            maxLength={2000}
            disabled={submitting}
            {...mentions.comboboxProps}
            className="w-full resize-y rounded-lg border border-transparent bg-transparent p-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/30 focus:bg-glass/[0.04] focus:outline-none"
          />

          {mentions.open && (
            <ul
              id={mentions.listboxId}
              role="listbox"
              aria-label="Mention a teammate"
              // Opens UPWARD. Downward it lands squarely on top of the
              // "Post comment" button, so a comment ending in a mention could
              // not be submitted by clicking — the click hit a listbox option
              // instead. Above the composer is the comment list, which nobody
              // needs to click mid-compose. The chat composer does the same.
              className="absolute inset-x-1 bottom-full z-30 mb-1 max-h-56 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-card"
            >
              {mentions.candidates.map((u, i) => {
                const selected = i === mentions.activeIndex;
                return (
                  <li key={u.id} {...mentions.getOptionProps(i)}>
                    <button
                      type="button"
                      {...mentions.getOptionButtonProps(u, i)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start transition-colors",
                        selected ? "bg-primary/10" : "hover:bg-glass/[0.06]"
                      )}
                    >
                      <Avatar name={u.name} size="xs" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="block truncate text-sm font-semibold text-fg">
                          {u.name}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-fg-muted">
                          @{slugifyName(u.name)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1.5 text-[10px] text-fg-muted">
            <AtSign className="h-3 w-3" aria-hidden="true" />
            <span className="font-mono uppercase tracking-wider">
              {slugSuggestions.length > 0
                ? slugSuggestions.slice(0, 3).join("  ")
                : "no teammates yet"}
            </span>
          </div>
          <button
            type="submit"
            disabled={submitting || body.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
          >
            <Send className="h-3 w-3" aria-hidden="true" />
            {submitting ? "Posting…" : "Post comment"}
          </button>
        </div>
      </form>
    </div>
  );
}
