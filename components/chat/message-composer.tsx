"use client";

/**
 * <MessageComposer> — the chat send box. Used twice: once at the foot of a
 * channel timeline, and once inside <ThreadPanel> with `parentId` set.
 *
 * Shares the @-mention combobox with <CommentThread> via
 * useMentionAutocomplete, so the keys, the a11y wiring and the caret handling
 * are the same surface in both places.
 *
 * ── The Enter binding ──────────────────────────────────────────────────────
 * Comments treat Enter as "newline, unless the mention listbox is open".
 * Chat has to treat Enter as "send". Those two rules collide on exactly one
 * keystroke, and the resolution is a strict priority order:
 *
 *   1. mid-IME composition (`isComposing`) → do nothing at all. A Japanese or
 *      Korean author presses Enter to *commit a candidate word*; sending there
 *      would cut them off mid-word and post a half-typed message.
 *   2. mention listbox open → the hook consumes Enter/Tab to accept the
 *      highlighted teammate, and we do NOT send. Picking a name and firing the
 *      message off in the same keystroke is never what anyone meant.
 *   3. Cmd/Ctrl+Enter → always send, even from a multi-line draft.
 *   4. Shift+Enter → newline (fall through to the browser default).
 *   5. bare Enter → send.
 *
 * `mentions.handleKeyDown` returning a boolean is what makes step 2 airtight:
 * we branch on "did the listbox consume this key" rather than re-deriving
 * "is the listbox open", so the two can never disagree.
 *
 * ── Failure behaviour ──────────────────────────────────────────────────────
 * On a failed send the typed body STAYS in the box. Clearing a composer on a
 * failed send loses someone's paragraph to a flaky network, and is the single
 * most infuriating bug a chat product can ship. The body is only cleared once
 * the server has confirmed the write.
 *
 * ── The Runway control ─────────────────────────────────────────────────────
 * `canPostRunway` adds a second, small button beside Send that posts the
 * workspace's cash / burn / runway snapshot as a `kind: "card"` message. It
 * touches none of the keyboard behaviour above: it is a plain `type="button"`
 * outside the textarea, so Enter, Shift+Enter, Cmd+Enter, the IME guard and
 * the mention listbox are all exactly as they were.
 *
 * THE PROP IS A CONVENIENCE, NOT THE GATE. It decides whether a control is
 * drawn; it decides nothing about whether a card may be posted. A prop is
 * client state, and client state is a suggestion — it arrives through a React
 * tree anyone can edit in a devtools pane, and this component is one
 * `<MessageComposer canPostRunway />` away from being wrong in a future
 * caller. `postRunwayCardAction` re-checks `canPostRunwayCard(role)` against
 * the session, server-side, before it computes a single figure. If the two
 * ever disagree, the server wins and the button was merely a lie about what
 * the click would do.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Rocket, Send, Smile } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { useMentionAutocomplete } from "@/components/mentions/use-mention-autocomplete";
import { postRunwayCardAction, sendMessageAction } from "@/lib/actions/chat";
import { composerPlaceholder, conversationTitle } from "@/lib/chat/dm";
import { slugifyName } from "@/lib/comments/mentions";
import { cn } from "@/lib/utils";

type Props = {
  channelId: string;
  /**
   * The conversation's `Channel.kind`, so the placeholder can tell a room from a
   * person: `Message #general` versus `Message Ahmed Khan` (chat-008).
   *
   * REQUIRED, deliberately, rather than optional-with-a-"public"-default. A
   * default would let a future caller silently reintroduce "Message #Ahmed Khan"
   * — which is the bug the product owner reported — and fail-open is the wrong
   * direction for a string that misrepresents who can read a conversation.
   * TypeScript refusing the call is the guard.
   */
  channelKind: string;
  /** Drives the placeholder: `Message #general`, or a person's name for a DM. */
  channelName: string;
  /** Set when composing a threaded reply; the thread root's id. */
  parentId?: string | null;
  /** Roster for the @-autocomplete. */
  users: { id: string; name: string }[];
  /** Archived channel, or no post permission. */
  disabled?: boolean;
  /**
   * May this author publish a Runway card here? Server-rendered from
   * `canPostRunwayCard(session.role)` and threaded down, rather than read from
   * a session inside this client component — a session in a client component
   * is a session in the browser bundle.
   *
   * CONVENIENCE, NOT THE GATE. See the header: the action re-checks. Defaults
   * to false so a caller that has not thought about it shows no control, which
   * is the fail-closed direction.
   */
  canPostRunway?: boolean;
  /** Caller refreshes its own message list. */
  onSent?: () => void;
};

/** Cap on the auto-grow, in px — roughly six rows before it scrolls. */
const MAX_COMPOSER_HEIGHT = 160;

export function MessageComposer({
  channelId,
  channelKind,
  channelName,
  parentId,
  users,
  disabled = false,
  canPostRunway = false,
  onSent,
}: Props) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [postingCard, setPostingCard] = useState(false);
  const textareaId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const mentions = useMentionAutocomplete({
    value: body,
    onChange: setBody,
    users,
    textareaRef,
  });

  // Auto-grow: reset to content height each time the draft changes, capped so
  // a pasted essay can't eat the whole timeline. Guarded on scrollHeight > 0
  // because jsdom reports 0 and we'd otherwise pin the box to zero height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT);
    el.style.height = next > 0 ? `${next}px` : "";
  }, [body]);

  const busy = sending || postingCard || disabled;
  const canSend = !busy && body.trim().length > 0;

  // Hidden inside a thread, not just disabled. `PostRunwayCardSchema` carries
  // no parentId on purpose, so a card posted from a thread panel would land in
  // the channel timeline instead of the thread the author is looking at — it
  // would appear to vanish. A control that does the wrong thing quietly is
  // worse than one that isn't there.
  const showRunway = canPostRunway && !parentId;

  async function submit() {
    if (busy) return;
    const trimmed = body.trim();
    // An empty (or whitespace-only) draft is a no-op, not an error toast —
    // it's almost always a stray Enter, and scolding for that is noise.
    if (!trimmed) return;

    setSending(true);
    const result = await sendMessageAction({
      channelId,
      body: trimmed,
      parentId: parentId ?? undefined,
    });
    setSending(false);

    if (!result.success) {
      toast.error(result.error);
      return; // Body deliberately untouched — see the header note.
    }

    setBody("");
    mentions.dismiss();

    // Honest fan-out reporting, same contract as <CommentThread>:
    // notifiedCount comes from the actual createMany result, mentionedUserIds
    // is the PARSED list. If we parsed mentions but notified nobody, the
    // fan-out failed and the author deserves to know rather than assume their
    // teammate was pinged.
    const { notifiedCount, mentionedUserIds } = result.data;
    if (notifiedCount > 0) {
      toast.success(`Sent — pinged ${notifiedCount} teammate(s)`);
    } else if (mentionedUserIds.length > 0) {
      toast(
        `Sent — couldn't send mention pings (${mentionedUserIds.length} attempted). The team has been notified.`,
        { icon: "⚠️" }
      );
    }
    // No toast for an ordinary message: the message appearing in the timeline
    // IS the confirmation, and a toast per message in a chat app is a plague.

    onSent?.();
  }

  /**
   * Post the Runway card.
   *
   * Sends the channelId and NOTHING ELSE — no figures. The action computes
   * cash, burn and runway server-side from the caller's own workspace, so a
   * client cannot publish numbers of its own invention under the company's
   * name; `PostRunwayCardSchema` has no field to put them in. Nothing is
   * rendered optimistically for the same reason: the timeline re-reads through
   * the query layer, which is where each viewer's redaction is applied.
   *
   * The draft is deliberately untouched, on success and on failure alike. A
   * half-typed message and a runway card are two separate acts, and eating
   * somebody's paragraph because they clicked the wrong button would be the
   * header's "most infuriating bug" with an extra step.
   */
  async function postRunwayCard() {
    if (busy) return;
    setPostingCard(true);
    const result = await postRunwayCardAction({ channelId });
    setPostingCard(false);

    if (!result.success) {
      toast.error(result.error);
      return;
    }

    // An ordinary message gets no toast — the header explains why a toast per
    // message is a plague — but a card is the exception on both counts. It is
    // rare, and unlike a send it leaves no trace in the composer: the box was
    // empty before the click and is empty after it, so without this the only
    // feedback is a row appearing further up a list the author may have
    // scrolled away from. It is also a disclosure of the company's finances,
    // and "that definitely happened" is worth one line for that alone.
    toast.success("Posted a runway snapshot");
    onSent?.();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // (1) Never interrupt an IME composition. React re-dispatches the native
    // event, so read the flag off nativeEvent rather than the synthetic one.
    if (e.nativeEvent.isComposing) return;

    // (2) The mention listbox gets first refusal on Arrow/Enter/Tab/Escape.
    // A `true` here means it accepted a teammate — do not also send.
    if (mentions.handleKeyDown(e)) return;

    if (e.key !== "Enter") return;

    // (3) Cmd/Ctrl+Enter always sends, whatever else is held.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // (4) Shift+Enter → let the browser insert the newline.
    if (e.shiftKey) return;
    // (5) Bare Enter → send.
    e.preventDefault();
    void submit();
  }

  // chat-008: this was `Message #${channelName}` unconditionally, so a DM read
  // "Message #Ahmed Khan". `composerPlaceholder` is the one place that decides,
  // shared with the browser tab and the channel header — and it is used for BOTH
  // the visible placeholder and the sr-only <label> below, so the wording a
  // screen-reader user hears cannot drift from the one a sighted reader sees.
  const placeholder = composerPlaceholder(channelKind, channelName);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="mt-auto border-t border-border p-3"
    >
      <label htmlFor={textareaId} className="sr-only">
        {parentId
          ? `Reply in the thread in ${conversationTitle(channelKind, channelName)}`
          : placeholder}
      </label>
      <div className="relative">
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2",
            "focus-within:border-primary/40",
            disabled && "opacity-60"
          )}
        >
          <textarea
            id={textareaId}
            ref={textareaRef}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              mentions.refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={handleKeyDown}
            onClick={(e) => mentions.refresh(body, e.currentTarget.selectionStart ?? body.length)}
            onSelect={(e) => mentions.refresh(body, e.currentTarget.selectionStart ?? body.length)}
            onBlur={mentions.dismiss}
            placeholder={placeholder}
            rows={1}
            maxLength={4000}
            disabled={disabled}
            {...mentions.comboboxProps}
            className="min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm text-fg placeholder:text-fg-muted/70 focus:outline-none disabled:cursor-not-allowed"
          />
          {/* Decorative, exactly as the landing mock shows it. An emoji PICKER
              is deliberately absent: reactions come from the fixed allow-list
              in <ReactionBar>, and emoji-mart is ~1MB of data for a feature
              nothing in the design asks for. */}
          <Smile className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
          {/* Quiet by design: a bordered text chip, not a second filled
              button. Only one action in this row is the primary one, and
              publishing the company's balance should read as a deliberate
              side-door rather than as the thing to press. `type="button"` is
              load-bearing — inside a <form> the default is "submit", which
              would fire the send path on every click. */}
          {showRunway && (
            <button
              type="button"
              onClick={() => void postRunwayCard()}
              disabled={busy}
              aria-busy={postingCard}
              aria-label="Post a runway snapshot to this channel"
              className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-1.5 py-1 font-mono text-[9px] uppercase tracking-wider text-fg-muted transition-colors hover:border-primary/40 hover:text-primary-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg-muted"
            >
              <Rocket className="h-3 w-3" aria-hidden="true" />
              {/* The visible label stays "Runway" while posting so the row
                  doesn't reflow mid-click; the state is announced through
                  aria-busy instead. */}
              <span>Runway</span>
            </button>
          )}
          <button
            type="submit"
            disabled={!canSend}
            aria-label={parentId ? "Send reply" : "Send message"}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
          >
            <Send className="h-3 w-3 text-primary-fg" aria-hidden="true" />
          </button>
        </div>

        {mentions.open && (
          <ul
            id={mentions.listboxId}
            role="listbox"
            aria-label="Mention a teammate"
            // Opens UPWARD: the composer sits at the bottom of the viewport,
            // so a downward popup would render off-screen.
            className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-56 overflow-auto rounded-xl border border-border bg-surface p-1 shadow-card"
          >
            {mentions.candidates.map((u, i) => {
              const selected = i === mentions.activeIndex;
              return (
                <li key={u.id} {...mentions.getOptionProps(i)}>
                  <button
                    type="button"
                    {...mentions.getOptionButtonProps(u, i)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                      selected ? "bg-primary/10" : "hover:bg-glass/[0.06]"
                    )}
                  >
                    <Avatar name={u.name} size="xs" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="block truncate text-sm font-semibold text-fg">{u.name}</span>
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
      {/* Enter/Shift+Enter is discoverable only if we say so once. */}
      <p className="mt-1 px-1 font-mono text-[9px] uppercase tracking-wider text-fg-muted">
        Enter to send · Shift+Enter for a new line
      </p>
    </form>
  );
}
