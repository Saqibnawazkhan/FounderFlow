"use client";

/**
 * Opening the thread a "<name> mentioned you" notification points at — the one
 * rule, shared by the four surfaces that have one.
 *
 * tasks-and-comments-003. `createCommentAction` sends the ping to
 * `/<page>?<target>=<rowId>&comment=<commentId>`: the TARGET param first,
 * because it is the one that locates the row, and `comment=` second, because it
 * names the conversation. The target half was honoured first — /tasks scrolls
 * and flashes the card, /expenses scrolls and flashes the row — and `comment=`
 * was carried but read by NOBODY, so the only call to action an @mention has
 * landed the reader on a list with the conversation still closed. That is the
 * finding's own wording: "the comment it points at never opens".
 *
 * WHY THE COMMENT ID DOES NOT RESOLVE ITSELF. There is no client-side way to go
 * from a comment id to its target — `listCommentsForTarget` takes a TARGET, and
 * a lookup endpoint that answered "which row owns comment X" would be a new
 * public read of exactly the shape tasks-and-comments-004 was about. So the row
 * is found from the target param the link already carries, and `comment=` is
 * only the trigger. An unresolvable pair opens nothing at all, deliberately: on
 * /tasks a member mentioned on a teammate's task has no such row on their board
 * and `listCommentsForTarget` would refuse them the thread anyway, so an empty
 * modal is a worse answer than none.
 *
 * ONE MODULE, FOUR CALLERS — /tasks, /expenses, /revenue, /investments. The
 * three ledgers differ a great deal in what else they do with a deep link
 * (/expenses also clears the reader's filters and scrolls across several frames;
 * /revenue and /investments read no target param at all before this), but they
 * do not differ in THIS decision, and three hand-written copies of a
 * once-per-id effect is three places for it to drift.
 */

import { useEffect, useRef } from "react";

/**
 * The row whose thread should open, or `null` for "leave the page alone".
 *
 * Pure, and separate from the hook, so the decision can be read and tested
 * without a DOM — the same split as `components/tasks/bulk-selection.ts`. Every
 * branch below is a case somebody will hit:
 *
 *   - no `comment=`    an ordinary task/row notification. Highlight, do not
 *                      open. Every `task_assigned` ping is this.
 *   - no target param  a hand-edited or truncated URL. Nothing to resolve.
 *   - already opened   the param is still in the URL after the reader closed
 *                      the modal, so without this they could not dismiss it.
 *   - row absent       beyond the page's row window, filtered out of the
 *                      server's response, or not visible to this reader.
 */
export function commentDeepLinkRow<T extends { id: string }>({
  commentId,
  targetId,
  rows,
  alreadyOpened,
}: {
  commentId: string | null;
  targetId: string | null;
  rows: readonly T[];
  alreadyOpened: string | null;
}): T | null {
  if (!commentId || !targetId) return null;
  if (alreadyOpened === commentId) return null;
  return rows.find((r) => r.id === targetId) ?? null;
}

/**
 * Wire `commentDeepLinkRow` to an effect, remembering which comment id has
 * already been answered.
 *
 * `onOpen` is held in a ref rather than listed as a dependency: every caller
 * passes an inline arrow, so as a dependency it would re-run this effect on
 * every render of a page that re-renders on every keystroke in its search box.
 * The ref keeps the effect keyed on the three things that can actually change
 * the answer.
 */
export function useCommentDeepLink<T extends { id: string }>({
  commentId,
  targetId,
  rows,
  onOpen,
}: {
  commentId: string | null;
  targetId: string | null;
  rows: readonly T[];
  onOpen: (row: T) => void;
}): void {
  const openedRef = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const row = commentDeepLinkRow({
      commentId,
      targetId,
      rows,
      alreadyOpened: openedRef.current,
    });
    if (!row) return;
    // Non-null whenever `row` is: `commentDeepLinkRow` returns null otherwise.
    openedRef.current = commentId;
    onOpenRef.current(row);
  }, [commentId, targetId, rows]);
}

/**
 * What an open thread should do about the one comment it was sent to.
 *
 * THE SECOND HALF OF THE SAME LINK. Opening the right thread is not the whole
 * promise: the filing asks for "the task's comment thread scrolled to that
 * comment". A thread can be long, and a mention is usually about one line in it.
 *
 * `missing` IS A REAL STATE AND NOT A PARANOIA BRANCH, which is why this returns
 * three cases rather than a `string | null`. `listCommentsForTarget` returns the
 * NEWEST `COMMENT_THREAD_LIMIT` (200) comments, so on a long thread an older
 * mention is simply not in the page that came back; and a comment deleted
 * between the ping and the click is filtered out by `deletedAt: null`. Without a
 * third case the reader clicks a notification, the thread opens, and nothing is
 * highlighted — which they cannot tell apart from a broken app. (`deleteComment`
 * sweeps the notification, so the deleted case is a race rather than the norm.)
 *
 * `loaded: null` means the fetch has not come back yet, and must NOT be read as
 * "not in the thread" — that would flash the "no longer here" notice on every
 * open, for the duration of the request, and then take it away.
 */
export type CommentHighlight =
  | { kind: "none" }
  | { kind: "scroll"; commentId: string }
  | { kind: "missing" };

export function commentHighlightState({
  requestedId,
  loaded,
}: {
  requestedId: string | null;
  loaded: readonly { id: string }[] | null;
}): CommentHighlight {
  if (!requestedId) return { kind: "none" };
  if (loaded === null) return { kind: "none" };
  if (loaded.some((c) => c.id === requestedId)) return { kind: "scroll", commentId: requestedId };
  return { kind: "missing" };
}
