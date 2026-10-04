"use client";

/**
 * The per-row "discuss this figure" control, shared by all three ledgers
 * (transactions-ledger-016).
 *
 * It lived inline in app/(app)/expenses/expenses-client.tsx, twice — once for
 * the md+ table and once for the phone card list — and nowhere else, which is
 * the whole of the finding: `Comment.transactionId` points at a Transaction, not
 * at an expense, and both server gates (`createCommentAction` and
 * `mayReadTarget`) ask only `canSeeFinances` + "is this row in my company". So a
 * sale and a capital injection were already commentable everywhere except on
 * screen. Hoisted here rather than copied twice more because six copies of one
 * accessible name is how two of them end up saying something different.
 *
 * THE COUNT IS ALREADY ON THE WIRE for every row of every type: `getTransactions`
 * includes `_count.comments` unconditionally (lib/queries/transactions.ts), so
 * /revenue and /investments were paying for a number they could not render.
 *
 * NOT GATED ON AUTHORSHIP, unlike edit and delete: discussing a figure is not
 * changing it, and `canSeeFinances` — which every reader of these pages has
 * already passed — is the only predicate the two server gates apply. The caller
 * therefore mounts this OUTSIDE its "mine-or-admin" fence.
 */

import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/i18n/use-t";

type Props = {
  /** `TransactionWithCount.commentCount` for this row. */
  count: number;
  /** The row's description, so the accessible name says WHICH row this opens. */
  description: string;
  onClick: () => void;
};

export function TransactionCommentButton({ count, description, onClick }: Props) {
  const n = useNumberFormat();
  return (
    <button
      onClick={onClick}
      aria-label={
        count > 0
          ? `Open comments (${n.number(count)}) for ${description}`
          : `Add a comment to ${description}`
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
        count > 0
          ? "text-forest-strong hover:bg-forest/10"
          : "text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
      )}
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
      {count > 0 && <span className="font-mono font-bold">{n.number(count)}</span>}
    </button>
  );
}
