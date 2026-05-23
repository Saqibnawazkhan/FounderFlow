"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import toast from "react-hot-toast";
import { useStore } from "@/lib/store";
import { Avatar } from "@/components/ui/avatar";
import { formatCurrency, formatDate } from "@/lib/utils";
import { format, startOfMonth, subMonths } from "date-fns";

const COLORS = ["#6366f1", "#d946ef", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#8b5cf6", "#f43f5e"];

export default function ReportsPage() {
  const transactions = useStore((s) => s.getCompanyTransactions());
  const users = useStore((s) => s.getCompanyUsers());
  const companies = useStore((s) => s.companies);
  const currentUser = useStore((s) => s.currentUser);
  const company = companies.find((c) => c.id === currentUser?.companyId);

  const [period, setPeriod] = useState<"3m" | "6m" | "1y" | "all">("6m");

  const periodMonths = { "3m": 3, "6m": 6, "1y": 12, all: 24 }[period];

  const monthlyData = useMemo(() => {
    return Array.from({ length: periodMonths }).map((_, i) => {
      const monthStart = startOfMonth(subMonths(new Date(), periodMonths - 1 - i));
      const monthEnd = startOfMonth(subMonths(new Date(), periodMonths - 2 - i));
      const monthTxns = transactions.filter((t) => {
        const d = new Date(t.date);
        return d >= monthStart && d < monthEnd;
      });
      const expenses = monthTxns.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
      const investments = monthTxns.filter((t) => t.type === "investment").reduce((s, t) => s + t.amount, 0);
      return {
        month: format(monthStart, "MMM yy"),
        expenses,
        investments,
        netFlow: investments - expenses,
      };
    });
  }, [transactions, periodMonths]);

  const categoryData = useMemo(() => {
    const map = new Map<string, number>();
    transactions
      .filter((t) => t.type === "expense")
      .forEach((t) => map.set(t.category, (map.get(t.category) || 0) + t.amount));
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [transactions]);

  const founderData = useMemo(() => {
    return users.map((u) => ({
      name: u.name.split(" ")[0],
      investments: transactions
        .filter((t) => t.addedBy === u.id && t.type === "investment")
        .reduce((s, t) => s + t.amount, 0),
      expenses: transactions
        .filter((t) => t.addedBy === u.id && t.type === "expense")
        .reduce((s, t) => s + t.amount, 0),
    }));
  }, [transactions, users]);

  const totalExpenses = transactions.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const totalInvestments = transactions.filter((t) => t.type === "investment").reduce((s, t) => s + t.amount, 0);

  async function exportPDF() {
    toast.loading("Generating PDF report...", { id: "pdf" });
    try {
      const { jsPDF } = await import("jspdf");
      const autoTable = (await import("jspdf-autotable")).default;

      const doc = new jsPDF();
      const pageWidth = doc.internal.pageSize.getWidth();

      doc.setFontSize(20);
      doc.setTextColor(99, 102, 241);
      doc.text("FounderFlow Report", 14, 20);

      doc.setFontSize(12);
      doc.setTextColor(15, 23, 42);
      doc.text(company?.name || "Company Report", 14, 30);

      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(`Generated on ${format(new Date(), "MMM dd, yyyy 'at' h:mm a")}`, 14, 36);

      // Summary stats
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text("Financial Summary", 14, 50);
      autoTable(doc, {
        startY: 54,
        head: [["Metric", "Amount"]],
        body: [
          ["Total Investments", `PKR ${totalInvestments.toLocaleString()}`],
          ["Total Expenses", `PKR ${totalExpenses.toLocaleString()}`],
          ["Net Balance", `PKR ${(totalInvestments - totalExpenses).toLocaleString()}`],
          ["Number of Transactions", transactions.length.toString()],
          ["Team Members", users.length.toString()],
        ],
        theme: "striped",
        headStyles: { fillColor: [99, 102, 241] },
        styles: { fontSize: 10 },
      });

      // Founder breakdown
      const lastY = (doc as any).lastAutoTable.finalY + 10;
      doc.text("Founder Contributions", 14, lastY);
      autoTable(doc, {
        startY: lastY + 4,
        head: [["Name", "Role", "Invested", "Logged Expenses"]],
        body: users.map((u) => {
          const inv = transactions
            .filter((t) => t.addedBy === u.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0);
          const exp = transactions
            .filter((t) => t.addedBy === u.id && t.type === "expense")
            .reduce((s, t) => s + t.amount, 0);
          return [u.name, u.role, `PKR ${inv.toLocaleString()}`, `PKR ${exp.toLocaleString()}`];
        }),
        theme: "striped",
        headStyles: { fillColor: [99, 102, 241] },
        styles: { fontSize: 9 },
      });

      // Transactions detail
      doc.addPage();
      doc.setFontSize(14);
      doc.setTextColor(15, 23, 42);
      doc.text("Transaction History", 14, 20);
      autoTable(doc, {
        startY: 26,
        head: [["Date", "Type", "Category", "Description", "Added By", "Amount"]],
        body: transactions.slice(0, 100).map((t) => [
          format(new Date(t.date), "MMM dd, yyyy"),
          t.type,
          t.category,
          t.description.length > 30 ? t.description.slice(0, 30) + "..." : t.description,
          t.addedByName,
          `${t.type === "expense" ? "-" : "+"} ${t.amount.toLocaleString()}`,
        ]),
        theme: "striped",
        headStyles: { fillColor: [99, 102, 241] },
        styles: { fontSize: 8 },
        columnStyles: { 5: { halign: "right" } },
      });

      doc.save(`${company?.name?.replace(/\s+/g, "_") || "report"}_${format(new Date(), "yyyy-MM-dd")}.pdf`);
      toast.success("PDF downloaded", { id: "pdf" });
    } catch (e) {
      toast.error("Failed to export PDF", { id: "pdf" });
    }
  }

  async function exportExcel() {
    toast.loading("Generating Excel report...", { id: "xlsx" });
    try {
      const XLSX = await import("xlsx");

      const summary = [
        ["FounderFlow Report"],
        [company?.name || "Company"],
        ["Generated", format(new Date(), "MMM dd, yyyy")],
        [],
        ["Financial Summary"],
        ["Total Investments", totalInvestments],
        ["Total Expenses", totalExpenses],
        ["Net Balance", totalInvestments - totalExpenses],
        ["Transactions", transactions.length],
      ];
      const summarySheet = XLSX.utils.aoa_to_sheet(summary);

      const txnData = [
        ["Date", "Type", "Category", "Description", "Added By", "Amount (PKR)"],
        ...transactions.map((t) => [
          format(new Date(t.date), "yyyy-MM-dd"),
          t.type,
          t.category,
          t.description,
          t.addedByName,
          t.type === "expense" ? -t.amount : t.amount,
        ]),
      ];
      const txnSheet = XLSX.utils.aoa_to_sheet(txnData);

      const founderSheet = XLSX.utils.aoa_to_sheet([
        ["Name", "Email", "Role", "Investments", "Expenses Logged"],
        ...users.map((u) => {
          const inv = transactions
            .filter((t) => t.addedBy === u.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0);
          const exp = transactions
            .filter((t) => t.addedBy === u.id && t.type === "expense")
            .reduce((s, t) => s + t.amount, 0);
          return [u.name, u.email, u.role, inv, exp];
        }),
      ]);

      const monthlySheet = XLSX.utils.aoa_to_sheet([
        ["Month", "Investments", "Expenses", "Net Flow"],
        ...monthlyData.map((m) => [m.month, m.investments, m.expenses, m.netFlow]),
      ]);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
      XLSX.utils.book_append_sheet(wb, txnSheet, "Transactions");
      XLSX.utils.book_append_sheet(wb, founderSheet, "Team");
      XLSX.utils.book_append_sheet(wb, monthlySheet, "Monthly");

      XLSX.writeFile(wb, `${company?.name?.replace(/\s+/g, "_") || "report"}_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
      toast.success("Excel downloaded", { id: "xlsx" });
    } catch (e) {
      toast.error("Failed to export Excel", { id: "xlsx" });
    }
  }

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Reports & Analytics</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Deep-dive analytics and exportable reports.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={exportPDF} className="btn-secondary">
            <FileText className="h-4 w-4" /> Export PDF
          </button>
          <button onClick={exportExcel} className="btn-primary">
            <FileSpreadsheet className="h-4 w-4" /> Export Excel
          </button>
        </div>
      </div>

      {/* Period filter */}
      <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800/50 rounded-xl w-fit">
        {[
          { key: "3m", label: "Last 3 months" },
          { key: "6m", label: "Last 6 months" },
          { key: "1y", label: "Last year" },
          { key: "all", label: "All time" },
        ].map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key as typeof period)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              period === p.key
                ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow"
                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Net cash flow */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="card p-6"
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold">Monthly Cash Flow</h3>
            <p className="text-sm text-slate-500">Investments vs Expenses over time</p>
          </div>
          <div className="flex gap-4 text-xs">
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-brand-500" />
              <span className="text-slate-600 dark:text-slate-400">Investments</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <span className="text-slate-600 dark:text-slate-400">Expenses</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span className="text-slate-600 dark:text-slate-400">Net Flow</span>
            </div>
          </div>
        </div>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(148 163 184 / 0.2)" vertical={false} />
              <XAxis dataKey="month" stroke="rgb(148 163 184)" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="rgb(148 163 184)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${v / 1000}K` : v.toString())} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 10px 30px rgba(0,0,0,0.1)" }} />
              <Bar dataKey="investments" fill="#6366f1" radius={[8, 8, 0, 0]} />
              <Bar dataKey="expenses" fill="#f59e0b" radius={[8, 8, 0, 0]} />
              <Line type="monotone" dataKey="netFlow" stroke="#10b981" strokeWidth={2} dot={{ fill: "#10b981", r: 4 }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Expense categories */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="card p-6"
        >
          <h3 className="text-lg font-semibold mb-1">Expense Categories</h3>
          <p className="text-sm text-slate-500 mb-4">Where your money goes</p>
          {categoryData.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={categoryData} cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2} dataKey="value">
                      {categoryData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-2">
                {categoryData.map((c, i) => {
                  const pct = (c.value / totalExpenses) * 100;
                  return (
                    <div key={c.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                        <span className="truncate text-slate-700 dark:text-slate-300">{c.name}</span>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <p className="font-semibold tabular-nums">{formatCurrency(c.value)}</p>
                        <p className="text-[10px] text-slate-500">{pct.toFixed(1)}%</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500 text-center py-8">No expenses to analyze</p>
          )}
        </motion.div>

        {/* Founder breakdown */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
          className="card p-6"
        >
          <h3 className="text-lg font-semibold mb-1">Team Contributions</h3>
          <p className="text-sm text-slate-500 mb-4">Who invested and spent what</p>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={founderData} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(148 163 184 / 0.2)" horizontal={false} />
                <XAxis type="number" stroke="rgb(148 163 184)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}K` : v.toString())} />
                <YAxis type="category" dataKey="name" stroke="rgb(148 163 184)" fontSize={11} tickLine={false} axisLine={false} width={70} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={{ borderRadius: 12, border: "none" }} />
                <Bar dataKey="investments" fill="#6366f1" radius={[0, 4, 4, 0]} />
                <Bar dataKey="expenses" fill="#f59e0b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
      </div>

      {/* Detailed table */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.3 }}
        className="card overflow-hidden"
      >
        <div className="p-6 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-lg font-semibold">Founder-wise Breakdown</h3>
          <p className="text-sm text-slate-500 mt-1">Complete contribution and activity report</p>
        </div>
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-left">
                <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Member</th>
                <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Role</th>
                <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Investments</th>
                <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Expenses Logged</th>
                <th className="px-6 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">% of Total Invested</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const inv = transactions.filter((t) => t.addedBy === u.id && t.type === "investment").reduce((s, t) => s + t.amount, 0);
                const exp = transactions.filter((t) => t.addedBy === u.id && t.type === "expense").reduce((s, t) => s + t.amount, 0);
                const pct = totalInvestments > 0 ? (inv / totalInvestments) * 100 : 0;
                return (
                  <tr key={u.id} className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.name} size="sm" />
                        <div>
                          <p className="font-medium text-sm">{u.name}</p>
                          <p className="text-xs text-slate-500">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="badge-default capitalize">{u.role === "admin" ? "Admin Founder" : u.role === "cofounder" ? "Co-Founder" : "Team Member"}</span>
                    </td>
                    <td className="px-6 py-4 text-right font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {formatCurrency(inv)}
                    </td>
                    <td className="px-6 py-4 text-right font-semibold text-amber-600 dark:text-amber-400 tabular-nums">
                      {formatCurrency(exp)}
                    </td>
                    <td className="px-6 py-4 text-right tabular-nums">{pct.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
