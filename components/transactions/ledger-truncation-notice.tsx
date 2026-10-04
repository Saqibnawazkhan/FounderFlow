"use client";

/**
 * "Showing the 5,000 most recent of N" — the one thing a read ceiling owes the
 * customer (transactions-ledger-001).
 *
 * WHY THIS EXISTS AFTER THE TOTALS WERE FIXED. Every money figure on every
 * finance surface now comes from an unbounded SQL roll-up, so nothing is short
 * any more. The ROW LIST still is: `getTransactions()` reads at most
 * `MAX_TRANSACTIONS_PER_TYPE` rows per type (lib/queries/transactions.ts), and
 * the rows a ceiling drops are the OLDEST. None of the three ledger clients has
 * pagination of any kind — no loadMore, no page param — so those rows are not on
 * page 2, they are unreachable in the product. Without this line the page reads
 * a correct "Total expenses" above a table quietly missing the oldest thousand,
 * which is the original complaint ("my numbers stopped matching my bank")
 * relocated rather than closed. The only other signal is a server-side Sentry
 * `boundary: read-ceiling` warning, which the customer never sees.
 *
 * DERIVED, NOT CONFIGURED. The comparison is between the rows the page actually
 * received of this type and that type's uncapped `count` from
 * `getTransactionTotals().byType[type]` — never against the ceiling constant. So
 * it stays correct if the ceiling moves, and it is silent for every workspace
 * below it, which today is all of them.
 *
 * It does not claim the figures are short, because they are not. Saying so is
 * the point: the sentence that tells someone rows are missing is also the
 * sentence that stops them distrusting the total above it.
 */

import { Info } from "lucide-react";
import { useNumberFormat } from "@/lib/i18n/use-t";

export interface LedgerTruncation {
  /** Rows of this type the page received. */
  shown: number;
  /** Rows of this type the ledger holds, from the uncapped roll-up. */
  total: number;
  /** `total − shown`, always > 0 — the oldest rows, which are not on this page. */
  hidden: number;
}

/**
 * Whether there is anything to say, and what. `null` means "say nothing".
 *
 * `total` is optional because /expenses' roll-up prop is: a notice that guessed
 * at a denominator it had not been given would be worse than no notice. And a
 * `total` BELOW `shown` returns null rather than a negative remainder — the
 * aggregate and the row read are two queries, so a delete landing between them
 * can legitimately make the count the smaller of the two, and "−3 older entries
 * are not shown" is a bug report, not a disclosure.
 */
export function ledgerTruncation(shown: number, total?: number): LedgerTruncation | null {
  if (total === undefined) return null;
  const hidden = total - shown;
  if (hidden <= 0) return null;
  return { shown, total, hidden };
}

export function LedgerTruncationNotice({
  shown,
  total,
  noun,
}: {
  shown: number;
  total?: number;
  /** Plural, lower case, as this page calls its rows: "expenses", "revenue
   *  entries", "investments". */
  noun: string;
}) {
  const n = useNumberFormat();
  const truncation = ledgerTruncation(shown, total);
  if (!truncation) return null;

  return (
    <p
      role="status"
      className="flex items-start gap-2.5 border-b border-border bg-primary/[0.06] px-6 py-3 text-sm text-fg-muted"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong" aria-hidden="true" />
      <span>
        Showing the {n.number(truncation.shown)} most recent of {n.number(truncation.total)} {noun}.
        The {n.number(truncation.hidden)} oldest aren&apos;t listed here — every figure above counts
        all {n.number(truncation.total)}.
      </span>
    </p>
  );
}
