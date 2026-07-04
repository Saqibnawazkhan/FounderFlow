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

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Send, Trash2, AtSign } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { createCommentAction, deleteCommentAction } from "@/lib/actions/comments";
import { cn } from "@/lib/utils";
import type { CommentClient, CommentTarget } from "@/lib/queries/comments";
import type { ActiveMention, MentionUser } from "@/lib/comments/mentions";
import { findMentionQuery, slugifyName } from "@/lib/comments/mentions";

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
};

export function CommentThread({
  target,
  initialComments,
  currentUserId,
  currentUserRole,
  companyUsers,
  onChanged,
}: Props) {
  const [comments, setComments] = useState(initialComments);
  useEffect(() => setComments(initialComments), [initialComments]);

  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaId = useId();
  const listboxId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // @mention autocomplete (T6): `mention` is the active token span under the
  // caret (or null); `activeIndex` is the highlighted candidate.
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const mentionCandidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return companyUsers
      .filter((u) => u.id !== currentUserId)
      .filter((u) => {
        const slug = slugifyName(u.name);
        return slug.includes(q) || u.name.toLowerCase().includes(q);
      })
      .slice(0, 6);
  }, [mention, companyUsers, currentUserId]);

  const showMentions = mention !== null && mentionCandidates.length > 0;

  function refreshMention(value: string, caret: number) {
    setMention(findMentionQuery(value, caret));
    setActiveIndex(0);
  }

  function acceptMention(user: MentionUser) {
    if (!mention) return;
    const slug = slugifyName(user.name);
    const before = body.slice(0, mention.from);
    const after = body.slice(mention.to);
    const insert = `@${slug} `;
    const next = before + insert + after;
    setBody(next);
    setMention(null);
    const caret = before.length + insert.length;
    // Restore focus + caret after the inserted slug on the next frame, once
    // React has flushed the new value into the textarea.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showMentions) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % mentionCandidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const pick = mentionCandidates[activeIndex];
      if (pick) {
        e.preventDefault();
        acceptMention(pick);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
    }
  }

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
    setMention(null);
    // Honest count: notifiedCount comes from the actual createMany result,
    // so if the fan-out threw, we don't overstate. mentionedUserIds is the
    // PARSED list — useful to know "we tried", but the user wants to know
    // who got the ping.
    const { notifiedCount, mentionedUserIds } = result.data;
    if (notifiedCount > 0) {
      toast.success(`Posted — pinged ${notifiedCount} teammate(s)`);
    } else if (mentionedUserIds.length > 0) {
      // Parsed mentions but no notifications landed → fan-out failed.
      toast(
        `Posted — couldn't send mention pings (${mentionedUserIds.length} attempted). The team has been notified.`,
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
                className={cn(
                  "group rounded-xl border bg-bg/40 p-4 transition-colors",
                  mentionsCurrentUser ? "border-primary/40 bg-primary/[0.04]" : "border-border"
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
                      className="rounded-md p-1 text-fg-muted opacity-0 transition-all hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
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
                            : "bg-cyan/15 text-cyan-strong"
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
              refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={handleTextareaKeyDown}
            onClick={(e) => refreshMention(body, e.currentTarget.selectionStart ?? body.length)}
            onSelect={(e) => refreshMention(body, e.currentTarget.selectionStart ?? body.length)}
            onBlur={() => setMention(null)}
            placeholder={`Write a comment… use ${slugSuggestions[0] ?? "@name"} to mention someone`}
            rows={3}
            maxLength={2000}
            disabled={submitting}
            role="combobox"
            aria-expanded={showMentions}
            aria-controls={showMentions ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={showMentions ? `${listboxId}-opt-${activeIndex}` : undefined}
            className="w-full resize-y rounded-lg border border-transparent bg-transparent p-2 text-sm text-fg placeholder:text-fg-muted/60 focus:border-primary/30 focus:bg-glass/[0.04] focus:outline-none"
          />

          {showMentions && (
            <ul
              id={listboxId}
              role="listbox"
              aria-label="Mention a teammate"
              className="absolute left-1 right-1 top-full z-30 mt-1 max-h-56 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-card"
            >
              {mentionCandidates.map((u, i) => {
                const selected = i === activeIndex;
                return (
                  <li
                    key={u.id}
                    id={`${listboxId}-opt-${i}`}
                    role="option"
                    aria-selected={selected}
                  >
                    <button
                      type="button"
                      // mousedown (not click) so the textarea never blurs first,
                      // which would null out `mention` before we can read it.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        acceptMention(u);
                      }}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
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
