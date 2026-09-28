"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  ArrowDown,
  Calculator,
  Filter,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  TrendingDown,
  Upload,
  Wallet,
} from "lucide-react";
import toast from "react-hot-toast";
import { deleteTransactionAction } from "@/lib/actions/transactions";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { ImportTransactionsModal } from "@/components/transactions/import-transactions-modal";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CommentThreadModal } from "@/components/comments/comment-thread-modal";
// formatUtcDate, not formatDate: `Transaction.date` is a DATE-ONLY value
// stored at UTC midnight (money-007), so the local renderer printed the day
// BEFORE the one the customer typed for every viewer west of UTC — an
// expense dated the 1st showed as the last day of the previous month, on the
// same page whose "This month" card had just been fixed to count it in this
// one. lib/utils.ts explains why `formatDate` itself stays local.
import { formatUtcDate, cn } from "@/lib/utils";
import { isInUtcMonth } from "@/lib/date-range";
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";
import { EXPENSE_CATEGORIES, type Transaction, type User } from "@/lib/types";
// TYPE-ONLY imports, so lib/queries' server graph (db, Sentry, the scoped-session
// read) stays out of the client bundle.
import type { TransactionWithCount, TypeTotal } from "@/lib/queries/transactions";

// Recharts is ~200KB. Lazy-load to keep /expenses initial bundle lean.
const CategoryBreakdownBar = dynamic(
  () => import("./expenses-charts").then((m) => ({ default: m.CategoryBreakdownBar })),
  { ssr: false, loading: () => <Skeleton className="h-full w-full rounded-xl" /> }
);

/* ─────────────────────────────────────────────────────────────────────────── *
 * /expenses' money figures, as pure functions over EITHER an aggregate or the
 * row array (money-008).
 *
 * WHAT WAS WRONG. "Total spend", the "N transactions" caption, "This month", the
 * "% of all-time" line and the category breakdown were all computed from
 * `transactions`, which is `getTransactions()` — a LIST window capped at
 * `MAX_TRANSACTIONS_PER_TYPE` (5,000 per type) whose docstring ends "DO NOT SUM
 * THE RESULT". Past the ceiling every one of them is short, silently, and the
 * rows dropped are the oldest.
 *
 * "Avg / transaction" was wrong in a second way: `total / expenses.length` mixes
 * a numerator and a denominator from different populations the moment either
 * comes from an aggregate. The roll-up carries its own `count`, so the average is
 * computed from one population.
 *
 * WHY THE ROLL-UP IS OPTIONAL: see the same note in dashboard-client.tsx. It is a
 * shim until app/(app)/expenses/page.tsx fetches the aggregates, and
 * tests/app/money-rollups.test.ts fails until it does.
 * ─────────────────────────────────────────────────────────────────────────── */

/** The server-side aggregates /expenses needs, in one prop. */
export interface ExpenseRollups {
  /** `getTransactionTotals().byType.expense` — whole-ledger expense sum + row
   *  count, neither of them capped. */
  expense: TypeTotal;
  /** `getMonthToDateExpense()` — the current UTC calendar month. */
  monthToDateExpense: number;
  /** `getExpenseTotalsByCategory()` — biggest first. */
  categories: { category: string; amount: number }[];
}

export interface ExpenseHeadline {
  /** All-time expense total. */
  total: number;
  /** All-time expense ROW COUNT — the denominator of the average, and the
   *  "N transactions" caption. */
  count: number;
  thisMonth: number;
  /** `total / count`, NOT pre-rounded: `money(Math.round(x))` threw the cents
   *  away before formatting, so three 0.50 expenses averaged to "PKR 1.00" — a
   *  wrong figure wearing a decimal point that makes it look exact (money-001).
   *  `formatCurrency` already rounds to the stored scale. */
  average: number;
}

export function expenseHeadline(
  expenses: Transaction[],
  now: Date,
  rollups?: ExpenseRollups
): ExpenseHeadline {
  const total = rollups ? rollups.expense.total : expenses.reduce((s, t) => s + t.amount, 0);
  const count = rollups ? rollups.expense.count : expenses.length;
  const thisMonth = rollups
    ? rollups.monthToDateExpense
    : // money-003 / rep-003: this compared `getMonth() === getMonth()` — the
      // month INDEX, with no year — so "This month" also counted the same
      // calendar month of every previous year and drifted further from
      // /dashboard's identically labelled card every year the workspace stayed
      // alive. `isInUtcMonth` is the shared boundary (lib/date-range.ts) the
      // dashboard card and the server-side budget queries use, so all three
      // bucket a row dated the 1st identically — see money-007 for why UTC.
      expenses.filter((t) => isInUtcMonth(t.date, now)).reduce((s, t) => s + t.amount, 0);
  return { total, count, thisMonth, average: count > 0 ? total / count : 0 };
}

/** Expense spend per category, biggest first. Re-sorted in both branches so the
 *  function does not depend on a caller's ordering. */
export function expenseCategoryRows(
  expenses: Transaction[],
  rollups?: ExpenseRollups
): { category: string; amount: number }[] {
  if (rollups) return rollups.categories.slice().sort((a, b) => b.amount - a.amount);
  const map = new Map<string, number>();
  expenses.forEach((t) => map.set(t.category, (map.get(t.category) || 0) + t.amount));
  // Array.from, not a spread: tsconfig sets no `target`, so it defaults to ES5
  // and spreading a Map fails `npm run typecheck` while passing vitest.
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

type Props = {
  /** All company transactions — we filter to expenses inside. */
  transactions: TransactionWithCount[];
  users: User[];
  projects: { id: string; name: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  /** Server-side aggregates. Optional ONLY so this could land ahead of the
   *  page.tsx change that supplies it (see ExpenseRollups); until it is passed,
   *  every figure on the metric row is short by whatever the 5,000-row-per-type
   *  list read dropped. tests/app/money-rollups.test.ts fails while it is
   *  absent. */
  rollups?: ExpenseRollups;
};

export function ExpensesClient({
  transactions,
  users,
  projects,
  currentUserId,
  currentUserRole,
  rollups,
}: Props) {
  const money = useMoney();
  const n = useNumberFormat();
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();

  // Active transaction whose comment thread is open (null = closed).
  const [commentingTxn, setCommentingTxn] = useState<TransactionWithCount | null>(null);
  const mentionUsers = useMemo(() => users.map((u) => ({ id: u.id, name: u.name })), [users]);

  const expenses = useMemo(() => transactions.filter((t) => t.type === "expense"), [transactions]);

  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  function refresh() {
    startTransition(() => router.refresh());
  }

  const filtered = useMemo(
    () =>
      expenses.filter((t) => {
        const matchSearch =
          !search ||
          t.description.toLowerCase().includes(search.toLowerCase()) ||
          t.category.toLowerCase().includes(search.toLowerCase()) ||
          t.addedByName.toLowerCase().includes(search.toLowerCase());
        const matchCategory = categoryFilter === "all" || t.category === categoryFilter;
        return matchSearch && matchCategory;
      }),
    [expenses, search, categoryFilter]
  );

  // One `new Date()` per render so the This-month window cannot move between
  // figures. The metric row goes through `expenseHeadline`, which prefers the
  // server-side aggregate over this page's capped list (money-008).
  const now = useMemo(() => new Date(), []);
  const headline = useMemo(() => expenseHeadline(expenses, now, rollups), [expenses, now, rollups]);
  const totalExpenses = headline.total;
  const thisMonthExpenses = headline.thisMonth;

  const categoryBreakdown = useMemo(
    () => expenseCategoryRows(expenses, rollups),
    [expenses, rollups]
  );

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this expense?",
      description: "This action cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const result = await deleteTransactionAction(id);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Expense deleted");
    refresh();
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="mint">Money out</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Expenses
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Track every penny going out of your company.
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
            <Plus className="h-4 w-4" aria-hidden="true" /> Log expense
          </button>
        </div>
      </header>

      <section aria-label="Expense metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total spend"
          value={money(totalExpenses)}
          icon={TrendingDown}
          tone="mint"
          // headline.count, not expenses.length: the caption and the figure above
          // it must describe the same population (money-008).
          deltaLabel={`${n.number(headline.count)} transactions`}
        />
        <DashboardStat
          label="This month"
          value={money(thisMonthExpenses)}
          icon={Wallet}
          tone="forest"
          delta={thisMonthExpenses > 0 ? "neutral" : "positive"}
          deltaLabel={
            thisMonthExpenses > 0
              ? // `n.percent` takes a 0–1 ratio, so the `* 100` the old `.toFixed(0)}%`
                // needed is gone rather than moved. `maximumFractionDigits: 0` keeps
                // the whole-number look the stat line was designed around.
                `${n.percent(thisMonthExpenses / Math.max(totalExpenses, 1), {
                  maximumFractionDigits: 0,
                })} of all-time`
              : "Nothing logged yet"
          }
        />
        <DashboardStat
          label="Avg / transaction"
          // money-001 lived one call site further out than the formatter: this
          // used to be `money(Math.round(total / count))`, which threw the cents
          // away BEFORE formatting — three 0.50 expenses averaged to "PKR 1.00",
          // a wrong figure wearing a decimal point that makes it look exact.
          // `formatCurrency` already rounds to the stored scale. The division
          // itself now lives in `expenseHeadline`, so numerator and denominator
          // come from one population (money-008).
          value={money(headline.average)}
          icon={Calculator}
          tone="primary"
          deltaLabel={`Across ${n.number(headline.count)} entries`}
        />
      </section>

      {categoryBreakdown.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              Where money goes
            </p>
            <h3 className="mt-1 text-lg font-bold tracking-tight">Spend by category</h3>
          </div>
          <div className="h-64">
            <CategoryBreakdownBar data={categoryBreakdown} />
          </div>
          <table className="sr-only">
            <caption>Spend by category</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {categoryBreakdown.map((c) => (
                <tr key={c.category}>
                  <th scope="row">{c.category}</th>
                  <td>{money(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section
        aria-label="Filter expenses"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="expense-search" className="sr-only">
            Search expenses
          </label>
          <input
            id="expense-search"
            placeholder="Search description, category, or person…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-xl border border-border bg-bg py-2.5 pl-10 pr-4 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
          />
        </div>
        <div className="relative">
          <Filter
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="expense-category" className="sr-only">
            Filter by category
          </label>
          <select
            id="expense-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pl-10 pr-4 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            <option value="all">All categories</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        {filtered.length === 0 ? (
          <EmptyState
            icon={TrendingDown}
            title={
              expenses.length === 0 ? "No expenses logged yet" : "No expenses match your filters"
            }
            description={
              expenses.length === 0
                ? "Start tracking your spending to see exactly where your money goes."
                : "Try adjusting your search or filter to see more results."
            }
            action={
              expenses.length === 0 && (
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Log first expense
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
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Description
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Category
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Added by
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                  >
                    Date
                  </th>
                  <th
                    scope="col"
                    className="px-6 py-3.5 text-right font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
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
                      <span className="inline-flex items-center rounded-full border border-border bg-bg px-2.5 py-0.5 text-xs font-medium text-fg-muted">
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
                      {formatUtcDate(t.date)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums text-mint-strong">
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        {money(t.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setCommentingTxn(t)}
                          aria-label={
                            t.commentCount > 0
                              ? `Open comments (${n.number(t.commentCount)}) for ${t.description}`
                              : `Add a comment to ${t.description}`
                          }
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
                            t.commentCount > 0
                              ? "text-forest-strong hover:bg-forest/10"
                              : "text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                          {t.commentCount > 0 && (
                            <span className="font-mono font-bold">{n.number(t.commentCount)}</span>
                          )}
                        </button>
                        {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                          <button
                            onClick={() => handleDelete(t.id)}
                            aria-label={`Delete expense ${t.description}`}
                            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Mobile card fallback (F10) — the table scrolls horizontally on a
            phone; cards read far better. Same rows, same actions. */}
        {filtered.length > 0 && (
          <ul className="divide-y divide-border md:hidden">
            {filtered.map((t) => (
              <li key={t.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm font-medium text-fg">{t.description}</p>
                  <span className="inline-flex shrink-0 items-center gap-1 font-mono text-sm font-bold tabular-nums text-mint-strong">
                    <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    {money(t.amount)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-border bg-bg px-2.5 py-0.5 text-xs font-medium text-fg-muted">
                    {t.category}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                    <Avatar name={t.addedByName} size="xs" /> {t.addedByName}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                    {formatUtcDate(t.date)}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => setCommentingTxn(t)}
                      aria-label={
                        t.commentCount > 0
                          ? `Open comments (${n.number(t.commentCount)}) for ${t.description}`
                          : `Add a comment to ${t.description}`
                      }
                      className={cn(
                        "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
                        t.commentCount > 0
                          ? "text-forest-strong hover:bg-forest/10"
                          : "text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
                      )}
                    >
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                      {t.commentCount > 0 && (
                        <span className="font-mono font-bold">{n.number(t.commentCount)}</span>
                      )}
                    </button>
                    {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                      <button
                        onClick={() => handleDelete(t.id)}
                        aria-label={`Delete expense ${t.description}`}
                        className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ImportTransactionsModal
        type="expense"
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
        title="Log new expense"
        description="Track a business expense"
      >
        <TransactionForm
          type="expense"
          projects={projects}
          onClose={() => setModalOpen(false)}
          onSuccess={refresh}
        />
      </Modal>

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
