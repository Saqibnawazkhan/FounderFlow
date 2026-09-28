"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileSpreadsheet, FileText } from "lucide-react";
import toast from "react-hot-toast";
import { Avatar } from "@/components/ui/avatar";
import { PillBadge } from "@/components/landing/pill-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatUtcDate, formatUtcDay, formatUtcMonthYear } from "@/lib/utils";
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";
import type { Company, Transaction, User } from "@/lib/types";
// `format` stays for the two things on this page that ARE wall-clock instants:
// the "Generated on <date> at <time>" stamp and the download filename, both of
// which mean "now, where the person is sitting". Every DATE-ONLY value — the
// range edges, the month buckets, a transaction's own date — goes through the
// UTC formatters instead, because `Transaction.date` is stored at UTC midnight
// and a local renderer prints the day before it for every viewer west of UTC.
// The month arithmetic (date-fns startOfMonth/endOfMonth/eachMonthOfInterval/
// subMonths, all LOCAL) is gone entirely; see lib/date-range.ts and money-007.
import { format } from "date-fns";
import { startOfUtcMonth } from "@/lib/date-range";

// Inlined palette — must NOT import named constants from reports-charts.tsx
// at top level, that pulls recharts into the initial chunk and defeats the
// dynamic split below.
const PALETTE = [
  "#10B981",
  "#047857",
  "#6EE7B7",
  "#065F46",
  "#34D399",
  "#64748B",
  "#334155",
  "#A7F3D0",
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

const C_PRIMARY = "#10B981";
const C_FOREST = "#047857";
const C_MINT = "#6EE7B7";

/* ─────────────────────────────────────────────────────────────────────────── *
 * The report's arithmetic, extracted as pure functions.
 *
 * Not a style preference: all three defects fixed here (money-007, money-010,
 * rep-004) were wrong NUMBERS or wrong LABELS, and while they lived inline in a
 * `useMemo` and twice more inside two exporters, the only way to check one was
 * to render the page and read it. They are tested directly in
 * tests/app/reports/reports-period.test.ts, which pins TZ=America/Bogota because
 * under UTC every money-007 assertion is vacuous.
 *
 * money-010 in particular existed BECAUSE the figures were computed twice —
 * once in `exportPDF`, once in `exportExcel` — so the mislabelled row had to be
 * written twice and fixed twice. `summaryFigures` is now the single source both
 * exporters map over.
 * ─────────────────────────────────────────────────────────────────────────── */

export type PeriodMode = "3m" | "6m" | "1y" | "all" | "custom";

/**
 * A half-open UTC interval, `[start, endExclusive)` — the same shape
 * lib/date-range.ts hands Prisma, for the same reason: an inclusive
 * `endOfMonth` (…T23:59:59.999) drops a row stored with microsecond precision
 * and has to be re-derived at every call site.
 */
export interface ReportWindow {
  start: Date;
  endExclusive: Date;
}

/** Whether a date-only value falls in the window. */
export function inWindow(value: string | Date, w: ReportWindow): boolean {
  const at = typeof value === "string" ? new Date(value) : value;
  return at >= w.start && at < w.endExclusive;
}

/** UTC midnight on the calendar day of `value`. */
function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** The next UTC midnight after `value`'s day — a half-open upper bound. */
function endOfUtcDayExclusive(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1));
}

const PRESET_MONTHS: Record<string, number> = { "3m": 3, "6m": 6, "1y": 12 };

/**
 * The period the picker selected, as a UTC interval (money-007).
 *
 * WHAT THIS REPLACES. `startOfMonth(subMonths(now, months - 1))` /
 * `endOfMonth(now)` from date-fns, which compute in the RUNTIME's LOCAL
 * calendar. `Transaction.date` is a date-only value stored at UTC midnight, so
 * in America/Bogota (UTC-5) the local start of May is 2026-05-01T05:00Z and a
 * row the customer dated "May 1st" sat five hours BEFORE the window that was
 * supposed to open on it — dropped from a "last 6 months" report, and pushed
 * into the previous month's bucket on the cash-flow chart. /budgets and the
 * project pages had always bucketed in UTC, so the same row was simultaneously
 * consuming May's cap. Every customer west of UTC; a Karachi team never sees it.
 *
 * `endExclusive` is the 1st of the month AFTER `now`, so the current month is
 * whole — the report is a calendar-month series, not a to-date one.
 */
export function reportWindow(args: {
  mode: PeriodMode;
  now: Date;
  customFrom?: string;
  customTo?: string;
  transactions: { date: string }[];
}): ReportWindow {
  const { mode, now, customFrom, customTo, transactions } = args;
  /** The default the custom mode falls back to while its inputs are incomplete. */
  const sixMonths = (): ReportWindow => ({
    start: startOfUtcMonth(now, -5),
    endExclusive: startOfUtcMonth(now, 1),
  });

  if (mode === "custom") {
    if (!customFrom || !customTo) return sixMonths();
    const a = new Date(customFrom);
    const b = new Date(customTo);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return sixMonths();
    // Forgive a reversed range instead of showing nothing. Both ends are whole
    // UTC DAYS: `<input type="date">` gives "2026-09-12", which parses to UTC
    // midnight, so date-fns `startOfDay`/`endOfDay` were shifting each edge by
    // the viewer's offset and silently clipping a day off one end of the range.
    const [from, to] = a <= b ? [a, b] : [b, a];
    return { start: startOfUtcDay(from), endExclusive: endOfUtcDayExclusive(to) };
  }

  if (mode === "all") {
    const earliest = transactions.reduce((min, t) => {
      const d = new Date(t.date);
      return d < min ? d : min;
    }, now);
    return { start: startOfUtcMonth(earliest), endExclusive: startOfUtcMonth(now, 1) };
  }

  const months = PRESET_MONTHS[mode] ?? 6;
  return { start: startOfUtcMonth(now, -(months - 1)), endExclusive: startOfUtcMonth(now, 1) };
}

export interface MonthBucket {
  month: string;
  expenses: number;
  investments: number;
  revenue: number;
  netFlow: number;
}

/**
 * One bucket per UTC month the window spans (money-007).
 *
 * Replaces `eachMonthOfInterval` + `endOfMonth`, both local. Consecutive
 * windows abut exactly — bucket N's `endExclusive` IS bucket N+1's `start` —
 * so no row lands in two buckets or in none, which an inclusive end could not
 * guarantee.
 *
 * The LABEL is UTC too, and that is a second off-by-one, not the same one:
 * `format(monthStart, "MMM yy")` renders a UTC-midnight Date in the viewer's
 * zone, so moving the bucket to UTC without moving the label would have printed
 * the October bucket as "Sep 26" in Bogota.
 */
export function monthBuckets(txns: Transaction[], w: ReportWindow): MonthBucket[] {
  const out: MonthBucket[] = [];
  let cursor = startOfUtcMonth(w.start);
  // Guard against a pathological window (endExclusive <= start): emit nothing
  // rather than loop. `reportWindow` never produces one, but a caller could.
  let guard = 0;
  while (cursor < w.endExclusive && guard < 600) {
    guard += 1;
    const next = startOfUtcMonth(cursor, 1);
    const bucket = { start: cursor, endExclusive: next };
    const inMonth = txns.filter((t) => inWindow(t.date, bucket));
    const expenses = inMonth.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    const investments = inMonth
      .filter((t) => t.type === "investment")
      .reduce((s, t) => s + t.amount, 0);
    const revenue = inMonth.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    out.push({
      month: formatUtcMonthYear(cursor),
      expenses,
      investments,
      revenue,
      netFlow: investments + revenue - expenses,
    });
    cursor = next;
  }
  return out;
}

function sumOfType(txns: Transaction[], type: Transaction["type"]): number {
  return txns.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
}

/** Cash in (founder capital + earned revenue) minus cash out — the formula
 *  /dashboard's Balance card uses, over whatever set it is handed. */
function netOf(txns: Transaction[]): number {
  return sumOfType(txns, "investment") + sumOfType(txns, "income") - sumOfType(txns, "expense");
}

export interface SummaryFigure {
  label: string;
  amount: number;
}

/**
 * The Financial Summary table, one definition for the PDF and the Excel sheet
 * (money-010).
 *
 * WHAT WENT WRONG. Both exporters printed
 * `["Net Balance", money(totalInvestments + totalRevenue - totalExpenses)]`
 * where all three sums are WINDOWED by the period picker, which defaults to six
 * months. "Net Balance" has exactly one meaning to whoever reads the export —
 * the cash the company holds, the figure /dashboard prints on its Balance card
 * — and for a company that raised its seed eight months ago the exported number
 * excluded the raise and could be deeply negative. This is the one artefact the
 * product is sold as "investor-ready"; it is a document a customer can be held
 * to.
 *
 * The fix is two rows, not a rename: the period net flow is a real and useful
 * figure, it just is not the balance. So every windowed row now says "(in
 * period)" out loud, and the balance gets its own all-time row computed from
 * every transaction the workspace has. `/reports` is handed the full ledger by
 * app/(app)/reports/page.tsx (`getTransactions()`, unwindowed), so this needs no
 * extra query — and because it reuses the dashboard's formula, the two surfaces
 * cannot drift.
 */
export function summaryFigures(args: {
  ranged: Transaction[];
  all: Transaction[];
}): SummaryFigure[] {
  const { ranged, all } = args;
  return [
    { label: "Investments (in period)", amount: sumOfType(ranged, "investment") },
    { label: "Revenue (in period)", amount: sumOfType(ranged, "income") },
    { label: "Expenses (in period)", amount: sumOfType(ranged, "expense") },
    { label: "Net flow (in period)", amount: netOf(ranged) },
    // Last, and all-time: the row a reader will look for, positioned after the
    // flows so it cannot be mistaken for one of them.
    { label: "Cash balance (all time)", amount: netOf(all) },
  ];
}

export interface ContributorRow {
  id: string;
  name: string;
  email: string;
  role: string;
  investments: number;
  expenses: number;
  /** 0–1 share of the window's total investments. Sums to 1 across all rows. */
  capitalRatio: number;
  /** True when this contributor is no longer on the roster (X8 deactivated). */
  former: boolean;
}

/**
 * The founder-wise breakdown, including contributors who have left (rep-004).
 *
 * WHAT WENT WRONG. Every per-person figure iterated `users`, which is
 * getCompanyUsers() and filters `deletedAt: null`. `removeUserAction` stamps
 * that tombstone and deliberately leaves the person's transactions in place —
 * lib/actions/team.ts says so outright — so deactivating a co-founder removed
 * their ROW while their capital stayed inside `totalInvestments` and inside the
 * pie. The "% of capital" column, the closest thing this product has to a cap
 * table and the centrepiece of the investor PDF, then understated everyone who
 * remained and stopped summing to 100% — at precisely the moment (a co-founder
 * departure) someone would generate the report. /expenses meanwhile kept
 * showing that person's rows by name, from the denormalised `addedByName`, so
 * the same human was present on one finance page and absent from the other.
 *
 * WHY IT DERIVES FROM THE TRANSACTIONS rather than from a new query. The
 * departed contributor's name is already on every row they added
 * (`Transaction.addedByName`, denormalised precisely so a deleted user's
 * history stays readable), so no round-trip is needed — and widening
 * getCompanyUsers() would have been wrong: its other consumers are the team
 * roster, the @-mention autocomplete and the task assignee picker, none of which
 * should offer a deactivated account. The report's own requirement is "account
 * for every unit of capital the totals claim", and the ledger is the authority
 * on that, not the roster.
 *
 * A contributor with no rows IN THE WINDOW gets no phantom row; a live member
 * with no rows keeps a zero row, because they are on the roster.
 */
export function contributorRows(users: User[], ranged: Transaction[]): ContributorRow[] {
  const totalInvestments = sumOfType(ranged, "investment");
  const ratio = (inv: number) => (totalInvestments > 0 ? inv / totalInvestments : 0);
  const forId = (id: string) => ({
    investments: ranged
      .filter((t) => t.addedBy === id && t.type === "investment")
      .reduce((s, t) => s + t.amount, 0),
    expenses: ranged
      .filter((t) => t.addedBy === id && t.type === "expense")
      .reduce((s, t) => s + t.amount, 0),
  });

  const live: ContributorRow[] = users.map((u) => {
    const sums = forId(u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      ...sums,
      capitalRatio: ratio(sums.investments),
      former: false,
    };
  });

  const onRoster = new Set<string>();
  users.forEach((u) => onRoster.add(u.id));
  // Distinct contributors in the window who are not on the roster, in the order
  // their first row appears. A plain object keyed by id rather than a Map spread
  // — tsconfig has no `target`, so it defaults to ES5 and spreading a Map fails
  // typecheck (TS2802) while passing vitest.
  const formerIds: string[] = [];
  const seen: Record<string, true> = {};
  const formerNames: Record<string, string> = {};
  ranged.forEach((t) => {
    if (onRoster.has(t.addedBy) || seen[t.addedBy]) return;
    seen[t.addedBy] = true;
    formerIds.push(t.addedBy);
    formerNames[t.addedBy] = t.addedByName;
  });

  const former: ContributorRow[] = formerIds.map((id) => {
    const sums = forId(id);
    return {
      id,
      name: formerNames[id] || "Former member",
      email: "",
      role: "former",
      ...sums,
      capitalRatio: ratio(sums.investments),
      former: true,
    };
  });

  return live.concat(former);
}

/** Human label for the Role column, former contributors included. */
function roleLabel(row: ContributorRow): string {
  if (row.former) return "Former member";
  if (row.role === "admin") return "Admin Founder";
  if (row.role === "cofounder") return "Co-Founder";
  return "Team Member";
}

/**
 * The last day the window includes, for display. `endExclusive` is the day
 * AFTER it, so printing that directly would advertise a range one day longer
 * than the one the figures cover.
 */
function lastIncludedDay(w: ReportWindow): Date {
  return new Date(w.endExclusive.getTime() - 1);
}

type Props = {
  transactions: Transaction[];
  users: User[];
  company: Company;
};

export function ReportsClient({ transactions, users, company }: Props) {
  const money = useMoney();
  const n = useNumberFormat();
  // Date window (F5): presets OR a custom from/to range. The whole report —
  // charts, category mix, per-founder totals — scopes to this window, so the
  // range picker is a single source of truth (previously the presets only
  // moved the cash-flow chart while the totals stayed all-time).
  const [mode, setMode] = useState<PeriodMode>("6m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // The window is a half-open UTC interval (money-007). Every date-fns month
  // helper that used to build it worked in the local calendar; see reportWindow.
  const range = useMemo(
    () => reportWindow({ mode, now: new Date(), customFrom, customTo, transactions }),
    [mode, customFrom, customTo, transactions]
  );
  /** The last day the range includes — what a human should be shown. */
  const rangeEndLabel = useMemo(() => lastIncludedDay(range), [range]);
  /** One string, used by the PDF, the Excel sheet and the custom-range hint, so
   *  the three cannot describe different periods. */
  const rangeText = `${formatUtcDate(range.start)} – ${formatUtcDate(rangeEndLabel)}`;

  // Every downstream metric derives from the windowed set.
  const rangedTxns = useMemo(
    () => transactions.filter((t) => inWindow(t.date, range)),
    [transactions, range]
  );

  const monthlyData = useMemo(() => monthBuckets(rangedTxns, range), [rangedTxns, range]);

  const categoryData = useMemo(() => {
    const map = new Map<string, number>();
    rangedTxns
      .filter((t) => t.type === "expense")
      .forEach((t) => map.set(t.category, (map.get(t.category) || 0) + t.amount));
    return Array.from(map.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [rangedTxns]);

  // ONE breakdown for the chart, the table and both exports (rep-004), so a
  // departed co-founder's capital cannot appear in the totals with no owner.
  const breakdown = useMemo(() => contributorRows(users, rangedTxns), [users, rangedTxns]);

  const founderData = useMemo(
    () =>
      breakdown.map((r) => ({
        // First name only for the axis, but a former member keeps a marker —
        // otherwise the bar is indistinguishable from a current teammate's.
        name: r.former ? `${r.name.split(" ")[0]} (former)` : r.name.split(" ")[0],
        investments: r.investments,
        expenses: r.expenses,
      })),
    [breakdown]
  );

  // The Financial Summary, defined once (money-010). `transactions` is the FULL
  // ledger — app/(app)/reports/page.tsx passes getTransactions() unwindowed — so
  // the all-time cash balance needs no extra query.
  const summary = useMemo(
    () => summaryFigures({ ranged: rangedTxns, all: transactions }),
    [rangedTxns, transactions]
  );

  const totalExpenses = rangedTxns
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);
  const totalInvestments = rangedTxns
    .filter((t) => t.type === "investment")
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
          // The range comes FIRST, above the figures it qualifies (money-010):
          // it used to sit below them, so a reader met four unqualified amounts
          // before learning they covered only six months.
          ["Date range", rangeText],
          ...summary.map((f) => [f.label, money(f.amount)]),
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
        head: [["Name", "Role", "Invested", "Logged Expenses", "% of capital"]],
        // rep-004: `breakdown`, not `users` — a departed co-founder's capital is
        // in "Investments (in period)" above, so it needs a row here or the page
        // claims money with no owner.
        body: breakdown.map((r) => [
          r.name,
          roleLabel(r),
          money(r.investments),
          money(r.expenses),
          n.percent(r.capitalRatio),
        ]),
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
          // formatUtcDate, not date-fns `format`: Transaction.date is a
          // date-only value stored at UTC midnight, so the local renderer
          // printed the day BEFORE the one the customer typed, west of UTC.
          formatUtcDate(t.date),
          t.type,
          t.category,
          t.description.length > 30 ? t.description.slice(0, 30) + "…" : t.description,
          t.addedByName,
          `${t.type === "expense" ? "-" : "+"} ${money(t.amount)}`,
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

      // Same rows as the PDF, from the same `summaryFigures` (money-010) — the
      // old code recomputed them here, which is why the mislabelled "Net
      // Balance" had to be written twice. Raw numbers, not formatted strings, so
      // the cells stay arithmetic.
      const summarySheet: (string | number)[][] = [
        ["FounderFlow Report"],
        [company.name || "Company"],
        ["Generated", format(new Date(), "MMM dd, yyyy")],
        [],
        ["Financial Summary"],
        ["Date range", `${formatUtcDay(range.start)} to ${formatUtcDay(rangeEndLabel)}`],
        ...summary.map((f) => [f.label, f.amount]),
        ["Transactions", rangedTxns.length],
      ];

      const txnData = [
        ["Date", "Type", "Category", "Description", "Added By", `Amount (${company.currency})`],
        ...rangedTxns.map((t) => [
          formatUtcDay(t.date),
          t.type,
          t.category,
          t.description,
          t.addedByName,
          t.type === "expense" ? -t.amount : t.amount,
        ]),
      ];

      // rep-004: `breakdown`, so the Team sheet's Investments column sums to the
      // Summary sheet's "Investments (in period)". It did not when a contributor
      // had been deactivated.
      const founderSheet = XLSX.utils.aoa_to_sheet([
        ["Name", "Email", "Role", "Status", "Investments", "Expenses Logged", "% of capital"],
        ...breakdown.map((r) => [
          r.name,
          r.email,
          r.role,
          r.former ? "former" : "active",
          r.investments,
          r.expenses,
          r.capitalRatio,
        ]),
      ]);

      const monthlySheet = XLSX.utils.aoa_to_sheet([
        ["Month", "Investments", "Revenue", "Expenses", "Net Flow"],
        ...monthlyData.map((m) => [m.month, m.investments, m.revenue, m.expenses, m.netFlow]),
      ]);

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summarySheet), "Summary");
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
          <PillBadge tone="forest">Analytics</PillBadge>
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
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
              <span className="font-mono text-[11px] text-fg-muted">{rangeText}</span>
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
            <Legend dot={C_FOREST} label="Revenue" />
            <Legend dot={C_MINT} label="Expenses" />
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
                  // 0–1 ratio — the scale `n.percent` takes. See lib/format.ts.
                  const ratio = c.value / totalExpenses;
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
                          {money(c.value)}
                        </p>
                        <p className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                          {n.percent(ratio)}
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
              {/* rep-004: `breakdown`, not `users`. Iterating the live roster
                  dropped a deactivated co-founder's row while their capital
                  stayed in the totals above, so this column — the nearest thing
                  the product has to a cap table — silently stopped summing to
                  100% the moment someone left. */}
              {breakdown.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-bg"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <Avatar name={r.name} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-fg">{r.name}</p>
                        <p className="text-xs text-fg-muted">
                          {r.email || "No longer on the team"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
                        r.former
                          ? "border-warning/40 bg-warning/10 text-warning"
                          : "border-border bg-bg text-fg-muted"
                      )}
                    >
                      {roleLabel(r)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span className="font-mono text-sm font-bold tabular-nums text-primary-strong">
                      {money(r.investments)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span className="font-mono text-sm font-bold tabular-nums text-mint-strong">
                      {money(r.expenses)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    {/* 0–1 ratio — the scale `n.percent` takes. See lib/format.ts. */}
                    <span className="font-mono text-sm tabular-nums text-fg">
                      {n.percent(r.capitalRatio)}
                    </span>
                  </td>
                </tr>
              ))}
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
