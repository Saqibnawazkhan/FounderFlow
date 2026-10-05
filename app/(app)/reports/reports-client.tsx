"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { FileSpreadsheet, FileText, Info } from "lucide-react";
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
import { CHART_SERIES, categoricalAt } from "@/lib/colors/categorical";

/**
 * Chart colours — from lib/colors/categorical.ts, the SAME module
 * reports-charts.tsx reads, so the legend dots and category dots below cannot
 * disagree with the marks they label.
 *
 * The constraint the old inline copy was built around still holds: this file
 * must NOT import named constants from reports-charts.tsx at top level, because
 * that pulls recharts into the initial chunk and defeats the dynamic split
 * below. The shared module has no recharts dependency, so it satisfies the
 * constraint WITHOUT a second copy of the palette — which is what the comment
 * here used to call "inlined" and what actually made the dots drift free of the
 * chart: eight hex colours for ten `EXPENSE_CATEGORIES`, and no response to the
 * theme toggle.
 */

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
  /**
   * The start that was ASKED for, present only when the span exceeded
   * `MAX_REPORT_MONTHS` and `start` was moved forward to fit (rep-009).
   *
   * One field rather than a `clamped` boolean beside a value: the picker has to
   * tell the reader what was narrowed, and two fields that must agree are two
   * fields that can disagree. Absent means nothing was narrowed, so a surface
   * reading it cannot announce a clamp that never happened.
   */
  requestedStart?: Date;
}

/** Whether a date-only value falls in the window. */
export function inWindow(value: string | Date, w: ReportWindow): boolean {
  const at = typeof value === "string" ? new Date(value) : value;
  return at >= w.start && at < w.endExclusive;
}

/**
 * UTC midnight at `year-month-day`, with the month/day overflow `Date.UTC`
 * gives (day 32 of December rolls into January).
 *
 * NOT `Date.UTC(year, ...)`, and that is not pedantry: `Date.UTC` maps a year
 * argument of 0–99 into 1900–1999, a legacy two-digit rule with no opt-out. So
 * `<input type="date">` set to `0001-01-01` produced 1901-01-01 here — a
 * silently different century from the one the customer typed, and the reason the
 * clamp below could not otherwise report the start it was actually given.
 * `setUTCFullYear` takes the year literally.
 */
function utcMidnight(year: number, month: number, day: number): Date {
  const at = new Date(0);
  at.setUTCFullYear(year, month, day);
  return at;
}

/** UTC midnight on the calendar day of `value`. */
function startOfUtcDay(value: Date): Date {
  return utcMidnight(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/** The next UTC midnight after `value`'s day — a half-open upper bound. */
function endOfUtcDayExclusive(value: Date): Date {
  return utcMidnight(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1);
}

/**
 * The widest span /reports will chart, in whole UTC months (rep-009).
 *
 * Ten years. Every figure on this page is a monthly series rendered as a recharts
 * BarChart, so the span is a bar count as much as a date range, and a founder
 * comparing decades is not a case this product has. `All time` on a real
 * workspace is a few years; anything past this cap arrived by a typo, a paste, or
 * a corrupt row.
 *
 * WHAT IT REPLACES. `eachMonthOfInterval({ start, end })` over 0001-01-01 →
 * 9999-12-31 materialised ~120,000 Dates and `monthlyData` re-filtered the whole
 * ledger once per bucket, which is what froze the tab. money-007 replaced that
 * walk with a counter, which stopped the hang but truncated from the START of the
 * span — so the same input charted the first fifty years AD: six hundred empty
 * months, none of the customer's data, and nothing said so. A clamp that keeps
 * the RECENT end and announces itself is the fix; the counter in `monthBuckets`
 * stays as the inner bound for a hand-built window.
 */
export const MAX_REPORT_MONTHS = 120;

/** A month as one comparable integer — the bucket index in `monthBuckets`. */
function utcMonthIndex(value: Date): number {
  return value.getUTCFullYear() * 12 + value.getUTCMonth();
}

/**
 * Calendar months the half-open window `[start, endExclusive)` TOUCHES — which is
 * the number of buckets `monthBuckets` will emit for it.
 *
 * NOT A MONTH-INDEX DIFFERENCE, and that distinction cost the chart its newest
 * month. A `utcMonthsBetween` helper used to live here doing exactly that
 * subtraction, and for a window ending on any day but the 1st — the normal case,
 * since a `to` date is usually mid-month — it reports one fewer than the window
 * covers: 2026-01-15 → 2026-03-10 is two by index and three months on a chart.
 * `clampSpan` measured that way while `monthBuckets`' loop counted touched
 * months, so a window clamped to exactly the limit needed one more bucket than
 * the guard allowed. The helper is deleted rather than left beside this one: two
 * functions answering almost the same question is how they got mixed up. The loop walks
 * FORWARD from the start, so the bucket it dropped was the most recent one: a
 * founder opening a ten-year report silently lost the current month, on a
 * cash-flow chart, with a notice underneath telling them the range had been
 * narrowed to something it had not.
 *
 * The last instant inside the window is what decides the final month. Both the
 * clamp and the loop now ask this one function, so they cannot disagree again.
 */
function utcMonthsTouched(start: Date, endExclusive: Date): number {
  if (endExclusive <= start) return 0;
  return utcMonthIndex(new Date(endExclusive.getTime() - 1)) - utcMonthIndex(start) + 1;
}

/**
 * `w`, narrowed to `MAX_REPORT_MONTHS` if it is wider — keeping the END the user
 * asked for and moving the start forward, because the recent months are the ones
 * a founder came to look at.
 */
function clampSpan(w: ReportWindow): ReportWindow {
  if (utcMonthsTouched(w.start, w.endExclusive) <= MAX_REPORT_MONTHS) return w;
  // Counted back from the LAST month the window touches, not from
  // `endExclusive` itself: a window ending 2026-03-10 touches March, so the
  // limit is March and the 119 months before it. Measuring from `endExclusive`
  // produced MAX_REPORT_MONTHS + 1 touched months whenever the end was
  // mid-month, which is the off-by-one this whole helper exists to close.
  const lastMonth = startOfUtcMonth(new Date(w.endExclusive.getTime() - 1));
  return {
    start: startOfUtcMonth(lastMonth, -(MAX_REPORT_MONTHS - 1)),
    endExclusive: w.endExclusive,
    requestedStart: w.start,
  };
}

/** `date` as the `yyyy-mm-dd` an `<input type="date">` speaks. */
function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Absolute `min` / `max` for the two Custom date inputs (rep-009).
 *
 * They carried only RELATIVE bounds (`max={customTo}` / `min={customFrom}`), so
 * nothing limited the absolute span — and `<input type="date">` accepts any year
 * up to 275760. The clamp above makes an absurd range harmless; this stops the
 * native picker offering one in the first place, which is the difference between
 * a narrowed report and a report the user never had to have narrowed.
 *
 * The ceiling is the end of NEXT year rather than today: recurring rules post
 * future-dated transactions, so a range that reaches ahead is legitimate.
 */
export function reportDateBounds(now: Date): { min: string; max: string } {
  return {
    // FounderFlow has no ledger older than this, and neither does any business
    // this product is for. It exists to make a mistyped year fail at the input.
    min: "2000-01-01",
    max: isoDay(utcMidnight(now.getUTCFullYear() + 1, 11, 31)),
  };
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
    // Clamped AFTER un-reversing, so the cap applies to the ordered pair and not
    // to whichever box happened to hold the older date (rep-009).
    return clampSpan({ start: startOfUtcDay(from), endExclusive: endOfUtcDayExclusive(to) });
  }

  if (mode === "all") {
    const earliest = transactions.reduce((min, t) => {
      const d = new Date(t.date);
      return d < min ? d : min;
    }, now);
    // Clamped too: the start comes from a stored row, and one mistyped or
    // corrupt date opens "all time" a millennium back.
    return clampSpan({ start: startOfUtcMonth(earliest), endExclusive: startOfUtcMonth(now, 1) });
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
  // Keyed by absolute UTC month, so a row is placed by arithmetic instead of by
  // re-filtering the ledger once per bucket (rep-009). The old shape was
  // O(months x transactions): with the 0001→9999 range the customer could type
  // and 5,000 rows per type, that measured 2.5 SECONDS of blocked main thread
  // before recharts drew a single bar.
  //
  // The key is `year * 12 + month`, NOT the display label: `formatUtcMonthYear`
  // is "MMM yy", which repeats every hundred years, so a label-keyed index would
  // fold 1926-03 into 2026-03.
  const byMonth: Record<number, MonthBucket> = {};
  let cursor = startOfUtcMonth(w.start);
  // Guard against a pathological window (endExclusive <= start): emit nothing
  // rather than loop. `reportWindow` clamps every window it builds, but
  // `monthBuckets` is exported and a caller can hand it anything.
  let guard = 0;
  while (cursor < w.endExclusive && guard < MAX_REPORT_MONTHS) {
    guard += 1;
    const bucket: MonthBucket = {
      month: formatUtcMonthYear(cursor),
      expenses: 0,
      investments: 0,
      revenue: 0,
      netFlow: 0,
    };
    out.push(bucket);
    byMonth[utcMonthIndex(cursor)] = bucket;
    cursor = startOfUtcMonth(cursor, 1);
  }

  // One pass. A row whose month has no bucket — outside the window, or an
  // unparseable date, whose index is NaN — is skipped, which is what the
  // per-bucket `inWindow` filter did implicitly.
  txns.forEach((t) => {
    const bucket = byMonth[utcMonthIndex(new Date(t.date))];
    if (!bucket) return;
    if (t.type === "expense") bucket.expenses += t.amount;
    else if (t.type === "investment") bucket.investments += t.amount;
    else if (t.type === "income") bucket.revenue += t.amount;
  });

  out.forEach((b) => {
    b.netFlow = b.investments + b.revenue - b.expenses;
  });
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
  /**
   * The workspace's cash balance from the server roll-up
   * (`getTransactionTotals().balance`), preferred over summing `all` (money-008).
   *
   * WHY IT IS NEEDED even though `all` is "the full ledger": `all` is
   * `getTransactions()`, a LIST window capped at `MAX_TRANSACTIONS_PER_TYPE`
   * (5,000 per type) whose own docstring ends "DO NOT SUM THE RESULT". Past the
   * ceiling, the row labelled "Cash balance (all time)" is the balance of the
   * most recent 5,000 rows per type — and a capped read drops the OLDEST rows,
   * which for a startup is the seed round. That is money-010's wrong number
   * arriving by a second route, in the one document a customer hands an investor.
   *
   * Only this row can come from an aggregate: every other figure here is scoped
   * by the client-side period picker, so it would need a per-window server round
   * trip. This one does not depend on the window at all. What the windowed rows
   * get instead is a disclosure — see `reportTruncation` below (RES-001).
   *
   * Optional ONLY so it could land ahead of the page.tsx change that supplies it;
   * tests/app/reports/reports-period.test.ts fails while /reports does not pass
   * it.
   */
  allTimeBalance?: number;
}): SummaryFigure[] {
  const { ranged, all, allTimeBalance } = args;
  return [
    { label: "Investments (in period)", amount: sumOfType(ranged, "investment") },
    { label: "Revenue (in period)", amount: sumOfType(ranged, "income") },
    { label: "Expenses (in period)", amount: sumOfType(ranged, "expense") },
    { label: "Net flow (in period)", amount: netOf(ranged) },
    // Last, and all-time: the row a reader will look for, positioned after the
    // flows so it cannot be mistaken for one of them.
    {
      label: "Cash balance (all time)",
      amount: allTimeBalance ?? netOf(all),
    },
  ];
}

/**
 * Rows the LEDGER holds, per type — `getTransactionTotals().byType[*].count`,
 * the uncapped aggregate that app/(app)/reports/page.tsx already fetches for the
 * all-time balance row. Not the ceiling constant, and not a flag: the comparison
 * below is between two numbers the page really has, so it stays correct if
 * `MAX_TRANSACTIONS_PER_TYPE` ever moves and it is silent for every workspace
 * under it (which today is all of them).
 */
export interface LedgerCounts {
  expense: number;
  income: number;
  investment: number;
}

export interface ReportTruncation {
  /** Ledger rows this page received, all three types. */
  shown: number;
  /** Ledger rows the workspace holds, all three types. */
  total: number;
  /** `total − shown` — the oldest rows, which this page never read. */
  hidden: number;
}

/** The three ledger types, as `Transaction.type` stores them and as
 *  `LedgerCounts` keys them. */
const LEDGER_TYPES: Transaction["type"][] = ["expense", "income", "investment"];

/**
 * Whether the read ceiling has cut rows that the SELECTED PERIOD could contain
 * — and if so, by how much (RES-001). `null` means "say nothing".
 *
 * WHY THIS PAGE NEEDS ITS OWN. `transactions` is `getTransactions()`, a LIST
 * window of at most `MAX_TRANSACTIONS_PER_TYPE` rows PER TYPE whose docstring
 * ends "DO NOT SUM THE RESULT" — and every figure here does exactly that:
 * `summaryFigures`' four in-period rows, `categoryData`, `contributorRows`,
 * `monthBuckets`, and both exporters mapping over all of them. Only the all-time
 * balance escaped, via `allTimeBalance` (money-008). The six sibling consumers
 * were moved onto unbounded roll-ups by transactions-ledger-001; these cannot
 * be, because the window is chosen in the BROWSER and an aggregate per window is
 * a server round trip per click. So the honest landing is that the page says so
 * — on screen and in both downloads — until that query exists. A page that
 * admits its window is short is correct; a page that understates a total a
 * customer emails to an investor is not, and this is the surface where a wrong
 * number travels furthest from anyone who could notice it.
 *
 * NOT `LedgerTruncationNotice` (components/transactions/ledger-truncation-notice.tsx):
 * that component ends "every figure above counts all N", which is true on the
 * three ledger clients, whose figures come from roll-ups, and FALSE here. A
 * false reassurance printed on this page is the finding, not the fix.
 *
 * WHY "COULD CONTAIN" RATHER THAN "IS SHORT". A ceiling drops the OLDEST rows,
 * so every dropped row of a type is dated on or before the oldest row of that
 * type the page DID receive. A period that opens after that day therefore cannot
 * be missing any of them, and announcing a shortfall there would be the
 * furniture the rep-009 clamp notice is careful to avoid (`requestedStart` is
 * set only when a span was really narrowed). Per type, because the ceiling is
 * per type: a full income window is not excused by an expense window with room
 * to spare.
 *
 * `shown` / `total` are all three types together, because the sentence they
 * feed describes THIS PAGE's coverage of the ledger. It does not claim to say
 * which of the period's figures is short, and deliberately: the page cannot
 * know that without the aggregate it does not have.
 */
export function reportTruncation(args: {
  transactions: Transaction[];
  counts?: LedgerCounts;
  window: ReportWindow;
}): ReportTruncation | null {
  const { transactions, counts, window: w } = args;
  // The prop is optional so the page renders before (and without) the roll-up.
  // A notice that guessed at a denominator would be worse than none.
  if (!counts) return null;

  let shown = 0;
  let total = 0;
  let reaches = false;
  LEDGER_TYPES.forEach((type) => {
    const rows = transactions.filter((t) => t.type === type);
    shown += rows.length;
    total += counts[type];
    if (counts[type] - rows.length <= 0) return;
    // `reduce` rather than a loop assigning an outer `let`: TypeScript narrows a
    // `number | null` initialised to `null` and does not track assignments made
    // inside a callback, so the comparison afterwards fails typecheck.
    const oldest = rows.reduce<number | null>((min, t) => {
      const at = new Date(t.date).getTime();
      // An unparseable stored date tells us nothing about where the dropped rows
      // sit, so it is skipped rather than treated as the oldest.
      if (Number.isNaN(at)) return min;
      return min === null || at < min ? at : min;
    }, null);
    // No rows of a type whose count is non-zero means the whole type was cut, so
    // there is no oldest row to reason from and every dropped row is a candidate.
    if (oldest === null || w.start.getTime() <= oldest) reaches = true;
  });

  const hidden = total - shown;
  // A roll-up read microseconds before a delete can come back SMALLER than the
  // row window, and "−3 oldest rows are missing" is a bug report, not a
  // disclosure. Same reasoning as `ledgerTruncation`.
  if (hidden <= 0 || !reaches) return null;
  return { shown, total, hidden };
}

/**
 * The one sentence that disclosure is made of, for the screen, the PDF and the
 * .xlsx — defined once for the reason `summaryFigures` is: money-010 existed
 * because the same figures were written in two exporters, so the mislabelled row
 * had to be fixed twice.
 *
 * It does not say the figures ARE wrong, because that is not known, and it does
 * not say they are fine, because that is the false reassurance this replaces.
 * It names the IN-PERIOD figures specifically: the "Cash balance (all time)"
 * row beside them is `allTimeBalance`, an unbounded aggregate (money-008), and
 * sweeping it in would understate what the reader can still trust. The last
 * sentence is the actionable part — the three ledger pages' totals come from
 * roll-ups with no ceiling and do count every row.
 *
 * `format` is passed in because number formatting is bound to the active locale
 * by `useNumberFormat`, which is a hook.
 */
export function truncationNote(
  truncation: ReportTruncation | null,
  format: (value: number) => string
): string | null {
  if (!truncation) return null;
  return (
    `Showing ${format(truncation.shown)} of this workspace's ${format(truncation.total)} transactions. ` +
    `The ${format(truncation.hidden)} oldest were not read, so every in-period figure, chart and ` +
    `export on this page can understate the selected period. The all-time cash balance, and the ` +
    `totals on Expenses, Revenue and Investments, count every row.`
  );
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
 * Zero-based index of the Description column in BOTH transaction tables. Named
 * rather than written as a literal because `columnStyles` in the PDF keys on it,
 * and a silently disagreeing number would widen the wrong column.
 */
export const TXN_DESCRIPTION_COL = 3;

/**
 * The Transaction History rows, for the PDF (rep-006).
 *
 * Extracted, and shared with `excelTransactionRows` below, because the two
 * adjacent download buttons on this page described the SAME ledger differently:
 * the PDF cut every description at 30 characters with an ellipsis while the
 * .xlsx from the button beside it wrote it in full. Descriptions validate up to
 * 500 characters (lib/schemas/transaction.ts), so "Cloud hosting renewal for the
 * analytics…" was a routine length, not an outlier — and the PDF is the artefact
 * the product sells as investor-ready, i.e. the one a customer can be held to.
 *
 * The truncation was never a layout necessity: jspdf-autotable wraps cell text
 * on its own, and `exportPDF` now gives this column an explicit `cellWidth` so
 * the wrap happens in the widest column instead of squeezing the amounts.
 *
 * `money` is passed in rather than imported: the formatter is bound to the
 * workspace currency by `useMoney`, which is a hook.
 */
export function pdfTransactionRows(
  txns: Transaction[],
  money: (amount: number) => string
): string[][] {
  return txns.map((t) => [
    // formatUtcDate, not date-fns `format`: Transaction.date is a date-only
    // value stored at UTC midnight, so the local renderer printed the day
    // BEFORE the one the customer typed, west of UTC.
    formatUtcDate(t.date),
    t.type,
    t.category,
    t.description,
    t.addedByName,
    `${t.type === "expense" ? "-" : "+"} ${money(t.amount)}`,
  ]);
}

/**
 * The same ledger for the Transactions sheet. Amounts stay NUMBERS (signed, so
 * the column can be summed in Excel) and the date is the sheet's day format.
 *
 * The free text is carried through verbatim, exactly as `pdfTransactionRows`
 * carries it, so the two download buttons describe the same ledger (rep-006).
 *
 * This used to route every string through `spreadsheetSafeRows` to
 * apostrophe-prefix anything leading with `=`, `+`, `-`, `@`, TAB or CR
 * (transactions-ledger-009). A59 removed that, because the premise was never
 * executed: `XLSX.utils.aoa_to_sheet` types such a cell `t: "s"` with no `f`,
 * and the bytes it writes carry no `<f>` element, so Excel has nothing to
 * evaluate and displays the text. The marker therefore prevented nothing, while
 * mangling ordinary accounting prose — `-` and `+` lead real descriptions, so
 * "-50% vendor credit" reached the spreadsheet as "'-50% vendor credit" and the
 * PDF printed it clean.
 *
 * tests/app/reports/export-formula-injection.test.ts now pins the measurement
 * itself, through a real write/read round trip and against the emitted XML, so
 * the suite goes red if a SheetJS upgrade or a change of export format ever
 * makes these cells live. `spreadsheetSafeRows` is kept, uncalled, as the guard
 * to wire in at that point and as the sanitiser a genuine CSV export will need.
 */
export function excelTransactionRows(txns: Transaction[]): (string | number)[][] {
  return txns.map((t) => [
    formatUtcDay(t.date),
    t.type,
    t.category,
    t.description,
    t.addedByName,
    t.type === "expense" ? -t.amount : t.amount,
  ]);
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
  /** `getTransactionTotals().balance` — the workspace's cash balance with no read
   *  ceiling. See `summaryFigures` for why the row needs it and why it is the
   *  only figure on this page that can come from an aggregate. */
  allTimeBalance?: number;
  /** `getTransactionTotals().byType[*].count` — the uncapped row count per type,
   *  so the page can tell the reader when the ledger holds rows it never read
   *  (RES-001). From the same roll-up as `allTimeBalance`: no extra query. */
  ledgerCounts?: LedgerCounts;
};

export function ReportsClient({
  transactions,
  users,
  company,
  allTimeBalance,
  ledgerCounts,
}: Props) {
  // rep-011: the currency comes from the `company` row the Server Component
  // already fetched, NOT from the store. `useMoney()` with no argument reads
  // `currentCompany.currency`, which is filled by a two-hop async chain
  // (providers.tsx → CompanyHydrator → getMyCompanyAction), and returned "PKR"
  // until both hops resolved. Export PDF is clickable for that whole window, so a
  // USD workspace's first paint after signup — or on a new device, or after
  // /settings' "Reset local preferences" — produced an investor PDF denominated
  // in rupees beside an .xlsx whose header said USD. The prop is authoritative
  // and available on the first paint; see lib/hooks/useMoney.ts.
  const money = useMoney(company.currency);
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
  /** Absolute floor/ceiling for the two Custom inputs (rep-009). The relative
   *  `min`/`max` they already carried bound the two dates to each other and left
   *  the absolute span unbounded. */
  const dateBounds = useMemo(() => reportDateBounds(new Date()), []);
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

  // The Financial Summary, defined once (money-010).
  //
  // `transactions` is NOT the full ledger, and believing it was is precisely
  // money-008: getTransactions() returns a per-type window (5,000 rows each), so
  // netting it gave the balance of the most recent rows and silently omitted the
  // seed investment from an investor-facing export. The all-time balance
  // therefore DOES need its own query — `allTimeBalance`, from
  // getTransactionTotals() in app/(app)/reports/page.tsx. The `?? netOf(all)`
  // fallback in summaryFigures is a safety net for a caller that forgets it, not
  // a second supported mode.
  const summary = useMemo(
    () => summaryFigures({ ranged: rangedTxns, all: transactions, allTimeBalance }),
    [rangedTxns, transactions, allTimeBalance]
  );

  // RES-001. Everything above this line — the summary, the charts, the category
  // mix, the founder breakdown — is reduced from `transactions`, which is a
  // per-type LIST WINDOW and not the ledger. When the rows it dropped could fall
  // inside the selected period, the page has to say so; see `reportTruncation`
  // for why that is per type and why it is not simply "always".
  const truncation = useMemo(
    () => reportTruncation({ transactions, counts: ledgerCounts, window: range }),
    [transactions, ledgerCounts, range]
  );
  /** One sentence for the screen AND both exports — the download is where an
   *  understated figure travels furthest from anyone who could notice it. */
  const coverageNote = truncationNote(truncation, n.number);

  const totalExpenses = rangedTxns
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);
  // `totalInvestments` used to live here too, for the "% of capital" column. That
  // column now comes from `contributorRows` (rep-004), which computes the
  // denominator itself, so the local copy was left unreferenced — a figure-shaped
  // dead binding is exactly what a later edit re-wires by mistake.

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
          // RES-001, for the same reason and in the same place: the reader of
          // this document is not the person who generated it, so a notice left
          // on the screen never reaches them.
          ...(coverageNote ? [["Ledger coverage", coverageNote]] : []),
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
        body: pdfTransactionRows(rangedTxns, money),
        theme: "striped",
        headStyles: { fillColor: [77, 124, 15] },
        styles: { fontSize: 8 },
        columnStyles: {
          // rep-006. The description is no longer cut at 30 characters, so it
          // needs room to WRAP instead of stealing width from the amount:
          // autoTable distributes leftover width across unstyled columns, and a
          // 500-character cell left to itself squeezes the figures. `cellWidth`
          // fixes the widest column and lets autoTable wrap inside it.
          [TXN_DESCRIPTION_COL]: { cellWidth: 60 },
          5: { halign: "right" },
        },
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
        // RES-001 — the same disclosure as the PDF, from the same sentence.
        ...(coverageNote ? [["Ledger coverage", coverageNote]] : []),
        ...summary.map((f) => [f.label, f.amount]),
        ["Transactions", rangedTxns.length],
      ];

      const txnData: (string | number)[][] = [
        ["Date", "Type", "Category", "Description", "Added By", `Amount (${company.currency})`],
        ...excelTransactionRows(rangedTxns),
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

      // A59: customer text goes into these four sheets verbatim, including
      // `company.name` here, a contributor's name and email in Team, and
      // `description` / `addedByName` in Transactions. None of it is marked or
      // escaped, because `aoa_to_sheet` writes a JS string as an inline string —
      // `t: "s"`, no `f`, no `<f>` element in the bytes — so none of it is
      // evaluated when the workbook is opened. That is MEASURED, not assumed:
      // tests/app/reports/export-formula-injection.test.ts round-trips the
      // payload class through a real write and read, and also pins the two
      // things that measurement depends on — that the file written below stays a
      // `.xlsx` (SheetJS picks its writer from the extension, and a `.csv` IS
      // evaluated), and that every sheet is built with `aoa_to_sheet`. If either
      // changes, wire `spreadsheetSafeRows` from lib/reports/spreadsheet-safe.ts
      // in here; it exists and is tested for exactly that day.
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
                min={dateBounds.min}
                max={customTo || dateBounds.max}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs text-fg focus:border-primary/50 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-fg-muted">
              <span className="font-mono uppercase tracking-wider">To</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || dateBounds.min}
                max={dateBounds.max}
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

      {/* rep-009. The clamp has to SAY SO. Silently redrawing a narrower range is
          how the 600-bucket guard came to chart the first fifty years AD without
          anyone noticing — a wrong chart that looks like a right one, on the page
          the founder is about to export from. `requestedStart` is set only when
          the span was actually narrowed, so this never announces a clamp that did
          not happen. */}
      {range.requestedStart && (
        <p role="status" className="text-xs text-warning">
          That range covers more than {MAX_REPORT_MONTHS / 12} years, which this report cannot
          chart. Showing the most recent {MAX_REPORT_MONTHS} months instead:{" "}
          <span className="font-mono">{rangeText}</span>.
        </p>
      )}

      {/* RES-001. The read ceiling is the other thing this page can silently
          narrow, and the one that reaches an investor: every figure below is
          reduced from a per-type LIST WINDOW, and the rows it drops are the
          oldest. Rendered from the same sentence both exporters write, and
          present only when the dropped rows could fall inside the selected
          period — see `reportTruncation`. */}
      {coverageNote && (
        <p
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.08] px-4 py-3 text-xs text-fg-muted"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>{coverageNote}</span>
        </p>
      )}

      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
              Cash flow
            </p>
            <h3 className="mt-1 text-lg font-bold tracking-tight">Money in vs out</h3>
          </div>
          <div className="flex gap-4 text-xs">
            <Legend dot={CHART_SERIES.investments} label="Investments" />
            <Legend dot={CHART_SERIES.revenue} label="Revenue" />
            <Legend dot={CHART_SERIES.expenses} label="Expenses" />
          </div>
        </div>
        <div className="h-80">
          <CashFlowBarChart data={monthlyData} currency={company.currency} />
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
                <CategoriesPieChart data={categoryData} currency={company.currency} />
              </div>
              <ul className="space-y-2">
                {categoryData.map((c, i) => {
                  // 0–1 ratio — the scale `n.percent` takes. See lib/format.ts.
                  //
                  // The `> 0` guard is money-012, not habit. This list renders for
                  // any category that has an expense ROW, whatever that row is
                  // worth, so one expense stored as 0.00 (the amount column is
                  // Decimal(12,2) with no check constraint, and rows predating
                  // money-002's scale rule still hold that value) makes
                  // `totalExpenses` 0 as well. 0/0 is NaN, and Intl's percent
                  // style formats NaN as the literal "NaN%" — on the page a
                  // customer exports to investors. Same shape as the three
                  // sibling shares: revenue-client.tsx, investments-client.tsx
                  // and `contributorRows` above.
                  const ratio = totalExpenses > 0 ? c.value / totalExpenses : 0;
                  return (
                    <li key={c.name} className="flex items-center justify-between text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: categoricalAt(i) }}
                          aria-hidden="true"
                        />
                        <span className="truncate text-fg">{c.name}</span>
                      </div>
                      <div className="ms-2 shrink-0 text-end">
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
            <FoundersHorizontalBar data={founderData} currency={company.currency} />
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
                  className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Member
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-start font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Role
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-end font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Investments
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-end font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
                >
                  Expenses
                </th>
                <th
                  scope="col"
                  className="px-6 py-3.5 text-end font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
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
                  <td className="px-6 py-4 text-end">
                    <span className="font-mono text-sm font-bold tabular-nums text-primary-strong">
                      {money(r.investments)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-end">
                    <span className="font-mono text-sm font-bold tabular-nums text-mint-strong">
                      {money(r.expenses)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-end">
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
