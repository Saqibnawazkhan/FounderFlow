"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { listTransactionsAction } from "@/lib/actions/transactions";
import { listTasksAction } from "@/lib/actions/tasks";
import { listActivitiesAction } from "@/lib/actions/activities";
import { listCompanyUsersAction } from "@/lib/actions/team";
import type { Activity, Task, Transaction, User } from "@/lib/types";
import { formatCurrency, formatRelativeTime, cn } from "@/lib/utils";
import { endOfMonth, format, startOfMonth, subMonths } from "date-fns";
import { Avatar } from "@/components/ui/avatar";
import { DashboardStat, type DashboardStatProps } from "@/components/ui/dashboard-stat";
import { PillBadge } from "@/components/landing/pill-badge";

/* Chart series colors — use the brand hexes directly so Recharts can render
 * them. CSS vars resolve at runtime; for SVG fill/stroke that's brittle, so
 * we keep the brand hexes here and let them sit visually well on both themes.
 */
const C_PRIMARY = "#b6f425"; // lime
const C_CYAN = "#70E6ED";
const C_PINK = "#FFB3DB";
const C_AMBER = "#f59e0b";
const C_SLATE = "#94a3b8";

const CATEGORY_PALETTE = [C_PRIMARY, C_CYAN, C_PINK, C_AMBER, "#a78bfa", "#34d399"];

export default function DashboardPage() {
  const currentUser = useStore((s) => s.currentUser);

  // All four reads live in Supabase as of Phase 1.C. One Promise.all on
  // mount keeps the waterfall flat.
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listTransactionsAction(),
      listTasksAction(),
      listActivitiesAction(),
      listCompanyUsersAction(),
    ]).then(([tx, tk, ac, us]) => {
      if (cancelled) return;
      if (tx.success) setTransactions(tx.data);
      if (tk.success) setTasks(tk.data);
      if (ac.success) setActivities(ac.data);
      if (us.success) setUsers(us.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const totalInvestments = transactions
    .filter((t) => t.type === "investment")
    .reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = transactions
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0);
  const balance = totalInvestments - totalExpenses;
  const pendingTasks = tasks.filter((t) => t.status !== "completed").length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;

  // Runway (months left) — burn-aware metric replaces the misleading "% of capital".
  const last3MoExpenses = useMemo(() => {
    const cutoff = subMonths(new Date(), 3);
    return transactions
      .filter((t) => t.type === "expense" && new Date(t.date) >= cutoff)
      .reduce((s, t) => s + t.amount, 0);
  }, [transactions]);
  const monthlyBurn = last3MoExpenses / 3;
  const runwayMonths = monthlyBurn > 0 ? balance / monthlyBurn : Infinity;

  // Last-6-months trend with proper month boundaries (fixes audit flaw #39).
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
  const upcomingTasks = tasks
    .filter((t) => t.status !== "completed")
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
    .slice(0, 4);

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
      label: "Capital raised",
      value: formatCurrency(totalInvestments),
      icon: TrendingUp,
      tone: "cyan",
      delta: "positive",
      deltaLabel: `${transactions.filter((t) => t.type === "investment").length} contributions`,
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
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <PillBadge>Live workspace</PillBadge>
          <h1 className="mt-4 text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Welcome back,{" "}
            <span className="text-primary-strong">{currentUser?.name?.split(" ")[0]}</span>.
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

      {/* Stats — 4-up Stitch-flavored metric cards */}
      <section
        aria-label="Key metrics"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {stats.map((s) => (
          <DashboardStat key={s.label} {...s} />
        ))}
        {/* DashboardStat is now imported from @/components/ui */}
      </section>

      {/* Main row — cash flow + category breakdown */}
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
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={monthlyData}
                role="img"
                aria-label={`Cash flow over the last 6 months. Investments and expenses by month.`}
              >
                <defs>
                  <linearGradient id="g-invest" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C_PRIMARY} stopOpacity={0.5} />
                    <stop offset="95%" stopColor={C_PRIMARY} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="g-expense" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C_PINK} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={C_PINK} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={C_SLATE}
                  strokeOpacity={0.18}
                  vertical={false}
                />
                <XAxis
                  dataKey="month"
                  stroke={C_SLATE}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke={C_SLATE}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString())}
                />
                <Tooltip
                  formatter={(value: number) => formatCurrency(value)}
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid rgb(var(--border))",
                    background: "rgb(var(--card))",
                    color: "rgb(var(--fg))",
                    boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="investments"
                  stroke={C_PRIMARY}
                  strokeWidth={2}
                  fill="url(#g-invest)"
                />
                <Area
                  type="monotone"
                  dataKey="expenses"
                  stroke={C_PINK}
                  strokeWidth={2}
                  fill="url(#g-expense)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-6">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            Spend mix
          </p>
          <h3 className="mt-1 text-lg font-bold tracking-tight">By category</h3>
          {categoryData.length > 0 ? (
            <>
              <div className="mt-4 h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categoryData}
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={78}
                      paddingAngle={3}
                      dataKey="value"
                      stroke="rgb(var(--card))"
                      strokeWidth={2}
                    >
                      {categoryData.map((_, i) => (
                        <Cell key={i} fill={CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(v: number) => formatCurrency(v)}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid rgb(var(--border))",
                        background: "rgb(var(--card))",
                        color: "rgb(var(--fg))",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
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

      {/* Bottom — founder contributions + upcoming tasks + recent activity */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Founder contributions */}
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

        {/* Upcoming tasks */}
        <div className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
                What&apos;s next
              </p>
              <h3 className="mt-1 text-lg font-bold tracking-tight">Upcoming tasks</h3>
            </div>
            <Link
              href="/tasks"
              className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest text-primary-strong hover:underline"
            >
              View all <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
          <div className="space-y-2.5">
            {upcomingTasks.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-muted">No pending tasks</p>
            ) : (
              upcomingTasks.map((task) => (
                <Link
                  key={task.id}
                  href="/tasks"
                  className="group block rounded-xl border border-border p-3 transition-colors hover:border-primary/30 hover:bg-surface-hover"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                        task.priority === "urgent" && "bg-danger/15 text-danger",
                        task.priority === "high" && "bg-warning/15 text-warning",
                        task.priority === "medium" && "bg-info/15 text-info",
                        task.priority === "low" && "bg-glass/[0.06] text-fg-muted"
                      )}
                    >
                      {task.status === "in_progress" ? (
                        <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium transition-colors group-hover:text-primary-strong">
                        {task.title}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                        {task.assignedToName} · Due {format(new Date(task.deadline), "MMM dd")}
                      </p>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Recent activity */}
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
