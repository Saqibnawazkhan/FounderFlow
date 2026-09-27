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
 * Read receipts fire only while the reader is parked at the bottom, and are
 * debounced — otherwise a flick through ten channels writes ten rows.
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
  readDebounceMs = READ_DEBOUNCE_MS,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
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
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
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

  // Read receipt: only while parked at the bottom, and only when the newest
  // message changes — re-running on every scroll tick would hammer the DB.
  const newestId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (!atBottom || !newestId) return;
    const timer = setTimeout(() => {
      // Wrapped in Promise.resolve so a mocked action that returns undefined
      // doesn't blow up on .catch.
      Promise.resolve(markChannelReadAction({ channelId })).catch(() => {
        // A failed read receipt is cosmetic — the badge stays until next time.
      });
    }, readDebounceMs);
    return () => clearTimeout(timer);
  }, [atBottom, newestId, channelId, readDebounceMs]);

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
            <div key={message.id} className={grouped ? "mt-0.5" : "mt-3 first:mt-0"}>
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
