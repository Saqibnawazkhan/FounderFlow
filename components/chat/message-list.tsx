"use client";

/**
 * <MessageList> — the scrollport, and the only place in the chat surface that
 * owns scroll decisions.
 *
 * The four rules, in the order they bite:
 *
 *  1. MOUNT pins to the bottom. A channel always opens on the newest message.
 *  2. AN ARRIVAL pins to the bottom ONLY if the reader was already there.
 *     Yanking someone out of the backlog to show a new message is the single
 *     most hated behaviour a chat client can have.
 *  3. THE READER'S OWN message always pins, wherever they were — they just
 *     pressed send and expect to see it land.
 *  4. A PREPENDED older page must not move the viewport. We restore
 *     `scrollTop` by the height the prepend added, so the message the reader
 *     was looking at stays exactly where it was.
 *
 * `prevMetrics` holds the PRE-update `scrollHeight`/`scrollTop`. It is
 * refreshed at the end of every messages-commit and on every scroll event, so
 * by the time a prepend lands it describes the DOM as it was a moment ago.
 * The restore is `newScrollHeight - oldScrollHeight + oldScrollTop`.
 *
 * Read receipts fire only while the reader is parked at the bottom, are
 * debounced — otherwise a flick through ten channels writes ten rows — and are
 * sent at most ONCE PER WATERMARK (chat-014): the effect has to depend on
 * `atBottom`, so without that guard every scroll back to the bottom re-sent a
 * receipt for a message the reader had already read, and each one cost two
 * `revalidatePath` calls on a shared cache tag.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { format, isSameDay } from "date-fns";
import { ArrowDown, Loader2, MessagesSquare } from "lucide-react";
import { markChannelReadAction } from "@/lib/actions/chat";
import { MessageRow } from "@/components/chat/message-row";
import { cn } from "@/lib/utils";
import type { MessageClient } from "@/lib/queries/chat";

/** Within this many px of the end still counts as "at the bottom". */
const BOTTOM_THRESHOLD_PX = 64;
/** Scrolling this close to the top asks for the next older page. */
const NEAR_TOP_PX = 96;
/** Same author inside this window collapses into the previous row. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const READ_DEBOUNCE_MS = 750;

export type MessageListProps = {
  channelId: string;
  currentUserId: string;
  /** Oldest to newest. The list never re-sorts; the caller owns order. */
  messages: MessageClient[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Archived channel or non-member — reactions render read-only. */
  disabled?: boolean;
  /** Passed through to each row's reply indicator. */
  onOpenThread?: (message: MessageClient) => void;
  /**
   * The message a `?message=<id>` deep link named (chat-010), or null.
   *
   * This component's job is to MARK it and to bring it into view. Whether the
   * row is in the loaded page at all, and what to do when it is not, is
   * <ChatClient>'s — see `nextAnchorStep` in lib/chat/anchor.ts. An id that is
   * not in `messages` marks nothing and scrolls nowhere: guessing at the nearest
   * row would assert that the wrong message was the one somebody was mentioned
   * in, which is worse than highlighting none.
   */
  anchoredMessageId?: string | null;
  /** Test seam: tests pass 0 so the read receipt doesn't need fake timers. */
  readDebounceMs?: number;
};

export function MessageList({
  channelId,
  currentUserId,
  messages,
  hasMore,
  loadingOlder,
  onLoadOlder,
  disabled = false,
  onOpenThread,
  anchoredMessageId = null,
  readDebounceMs = READ_DEBOUNCE_MS,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The rendered row for each message id, so the anchor can be found without a
   * `document.getElementById` reaching outside this component's own tree. Ref
   * callbacks, not a query: two <MessageList>s on one page (a thread panel is a
   * different component, but nothing prevents it) would collide on a global id
   * lookup, and this cannot.
   */
  const rowRefs = useRef(new Map<string, HTMLElement>());
  /**
   * Was a deep link present when this list MOUNTED?
   *
   * A ref seeded once, rather than the prop, because the mount branch of the
   * scroll effect below must not list `anchoredMessageId` as a dependency: that
   * effect also handles arrivals and prepends, and re-running it because the
   * anchor changed would put it through the arrival branch and pin the viewport
   * to the bottom — exactly what the anchor exists to prevent. The question it
   * needs answered is about mount time anyway, and that never changes.
   */
  const anchoredOnMount = useRef(anchoredMessageId);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);

  // Refs, not state: the layout effect needs these DURING the commit, before
  // any re-render could deliver a new state value.
  const atBottomRef = useRef(true);
  const prevMetrics = useRef({ scrollHeight: 0, scrollTop: 0 });
  const prevFirstId = useRef<string | null>(null);
  const prevLastId = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    prevMetrics.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };

    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = distance <= BOTTOM_THRESHOLD_PX;
    atBottomRef.current = nowAtBottom;
    setAtBottom(nowAtBottom);
    if (nowAtBottom) setUnseen(0);

    if (el.scrollTop <= NEAR_TOP_PX && hasMore && !loadingOlder) onLoadOlder();
  }, [hasMore, loadingOlder, onLoadOlder]);

  // Layout (not passive) so the reader never sees the intermediate position.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const firstId = messages[0]?.id ?? null;
    const lastId = messages[messages.length - 1]?.id ?? null;

    if (!mountedRef.current) {
      mountedRef.current = true;
      prevFirstId.current = firstId;
      prevLastId.current = lastId;
      // chat-010: a deep link opens ON the message it named, not at the live
      // edge. The anchor effect below owns the position in that case; pinning
      // here first would scroll twice and land wherever the second one ran.
      //
      // BUT ONLY IF THE ANCHOR IS ACTUALLY HERE. This tested the raw prop, and
      // the anchor effect returns early on the DERIVED `anchoredId`, which is
      // null whenever the id is not in `messages`. So for three of chat-010's
      // own outcomes — a thread reply (never in the timeline by design), a root
      // older than the loaded page, and an id that resolves to nothing — the pin
      // was suppressed and the anchor effect then did nothing either, leaving
      // the reader at the TOP of the loaded history: no anchor, and not the live
      // edge they would have got with no link at all. Found by adversarial
      // verification, which is also why the comment above now says "below".
      //
      // Asked here rather than by re-seeding the ref, because this branch runs
      // exactly once and `messages` is already in scope; `useRef(expr)` would
      // re-evaluate the search on every render to keep a value from the first.
      const anchorIsHere =
        anchoredOnMount.current !== null && messages.some((m) => m.id === anchoredOnMount.current);
      if (!anchorIsHere) {
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
      }
      prevMetrics.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      return;
    }

    const prepended = firstId !== null && firstId !== prevFirstId.current;
    const appended = lastId !== null && lastId !== prevLastId.current;

    if (prepended) {
      el.scrollTop =
        el.scrollHeight - prevMetrics.current.scrollHeight + prevMetrics.current.scrollTop;
    }

    if (appended) {
      const newest = messages[messages.length - 1];
      const mine = newest?.authorId === currentUserId;
      if (mine || atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
        setAtBottom(true);
        setUnseen(0);
      } else {
        // Count what actually arrived rather than assuming one, so a burst
        // delivered in a single update reports honestly.
        const seenIndex = messages.findIndex((m) => m.id === prevLastId.current);
        const added = seenIndex >= 0 ? messages.length - 1 - seenIndex : 1;
        setUnseen((n) => n + added);
      }
    }

    prevFirstId.current = firstId;
    prevLastId.current = lastId;
    prevMetrics.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
  }, [messages, currentUserId]);

  /**
   * The watermark this list has already told the server about (chat-014).
   *
   * THE EFFECT BELOW DEPENDS ON `atBottom`, and it has to: the receipt may only
   * be sent while the reader is parked at the live edge, and that is a piece of
   * state. The consequence was that every transition INTO the at-bottom state
   * sent another receipt — so a reader flicking up and down a long channel
   * generated a stream of them, and each one cost the server a membership read,
   * a newest-message read, an UPDATE and `revalidatePath("/chat")` +
   * `revalidatePath("/chat/<slug>")` on a shared cache tag, to move a watermark
   * that had not moved.
   *
   * A ref, not state: it must not itself trigger a render, and the effect reads
   * it at the moment the timer fires rather than at the moment it was scheduled.
   *
   * SET ON SUCCESS ONLY. A refused receipt moved nothing, so the badge is still
   * wrong and the next opportunity has to take it — latching on the attempt
   * would make a single network blip permanent until the next message arrived.
   *
   * This is NOT the whole guard: `markChannelReadAction` makes the same
   * judgement server-side for every other caller (a second tab, a direct POST),
   * where it is the revalidation rather than the round trip that is being saved.
   */
  const sentWatermark = useRef<string | null>(null);

  // Read receipt: only while parked at the bottom, and only when the newest
  // message changes — re-running on every scroll tick would hammer the DB.
  const newestId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (!atBottom || !newestId) return;
    const timer = setTimeout(() => {
      // Already told the server about this exact message. Nothing newer has
      // been said, so there is nothing newer to have read.
      if (sentWatermark.current === newestId) return;
      // Wrapped in Promise.resolve so a mocked action that returns undefined
      // doesn't blow up on .catch.
      Promise.resolve(markChannelReadAction({ channelId }))
        .then((res) => {
          if (!res || !res.success) return;
          sentWatermark.current = newestId;
          // Tell the sidebar its Chat total just shrank. Only on a real
          // success: `res` is undefined under the test mocks this Promise.resolve
          // exists for, and firing on those would have the badge refetch after a
          // write that never happened. The sidebar re-reads the count from the
          // server rather than trusting a number from here, so a spurious event
          // is harmless but a missed one leaves a stale badge for 30s.
          //
          // AND ONLY WHEN THE WATERMARK ACTUALLY MOVED (chat-014). The action
          // now says so: `moved: false` covers a public channel the reader
          // never joined (so there is no watermark at all — audit row A54) and
          // a receipt for a message they had already read. `!== false` rather
          // than `=== true` because the data is optional in the test mocks this
          // guard already accommodates, and the costly mistake is the missed
          // event, not the spare one.
          if (res.data?.moved === false) return;
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ff-chat-read"));
          }
        })
        .catch(() => {
          // A failed read receipt is cosmetic — the badge stays until next time.
        });
    }, readDebounceMs);
    return () => clearTimeout(timer);
  }, [atBottom, newestId, channelId, readDebounceMs]);

  /**
   * Is the anchored message actually in the page on screen?
   *
   * Derived rather than trusted: the parent may hand down an id it is still
   * paging towards, so "did we get one?" and "is it on screen?" are different
   * questions and the mark and the scroll below both need the second.
   *
   * THE MOUNT BOTTOM-PIN ASKS THE SAME QUESTION AND NOT THROUGH THIS VALUE, and
   * an earlier version of this comment claimed otherwise — "every branch below …
   * has to agree … One answer, computed once" — while the pin a hundred lines up
   * read the raw prop. That disagreement was the regression: an anchor outside
   * the loaded page suppressed the pin and satisfied nothing. The pin cannot use
   * this memo (it runs in a layout effect that must not depend on the anchor, or
   * an anchor change would re-enter the arrival branch and pin to the bottom —
   * the exact thing the anchor exists to prevent), so it repeats the membership
   * test locally against the same `messages`. Two call sites, one rule, stated in
   * both places.
   */
  const anchoredId = useMemo(() => {
    if (!anchoredMessageId) return null;
    return messages.some((m) => m.id === anchoredMessageId) ? anchoredMessageId : null;
  }, [anchoredMessageId, messages]);

  /**
   * Bring the anchored row into view, once per anchor that lands.
   *
   * WHY IT IS ALLOWED TO OVERRIDE RULE 1 ("mount pins to the bottom"). A reader
   * who followed a mention notification did not ask for the newest message, they
   * asked for a specific one, and the mount pin is what left them at the live
   * edge of a busy room with nothing to show which message the link was about.
   * The pin still governs every ordinary open, because `anchoredId` is null then.
   *
   * `atBottomRef` is cleared at the same time so the NEXT arrival does not yank
   * the viewport back down to it — rule 2 already says an arrival pins only if
   * the reader was at the bottom, and someone reading a five-week-old message is
   * not.
   *
   * `scrollIntoView` is guarded: jsdom does not implement it (tests/setup.ts
   * installs a stub), and neither did older Safari with an options object.
   */
  const scrolledToAnchor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!anchoredId || scrolledToAnchor.current === anchoredId) return;
    const node = rowRefs.current.get(anchoredId);
    if (!node) return;
    scrolledToAnchor.current = anchoredId;
    atBottomRef.current = false;
    setAtBottom(false);
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center" });
    }
  }, [anchoredId]);

  const rows = useMemo(() => {
    return messages.map((message, i) => {
      const prev = i > 0 ? messages[i - 1] : null;
      const created = new Date(message.createdAt);
      const startsDay = !prev || !isSameDay(new Date(prev.createdAt), created);
      const grouped =
        !!prev &&
        !startsDay &&
        prev.authorId === message.authorId &&
        prev.deletedAt === null &&
        message.deletedAt === null &&
        created.getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
      return { message, startsDay, grouped, created };
    });
  }, [messages]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {hasMore && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted transition-colors hover:text-fg disabled:opacity-60"
            >
              {loadingOlder && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              {loadingOlder ? "Loading" : "Load earlier messages"}
            </button>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <MessagesSquare className="mb-2 h-6 w-6 text-fg-muted/40" aria-hidden="true" />
            <p className="text-sm text-fg-muted">No messages yet — say the first thing.</p>
          </div>
        ) : (
          rows.map(({ message, startsDay, grouped, created }) => (
            <div
              key={message.id}
              ref={(node) => {
                if (node) rowRefs.current.set(message.id, node);
                else rowRefs.current.delete(message.id);
              }}
              className={grouped ? "mt-0.5" : "mt-3 first:mt-0"}
            >
              {startsDay && (
                <div className="my-4 flex items-center gap-3 first:mt-0">
                  <span className="h-px flex-1 bg-border" />
                  <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">
                    {format(created, "EEE d MMM")}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <MessageRow
                message={message}
                currentUserId={currentUserId}
                grouped={grouped}
                disabled={disabled}
                onOpenThread={onOpenThread}
                anchored={message.id === anchoredId}
              />
            </div>
          ))
        )}
      </div>

      {unseen > 0 && (
        <button
          type="button"
          onClick={pinToBottom}
          className={cn(
            "absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-primary px-3 py-1.5",
            "inline-flex items-center gap-1.5 text-xs font-bold text-primary-fg shadow-card"
          )}
        >
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
          {unseen === 1 ? "1 new message" : `${unseen} new messages`}
        </button>
      )}
    </div>
  );
}
