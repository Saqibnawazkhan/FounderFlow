"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Filter,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  Wallet,
} from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { Modal } from "@/components/ui/modal";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { INVESTMENT_CATEGORIES } from "@/lib/types";

export default function InvestmentsPage() {
  const transactions = useStore((s) => s.getCompanyTransactions());
  const users = useStore((s) => s.getCompanyUsers());
  const deleteTransaction = useStore((s) => s.deleteTransaction);
  const currentUser = useStore((s) => s.currentUser);

  const investments = transactions.filter((t) => t.type === "investment");

  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    return investments.filter((t) => {
      const matchSearch =
        !search ||
        t.description.toLowerCase().includes(search.toLowerCase()) ||
        t.category.toLowerCase().includes(search.toLowerCase()) ||
        t.addedByName.toLowerCase().includes(search.toLowerCase());
      const matchCategory = categoryFilter === "all" || t.category === categoryFilter;
      return matchSearch && matchCategory;
    });
  }, [investments, search, categoryFilter]);

  const totalInvestments = investments.reduce((s, t) => s + t.amount, 0);
  const founderStats = useMemo(() => {
    return users
      .map((u) => {
        const amount = investments
          .filter((t) => t.addedBy === u.id)
          .reduce((s, t) => s + t.amount, 0);
        return { name: u.name, amount, role: u.role };
      })
      .filter((u) => u.amount > 0)
      .sort((a, b) => b.amount - a.amount);
  }, [investments, users]);

  function handleDelete(id: string) {
    if (!confirm("Delete this investment? This action cannot be undone.")) return;
    deleteTransaction(id);
    toast.success("Investment deleted");
  }

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Investments</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Capital injected by founders and investors.
          </p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary">
          <Plus className="h-4 w-4" /> Add Investment
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Total Raised</p>
              <p className="text-2xl font-bold mt-1 tabular-nums">{formatCurrency(totalInvestments)}</p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center text-white">
              <TrendingUp className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Contributors</p>
              <p className="text-2xl font-bold mt-1 tabular-nums">{founderStats.length}</p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center text-white">
              <Wallet className="h-5 w-5" />
            </div>
          </div>
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">Avg per contribution</p>
              <p className="text-2xl font-bold mt-1 tabular-nums">
                {formatCurrency(investments.length > 0 ? Math.round(totalInvestments / investments.length) : 0)}
              </p>
            </div>
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center text-white">
              <TrendingUp className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      {/* Founder breakdown */}
      {founderStats.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="card p-6"
        >
          <h3 className="text-lg font-semibold mb-4">Founder Contributions</h3>
          <div className="space-y-4">
            {founderStats.map((f, i) => {
              const pct = totalInvestments > 0 ? (f.amount / totalInvestments) * 100 : 0;
              return (
                <div key={f.name} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Avatar name={f.name} size="md" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold">{f.name}</p>
                          <p className="text-xs text-slate-500 capitalize">
                            {f.role === "admin"
                              ? "Admin Founder"
                              : f.role === "cofounder"
                              ? "Co-Founder"
                              : "Team Member"}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold tabular-nums">{formatCurrency(f.amount)}</p>
                          <p className="text-xs text-slate-500">{pct.toFixed(1)}%</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden ml-14">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, delay: 0.1 + i * 0.1 }}
                      className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Filters */}
      <div className="card p-4 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            placeholder="Search investments..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input pl-10"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="input pl-10 pr-10 min-w-[200px]"
          >
            <option value="all">All sources</option>
            {INVESTMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* List */}
      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title={investments.length === 0 ? "No investments yet" : "No investments match your filters"}
            description={
              investments.length === 0
                ? "Log founder contributions or external funding to track your runway."
                : "Try adjusting your search or filter."
            }
            action={
              investments.length === 0 && (
                <button onClick={() => setModalOpen(true)} className="btn-primary">
                  <Plus className="h-4 w-4" /> Add first investment
                </button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-left">
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Description</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Source</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Added By</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Date</th>
                  <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Amount</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((t, i) => (
                  <motion.tr
                    key={t.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2, delay: Math.min(i * 0.02, 0.3) }}
                    className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition"
                  >
                    <td className="px-6 py-4">
                      <p className="font-medium text-sm">{t.description}</p>
                    </td>
                    <td className="px-6 py-4">
                      <span className="badge-info">{t.category}</span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <Avatar name={t.addedByName} size="xs" />
                        <span className="text-sm">{t.addedByName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-500">{formatDate(t.date)}</td>
                    <td className="px-6 py-4 text-right">
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                        +{formatCurrency(t.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {(currentUser?.id === t.addedBy || currentUser?.role === "admin") && (
                        <button
                          onClick={() => handleDelete(t.id)}
                          className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-500/10 text-slate-400 hover:text-red-500 transition"
                          aria-label="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add new investment" description="Record capital injected into your company">
        <TransactionForm type="investment" onClose={() => setModalOpen(false)} />
      </Modal>
    </div>
  );
}
