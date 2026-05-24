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
  Wallet,
} from "lucide-react";
import toast from "react-hot-toast";
import { deleteTransactionAction } from "@/lib/actions/transactions";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CommentThreadModal } from "@/components/comments/comment-thread-modal";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { EXPENSE_CATEGORIES, type User } from "@/lib/types";
import type { TransactionWithCount } from "@/lib/queries/transactions";

// Recharts is ~200KB. Lazy-load to keep /expenses initial bundle lean.
const CategoryBreakdownBar = dynamic(
  () => import("./expenses-charts").then((m) => ({ default: m.CategoryBreakdownBar })),
  { ssr: false, loading: () => <Skeleton className="h-full w-full rounded-xl" /> }
);

type Props = {
  /** All company transactions — we filter to expenses inside. */
  transactions: TransactionWithCount[];
  users: User[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
};

export function ExpensesClient({ transactions, users, currentUserId, currentUserRole }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();

  // Active transaction whose comment thread is open (null = closed).
  const [commentingTxn, setCommentingTxn] = useState<TransactionWithCount | null>(null);
  const mentionUsers = useMemo(() => users.map((u) => ({ id: u.id, name: u.name })), [users]);

  const expenses = useMemo(() => transactions.filter((t) => t.type === "expense"), [transactions]);

  const [modalOpen, setModalOpen] = useState(false);
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

  const totalExpenses = expenses.reduce((s, t) => s + t.amount, 0);
  const thisMonthExpenses = expenses
    .filter((t) => new Date(t.date).getMonth() === new Date().getMonth())
    .reduce((s, t) => s + t.amount, 0);

  const categoryBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    expenses.forEach((t) => map.set(t.category, (map.get(t.category) || 0) + t.amount));
    return Array.from(map.entries())
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [expenses]);

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
          <PillBadge tone="pink">Money out</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Expenses
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Track every penny going out of your company.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Log expense
        </button>
      </header>

      <section aria-label="Expense metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total spend"
          value={formatCurrency(totalExpenses)}
          icon={TrendingDown}
          tone="pink"
          deltaLabel={`${expenses.length} transactions`}
        />
        <DashboardStat
          label="This month"
          value={formatCurrency(thisMonthExpenses)}
          icon={Wallet}
          tone="cyan"
          delta={thisMonthExpenses > 0 ? "neutral" : "positive"}
          deltaLabel={
            thisMonthExpenses > 0
              ? `${((thisMonthExpenses / Math.max(totalExpenses, 1)) * 100).toFixed(0)}% of all-time`
              : "Nothing logged yet"
          }
        />
        <DashboardStat
          label="Avg / transaction"
          value={formatCurrency(
            expenses.length > 0 ? Math.round(totalExpenses / expenses.length) : 0
          )}
          icon={Calculator}
          tone="primary"
          deltaLabel={`Across ${expenses.length} entries`}
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
                  <td>{formatCurrency(c.amount)}</td>
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
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pl-10 pr-10 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
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
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Log first expense
                </button>
              )
            }
          />
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
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
                      {formatDate(t.date)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums text-pink-strong">
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        {formatCurrency(t.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => setCommentingTxn(t)}
                          aria-label={
                            t.commentCount > 0
                              ? `Open comments (${t.commentCount}) for ${t.description}`
                              : `Add a comment to ${t.description}`
                          }
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors",
                            t.commentCount > 0
                              ? "text-cyan-strong hover:bg-cyan/10"
                              : "text-fg-muted hover:bg-glass/[0.06] hover:text-fg"
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                          {t.commentCount > 0 && (
                            <span className="font-mono font-bold">{t.commentCount}</span>
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
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Log new expense"
        description="Track a business expense"
      >
        <TransactionForm type="expense" onClose={() => setModalOpen(false)} onSuccess={refresh} />
      </Modal>

      {commentingTxn && (
        <CommentThreadModal
          open={Boolean(commentingTxn)}
          onClose={() => setCommentingTxn(null)}
          target={{ transactionId: commentingTxn.id }}
          title={`Comments · ${commentingTxn.description}`}
          description={`${formatCurrency(commentingTxn.amount)} — ${commentingTxn.category}`}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={mentionUsers}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
