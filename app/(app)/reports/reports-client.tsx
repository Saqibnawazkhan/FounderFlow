"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileSpreadsheet, FileText } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { PillBadge } from "@/components/landing/pill-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, cn } from "@/lib/utils";
import type { Company, Transaction, User } from "@/lib/types";
import {
  eachMonthOfInterval,
  endOfDay,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  subMonths,
} from "date-fns";

// Inlined palette — must NOT import named constants from reports-charts.tsx
// at top level, that pulls recharts into the initial chunk and defeats the
// dynamic split below.
const PALETTE = [
  "#b6f425",
  "#70E6ED",
  "#FFB3DB",
  "#f59e0b",
  "#a78bfa",
  "#34d399",
  "#fb7185",
  "#facc15",
];

// Recharts is ~200KB. Lazy-load each chart so /reports' initial bundle stays
// lean; the chart skeleton from Phase 2 fills the space during the fetch.
const chartLoading = () => <Skeleton className="h-full w-full rounded-xl" />;
const CashFlowBarChart = dynamic(
  () => import("./reports-charts").then((m) => ({ default: m.CashFlowBarChart })),
  { ssr: false, loading: chartLoading }
);
const CategoriesPieChart = dynamic(
  () => import("./reports-charts").then((m) => ({ default: m.CategoriesPieChart })),
  { ssr: false, loading: chartLoading }
);
const FoundersHorizontalBar = dynamic(
  () => import("./reports-charts").then((m) => ({ default: m.FoundersHorizontalBar })),
  { ssr: false, loading: chartLoading }
);

const C_PRIMARY = "#b6f425";
const C_CYAN = "#70E6ED";
const C_PINK = "#FFB3DB";

type Props = {
  transactions: Transaction[];
  users: User[];
  company: Company;
};

export function ReportsClient({ transactions, users, company }: Props) {
  // Date window (F5): presets OR a custom from/to range. The whole report —
  // charts, category mix, per-founder totals — scopes to this window, so the
  // range picker is a single source of truth (previously the presets only
  // moved the cash-flow chart while the totals stayed all-time).
  const [mode, setMode] = useState<"3m" | "6m" | "1y" | "all" | "custom">("6m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const { rangeStart, rangeEnd } = useMemo(() => {
    const now = new Date();
    if (mode === "custom") {
      if (!customFrom || !customTo) {
        return { rangeStart: startOfMonth(subMonths(now, 5)), rangeEnd: endOfMonth(now) };
      }
      let from = startOfDay(new Date(customFrom));
      let to = endOfDay(new Date(customTo));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return { rangeStart: startOfMonth(subMonths(now, 5)), rangeEnd: endOfMonth(now) };
      }
      // Forgive a reversed range instead of showing nothing.
      if (from > to) [from, to] = [startOfDay(new Date(customTo)), endOfDay(new Date(customFrom))];
      return { rangeStart: from, rangeEnd: to };
    }
    if (mode === "all") {
      const earliest = transactions.reduce((min, t) => {
        const d = new Date(t.date);
        return d < min ? d : min;
      }, now);
      return { rangeStart: startOfMonth(earliest), rangeEnd: endOfMonth(now) };
    }
    const months = { "3m": 3, "6m": 6, "1y": 12 }[mode] ?? 6;
    return {
      rangeStart: startOfMonth(subMonths(now, months - 1)),
      rangeEnd: endOfMonth(now),
    };
  }, [mode, customFrom, customTo, transactions]);

  // Every downstream metric derives from the windowed set.
  const rangedTxns = useMemo(
    () =>
      transactions.filter((t) => {
        const d = new Date(t.date);
        return d >= rangeStart && d <= rangeEnd;
      }),
    [transactions, rangeStart, rangeEnd]
  );

  const monthlyData = useMemo(() => {
    // Bucket every month spanned by the window. Guard the interval call — a
    // custom end before start would throw; the range logic already forgives
    // reversal, but clamp defensively.
    const start = rangeStart <= rangeEnd ? rangeStart : rangeEnd;
    const months = eachMonthOfInterval({ start: startOfMonth(start), end: rangeEnd });
    return months.map((monthStart) => {
      const monthEnd = endOfMonth(monthStart);
      const monthTxns = rangedTxns.filter((t) => {
        const d = new Date(t.date);
        return d >= monthStart && d <= monthEnd;
      });
      const expenses = monthTxns
        .filter((t) => t.type === "expense")
        .reduce((s, t) => s + t.amount, 0);
      const investments = monthTxns
        .filter((t) => t.type === "investment")
        .reduce((s, t) => s + t.amount, 0);
      const revenue = monthTxns
        .filter((t) => t.type === "income")
        .reduce((s, t) => s + t.amount, 0);
      return {
        month: format(monthStart, "MMM yy"),
        expenses,
        investments,
        revenue,
        netFlow: investments + revenue - expenses,
      };
    });
  }, [rangedTxns, rangeStart, rangeEnd]);

  const categoryData = useMemo(() => {
    const map = new Map<string, number>();
    rangedTxns
      .filter((t) => t.type === "expense")
      .forEach((t) => map.set(t.category, (map.get(t.category) || 0) + t.amount));
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [rangedTxns]);

  const founderData = useMemo(
    () =>
      users.map((u) => ({
        name: u.name.split(" ")[0],
        investments: rangedTxns
          .filter((t) => t.addedBy === u.id && t.type === "investment")
          .reduce((s, t) => s + t.amount, 0),
        expenses: rangedTxns
          .filter((t) => t.addedBy === u.id && t.type === "expense")
          .reduce((s, t) => s + t.amount, 0),
      })),
    [rangedTxns, users]
  );

  const totalExpenses = rangedTxns
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);
  const totalInvestments = rangedTxns
    .filter((t) => t.type === "investment")
    .reduce((s, t) => s + t.amount, 0);
  const totalRevenue = rangedTxns
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount, 0);

  async function exportPDF() {
    toast.loading("Generating PDF report…", { id: "pdf" });
    try {
      const { jsPDF } = await import("jspdf");
      const autoTable = (await import("jspdf-autotable")).default;

      const doc = new jsPDF();
      doc.setFontSize(20);
      doc.setTextColor(15, 23, 42);
      doc.text("FounderFlow Report", 14, 20);

      doc.setFontSize(12);
      doc.text(company.name || "Company Report", 14, 30);

      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(`Generated on ${format(new Date(), "MMM dd, yyyy 'at' h:mm a")}`, 14, 36);

      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text("Financial Summary", 14, 50);
      autoTable(doc, {
        startY: 54,
        head: [["Metric", "Amount"]],
        body: [
          ["Total Investments", formatCurrency(totalInvestments)],
          ["Total Revenue", formatCurrency(totalRevenue)],
          ["Total Expenses", formatCurrency(totalExpenses)],
          ["Net Balance", formatCurrency(totalInvestments + totalRevenue - totalExpenses)],
          [
            "Date range",
            `${format(rangeStart, "MMM d, yyyy")} – ${format(rangeEnd, "MMM d, yyyy")}`,
          ],
          ["Number of Transactions", rangedTxns.length.toString()],
          ["Team Members", users.length.toString()],
        ],
        theme: "striped",
        headStyles: { fillColor: [77, 124, 15] },
        styles: { fontSize: 10 },
      });

      const lastY =
        (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
      doc.text("Founder Contributions", 14, lastY);
      autoTable(doc, {
        startY: lastY + 4,
        head: [["Name", "Role", "Invested", "Logged Expenses"]],
        body: users.map((u) => {
          const inv = rangedTxns
            .filter((t) => t.addedBy === u.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0);
          const exp = rangedTxns
            .filter((t) => t.addedBy === u.id && t.type === "expense")
            .reduce((s, t) => s + t.amount, 0);
          return [u.name, u.role, formatCurrency(inv), formatCurrency(exp)];
        }),
        theme: "striped",
        headStyles: { fillColor: [77, 124, 15] },
        styles: { fontSize: 9 },
      });

      doc.addPage();
      doc.setFontSize(14);
      doc.setTextColor(15, 23, 42);
      doc.text("Transaction History", 14, 20);
      autoTable(doc, {
        startY: 26,
        head: [["Date", "Type", "Category", "Description", "Added By", "Amount"]],
        body: rangedTxns.map((t) => [
          format(new Date(t.date), "MMM dd, yyyy"),
          t.type,
          t.category,
          t.description.length > 30 ? t.description.slice(0, 30) + "…" : t.description,
          t.addedByName,
          `${t.type === "expense" ? "-" : "+"} ${formatCurrency(t.amount)}`,
        ]),
        theme: "striped",
        headStyles: { fillColor: [77, 124, 15] },
        styles: { fontSize: 8 },
        columnStyles: { 5: { halign: "right" } },
      });

      doc.save(
        `${company.name?.replace(/\s+/g, "_") || "report"}_${format(new Date(), "yyyy-MM-dd")}.pdf`
      );
      toast.success("PDF downloaded", { id: "pdf" });
    } catch (e) {
      console.error("PDF export failed:", e);
      toast.error("Failed to export PDF", { id: "pdf" });
    }
  }

  async function exportExcel() {
    toast.loading("Generating Excel report…", { id: "xlsx" });
    try {
      const XLSX = await import("xlsx");

      const summary = [
        ["FounderFlow Report"],
        [company.name || "Company"],
        ["Generated", format(new Date(), "MMM dd, yyyy")],
        [],
        ["Financial Summary"],
        ["Date range", `${format(rangeStart, "yyyy-MM-dd")} to ${format(rangeEnd, "yyyy-MM-dd")}`],
        ["Total Investments", totalInvestments],
        ["Total Revenue", totalRevenue],
        ["Total Expenses", totalExpenses],
        ["Net Balance", totalInvestments + totalRevenue - totalExpenses],
        ["Transactions", rangedTxns.length],
      ];

      const txnData = [
        ["Date", "Type", "Category", "Description", "Added By", `Amount (${company.currency})`],
        ...rangedTxns.map((t) => [
          format(new Date(t.date), "yyyy-MM-dd"),
          t.type,
          t.category,
          t.description,
          t.addedByName,
          t.type === "expense" ? -t.amount : t.amount,
        ]),
      ];

      const founderSheet = XLSX.utils.aoa_to_sheet([
        ["Name", "Email", "Role", "Investments", "Expenses Logged"],
        ...users.map((u) => {
          const inv = rangedTxns
            .filter((t) => t.addedBy === u.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0);
          const exp = rangedTxns
            .filter((t) => t.addedBy === u.id && t.type === "expense")
            .reduce((s, t) => s + t.amount, 0);
          return [u.name, u.email, u.role, inv, exp];
        }),
      ]);

      const monthlySheet = XLSX.utils.aoa_to_sheet([
        ["Month", "Investments", "Revenue", "Expenses", "Net Flow"],
        ...monthlyData.map((m) => [m.month, m.investments, m.revenue, m.expenses, m.netFlow]),
      ]);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(txnData), "Transactions");
      XLSX.utils.book_append_sheet(wb, founderSheet, "Team");
      XLSX.utils.book_append_sheet(wb, monthlySheet, "Monthly");

      XLSX.writeFile(
        wb,
        `${company.name?.replace(/\s+/g, "_") || "report"}_${format(new Date(), "yyyy-MM-dd")}.xlsx`
      );
      toast.success("Excel downloaded", { id: "xlsx" });
    } catch (e) {
      console.error("Excel export failed:", e);
      toast.error("Failed to export Excel", { id: "xlsx" });
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge tone="cyan">Analytics</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Reports
          </h1>
          <p className="mt-2 text-sm text-fg-muted md:text-base">
            Deep-dive analytics and investor-ready exports.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportPDF}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
          >
            <FileText className="h-4 w-4" aria-hidden="true" /> Export PDF
          </button>
          <button
            onClick={exportExcel}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" /> Export Excel
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="inline-flex w-fit flex-wrap gap-1 rounded-full border border-border bg-bg p-1">
          {[
            { key: "3m", label: "3 months" },
            { key: "6m", label: "6 months" },
            { key: "1y", label: "1 year" },
            { key: "all", label: "All time" },
            { key: "custom", label: "Custom" },
          ].map((p) => {
            const active = mode === p.key;
            return (
              <button
                key={p.key}
                onClick={() => setMode(p.key as typeof mode)}
                aria-pressed={active}
                className={cn(
                  "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
                  active ? "bg-surface text-fg shadow-card" : "text-fg-muted hover:text-fg"
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {mode === "custom" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span className="font-mono uppercase tracking-wider">From</span>
              <input
                type="date"
                value={customFrom}
                max={customTo || undefined}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-fg focus:border-primary/50 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span className="font-mono uppercase tracking-wider">To</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                onChange={(e) => setCustomTo(e.target.value)}
                className="rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-fg focus:border-primary/50 focus:outline-none"
              />
            </label>
            {!customFrom || !customTo ? (
              <span className="text-[11px] text-fg-muted">
                Pick both dates — showing last 6 months meanwhile.
              </span>
            ) : (
              <span className="font-mono text-[11px] text-fg-muted">
                {format(rangeStart, "MMM d, yyyy")} → {format(rangeEnd, "MMM d, yyyy")}
              </span>
            )}
          </div>
        )}
      </div>

      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              Cash flow
            </p>
            <h3 className="mt-1 text-lg font-bold tracking-tight">Money in vs out</h3>
          </div>
          <div className="flex gap-4 text-xs">
            <Legend dot={C_PRIMARY} label="Investments" />
            <Legend dot={C_CYAN} label="Revenue" />
            <Legend dot={C_PINK} label="Expenses" />
          </div>
        </div>
        <div className="h-80">
          <CashFlowBarChart data={monthlyData} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-border bg-surface p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            Spend mix
          </p>
          <h3 className="mt-1 text-lg font-bold tracking-tight">Expense categories</h3>
          {categoryData.length > 0 ? (
            <div className="mt-5 grid grid-cols-1 items-center gap-4 md:grid-cols-2">
              <div className="h-64">
                <CategoriesPieChart data={categoryData} />
              </div>
              <ul className="space-y-2">
                {categoryData.map((c, i) => {
                  const pct = (c.value / totalExpenses) * 100;
                  return (
                    <li key={c.name} className="flex items-center justify-between text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                          aria-hidden="true"
                        />
                        <span className="truncate text-fg">{c.name}</span>
                      </div>
                      <div className="ml-2 shrink-0 text-right">
                        <p className="font-mono text-xs font-bold tabular-nums text-fg">
                          {formatCurrency(c.value)}
                        </p>
                        <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                          {pct.toFixed(1)}%
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-fg-muted">No expenses to analyze</p>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-surface p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            By person
          </p>
          <h3 className="mt-1 text-lg font-bold tracking-tight">Team contributions</h3>
          <div className="mt-5 h-64">
            <FoundersHorizontalBar data={founderData} />
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="border-b border-border p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            Full report
          </p>
          <h3 className="mt-1 text-lg font-bold tracking-tight">Founder-wise breakdown</h3>
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full">
            <thead className="bg-bg">
              <tr className="border-b border-border">
                <th
                  scope="col"
                  className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Member
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-left font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Role
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-right font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Investments
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-right font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Expenses
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-right font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  % of capital
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const inv = rangedTxns
                  .filter((t) => t.addedBy === u.id && t.type === "investment")
                  .reduce((s, t) => s + t.amount, 0);
                const exp = rangedTxns
                  .filter((t) => t.addedBy === u.id && t.type === "expense")
                  .reduce((s, t) => s + t.amount, 0);
                const pct = totalInvestments > 0 ? (inv / totalInvestments) * 100 : 0;
                return (
                  <tr
                    key={u.id}
                    className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-bg"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.name} size="sm" />
                        <div>
                          <p className="text-sm font-medium text-fg">{u.name}</p>
                          <p className="text-xs text-fg-muted">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center rounded-full border border-border bg-bg px-2.5 py-0.5 text-xs font-medium text-fg-muted">
                        {u.role === "admin"
                          ? "Admin Founder"
                          : u.role === "cofounder"
                            ? "Co-Founder"
                            : "Team Member"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="font-mono text-sm font-bold tabular-nums text-primary-strong">
                        {formatCurrency(inv)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="font-mono text-sm font-bold tabular-nums text-pink-strong">
                        {formatCurrency(exp)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="font-mono text-sm tabular-nums text-fg">
                        {pct.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: dot }}
        aria-hidden="true"
      />
      <span className="text-fg-muted">{label}</span>
    </div>
  );
}
