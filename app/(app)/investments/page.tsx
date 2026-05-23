"use client";

import { useMemo, useState } from "react";
import {
  ArrowUp,
  Calculator,
  Filter,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { Modal } from "@/components/ui/modal";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardStat } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { formatCurrency, formatDate } from "@/lib/utils";
import { INVESTMENT_CATEGORIES } from "@/lib/types";

const ROLE_LABEL = {
  admin: "Admin Founder",
  cofounder: "Co-Founder",
  member: "Team Member",
} as const;

export default function InvestmentsPage() {
  const transactions = useStore((s) => s.getCompanyTransactions());
  const users = useStore((s) => s.getCompanyUsers());
  const deleteTransaction = useStore((s) => s.deleteTransaction);
  const currentUser = useStore((s) => s.currentUser);

  const investments = transactions.filter((t) => t.type === "investment");

  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const filtered = useMemo(
    () =>
      investments.filter((t) => {
        const matchSearch =
          !search ||
          t.description.toLowerCase().includes(search.toLowerCase()) ||
          t.category.toLowerCase().includes(search.toLowerCase()) ||
          t.addedByName.toLowerCase().includes(search.toLowerCase());
        const matchCategory = categoryFilter === "all" || t.category === categoryFilter;
        return matchSearch && matchCategory;
      }),
    [investments, search, categoryFilter]
  );

  const totalInvestments = investments.reduce((s, t) => s + t.amount, 0);
  const founderStats = useMemo(
    () =>
      users
        .map((u) => ({
          name: u.name,
          amount: investments.filter((t) => t.addedBy === u.id).reduce((s, t) => s + t.amount, 0),
          role: u.role,
        }))
        .filter((u) => u.amount > 0)
        .sort((a, b) => b.amount - a.amount),
    [investments, users]
  );

  function handleDelete(id: string) {
    if (!confirm("Delete this investment? This action cannot be undone.")) return;
    deleteTransaction(id);
    toast.success("Investment deleted");
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="cyan">Money in</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Investments
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Capital injected by founders and outside investors.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Add investment
        </button>
      </header>

      {/* Stats */}
      <section aria-label="Investment metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat
          label="Total raised"
          value={formatCurrency(totalInvestments)}
          icon={TrendingUp}
          tone="primary"
          delta="positive"
          deltaLabel={`${investments.length} contributions`}
        />
        <DashboardStat
          label="Contributors"
          value={founderStats.length.toString()}
          icon={Users}
          tone="cyan"
          deltaLabel={founderStats.length === 0 ? "No data yet" : "Active founders"}
        />
        <DashboardStat
          label="Avg / contribution"
          value={formatCurrency(
            investments.length > 0 ? Math.round(totalInvestments / investments.length) : 0
          )}
          icon={Calculator}
          tone="pink"
          deltaLabel={`Across ${investments.length} entries`}
        />
      </section>

      {/* Founder breakdown */}
      {founderStats.length > 0 && (
        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-6">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              Who put in what
            </p>
            <h3 className="mt-1 text-lg font-bold tracking-tight">Founder contributions</h3>
          </div>
          <div className="space-y-5">
            {founderStats.map((f) => {
              const pct = totalInvestments > 0 ? (f.amount / totalInvestments) * 100 : 0;
              return (
                <div key={f.name} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Avatar name={f.name} size="md" />
                    <div className="flex flex-1 items-center justify-between">
                      <div>
                        <p className="font-semibold text-fg">{f.name}</p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                          {ROLE_LABEL[f.role]}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-base font-bold tabular-nums text-fg">
                          {formatCurrency(f.amount)}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-primary-strong">
                          {pct.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="ml-14 h-1.5 overflow-hidden rounded-full bg-glass/[0.06]">
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

      {/* Filters */}
      <section
        aria-label="Filter investments"
        className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row"
      >
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            aria-hidden="true"
          />
          <label htmlFor="investment-search" className="sr-only">
            Search investments
          </label>
          <input
            id="investment-search"
            placeholder="Search description, source, or person…"
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
          <label htmlFor="investment-category" className="sr-only">
            Filter by source
          </label>
          <select
            id="investment-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full min-w-[200px] appearance-none rounded-xl border border-border bg-bg py-2.5 pl-10 pr-10 text-sm text-fg transition-colors focus:border-primary/50 focus:bg-surface focus:outline-none"
          >
            <option value="all">All sources</option>
            {INVESTMENT_CATEGORIES.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* List */}
      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Wallet}
            title={
              investments.length === 0 ? "No investments yet" : "No investments match your filters"
            }
            description={
              investments.length === 0
                ? "Log founder contributions or external funding to track your runway."
                : "Try adjusting your search or filter."
            }
            action={
              investments.length === 0 && (
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add first investment
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
                    Source
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
                      <span className="inline-flex items-center rounded-full border border-cyan/30 bg-cyan/10 px-2.5 py-0.5 text-xs font-medium text-cyan-strong">
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
                      {(currentUser?.id === t.addedBy || currentUser?.role === "admin") && (
                        <button
                          onClick={() => handleDelete(t.id)}
                          aria-label={`Delete investment ${t.description}`}
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
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add new investment"
        description="Record capital injected into your company"
      >
        <TransactionForm type="investment" onClose={() => setModalOpen(false)} />
      </Modal>
    </div>
  );
}
