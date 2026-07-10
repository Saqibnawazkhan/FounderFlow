"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Calculator,
  Coins,
  Filter,
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
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { REVENUE_CATEGORIES, type Transaction } from "@/lib/types";

type Props = {
  transactions: Transaction[];
  projects: { id: string; name: string }[];
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
};

export function RevenueClient({ transactions, projects, currentUserId, currentUserRole }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [, startTransition] = useTransition();

  const revenue = useMemo(() => transactions.filter((t) => t.type === "income"), [transactions]);

  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

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

  const totalRevenue = revenue.reduce((s, t) => s + t.amount, 0);

  // Revenue's natural breakdown is by category (product vs services vs subs),
  // not by person the way founder capital is.
  const byCategory = useMemo(
    () =>
      REVENUE_CATEGORIES.map((cat) => ({
        name: cat,
        amount: revenue.filter((t) => t.category === cat).reduce((s, t) => s + t.amount, 0),
      }))
        .filter((c) => c.amount > 0)
        .sort((a, b) => b.amount - a.amount),
    [revenue]
  );

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete this revenue entry?",
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
    toast.success("Revenue entry deleted");
    refresh();
  }

  const entryWord = (n: number) => (n === 1 ? "entry" : "entries");

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
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> Add revenue
          </button>
        </div>
      </header>

      <section aria-label="Revenue metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total revenue"
          value={formatCurrency(totalRevenue)}
          icon={Coins}
          tone="primary"
          delta="positive"
          deltaLabel={`${revenue.length} ${entryWord(revenue.length)}`}
        />
        <DashboardStat
          label="Categories"
          value={byCategory.length.toString()}
          icon={Tag}
          tone="cyan"
          deltaLabel={byCategory.length === 0 ? "No revenue yet" : "Earning categories"}
        />
        <DashboardStat
          label="Avg / entry"
          value={formatCurrency(revenue.length > 0 ? Math.round(totalRevenue / revenue.length) : 0)}
          icon={Calculator}
          tone="pink"
          deltaLabel={`Across ${revenue.length} ${entryWord(revenue.length)}`}
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
              const pct = totalRevenue > 0 ? (c.amount / totalRevenue) * 100 : 0;
              return (
                <div key={c.name} className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-semibold text-fg">{c.name}</p>
                    <div className="text-right">
                      <p className="font-mono text-base font-bold tabular-nums text-fg">
                        {formatCurrency(c.amount)}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-primary-strong">
                        {pct.toFixed(1)}%
                      </p>
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-glass/[0.06]">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-700"
                      style={{ width: `${pct}%` }}
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
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
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
            className="w-full rounded-xl border border-border bg-bg py-2.5 pl-10 pr-4 text-sm text-fg transition-colors placeholder:text-fg-muted/70 focus:border-primary/50 focus:bg-surface focus:outline-none"
          />
        </div>
        <div className="relative">
          <Filter
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="revenue-category" className="sr-only">
            Filter by category
          </label>
          <select
            id="revenue-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pl-10 pr-4 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
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
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
                      {formatDate(t.date)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="inline-flex items-center gap-1 font-mono text-sm font-bold tabular-nums text-primary-strong">
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        {formatCurrency(t.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                        <button
                          onClick={() => handleDelete(t.id)}
                          aria-label={`Delete revenue ${t.description}`}
                          className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
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
                    {formatCurrency(t.amount)}
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
                    {formatDate(t.date)}
                  </span>
                  {(currentUserId === t.addedBy || currentUserRole === "admin") && (
                    <button
                      onClick={() => handleDelete(t.id)}
                      aria-label={`Delete revenue ${t.description}`}
                      className="ml-auto rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ImportTransactionsModal
        type="income"
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
          onClose={() => setModalOpen(false)}
          onSuccess={refresh}
        />
      </Modal>
    </div>
  );
}
