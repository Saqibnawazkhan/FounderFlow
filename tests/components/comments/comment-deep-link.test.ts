/**
 * The two decisions a mention deep link makes, as pure functions.
 * Finding tasks-and-comments-003.
 *
 * `createCommentAction` sends "<name> mentioned you" to
 * `/<page>?<target>=<rowId>&comment=<commentId>`. The target half located the
 * row; `comment=` was carried and read by nobody, so the only call to action an
 * @mention has landed the reader on a list with the conversation closed. Four
 * surfaces have one of these links — /tasks, /expenses, /revenue and
 * /investments — and the two decisions below are the whole of what they share:
 *
 *   `commentDeepLinkRow`      which row's thread to open, if any
 *   `commentHighlightState`   what to do about the one comment inside it
 *
 * WHY THEY ARE UNIT CASES. The interesting states are invisible from a click.
 * `missing` happens when the named comment is NOT in what came back — because
 * `listCommentsForTarget` returns only the newest `COMMENT_THREAD_LIMIT` (200)
 * comments, or because the comment was deleted between the ping and the click —
 * and reaching that through a rendered thread means 200+ fixture comments. That
 * is the lesson of tests/components/tasks/bulk-selection.test.ts, which started
 * life as a 210-row board test that never finished.
 */

import { describe, expect, it } from "vitest";
import { commentDeepLinkRow, commentHighlightState } from "@/components/comments/comment-deep-link";

const ROWS = [{ id: "r_1" }, { id: "r_2" }, { id: "r_3" }];

describe("commentDeepLinkRow — which thread a mention link opens", () => {
  it("resolves the row the target param names", () => {
    expect(
      commentDeepLinkRow({ commentId: "cm_9", targetId: "r_2", rows: ROWS, alreadyOpened: null })
    ).toEqual({ id: "r_2" });
  });

  it("opens nothing for a link with no comment id", () => {
    // Every `task_assigned` / `task_completed` notification is this shape. It
    // must highlight and nothing more — a modal nobody asked for on every task
    // ping would be a worse bug than the one being fixed.
    expect(
      commentDeepLinkRow({ commentId: null, targetId: "r_2", rows: ROWS, alreadyOpened: null })
    ).toBeNull();
  });

  it("opens nothing when the target param is missing", () => {
    // The comment id cannot resolve itself: there is no client-side route from a
    // comment to its row, and adding a server one would be a new public read of
    // the shape tasks-and-comments-004 was about.
    expect(
      commentDeepLinkRow({ commentId: "cm_9", targetId: null, rows: ROWS, alreadyOpened: null })
    ).toBeNull();
  });

  it("opens nothing when the row is not on this page", () => {
    // Beyond the page's row window, filtered out of the server's response, or
    // not visible to this reader at all — a member mentioned on a teammate's
    // task has no such card, and `listCommentsForTarget` would refuse them the
    // thread anyway. An empty modal is a worse answer than none.
    expect(
      commentDeepLinkRow({ commentId: "cm_9", targetId: "r_x", rows: ROWS, alreadyOpened: null })
    ).toBeNull();
  });

  it("opens nothing for a comment it has already answered", () => {
    // The param is still in the URL after the reader closes the modal, so
    // without this they could not dismiss it: it would reopen on the next
    // render, forever.
    expect(
      commentDeepLinkRow({ commentId: "cm_9", targetId: "r_2", rows: ROWS, alreadyOpened: "cm_9" })
    ).toBeNull();
  });

  it("still opens a DIFFERENT comment after one has been answered", () => {
    // GUARDS THE GUARD: a once-and-never-again latch would pass the case above
    // and break the second notification a reader follows in one session.
    expect(
      commentDeepLinkRow({ commentId: "cm_10", targetId: "r_2", rows: ROWS, alreadyOpened: "cm_9" })
    ).toEqual({ id: "r_2" });
  });

  it("opens nothing on an empty page", () => {
    expect(
      commentDeepLinkRow({ commentId: "cm_9", targetId: "r_2", rows: [], alreadyOpened: null })
    ).toBeNull();
  });
});

describe("commentHighlightState — which comment inside the thread", () => {
  const LOADED = [{ id: "cm_1" }, { id: "cm_2" }];

  it("scrolls to the comment when it is in the loaded thread", () => {
    expect(commentHighlightState({ requestedId: "cm_2", loaded: LOADED })).toEqual({
      kind: "scroll",
      commentId: "cm_2",
    });
  });

  it("does nothing when the thread was opened by hand", () => {
    // Which is every other way it opens: the per-row "💬 N" button passes null.
    expect(commentHighlightState({ requestedId: null, loaded: LOADED })).toEqual({ kind: "none" });
  });

  it("does nothing while the fetch is still in flight", () => {
    // `loaded: null` is "not back yet", NOT "not in the thread". Reading it as
    // the latter flashes the "no longer here" notice on every single open, for
    // the length of the request, and then takes it away again.
    expect(commentHighlightState({ requestedId: "cm_2", loaded: null })).toEqual({ kind: "none" });
  });

  it("reports the comment as missing when it is not in what came back", () => {
    // The real case, not a paranoia branch: the read returns the newest 200
    // comments, so an older mention is simply absent from a long thread; and a
    // comment deleted between the ping and the click is filtered by
    // `deletedAt: null`. Silence here is the original bug wearing a fix — the
    // reader follows a ping, the thread opens, and nothing is highlighted.
    expect(commentHighlightState({ requestedId: "cm_gone", loaded: LOADED })).toEqual({
      kind: "missing",
    });
  });

  it("reports missing rather than none on an empty thread", () => {
    expect(commentHighlightState({ requestedId: "cm_gone", loaded: [] })).toEqual({
      kind: "missing",
    });
  });
});
