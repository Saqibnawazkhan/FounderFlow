"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { TaskStatusCounts } from "@/lib/queries/tasks";
// TYPE-ONLY import, so none of lib/queries' server graph (db, Sentry, the
// scoped-session read) is pulled into the client bundle — the same shape as the
// TaskStatusCounts line above.
import type { MonthTotals, TransactionTotals, UserContribution } from "@/lib/queries/transactions";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  ClipboardList,
  Coins,
  Flame,
  Rocket,
  Timer,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Activity, Task, Transaction, User } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMoney } from "@/lib/hooks/useMoney";
import { useDateFormat, useNumberFormat } from "@/lib/i18n/use-t";
// Only the deadline predicates come from date-fns now. Month bucketing lives in
// lib/date-range.ts: every date-fns month helper works in the LOCAL calendar,
// and `Transaction.date` is a date-only value stored at UTC midnight, so a local
// boundary filed a row dated the 1st under the previous month for every viewer
// west of UTC while /budgets counted it in the current one (money-007).
import { isDeadlineOverdue } from "@/lib/tasks/deadline";
import { isInUtcMonth, utcMonthShortLabel, utcMonthWindow } from "@/lib/date-range";
// From a plain module, NOT re-exported from here: page.tsx is a Server
// Component and needs the same number. An export from this file would reach it
// as a client-reference proxy ({}) rather than a number, which is exactly how
// the dashboard crashed. See ./windows.ts for the full account.
import { CASH_FLOW_MONTHS } from "./windows";
// Burn, runway and the pace comparison are SHARED with the chat runway card
// (lib/actions/chat.ts). One copy, or the two surfaces quote different runways
// for the same workspace on the same afternoon — money-017.
import {
  averageMonthlyBurn,
  burnPaceDeltaPct,
  burnWindowStart,
  runwayMonths,
} from "@/lib/finance/runway";
import { Avatar } from "@/components/ui/avatar";
import { DashboardStat, type DashboardStatProps } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AnnouncementBanner } from "./announcement-banner";
import { CHART_SERIES, categoricalAt } from "@/lib/colors/categorical";

// Recharts is ~200KB. Lazy it so the dashboard's initial bundle stays lean;
// the chart skeleton from Phase 2 doubles as the loading placeholder.
// NOTE: don't import named constants from dashboard-charts at top level —
// that pulls the whole module (and recharts) into the initial chunk and
// defeats the split. Inline the palette here instead.
const CashFlowChart = dynamic(
  () => import("./dashboard-charts").then((m) => ({ default: m.CashFlowChart })),
  { ssr: false, loading: () => <Skeleton className="h-full w-full rounded-xl" /> }
);
const CategoryPieChart = dynamic(
  () => import("./dashboard-charts").then((m) => ({ default: m.CategoryPieChart })),
  { ssr: false, loading: () => <Skeleton className="h-full w-full rounded-xl" /> }
);

/**
 * Chart colours — from lib/colors/categorical.ts, the SAME module
 * dashboard-charts.tsx reads, so the legend dots below cannot disagree with the
 * marks they label.
 *
 * They used to be a byte-for-byte copy of that file's palette, pasted here
 * because importing a named constant out of dashboard-charts.tsx would pull
 * recharts into the initial chunk and defeat the next/dynamic split above. The
 * shared module has no recharts dependency, so the split survives and the copy
 * is gone. Two live consequences of the copy: the legend's six colours could
 * not cover ten `EXPENSE_CATEGORIES` (so the 7th category's dot repeated the
 * 1st's), and being fixed hex, these dots stayed light-theme green on a
 * charcoal card while nothing marked them as wrong.
 */

/* ─────────────────────────────────────────────────────────────────────────── *
 * The dashboard's money figures, as pure functions over EITHER an aggregate or
 * the row array (money-008).
 *
 * WHAT WAS WRONG. Every figure below was `transactions.filter(…).reduce(…)` over
 * the prop. That prop is `getTransactions()`, a windowed LIST read capped at
 * `MAX_TRANSACTIONS_PER_TYPE` (5,000 per type) whose own docstring ends "DO NOT
 * SUM THE RESULT". Past the ceiling the Balance card, the runway, the cash-flow
 * chart, the category pie and the per-founder bars all silently shrink — and
 * because a capped read drops the OLDEST rows, the first figure to go wrong is
 * the seed investment: the founder whose capital started the company is the one
 * whose contribution disappears as the workspace grows. This is the same defect
 * the task KPI below already had (`tasks.length` over a 300-row window, fixed in
 * 19bd7e7 by reading `getTaskStatusCounts()`), and the same one /reports' "Net
 * Balance" had (money-010).
 *
 * WHY EACH TAKES AN OPTIONAL ROLL-UP. The aggregates are server-side
 * (lib/queries/transactions.ts) so only app/(app)/dashboard/page.tsx can fetch
 * them. Until it does, the array path keeps the page exactly as correct as it is
 * today rather than half-wiring it; once it does, no figure here can be short by
 * a dropped row. The fallback is a shim, not the destination —
 * tests/app/money-rollups.test.ts asserts the page passes `rollups` and fails
 * while it does not, because a roll-up with no caller fixes nothing and this repo
 * has shipped that exact non-fix six times.
 *
 * All of them are exported and pure so the preference is testable without
 * rendering React, the way reports-client.tsx already does it.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The server-side aggregates /dashboard needs, in one prop.
 *
 * One object rather than five props deliberately: the figures have to come from
 * the same instant, and a page that can forget one of five props will.
 */
export interface DashboardRollups {
  /** `getTransactionTotals()` — whole-ledger sums + counts per type. */
  totals: TransactionTotals;
  /** `getMonthToDateExpense()` — expense total for the current UTC month. */
  monthToDateExpense: number;
  /** Expense total over the rolling burn window:
   *  `getTransactionTotals({ from: burnWindowStart(now) })`. */
  burnWindowExpense: number;
  /** `getLedgerStart()` — the earliest ledger row's date, ISO, or null on an
   *  empty ledger. The DIVISOR behind burn: the window's spend is averaged over
   *  the months the ledger actually covers, not over a constant 3 (money-017). */
  ledgerStartsAt: string | null;
  /** `getMonthlyTotals(CASH_FLOW_MONTHS)` — oldest bucket first. */
  monthly: MonthTotals[];
  /** `getExpenseTotalsByCategory()` — biggest first. */
  categories: { category: string; amount: number }[];
  /** `getContributionTotalsByUser()` — keyed by `Transaction.addedBy`. */
  contributions: Record<string, UserContribution>;
}

/** Slices the pie stays readable at. */
const MAX_PIE_SLICES = 6;

function sumOfType(txns: Transaction[], type: Transaction["type"]): number {
  return txns.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
}

export interface LedgerTotals {
  investments: number;
  revenue: number;
  expenses: number;
  /** Cash in (founder capital + earned revenue) − cash out. The same formula
   *  /reports' "Cash balance (all time)" row uses, so the two cannot drift. */
  balance: number;
  /**
   * How many expense ROWS the ledger holds — the "N transactions" caption under
   * the Total spend card (transactions-ledger-001).
   *
   * It was `transactions.filter(…).length` inline in the card, i.e. a count of
   * the 5,000-row-per-type window sitting under a figure that already came from
   * an uncapped aggregate. /expenses had already moved the identical caption
   * onto `expenseHeadline().count`, so past the ceiling the two surfaces printed
   * different row counts for the same ledger with the same money above them.
   */
  expenseCount: number;
}

export function ledgerTotals(
  transactions: Transaction[],
  rollups?: DashboardRollups
): LedgerTotals {
  if (rollups) {
    const { byType, balance } = rollups.totals;
    return {
      investments: byType.investment.total,
      revenue: byType.income.total,
      expenses: byType.expense.total,
      balance,
      expenseCount: byType.expense.count,
    };
  }
  const investments = sumOfType(transactions, "investment");
  const revenue = sumOfType(transactions, "income");
  const expenses = sumOfType(transactions, "expense");
  return {
    investments,
    revenue,
    expenses,
    balance: investments + revenue - expenses,
    expenseCount: transactions.filter((t) => t.type === "expense").length,
  };
}

/**
 * This month's spend, in the UTC calendar month.
 *
 * `isInUtcMonth` is the SAME boundary lib/queries/budgets.ts, lib/budgets/check.ts
 * and /expenses use, which is the point: this card and the budget cap a row
 * consumes agree about which month that row is in (money-007). The roll-up's own
 * window is built from `startOfUtcMonth`, so both paths mean one thing.
 */
export function monthToDateExpense(
  transactions: Transaction[],
  now: Date,
  rollups?: DashboardRollups
): number {
  if (rollups) return rollups.monthToDateExpense;
  return transactions
    .filter((t) => t.type === "expense" && isInUtcMonth(t.date, now))
    .reduce((s, t) => s + t.amount, 0);
}

/**
 * Spend over the rolling burn window.
 *
 * A ROLLING window, not the last N complete calendar months: a complete-months
 * window would exclude the current month's spend entirely, which for a workspace
 * in its first month means a burn of zero and an infinite runway.
 * `burnWindowStart` pins the edge to UTC midnight so the window does not shift
 * with the hour of day the dashboard happens to be opened.
 *
 * This is the NUMERATOR only. What it is divided by lives in
 * lib/finance/runway.ts (`averageMonthlyBurn`), because a workspace younger than
 * the window has fewer than `BURN_WINDOW_MONTHS` months to average over —
 * money-017.
 */
export function burnWindowExpense(
  transactions: Transaction[],
  now: Date,
  rollups?: DashboardRollups
): number {
  if (rollups) return rollups.burnWindowExpense;
  const cutoff = burnWindowStart(now);
  return transactions
    .filter((t) => t.type === "expense" && new Date(t.date) >= cutoff)
    .reduce((s, t) => s + t.amount, 0);
}

/**
 * When this workspace's ledger starts — the divisor behind burn (money-017).
 *
 * Prefers the roll-up's `_min(date)` aggregate. The array fallback is the
 * weakest of the fallbacks in this file and says so: `getTransactions()` is
 * capped at 5,000 rows per type and the rows a ceiling drops are the OLDEST, so
 * past the ceiling the earliest row the page can see is NOT the earliest row that
 * exists. That errs towards less history, so a smaller divisor, so a HIGHER burn
 * and a LOWER runway — the safe direction, and the reason it is tolerable until
 * the aggregate arrives.
 */
export function ledgerStart(
  transactions: Transaction[],
  rollups?: DashboardRollups
): string | null {
  if (rollups) return rollups.ledgerStartsAt;
  // Compared as instants, not as strings: an unparseable row must be skipped
  // rather than win a lexicographic sort and silently become the ledger's start.
  let earliest: string | null = null;
  let earliestAt = Infinity;
  for (let i = 0; i < transactions.length; i++) {
    const at = new Date(transactions[i].date).getTime();
    if (!Number.isNaN(at) && at < earliestAt) {
      earliestAt = at;
      earliest = transactions[i].date;
    }
  }
  return earliest;
}

export interface CashFlowBucket {
  month: string;
  expenses: number;
  investments: number;
  revenue: number;
}

/**
 * Six UTC month buckets, oldest first, that abut exactly — `[start,
 * endExclusive)` per month, so no row lands in two buckets or in none.
 *
 * The label is `utcMonthShortLabel`, never `format(monthStart, "MMM")`: the
 * latter renders a UTC-midnight Date in the viewer's zone and prints "Sep" for
 * the October bucket west of UTC — the same off-by-one as money-007, moved from
 * the sum into the axis label. `getMonthlyTotals` labels its buckets with the
 * same helper, so the two paths produce the same axis.
 */
export function cashFlowSeries(
  transactions: Transaction[],
  now: Date,
  rollups?: DashboardRollups
): CashFlowBucket[] {
  if (rollups) {
    return rollups.monthly.map((b) => ({
      month: b.month,
      expenses: b.expense,
      investments: b.investment,
      revenue: b.income,
    }));
  }
  return Array.from({ length: CASH_FLOW_MONTHS }).map((_, i) => {
    // i - (CASH_FLOW_MONTHS - 1) walks oldest→newest; `utcMonthWindow`
    // normalises the year rollover.
    const { start: monthStart, endExclusive } = utcMonthWindow(now, i - (CASH_FLOW_MONTHS - 1));
    const monthTxns = transactions.filter((t) => {
      const d = new Date(t.date);
      return d >= monthStart && d < endExclusive;
    });
    return {
      month: utcMonthShortLabel(monthStart),
      expenses: sumOfType(monthTxns, "expense"),
      investments: sumOfType(monthTxns, "investment"),
      revenue: sumOfType(monthTxns, "income"),
    };
  });
}

/** Expense spend per category for the pie, biggest first, capped at
 *  `MAX_PIE_SLICES`. The roll-up already orders its rows; re-sorting keeps the
 *  function total rather than dependent on a caller's ordering. */
export function expenseCategorySlices(
  transactions: Transaction[],
  rollups?: DashboardRollups
): { name: string; value: number }[] {
  let rows: { category: string; amount: number }[];
  if (rollups) {
    rows = rollups.categories.slice();
  } else {
    const m = new Map<string, number>();
    transactions
      .filter((t) => t.type === "expense")
      .forEach((t) => m.set(t.category, (m.get(t.category) || 0) + t.amount));
    // Array.from, not a spread: tsconfig sets no `target`, so it defaults to ES5
    // and spreading a Map fails `npm run typecheck` while passing vitest.
    rows = Array.from(m.entries()).map(([category, amount]) => ({ category, amount }));
  }
  return rows
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_PIE_SLICES)
    .map((r) => ({ name: r.category, value: r.amount }));
}

/**
 * Capital contributed per person, biggest first, zero-contributors omitted.
 *
 * This is money-008 at its sharpest and the reason the roll-up exists: over the
 * capped array the founder whose seed round opened the company is exactly the
 * person whose bar vanishes, because the rows a ceiling drops are the oldest.
 * Keyed by `Transaction.addedBy` (who RECORDED the row), matching what the card
 * has always displayed.
 */
export function founderContributionRows(
  users: User[],
  transactions: Transaction[],
  rollups?: DashboardRollups
): { name: string; amount: number; role: string }[] {
  const investedBy = (id: string): number =>
    rollups
      ? (rollups.contributions[id]?.investment ?? 0)
      : transactions
          .filter((t) => t.addedBy === id && t.type === "investment")
          .reduce((s, t) => s + t.amount, 0);
  return users
    .map((u) => ({ name: u.name, amount: investedBy(u.id), role: u.role as string }))
    .filter((f) => f.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

type Props = {
  transactions: Transaction[];
  tasks: Task[];
  taskCounts: TaskStatusCounts;
  activities: Activity[];
  users: User[];
  clockedIn: { count: number; peers: { userId: string; userName: string }[] };
  currentUserId: string;
  currentUserName: string;
  /** Server-side aggregates. Optional ONLY so this could land ahead of the
   *  page.tsx change that supplies it (see DashboardRollups); every money figure
   *  on this page is short by whatever the 5,000-row-per-type list read dropped
   *  until it is passed. tests/app/money-rollups.test.ts fails while it is
   *  absent. */
  rollups?: DashboardRollups;
};

export function DashboardClient({
  transactions,
  tasks,
  taskCounts,
  activities,
  users,
  clockedIn,
  currentUserId,
  currentUserName,
  rollups,
}: Props) {
  const money = useMoney();
  const n = useNumberFormat();
  const d = useDateFormat();

  // EVERY money figure below goes through the pure functions above, which prefer
  // the server-side aggregate and fall back to the row array (money-008). The
  // array is `getTransactions()`, a 5,000-row-per-type LIST window whose own
  // docstring says not to sum it — so `transactions.filter(…).reduce(…)` here
  // was the same defect as the task KPI four lines down.
  //
  // One `new Date()` per render, shared by every window below: re-reading the
  // clock per figure could, across a month boundary, put the This-month card and
  // the cash-flow chart in different months.
  const now = useMemo(() => new Date(), []);

  const {
    investments: totalInvestments,
    expenses: totalExpenses,
    balance,
    expenseCount,
  } = useMemo(() => ledgerTotals(transactions, rollups), [transactions, rollups]);
  // From the count query, not from `tasks`: that array is a 300-row window
  // (perf-002), so filtering it under-reports the KPI in a busy workspace.
  const pendingTasks = taskCounts.open;
  const completedTasks = taskCounts.completed;

  // The window's spend over the months the LEDGER actually covers, capped at the
  // window and floored at one month — not over a constant 3, which averaged a
  // young workspace's money across months in which it did not yet exist and
  // overstated its runway roughly threefold (money-017). The arithmetic is shared
  // with the chat runway card so the two surfaces cannot quote different numbers.
  // The earliest ledger row. Read twice: it is the burn divisor, and it is also
  // what decides whether a "vs avg pace" comparison exists at all.
  const ledgerStartsAt = useMemo(() => ledgerStart(transactions, rollups), [transactions, rollups]);
  const monthlyBurn = useMemo(
    () => averageMonthlyBurn(burnWindowExpense(transactions, now, rollups), ledgerStartsAt, now),
    [transactions, now, rollups, ledgerStartsAt]
  );
  // `null`, not Infinity: "no burn recorded". Same spelling the card uses.
  const runway = runwayMonths(balance, monthlyBurn);

  // This-month spend + how it compares to the average burn — a far more
  // frequently-checked number than all-time capital raised.
  const currentMonthSpend = useMemo(
    () => monthToDateExpense(transactions, now, rollups),
    [transactions, now, rollups]
  );
  // Month-to-date against the SAME FRACTION of an average month. Against a whole
  // month it was structurally negative for three weeks out of four: on the 3rd a
  // workspace spending its normal amount read "-90% vs avg" and one spending at
  // twice its normal pace read "-3%" (money-017).
  //
  // `null` — the "spent this month" branch below — while the ledger is under a
  // month old. There the burn divisor is clamped to one month, so the "average"
  // IS this month's own total and the comparison read +107% on the 15th (+933% on
  // the 3rd) for every such workspace alike, whatever it had spent
  // (R2-money-017-pace).
  const burnPaceDelta = burnPaceDeltaPct(currentMonthSpend, monthlyBurn, ledgerStartsAt, now);

  const monthlyData = useMemo(
    () => cashFlowSeries(transactions, now, rollups),
    [transactions, now, rollups]
  );

  const founderContributions = useMemo(
    () => founderContributionRows(users, transactions, rollups),
    [users, transactions, rollups]
  );

  const categoryData = useMemo(
    () => expenseCategorySlices(transactions, rollups),
    [transactions, rollups]
  );

  const recentActivities = activities.slice(0, 6);

  // #2: surface the CURRENT user's own open tasks (overdue first) rather than
  // the whole company backlog, so the dashboard shows what this person owns.
  const myOpenTasks = useMemo(
    () => tasks.filter((t) => t.assignedTo === currentUserId && t.status !== "completed"),
    [tasks, currentUserId]
  );
  const myOpenCount = myOpenTasks.length;
  // THE FIFTH CLIENT SURFACE, and for a while the only one still wrong.
  //
  // tasks-and-comments-011 moved four surfaces onto `lib/tasks/deadline.ts`,
  // which reads a deadline's calendar day from UTC parts because that is how the
  // day is stored. This one kept `isPast(new Date(...)) && !isToday(...)`, which
  // reads the instant in the VIEWER's zone: at UTC-5 a legacy midnight-UTC row due
  // today is "past and not today", so the dashboard said "1 overdue" while /tasks
  // said nothing was. Before that wave the two agreed and were both wrong;
  // afterwards they disagreed, which is worse — a customer cannot tell which
  // screen to believe, and the stat chip turns red to insist on the wrong one.
  const myOverdueCount = useMemo(
    () => myOpenTasks.filter((t) => t.deadline && isDeadlineOverdue(t.deadline)).length,
    [myOpenTasks]
  );
  const stats: DashboardStatProps[] = [
    {
      label: "Balance",
      value: money(balance),
      icon: Wallet,
      tone: "primary",
      delta: balance >= 0 ? "positive" : "negative",
      deltaLabel:
        runway === null
          ? "No burn recorded"
          : // min == max reproduces `toFixed(1)`: one decimal always, so the
            // card's width doesn't twitch between "8 mo" and "8.4 mo".
            `${n.number(runway, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })} mo runway`,
    },
    {
      label: "This month",
      value: money(currentMonthSpend),
      icon: Flame,
      tone: "forest",
      delta: "neutral",
      deltaLabel:
        burnPaceDelta !== null
          ? // "vs avg pace", not "vs avg": the comparison is against the part of
            // an average month that has elapsed, which is what makes it readable
            // on the 3rd. Intl signs negatives itself; the explicit "+" is the
            // product's own gain marker, which `signDisplay` cannot reach.
            `${burnPaceDelta >= 0 ? "+" : ""}${n.percent(burnPaceDelta / 100, {
              maximumFractionDigits: 0,
            })} vs avg pace`
          : "spent this month",
    },
    {
      label: "Total spend",
      value: money(totalExpenses),
      icon: TrendingDown,
      tone: "mint",
      delta: "neutral",
      // From the roll-up's own count, like the figure above it: a caption that
      // counted the row window read 5,000 under a correct 6,000-row total, and
      // disagreed with the same caption on /expenses (transactions-ledger-001).
      deltaLabel: `${n.number(expenseCount)} transactions`,
    },
    {
      label: "Open tasks",
      value: n.number(pendingTasks),
      icon: CheckCircle2,
      tone: "primary",
      delta: pendingTasks === 0 ? "positive" : "neutral",
      deltaLabel: `${n.number(completedTasks)} shipped · ${n.number(taskCounts.total)} total`,
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      {/* One-time product announcement. Renders nothing at all until hydration
          has read this browser's dismissal flag, so it contributes nothing to
          the server HTML — see ./announcement-banner.tsx for why that matters
          here specifically. Above the header on purpose: it is the first thing
          on the page or it is not an announcement. */}
      <AnnouncementBanner />

      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge>Live workspace</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Welcome back,{" "}
            <span className="text-primary-strong">{currentUserName.split(" ")[0]}</span>.
          </h1>
          <p className="mt-2 text-pretty text-sm text-fg-muted md:text-base">
            Here&apos;s how your startup is doing today.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/expenses"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
          >
            <TrendingDown className="h-4 w-4" aria-hidden="true" /> Log expense
          </Link>
          <Link
            href="/revenue"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
          >
            <Coins className="h-4 w-4 text-primary-strong" aria-hidden="true" /> Log revenue
          </Link>
          <Link
            href="/investments"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
          >
            <TrendingUp className="h-4 w-4" aria-hidden="true" /> Add investment
          </Link>
        </div>
      </header>

      <GettingStarted transactions={transactions} tasks={tasks} users={users} />

      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <DashboardStat key={s.label} {...s} valueClassName="text-xl sm:text-3xl" />
        ))}
      </section>

      {/* #1/#2 Team pulse — people, time on the clock, and your own workload,
          each a one-tap shortcut into the relevant page. */}
      <section aria-label="Team pulse" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <PulseCard
          href="/time?scope=team"
          icon={Timer}
          value={n.number(clockedIn.count)}
          label="Clocked in now"
          live={clockedIn.count > 0}
          sub={
            clockedIn.count > 0
              ? clockedIn.peers
                  .slice(0, 3)
                  .map((p) => p.userName.split(" ")[0])
                  .join(", ") +
                (clockedIn.count > 3 ? ` +${n.number(clockedIn.count - 3)} more` : "")
              : "Nobody on the clock"
          }
        />
        <PulseCard
          href="/team"
          icon={Users}
          value={n.number(users.length)}
          label="Team members"
          sub={
            founderContributions.length > 0
              ? `${n.number(founderContributions.length)} contributing capital`
              : "Invite your co-founders"
          }
        />
        <PulseCard
          href="/tasks"
          icon={ClipboardList}
          value={n.number(myOpenCount)}
          label="Open tasks"
          alert={myOverdueCount > 0}
          sub={myOverdueCount > 0 ? `${n.number(myOverdueCount)} overdue` : "Nothing overdue"}
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface p-6 lg:col-span-2">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
                Cash flow
              </p>
              <h3 className="mt-1 text-lg font-bold tracking-tight">Last 6 months</h3>
            </div>
            <div className="flex gap-4 text-xs">
              <Legend dot={CHART_SERIES.investments} label="Investments" />
              <Legend dot={CHART_SERIES.revenue} label="Revenue" />
              <Legend dot={CHART_SERIES.expenses} label="Expenses" />
            </div>
          </div>
          <div className="h-72">
            <CashFlowChart data={monthlyData} />
          </div>
          {/* SR-only data table — gives screen readers the numbers Recharts hides. */}
          <table className="sr-only">
            <caption>Cash flow by month: investments vs expenses</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Investments</th>
                <th scope="col">Revenue</th>
                <th scope="col">Expenses</th>
              </tr>
            </thead>
            <tbody>
              {monthlyData.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{money(m.investments)}</td>
                  <td>{money(m.revenue)}</td>
                  <td>{money(m.expenses)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            Spend mix
          </p>
          <h3 className="mt-1 text-lg font-bold tracking-tight">By category</h3>
          {categoryData.length > 0 ? (
            <>
              <div className="mt-4 h-44">
                <CategoryPieChart data={categoryData} />
              </div>
              <ul className="mt-4 space-y-2">
                {categoryData.slice(0, 4).map((c, i) => (
                  <li key={c.name} className="flex items-center justify-between text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: categoricalAt(i) }}
                      />
                      <span className="truncate text-fg-muted">{c.name}</span>
                    </div>
                    <span className="font-mono font-semibold tabular-nums text-fg">
                      {money(c.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-12 text-center text-sm text-fg-muted">No expenses yet</p>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
                Cap table
              </p>
              <h3 className="mt-1 text-lg font-bold tracking-tight">Founder contributions</h3>
            </div>
            <Users className="h-4 w-4 text-fg-muted" aria-hidden="true" />
          </div>
          <div className="space-y-4">
            {founderContributions.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-muted">No investments yet</p>
            ) : (
              founderContributions.slice(0, 5).map((f) => {
                const pct = totalInvestments > 0 ? (f.amount / totalInvestments) * 100 : 0;
                return (
                  <div key={f.name} className="space-y-2">
                    <div className="flex items-center gap-3">
                      <Avatar name={f.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{f.name}</p>
                      </div>
                      <p className="font-mono text-sm font-bold tabular-nums">{money(f.amount)}</p>
                    </div>
                    <div className="ms-10 h-1.5 overflow-hidden rounded-full bg-glass/[0.06]">
                      <div
                        className="h-full rounded-full bg-primary transition-[width] duration-700"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
                Live feed
              </p>
              <h3 className="mt-1 text-lg font-bold tracking-tight">Recent activity</h3>
            </div>
            <Link
              href="/activities"
              className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest text-primary-strong hover:underline"
            >
              View all <ArrowRight className="h-3 w-3 rtl:rotate-180" aria-hidden="true" />
            </Link>
          </div>
          <div className="space-y-4">
            {recentActivities.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-muted">No activity yet</p>
            ) : (
              recentActivities.map((activity) => (
                <div key={activity.id} className="flex items-start gap-3">
                  <Avatar name={activity.userName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug text-fg">{activity.message}</p>
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                      {d.relative(activity.createdAt)}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
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

/**
 * PulseCard — a compact, clickable dashboard shortcut (clocked-in count, team
 * size, your open tasks). `live` shows a pulsing dot (someone's on the clock);
 * `alert` recolors the icon chip red (you have overdue work).
 */
function PulseCard({
  href,
  icon: Icon,
  value,
  label,
  sub,
  live,
  alert,
}: {
  href: string;
  icon: LucideIcon;
  value: number | string;
  label: string;
  sub?: string;
  live?: boolean;
  alert?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-primary/30 hover:bg-surface-hover"
    >
      <span
        className={cn(
          "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
          alert ? "bg-danger/15 text-danger-strong" : "bg-primary/10 text-primary-strong"
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
        {live && (
          <span className="absolute -end-0.5 -top-0.5 flex h-3 w-3" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-primary ring-2 ring-surface" />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-2xl font-bold tabular-nums leading-none">{value}</p>
        <p className="mt-1 text-sm font-semibold text-fg">{label}</p>
        {sub && <p className="mt-0.5 truncate text-xs text-fg-muted">{sub}</p>}
      </div>
      <ArrowRight
        className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
        aria-hidden="true"
      />
    </Link>
  );
}

/**
 * Getting-started checklist (audit A12) — shows on a fresh workspace so a
 * brand-new signup isn't staring at an all-zeros dashboard with no idea
 * what to do first. Each step's done-state derives from live data, so the
 * card fills in as they work and disappears entirely once every step is
 * complete. No dismissal state to persist — the data IS the dismissal.
 */
function GettingStarted({
  transactions,
  tasks,
  users,
}: {
  transactions: Transaction[];
  tasks: Task[];
  users: User[];
}) {
  // Its own hook call rather than a formatted prop from the parent: this
  // component owns the arithmetic (`steps.length - remaining`), so formatting
  // upstream would mean passing two pre-rendered strings for one sentence.
  const n = useNumberFormat();
  const steps = [
    {
      done: transactions.some((t) => t.type === "investment"),
      label: "Record your starting capital",
      desc: "Add the money already in the company as an investment.",
      href: "/investments",
    },
    {
      done: transactions.some((t) => t.type === "expense"),
      label: "Log your first expense",
      desc: "Rent, tools, salaries — start the money trail.",
      href: "/expenses",
    },
    {
      done: tasks.length > 0,
      label: "Create a task",
      desc: "Put the next piece of work on the board.",
      href: "/tasks",
    },
    {
      done: users.length > 1,
      label: "Invite your co-founder",
      desc: "FounderFlow is built for more than one pair of hands.",
      href: "/team",
    },
  ];

  const remaining = steps.filter((s) => !s.done).length;
  // Fully-onboarded workspaces never see this. Also hide once the workspace
  // is clearly active (3 of 4 done) — at that point the card is nagging,
  // not helping.
  if (remaining <= 1) return null;

  return (
    <section
      aria-label="Getting started"
      className="rounded-2xl border border-primary/30 bg-primary/[0.04] p-6"
    >
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary-strong">
          <Rocket className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-sm font-bold text-fg">Get your workspace rolling</h2>
          <p className="text-xs text-fg-muted">
            {n.number(steps.length - remaining)} of {n.number(steps.length)} done — a couple of
            minutes each.
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {steps.map((step) => (
          <Link
            key={step.label}
            href={step.href}
            className={cn(
              "group flex items-start gap-3 rounded-xl border p-3 transition-colors",
              step.done
                ? "border-border/40 bg-bg/40 opacity-60"
                : "border-border bg-bg hover:border-primary/40 hover:bg-surface-hover"
            )}
          >
            {step.done ? (
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong"
                aria-hidden="true"
              />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-semibold",
                  step.done ? "text-fg-muted line-through" : "text-fg"
                )}
              >
                {step.label}
              </p>
              {!step.done && <p className="mt-0.5 text-xs text-fg-muted">{step.desc}</p>}
            </div>
            {!step.done && (
              <ArrowRight
                className="ms-auto mt-1 h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                aria-hidden="true"
              />
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
