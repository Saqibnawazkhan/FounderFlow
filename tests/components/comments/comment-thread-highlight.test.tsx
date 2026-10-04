/**
 * The thread puts the reader on the line they were sent to.
 * Finding tasks-and-comments-003, the last half.
 *
 * Opening the right thread was not the whole promise. The filing asks for "the
 * task's comment thread scrolled to that comment, the way `/tasks?taskId=<id>`
 * scrolls and flashes the card" — and a thread can be two hundred comments
 * long while a mention is about one line of it.
 *
 * WHAT IS ASSERTED, and the deliberate division of labour. The DECISION —
 * scroll, say it is gone, or do nothing — is `commentHighlightState`, covered
 * exhaustively in tests/components/comments/comment-deep-link.test.ts without a
 * DOM. What is left for this file is the wiring: that the decision reaches a
 * real `<article>`, that `scrollIntoView` is actually called on THAT node and
 * not another, that the flash ring lands on the right comment, and that the
 * missing case renders something a reader can read.
 *
 * WHY `scrollIntoView` IS AN ASSERTION AND NOT A SMOKE CHECK. jsdom lays nothing
 * out, so tests/setup.ts stubs `Element.prototype.scrollIntoView` with a spy —
 * which makes "was the right node scrolled" the one observable thing here, and
 * the only thing that distinguishes a wired ref from a dead one. A test that
 * only looked for the ring would pass against a component that highlights
 * correctly and never scrolls, which on a long thread is the entire bug.
 *
 * The composer's own behaviour (@-autocomplete, the submit toast) belongs to
 * other files; this one never types.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommentThread } from "@/components/comments/comment-thread";
import type { CommentClient } from "@/lib/queries/comments";

/* ───────────────────────────── module mocks ─────────────────────────────── */

// The thread imports lib/actions/comments, which pulls in lib/auth — next-auth's
// server entry does not resolve under vitest. Nothing here submits.
vi.mock("@/lib/actions/comments", () => ({
  createCommentAction: vi.fn(),
  deleteCommentAction: vi.fn(),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
// useNumberFormat reads the workspace locale from the store.
vi.mock("@/lib/store", () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ locale: "en", currentCompany: { id: "c1", currency: "PKR" } }),
  useStoreHasHydrated: () => true,
}));

/* ────────────────────────────── fixtures ────────────────────────────────── */

function comment(id: string, body: string): CommentClient {
  return {
    id,
    body,
    authorId: "u_ayesha",
    authorName: "Ayesha Raza",
    authorAvatar: null,
    mentionedUserIds: [],
    segments: [{ type: "text", text: body }],
    createdAt: "2026-09-30T10:00:00.000Z",
    editedAt: null,
  };
}

const FIRST = comment("cm_1", "Booked against the wrong category, I think");
const TARGET = comment("cm_2", "Moved it to Consulting — @sana can you confirm");
const LAST = comment("cm_3", "Confirmed, thanks");
const THREAD = [FIRST, TARGET, LAST];

function renderThread(highlightCommentId: string | null, comments = THREAD) {
  return render(
    <CommentThread
      target={{ taskId: "t_1" }}
      initialComments={comments}
      currentUserId="u_sana"
      currentUserRole="member"
      companyUsers={[{ id: "u_ayesha", name: "Ayesha Raza", handle: "ayesha" }]}
      highlightCommentId={highlightCommentId}
    />
  );
}

/** The `<article>` wrapping one comment, found through its body text. */
function articleFor(body: string): HTMLElement {
  const el = screen.getByText(body).closest("article");
  if (!el) throw new Error(`No <article> around "${body}"`);
  return el as HTMLElement;
}

const scrollSpy = () => Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;

const MISSING_NOTICE = /isn't in this thread any more|isn’t in this thread any more/i;

beforeEach(() => {
  scrollSpy().mockClear();
  vi.useRealTimers();
});

describe("a deep-linked comment is scrolled to and flashed (003)", () => {
  it("scrolls the named comment into view, and not a different one", async () => {
    renderThread("cm_2");

    // requestAnimationFrame, which the component uses so the ref's node is laid
    // out before it is read.
    await vi.waitFor(() => expect(scrollSpy()).toHaveBeenCalled());

    const calls = scrollSpy().mock.instances ?? [];
    // `mock.instances` holds the `this` of each call — the element scrolled.
    expect(calls[0], "scrollIntoView ran on the wrong node").toBe(articleFor(TARGET.body));
  });

  it("flashes the named comment and leaves the others alone", async () => {
    renderThread("cm_2");
    await vi.waitFor(() => expect(scrollSpy()).toHaveBeenCalled());

    expect(articleFor(TARGET.body).className).toMatch(/ring-2/);
    expect(
      articleFor(FIRST.body).className,
      "the flash landed on a comment nobody was linked to"
    ).not.toMatch(/ring-2/);
    expect(articleFor(LAST.body).className).not.toMatch(/ring-2/);
  });

  it("does nothing at all when the thread was opened by hand", async () => {
    // GUARDS THE GUARD. Every assertion above would also pass against a thread
    // that scrolled to and flashed its middle comment unconditionally — which is
    // what the per-row "💬 N" button would then do on every open.
    renderThread(null);

    expect(scrollSpy()).not.toHaveBeenCalled();
    THREAD.forEach((c) => expect(articleFor(c.body).className).not.toMatch(/ring-2/));
    expect(screen.queryByText(MISSING_NOTICE)).not.toBeInTheDocument();
  });

  it("drops the flash after a few seconds rather than leaving it on forever", async () => {
    vi.useFakeTimers();
    renderThread("cm_2");
    // The ring is applied synchronously with the decision; only the scroll waits
    // for a frame, so this needs no waitFor.
    expect(articleFor(TARGET.body).className).toMatch(/ring-2/);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(
      articleFor(TARGET.body).className,
      "the ring is a 'here it is', not a permanent state"
    ).not.toMatch(/ring-2/);
    vi.useRealTimers();
  });
});

describe("a deep-linked comment that is no longer in the thread says so (003)", () => {
  it("explains the gap instead of highlighting nothing", async () => {
    // The read returns only the newest COMMENT_THREAD_LIMIT comments, so an
    // older mention is absent from a long thread; and a comment deleted between
    // the ping and the click is filtered out. Silence is indistinguishable from
    // a broken app.
    renderThread("cm_vanished");

    expect(screen.getByText(MISSING_NOTICE)).toBeInTheDocument();
    expect(scrollSpy(), "there was nothing to scroll to").not.toHaveBeenCalled();
  });

  it("still shows the conversation underneath the notice", async () => {
    // The thread is not an error state: they were linked to one line of it, and
    // the rest is still what they came to read.
    renderThread("cm_vanished");

    THREAD.forEach((c) => expect(screen.getByText(c.body)).toBeInTheDocument());
  });

  it("announces the notice to a screen reader", async () => {
    renderThread("cm_vanished");

    const status = screen.getByRole("status");
    expect(status.textContent ?? "").toMatch(MISSING_NOTICE);
  });
});
