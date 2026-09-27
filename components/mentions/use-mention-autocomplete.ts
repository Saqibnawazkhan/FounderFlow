"use client";

/**
 * useMentionAutocomplete — the @-mention combobox, extracted from
 * <CommentThread> so chat and comments share one implementation.
 *
 * This hook owns the *behaviour* (which token is under the caret, which
 * candidate is highlighted, what each key does, where the caret lands after an
 * accept) and hands back the a11y attributes. It deliberately does NOT own the
 * markup: the popup list is a handful of divs that each surface styles
 * differently, and JSX in here would drag layout decisions into a hook.
 *
 * The parsing rules live in lib/comments/mentions.ts and are reused verbatim —
 * `findMentionQuery` decides what counts as an in-progress token,
 * `mentionToken` decides what gets inserted. Do not re-derive either. In
 * particular do NOT go back to `slugifyName(u.name)` here: that is the T16 bug
 * (a name with no ASCII letters slugifies to `""`, or to a lone `"-"` when it
 * contains a space, and this hook used to insert a literal `"@ "` for it).
 * `mentionToken` prefers the handle, which is also what the resolver prefers,
 * so what the list offers is exactly what will resolve.
 *
 * Four details here are load-bearing and easy to lose in a rewrite:
 *
 *  1. `getOptionButtonProps` binds **onMouseDown with preventDefault**, not
 *     onClick. A click fires after blur, and blur nulls the active token — so
 *     an onClick handler would read `mention === null` and insert nothing.
 *  2. The caret is restored inside a `requestAnimationFrame`, after React has
 *     flushed the new value into the textarea. Setting it synchronously puts
 *     the caret at the end of the *old* value.
 *  3. `handleKeyDown` returns a boolean — `true` means "the listbox consumed
 *     this key". Callers with their own Enter binding (the chat composer sends
 *     on Enter) branch on that return instead of re-deriving `open`, which is
 *     what keeps mention-accept and Enter-to-send from fighting.
 *  4. A teammate with NO typable token at all — no handle, and a name that
 *     yields no typable slug — is filtered out of `candidates` entirely.
 *     Offering them is offering a row that inserts `@` followed by nothing and
 *     pings nobody. Their absence is a data problem (a missing handle, or a
 *     roster query that forgot `handle: true` in its `select`), and it is
 *     better to show one fewer row than a row that lies.
 *
 * The listbox markup still lives in each composer — see the note on the hook's
 * `tokenFor` below for the one thing those rows must render.
 */

import { useCallback, useId, useMemo, useState } from "react";
import type { ActiveMention, MentionUser } from "@/lib/comments/mentions";
import { findMentionQuery, mentionToken, slugifyName } from "@/lib/comments/mentions";

export type UseMentionAutocompleteOptions = {
  /** Current textarea value — the hook rewrites it on accept. */
  value: string;
  /** Called with the rewritten value when a candidate is accepted. */
  onChange: (next: string) => void;
  /** Roster to match against. */
  users: MentionUser[];
  /** Usually the reader — nobody wants to @-mention themselves. */
  excludeUserId?: string;
  /** The textarea being driven, for focus + caret restoration. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Max candidates shown. Defaults to 6, which is what comments shipped. */
  limit?: number;
};

export type MentionAutocomplete = {
  /** True when a token is active AND at least one candidate matches. */
  open: boolean;
  /** The filtered, capped candidate list, in roster order. */
  candidates: MentionUser[];
  /** Index of the highlighted candidate. Always 0 on a fresh token. */
  activeIndex: number;
  /** The active token's span + partial query, or null. */
  mention: ActiveMention | null;
  /** id for the popup's `role="listbox"` element. */
  listboxId: string;
  /** Spread onto the textarea: role/aria-expanded/aria-activedescendant/etc. */
  comboboxProps: {
    role: "combobox";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    "aria-autocomplete": "list";
    "aria-activedescendant": string | undefined;
  };
  /** Spread onto each `<li>`: id + role="option" + aria-selected. */
  getOptionProps: (index: number) => {
    id: string;
    role: "option";
    "aria-selected": boolean;
  };
  /** Spread onto each option's `<button>`: the mousedown/hover wiring. */
  getOptionButtonProps: (
    user: MentionUser,
    index: number
  ) => {
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseEnter: () => void;
  };
  /**
   * Arrow/Enter/Tab/Escape handling. Returns true when the listbox consumed
   * the event (and called preventDefault); false when the caller should apply
   * its own binding for that key.
   */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /**
   * The token a candidate will insert, without the `@` — their handle, or
   * their name slug when they have no handle.
   *
   * Every listbox row is two lines: the display name on top, `@` + this
   * underneath. Render THIS and not `slugifyName(u.name)`: the second line is
   * a promise about what accepting the row will type, and for a teammate whose
   * name is written in Urdu the name slug is untypable, so that row used to
   * promise `@` and nothing (T16, symptom 3). The markup stays in each
   * composer — this hook hands over the string, not the JSX.
   */
  tokenFor: (user: MentionUser) => string;
  /** Re-evaluate the active token. Call from onChange/onClick/onSelect. */
  refresh: (value: string, caret: number) => void;
  /** Insert `@token ` over the active token and restore the caret after it. */
  accept: (user: MentionUser) => void;
  /** Drop the active token — blur, Escape, and post-submit reset. */
  dismiss: () => void;
};

export function useMentionAutocomplete({
  value,
  onChange,
  users,
  excludeUserId,
  textareaRef,
  limit = 6,
}: UseMentionAutocompleteOptions): MentionAutocomplete {
  // `mention` is the active token span under the caret (or null);
  // `activeIndex` is the highlighted candidate within `candidates`.
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return (
      users
        .filter((u) => u.id !== excludeUserId)
        // No typable token → not offerable. See note 4 in the header.
        .filter((u) => mentionToken(u) !== "")
        .filter((u) => {
          // Match on all three of the things a person might be typing: the token
          // that will actually be inserted (usually the handle), the legacy name
          // slug, and the raw display name. Matching the name matters most for
          // the case this hook exists to fix — someone hunting for a teammate
          // written in Urdu script types latin letters of the handle, but
          // someone who knows the handle types it directly, and both have to land.
          const token = mentionToken(u);
          const slug = slugifyName(u.name);
          return token.includes(q) || slug.includes(q) || u.name.toLowerCase().includes(q);
        })
        .slice(0, limit)
    );
  }, [mention, users, excludeUserId, limit]);

  const open = mention !== null && candidates.length > 0;

  const refresh = useCallback((nextValue: string, caret: number) => {
    setMention(findMentionQuery(nextValue, caret));
    setActiveIndex(0);
  }, []);

  const dismiss = useCallback(() => setMention(null), []);

  const accept = useCallback(
    (user: MentionUser) => {
      if (!mention) return;
      const token = mentionToken(user);
      // Defensive: `candidates` already drops tokenless users, but `accept` is
      // public and inserting `"@ "` — a mention that pings nobody and reads as
      // a typo — is exactly the symptom T16 catalogued. Dismiss instead.
      if (!token) {
        setMention(null);
        return;
      }
      const before = value.slice(0, mention.from);
      const after = value.slice(mention.to);
      const insert = `@${token} `;
      onChange(before + insert + after);
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
    },
    [mention, value, onChange, textareaRef]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % candidates.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const pick = candidates[activeIndex];
        // No pick (an out-of-range index) → fall through to the caller's own
        // binding rather than swallowing the key.
        if (!pick) return false;
        e.preventDefault();
        accept(pick);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return true;
      }
      return false;
    },
    [open, candidates, activeIndex, accept]
  );

  const getOptionProps = useCallback(
    (index: number) => ({
      id: `${listboxId}-opt-${index}`,
      role: "option" as const,
      "aria-selected": index === activeIndex,
    }),
    [listboxId, activeIndex]
  );

  const getOptionButtonProps = useCallback(
    (user: MentionUser, index: number) => ({
      // mousedown (not click) so the textarea never blurs first, which would
      // null out `mention` before we can read it.
      onMouseDown: (e: React.MouseEvent) => {
        e.preventDefault();
        accept(user);
      },
      onMouseEnter: () => setActiveIndex(index),
    }),
    [accept]
  );

  return {
    open,
    candidates,
    activeIndex,
    mention,
    listboxId,
    comboboxProps: {
      role: "combobox",
      "aria-expanded": open,
      "aria-controls": open ? listboxId : undefined,
      "aria-autocomplete": "list",
      "aria-activedescendant": open ? `${listboxId}-opt-${activeIndex}` : undefined,
    },
    getOptionProps,
    getOptionButtonProps,
    tokenFor: mentionToken,
    handleKeyDown,
    refresh,
    accept,
    dismiss,
  };
}
