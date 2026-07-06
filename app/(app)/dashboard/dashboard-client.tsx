"use client";

import Link from "next/link";
import { useMemo } from "react";
import dynamic from "next/dynamic";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  ClipboardList,
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
import { formatCurrency, formatRelativeTime, cn } from "@/lib/utils";
import { endOfMonth, format, isPast, isToday, startOfMonth, subMonths } from "date-fns";
import { Avatar } from "@/components/ui/avatar";
import { DashboardStat, type DashboardStatProps } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";
import { Skeleton } from "@/components/ui/skeleton";

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

const C_PRIMARY = "#b6f425";
const C_CYAN = "#70E6ED";
const C_PINK = "#FFB3DB";
const C_AMBER = "#f59e0b";
const CATEGORY_PALETTE = [C_PRIMARY, C_CYAN, C_PINK, C_AMBER, "#a78bfa", "#34d399"];

type Props = {
  transactions: Transaction[];
  tasks: Task[];
  activities: Activity[];
  users: User[];
  clockedIn: { count: number; peers: { userId: string; userName: string }[] };
  currentUserId: string;
  currentUserName: string;
};

export function DashboardClient({
  transactions,
  tasks,
  activities,
  users,
  clockedIn,
  currentUserId,
  currentUserName,
}: Props) {
  const totalInvestments = transactions
    .filter((t) => t.type === "investment")
    .reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = transactions
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0);
  const balance = totalInvestments - totalExpenses;
  const pendingTasks = tasks.filter((t) => t.status !== "completed").length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;

  const last3MoExpenses = useMemo(() => {
    const cutoff = subMonths(new Date(), 3);
    return transactions
      .filter((t) => t.type === "expense" && new Date(t.date) >= cutoff)
      .reduce((s, t) => s + t.amount, 0);
  }, [transactions]);
  const monthlyBurn = last3MoExpenses / 3;
  const runwayMonths = monthlyBurn > 0 ? balance / monthlyBurn : Infinity;

  // This-month spend + how it compares to the 3-month average burn — a far more
  // frequently-checked number than all-time capital raised.
  const currentMonthSpend = useMemo(() => {
    const start = startOfMonth(new Date());
    return transactions
      .filter((t) => t.type === "expense" && new Date(t.date) >= start)
      .reduce((s, t) => s + t.amount, 0);
  }, [transactions]);
  const burnDeltaPct =
    monthlyBurn > 0 ? Math.round(((currentMonthSpend - monthlyBurn) / monthlyBurn) * 100) : 0;

  const monthlyData = useMemo(
    () =>
      Array.from({ length: 6 }).map((_, i) => {
        const ref = subMonths(new Date(), 5 - i);
        const monthStart = startOfMonth(ref);
        const monthEnd = endOfMonth(ref);
        const monthTxns = transactions.filter((t) => {
          const d = new Date(t.date);
          return d >= monthStart && d <= monthEnd;
        });
        return {
          month: format(monthStart, "MMM"),
          expenses: monthTxns.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0),
          investments: monthTxns
            .filter((t) => t.type === "investment")
            .reduce((s, t) => s + t.amount, 0),
        };
      }),
    [transactions]
  );

  const founderContributions = useMemo(
    () =>
      users
        .map((u) => ({
          name: u.name,
          amount: transactions
            .filter((t) => t.addedBy === u.id && t.type === "investment")
            .reduce((s, t) => s + t.amount, 0),
          role: u.role,
        }))
        .filter((f) => f.amount > 0)
        .sort((a, b) => b.amount - a.amount),
    [users, transactions]
  );

  const categoryData = useMemo(() => {
    const m = new Map<string, number>();
    transactions
      .filter((t) => t.type === "expense")
      .forEach((t) => m.set(t.category, (m.get(t.category) || 0) + t.amount));
    return Array.from(m.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
  }, [transactions]);

  const recentActivities = activities.slice(0, 6);

  // #2: surface the CURRENT user's own open tasks (overdue first) rather than
  // the whole company backlog, so the dashboard shows what this person owns.
  const myOpenTasks = useMemo(
    () => tasks.filter((t) => t.assignedTo === currentUserId && t.status !== "completed"),
    [tasks, currentUserId]
  );
  const myOpenCount = myOpenTasks.length;
  const myOverdueCount = useMemo(
    () =>
      myOpenTasks.filter(
        (t) => t.deadline && isPast(new Date(t.deadline)) && !isToday(new Date(t.deadline))
      ).length,
    [myOpenTasks]
  );
  const stats: DashboardStatProps[] = [
    {
      label: "Balance",
      value: formatCurrency(balance),
      icon: Wallet,
      tone: "primary",
      delta: balance >= 0 ? "positive" : "negative",
      deltaLabel:
        runwayMonths === Infinity ? "No burn recorded" : `${runwayMonths.toFixed(1)} mo runway`,
    },
    {
      label: "This month",
      value: formatCurrency(currentMonthSpend),
      icon: Flame,
      tone: "cyan",
      delta: "neutral",
      deltaLabel:
        monthlyBurn > 0
          ? `${burnDeltaPct >= 0 ? "+" : ""}${burnDeltaPct}% vs avg`
          : "spent this month",
    },
    {
      label: "Total spend",
      value: formatCurrency(totalExpenses),
      icon: TrendingDown,
      tone: "pink",
      delta: "neutral",
      deltaLabel: `${transactions.filter((t) => t.type === "expense").length} transactions`,
    },
    {
      label: "Open tasks",
      value: pendingTasks.toString(),
      icon: CheckCircle2,
      tone: "primary",
      delta: pendingTasks === 0 ? "positive" : "neutral",
      deltaLabel: `${completedTasks} shipped · ${tasks.length} total`,
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
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
        <div className="flex gap-3">
          <Link
            href="/expenses"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover active:scale-95"
          >
            <TrendingDown className="h-4 w-4" aria-hidden="true" /> Log expense
          </Link>
          <Link
            href="/investments"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_var(--glow-shadow-opacity))] transition-transform hover:scale-[1.02] active:scale-95"
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
          value={clockedIn.count}
          label="Clocked in now"
          live={clockedIn.count > 0}
          sub={
            clockedIn.count > 0
              ? clockedIn.peers
                  .slice(0, 3)
                  .map((p) => p.userName.split(" ")[0])
                  .join(", ") + (clockedIn.count > 3 ? ` +${clockedIn.count - 3} more` : "")
              : "Nobody on the clock"
          }
        />
        <PulseCard
          href="/team"
          icon={Users}
          value={users.length}
          label="Team members"
          sub={
            founderContributions.length > 0
              ? `${founderContributions.length} contributing capital`
              : "Invite your co-founders"
          }
        />
        <PulseCard
          href="/tasks"
          icon={ClipboardList}
          value={myOpenCount}
          label="Open tasks"
          alert={myOverdueCount > 0}
          sub={myOverdueCount > 0 ? `${myOverdueCount} overdue` : "Nothing overdue"}
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
              <Legend dot={C_PRIMARY} label="Investments" />
              <Legend dot={C_PINK} label="Expenses" />
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
                <th scope="col">Expenses</th>
              </tr>
            </thead>
            <tbody>
              {monthlyData.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{formatCurrency(m.investments)}</td>
                  <td>{formatCurrency(m.expenses)}</td>
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
                        style={{ backgroundColor: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length] }}
                      />
                      <span className="truncate text-fg-muted">{c.name}</span>
                    </div>
                    <span className="font-mono font-semibold tabular-nums text-fg">
                      {formatCurrency(c.value)}
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
                      <p className="font-mono text-sm font-bold tabular-nums">
                        {formatCurrency(f.amount)}
                      </p>
                    </div>
                    <div className="ml-10 h-1.5 overflow-hidden rounded-full bg-glass/[0.06]">
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
              View all <ArrowRight className="h-3 w-3" aria-hidden="true" />
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
                      {formatRelativeTime(activity.createdAt)}
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
          <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3" aria-hidden="true">
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
        className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
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
            {steps.length - remaining} of {steps.length} done — a couple of minutes each.
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
                className="ml-auto mt-1 h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
