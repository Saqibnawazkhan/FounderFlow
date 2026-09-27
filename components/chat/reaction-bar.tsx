"use client";

/**
 * <ReactionBar> — the row of emoji chips under a message, plus the "add one"
 * affordance.
 *
 * Deliberately NOT an emoji picker. The offer is the fixed eight in
 * REACTION_EMOJI (lib/schemas/chat.ts), which is also what the server will
 * accept, so the UI can't offer something the action would reject. emoji-mart
 * and friends ship ~1MB of emoji metadata for a feature the design never asks
 * for — the landing mock shows chips (👀 2, 🚀 3), not a picker.
 *
 * Toggling is optimistic with a real rollback: the chip flips the instant it's
 * clicked, and if the server says no we put the previous chips back AND toast.
 * A silent rollback is worse than no optimism at all — the count just "wrong"s
 * itself and the reader assumes they misclicked.
 */

import { useEffect, useRef, useState } from "react";
import { SmilePlus } from "lucide-react";
import toast from "react-hot-toast";
import { toggleReactionAction } from "@/lib/actions/chat";
import { REACTION_EMOJI } from "@/lib/schemas/chat";
import type { MessageReactionClient } from "@/lib/queries/chat";
import { cn } from "@/lib/utils";

/**
 * The query layer already defines this shape. Aliasing rather than
 * re-declaring keeps one source of truth: two structurally identical types
 * typecheck happily against each other, which is exactly why a divergence
 * between them would survive review.
 */
export type ReactionSummary = MessageReactionClient;

type Props = {
  messageId: string;
  reactions: ReactionSummary[];
  /** Archived channel, or no post permission. */
  disabled?: boolean;
};

/**
 * Pure toggle over the chip list — extracted so the optimistic apply, the
 * rollback and the post-response reconcile all agree on the same arithmetic.
 * A chip that drops to zero disappears; a brand-new emoji appends so the
 * existing chips don't reshuffle under the reader's cursor.
 */
function toggleIn(list: ReactionSummary[], emoji: string): ReactionSummary[] {
  const existing = list.find((r) => r.emoji === emoji);
  if (!existing) return [...list, { emoji, count: 1, mine: true }];
  if (existing.mine) {
    const count = existing.count - 1;
    if (count <= 0) return list.filter((r) => r.emoji !== emoji);
    return list.map((r) => (r.emoji === emoji ? { ...r, count, mine: false } : r));
  }
  return list.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r));
}

function isMine(list: ReactionSummary[], emoji: string): boolean {
  return list.some((r) => r.emoji === emoji && r.mine);
}

export function ReactionBar({ messageId, reactions, disabled = false }: Props) {
  const [chips, setChips] = useState<ReactionSummary[]>(reactions);
  // Server refetches (the caller's router.refresh after a send) replace the
  // optimistic view with the canonical one.
  useEffect(() => setChips(reactions), [reactions]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click-away close. Without it the picker stays open behind the next
  // message the reader clicks, which reads as a stuck UI.
  useEffect(() => {
    if (!pickerOpen) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  async function toggle(emoji: string) {
    if (disabled) return;
    const previous = chips;
    const optimistic = toggleIn(previous, emoji);
    setChips(optimistic);
    setPickerOpen(false);

    const result = await toggleReactionAction({ messageId, emoji });

    if (!result.success) {
      setChips(previous); // Roll back to exactly what was on screen before.
      toast.error(result.error);
      return;
    }

    // Reconcile: if the server landed on the opposite state (a double-click
    // race, or someone else's write interleaved), flip once more so the chip
    // matches the row that actually exists.
    if (result.data.reacted !== isMine(optimistic, emoji)) {
      setChips((current) => toggleIn(current, emoji));
    }
  }

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-2">
      {chips.map((r) => (
        <button
          key={r.emoji}
          type="button"
          disabled={disabled}
          aria-pressed={r.mine}
          aria-label={
            r.mine
              ? `Remove your ${r.emoji} reaction, ${r.count} total`
              : `React with ${r.emoji}, ${r.count} total`
          }
          onClick={() => void toggle(r.emoji)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] transition-colors",
            // The reader's own reaction is tinted AND aria-pressed — colour
            // alone would leave a screen-reader user unable to tell whether
            // they'd already reacted.
            r.mine && "border-primary/40 bg-primary/10",
            !disabled && "hover:border-primary/40",
            disabled && "cursor-not-allowed opacity-60"
          )}
        >
          <span aria-hidden="true">{r.emoji}</span>
          <span
            aria-hidden="true"
            className={cn("font-mono", r.mine ? "text-primary-strong" : "text-fg-muted")}
          >
            {r.count}
          </span>
        </button>
      ))}

      {!disabled && (
        <button
          type="button"
          aria-label="Add reaction"
          aria-haspopup="true"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((o) => !o)}
          className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-fg-muted transition-colors hover:border-primary/40 hover:text-fg"
        >
          <SmilePlus className="h-3 w-3" aria-hidden="true" />
        </button>
      )}

      {pickerOpen && (
        <div
          role="group"
          aria-label="Choose a reaction"
          className="absolute bottom-full left-0 z-30 mb-1 flex gap-1 rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          {REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              onClick={() => void toggle(emoji)}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-lg text-sm transition-colors hover:bg-primary/10",
                isMine(chips, emoji) && "bg-primary/10"
              )}
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
