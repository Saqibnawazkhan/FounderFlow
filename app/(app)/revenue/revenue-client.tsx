"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Calculator,
  Coins,
  Filter,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import toast from "react-hot-toast";
import { deleteTransactionAction } from "@/lib/actions/transactions";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";
import { LedgerTruncationNotice } from "@/components/transactions/ledger-truncation-notice";
import { TransactionCommentButton } from "@/components/transactions/transaction-comment-button";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { CommentThreadModal } from "@/components/comments/comment-thread-modal";
import { REVENUE_CATEGORIES, type Transaction, type User } from "@/lib/types";
// TYPE-ONLY, so lib/queries' server graph (db, Sentry, the scoped-session read)
// stays out of the client bundle.
import type { TransactionWithCount, TypeTotal } from "@/lib/queries/transactions";
import { useMoney } from "@/lib/hooks/useMoney";
import { useDateFormat, useNumberFormat } from "@/lib/i18n/use-t";

/* ─────────────────────────────────────────────────────────────────────────── *
 * /revenue's money figures, as pure functions over EITHER an aggregate or the
 * row array (transactions-ledger-001, the tail of money-008).
 *
 * WHAT WAS WRONG. "Total revenue", "Avg / entry", the N-entries caption and
 * every category bar were computed from `transactions`, which is
 * `getTransactions()` — a LIST window capped at `MAX_TRANSACTIONS_PER_TYPE`
 * (5,000 per type) whose docstring ends "DO NOT SUM THE RESULT". Past the
 * ceiling every one of them is short, silently, and the rows dropped are the
 * oldest.
 *
 * "Avg / entry" was wrong in a second way, the same way /expenses' was:
 * `total / revenue.length` mixes a numerator and a denominator from different
 * populations the moment either comes from an aggregate. The roll-up carries its
 * own `count`, so the average is computed from one population.
 *
 * Pinned by tests/app/finance/uncapped-totals.test.ts, which also asserts
 * app/(app)/revenue/page.tsx actually passes the aggregates: a roll-up with no
 * caller fixes nothing.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The server-side aggregates /revenue needs, in one prop. One object rather
 *  than two props because the figures have to come from the same instant. */
export interface RevenueRollups {
  /** `getTransactionTotals().byType.income` — whole-ledger revenue sum + row
   *  count, neither of them capped. */
  income: TypeTotal;
  /** `getTotalsByCategory("income")` — biggest first. */
  categories: { category: string; amount: number }[];
}

export interface RevenueHeadline {
  /** All-time revenue total. */
  total: number;
  /** All-time revenue ROW COUNT — the denominator of the average, and the
   *  "N entries" caption. */
  count: number;
  /** `total / count`, NOT pre-rounded: `money(Math.round(x))` throws the cents
   *  away before formatting, so three 0.50 entries average to a figure wearing a
   *  decimal point that makes it look exact (money-001). `formatCurrency`
   *  already rounds to the stored scale. */
  average: number;
}

export function revenueHeadline(revenue: Transaction[], rollups?: RevenueRollups): RevenueHeadline {
  const total = rollups ? rollups.income.total : revenue.reduce((s, t) => s + t.amount, 0);
  const count = rollups ? rollups.income.count : revenue.length;
  return { total, count, average: count > 0 ? total / count : 0 };
}

/**
 * Revenue per category, biggest first, empty categories omitted.
 *
 * Revenue's natural breakdown is by category (product vs services vs subs), not
 * by person the way founder capital is.
 *
 * BOTH BRANCHES READ THE LEDGER, not `REVENUE_CATEGORIES`. Iterating the
 * constant — which is what this used to do — meant a row carrying anything else
 * had its money in the headline and in no bar, so the breakdown silently failed
 * to add up.
 *
 * The write path that lets that happen is `addTransactionAction`: it validates
 * `category` against the union of all three constants and never cross-checks it
 * against the row's own `type`, so an income row filed under an expense category
 * is stored as filed. `updateTransactionAction` and
 * `bulkImportTransactionsAction` both do cross-check — the CSV importer drops
 * such a row and counts it as `skipped` — so the importer, which an earlier
 * version of this comment blamed, is the one path that provably cannot cause it.
 *
 * Re-sorted in both branches so the function does not depend on a caller's
 * ordering.
 */
export function revenueCategoryRows(
  revenue: Transaction[],
  rollups?: RevenueRollups
): { name: string; amount: number }[] {
  let rows: { category: string; amount: number }[];
  if (rollups) {
    rows = rollups.categories.slice();
  } else {
    const m = new Map<string, number>();
    revenue.forEach((t) => m.set(t.category, (m.get(t.category) || 0) + t.amount));
    // Array.from, not a spread: tsconfig sets no `target`, so it defaults to ES5
    // and spreading a Map fails `npm run typecheck` while passing vitest.
    rows = Array.from(m.entries()).map(([category, amount]) => ({ category, amount }));
  }
  return rows
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .map((r) => ({ name: r.category, amount: r.amount }));
}

type Props = {
  /** Rows WITH their comment counts: `getTransactions` has always included
   *  `_count.comments` for every type, and since transactions-ledger-016 this
   *  page renders it instead of discarding it. */
  transactions: TransactionWithCount[];
  /** The company roster, for @-mention autocomplete inside a thread. Without it
   *  every `@name` typed on this page resolves to nobody. */
  users: User[];
  projects: { id: string; name: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  /** Server-side aggregates, from app/(app)/revenue/page.tsx. Every money figure
   *  on this page is short by whatever the 5,000-row-per-type list read dropped
   *  without them. */
  rollups: RevenueRollups;
  /** `Company.currency`, from the row page.tsx fetched (transactions-ledger-006).
   *  Required rather than optional: the store's copy is absent for a whole
   *  server-action round-trip after sign-in, so a page that forgets this renders
   *  a USD workspace's money — and its amount input's label — in rupees, and
   *  `npm run typecheck` is the right place to catch that. */
  currency: string;
};

export function RevenueClient({
  transactions,
  users,
  projects,
  currentUserId,
  currentUserRole,
  rollups,
  currency,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();
  // The server's value, not the store's: see the `currency` prop above. The form
  // below takes the same one, so the figures and the question cannot disagree.
  const money = useMoney(currency);
  const n = useNumberFormat();
  const d = useDateFormat();

  const revenue = useMemo(() => transactions.filter((t) => t.type === "income"), [transactions]);

  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  // Active row being corrected (null = closed). money-016 — a mistyped figure
  // has to be fixable in place, not only deletable.
  const [editingTxn, setEditingTxn] = useState<Transaction | null>(null);
  // Active row whose comment thread is open (null = closed).
  // transactions-ledger-016 — "why is this 4.2M sale booked to Consulting?" had
  // nowhere to live on the page that shows the sale.
  const [commentingTxn, setCommentingTxn] = useState<TransactionWithCount | null>(null);
  const mentionUsers = useMemo(() => users.map((u) => ({ id: u.id, name: u.name })), [users]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  const filtered = useMemo(
    () =>
      revenue.filter((t) => {
        const matchSearch =
          !search ||
          t.description.toLowerCase().includes(search.toLowerCase()) ||
          t.category.toLowerCase().includes(search.toLowerCase()) ||
          t.addedByName.toLowerCase().includes(search.toLowerCase());
        const matchCategory = categoryFilter === "all" || t.category === categoryFilter;
        return matchSearch && matchCategory;
      }),
    [revenue, search, categoryFilter]
  );

  // From the aggregate, never from `revenue`: that array is a 5,000-row-per-type
  // LIST window whose own docstring says not to sum it.
  const {
    total: totalRevenue,
    count: revenueCount,
    average: avgRevenue,
  } = useMemo(() => revenueHeadline(revenue, rollups), [revenue, rollups]);

  const byCategory = useMemo(() => revenueCategoryRows(revenue, rollups), [revenue, rollups]);

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this revenue entry?",
      // Same sentence as /expenses and /investments, for the reason spelled out
      // in app/(app)/expenses/expenses-client.tsx: delete writes a `deletedAt`
      // tombstone (data-integrity-001), nothing purges an individually deleted
      // transaction, and recovery is an operator's UPDATE rather than a button.
      description:
        "It leaves your ledger, reports and exports immediately. Nothing is erased, though — " +
        "contact support right away and it can be restored.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const result = await deleteTransactionAction(id);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Revenue entry deleted");
    refresh();
  }

  // Takes the raw count, not the formatted string: pluralisation is a numeric
  // decision and `n.number()` may have inserted a grouping separator by the
  // time the digits reach the label.
  const entryWord = (count: number) => (count === 1 ? "entry" : "entries");

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge>Money in</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Revenue
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Sales, services, and other income the business earns.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setImportOpen(true)}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
          >
            <Upload className="h-4 w-4" aria-hidden="true" /> Import CSV
          </button>
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add revenue
          </button>
        </div>
      </header>

      <section aria-label="Revenue metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total revenue"
          value={money(totalRevenue)}
          icon={Coins}
          tone="primary"
          delta="positive"
          deltaLabel={`${n.number(revenueCount)} ${entryWord(revenueCount)}`}
        />
        <DashboardStat
          label="Categories"
          value={n.number(byCategory.length)}
          icon={Tag}
          tone="forest"
          deltaLabel={byCategory.length === 0 ? "No revenue yet" : "Earning categories"}
        />
        <DashboardStat
          label="Avg / entry"
          // Not pre-rounded: `money()` rounds to the stored scale, and
          // `Math.round` first threw the cents away before formatting, so small
          // figures averaged to a wrong number wearing a decimal point that made
          // it look exact (money-001).
          value={money(avgRevenue)}
          icon={Calculator}
          tone="mint"
          deltaLabel={`Across ${n.number(revenueCount)} ${entryWord(revenueCount)}`}
        />
      </section>

      {byCategory.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              Where it comes from
            </p>
            <h3 className="mt-1 text-lg font-bold tracking-tight">Revenue by category</h3>
          </div>
          <div className="space-y-5">
            {byCategory.map((c) => {
              // Held as a 0–1 ratio because that is what `n.percent` takes (see
              // lib/format.ts on why it matches Intl rather than the old 0–100
              // call sites). The CSS bar below re-multiplies for its `width`,
              // which is a length, not a rendered number.
              const ratio = totalRevenue > 0 ? c.amount / totalRevenue : 0;
              return (
                <div key={c.name} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-fg">{c.name}</p>
                    <div className="text-end">
                      <p className="font-mono text-base font-bold tabular-nums text-fg">
                        {money(c.amount)}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-primary-strong">
                        {n.percent(ratio)}
                      </p>
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-glass/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-700"
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section
        aria-label="Filter revenue"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search
            className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="revenue-search" className="sr-only">
            Search revenue
          </label>
          <input
            id="revenue-search"
            placeholder="Search description, category, or person…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg py-2.5 pe-4 ps-10 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
          />
        </div>
        <div className="relative">
          <Filter
            className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="revenue-category" className="sr-only">
            Filter by category
          </label>
          <select
            id="revenue-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pe-4 ps-10 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            <option value="all">All categories</option>
            {REVENUE_CATEGORIES.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        {/* The table below is a WINDOW: at most MAX_TRANSACTIONS_PER_TYPE rows,
            oldest dropped first, and this page has no pagination to reach them
            with. Renders nothing until the window is actually short of the
            ledger (transactions-ledger-001). */}
        <LedgerTruncationNotice
          shown={revenue.length}
          total={rollups.income.count}
          noun="revenue entries"
        />
        {filtered.length === 0 ? (
          <EmptyState
            icon={Coins}
            title={revenue.length === 0 ? "No revenue yet" : "No revenue matches your filters"}
            description={
              revenue.length === 0
                ? "Log a sale or other income so your balance and runway reflect the cash you're earning."
                : "Try adjusting your search or filter."
            }
            action={
              revenue.length === 0 && (
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add first revenue
                </button>
              )
            }
          />
        ) : (
          <div className="scrollbar-thin hidden overflow-x-auto md:block">
            <table className="w-full">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Description
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Category
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Added by
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Date
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-end font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Amount
                  </th>
                  <th scope="col" className="px-6 py-3.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-bg"
                  >
                    <td className="px-6 py-4">
                      <p className="text-sm font-medium text-fg">{t.description}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary-strong">
                        {t.category}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Avatar name={t.addedByName} size="xs" />
                        <span className="text-sm text-fg">{t.addedByName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs uppercase tracking-wider text-fg-muted">
                      {d.date(t.date)}
                    </td>
                    <td className="px-6 py-4 text-end">
                      <span className="inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums text-primary-strong">
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        {money(t.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-end">
                      <div className="inline-flex items-center gap-1">
                        {/* OUTSIDE the mine-or-admin fence below: discussing a
                            figure is not changing it, and `canSeeFinances` —
                            which every reader of this page has passed — is the
                            only predicate either server gate applies
                            (transactions-ledger-016). */}
                        <TransactionCommentButton
                          count={t.commentCount}
                          description={t.description}
                          onClick={() => setCommentingTxn(t)}
                        />
                        {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                          <>
                            {/* Same permission rule as delete, because a
                                correction moves money just as effectively. */}
                            <button
                              onClick={() => setEditingTxn(t)}
                              aria-label={`Edit revenue ${t.description}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-primary/10 hover:text-primary-strong"
                            >
                              <Pencil className="h-4 w-4" aria-hidden="true" />
                            </button>
                            <button
                              onClick={() => handleDelete(t.id)}
                              aria-label={`Delete revenue ${t.description}`}
                              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Mobile card fallback. */}
        {filtered.length > 0 && (
          <ul className="divide-y divide-border md:hidden">
            {filtered.map((t) => (
              <li key={t.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm font-medium text-fg">{t.description}</p>
                  <span className="inline-flex shrink-0 items-center gap-1 font-mono text-sm font-bold tabular-nums text-primary-strong">
                    <ArrowUp className="h-3 w-3" aria-hidden="true" />
                    {money(t.amount)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary-strong">
                    {t.category}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                    <Avatar name={t.addedByName} size="xs" /> {t.addedByName}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                    {d.date(t.date)}
                  </span>
                  <div className="ms-auto flex items-center gap-1">
                    <TransactionCommentButton
                      count={t.commentCount}
                      description={t.description}
                      onClick={() => setCommentingTxn(t)}
                    />
                    {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                      <>
                        <button
                          onClick={() => setEditingTxn(t)}
                          aria-label={`Edit revenue ${t.description}`}
                          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-primary/10 hover:text-primary-strong"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          onClick={() => handleDelete(t.id)}
                          aria-label={`Delete revenue ${t.description}`}
                          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ImportTransactionsModal
        type="income"
        projects={projects}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          refresh();
        }}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add revenue"
        description="Record a sale or other income the business earned"
      >
        <TransactionForm
          type="income"
          projects={projects}
          serverCurrency={currency}
          onClose={() => setModalOpen(false)}
          onSuccess={refresh}
        />
      </Modal>

      {/* Correcting a row, rather than deleting and retyping it (money-016).
          Keyed on the row id so reopening on a different entry remounts the
          form with that row's values instead of the last one's. */}
      {editingTxn && (
        <Modal
          open={Boolean(editingTxn)}
          onClose={() => setEditingTxn(null)}
          title="Edit revenue"
          description="Correct the amount, category, date or description. The change is recorded in the activity feed."
        >
          <TransactionForm
            key={editingTxn.id}
            type="income"
            editing={editingTxn}
            serverCurrency={currency}
            onClose={() => setEditingTxn(null)}
            onSuccess={refresh}
          />
        </Modal>
      )}

      {/* The thread, same component and same shape as /expenses and
          /investments. `onChanged={refresh}` is what keeps the row's count
          badge honest after a post or a delete. */}
      {commentingTxn && (
        <CommentThreadModal
          open={Boolean(commentingTxn)}
          onClose={() => setCommentingTxn(null)}
          target={{ transactionId: commentingTxn.id }}
          title={`Comments · ${commentingTxn.description}`}
          description={`${money(commentingTxn.amount)} — ${commentingTxn.category}`}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={mentionUsers}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
