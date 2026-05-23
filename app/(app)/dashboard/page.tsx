"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  Clock,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { formatCurrency, formatRelativeTime, cn } from "@/lib/utils";
import { format, startOfMonth, subMonths } from "date-fns";
import { Avatar } from "@/components/ui/avatar";

export default function DashboardPage() {
  const currentUser = useStore((s) => s.currentUser);
  const transactions = useStore((s) => s.getCompanyTransactions());
  const tasks = useStore((s) => s.getCompanyTasks());
  const activities = useStore((s) => s.getCompanyActivities());
  const users = useStore((s) => s.getCompanyUsers());

  const totalInvestments = transactions
    .filter((t) => t.type === "investment")
    .reduce((sum, t) => sum + t.amount, 0);
  const totalExpenses = transactions
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0);
  const balance = totalInvestments - totalExpenses;
  const pendingTasks = tasks.filter((t) => t.status !== "completed").length;
  const completedTasks = tasks.filter((t) => t.status === "completed").length;

  // Monthly trend data (last 6 months)
  const monthlyData = Array.from({ length: 6 }).map((_, i) => {
    const monthStart = startOfMonth(subMonths(new Date(), 5 - i));
    const monthEnd = startOfMonth(subMonths(new Date(), 4 - i));
    const monthTxns = transactions.filter((t) => {
      const d = new Date(t.date);
      return d >= monthStart && d < monthEnd;
    });
    return {
      month: format(monthStart, "MMM"),
      expenses: monthTxns.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0),
      investments: monthTxns.filter((t) => t.type === "investment").reduce((s, t) => s + t.amount, 0),
    };
  });

  // Founder contributions
  const founderContributions = users
    .map((u) => {
      const invested = transactions
        .filter((t) => t.addedBy === u.id && t.type === "investment")
        .reduce((s, t) => s + t.amount, 0);
      return { name: u.name, amount: invested, role: u.role };
    })
    .filter((f) => f.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  // Category breakdown for expenses
  const categoryMap = new Map<string, number>();
  transactions
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      categoryMap.set(t.category, (categoryMap.get(t.category) || 0) + t.amount);
    });
  const categoryData = Array.from(categoryMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  const CATEGORY_COLORS = ["#6366f1", "#d946ef", "#ec4899", "#f59e0b", "#10b981", "#06b6d4"];

  const recentActivities = activities.slice(0, 6);
  const upcomingTasks = tasks
    .filter((t) => t.status !== "completed")
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
    .slice(0, 4);

  const stats = [
    {
      label: "Total Balance",
      value: formatCurrency(balance),
      icon: Wallet,
      gradient: "from-emerald-500 to-teal-500",
      change: totalInvestments > 0 ? `${Math.round((balance / totalInvestments) * 100)}% of capital` : "—",
      positive: balance > 0,
    },
    {
      label: "Total Investments",
      value: formatCurrency(totalInvestments),
      icon: TrendingUp,
      gradient: "from-brand-500 to-accent-500",
      change: `${transactions.filter((t) => t.type === "investment").length} contributions`,
      positive: true,
    },
    {
      label: "Total Expenses",
      value: formatCurrency(totalExpenses),
      icon: TrendingDown,
      gradient: "from-amber-500 to-orange-500",
      change: `${transactions.filter((t) => t.type === "expense").length} transactions`,
      positive: false,
    },
    {
      label: "Pending Tasks",
      value: pendingTasks.toString(),
      icon: CheckCircle2,
      gradient: "from-pink-500 to-rose-500",
      change: `${completedTasks} completed`,
      positive: true,
    },
  ];

  return (
    <div className="space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Welcome back, {currentUser?.name?.split(" ")[0]} <span className="inline-block animate-pulse">👋</span>
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Here's how your startup is doing today.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/expenses" className="btn-secondary">
            <TrendingDown className="h-4 w-4" /> Log expense
          </Link>
          <Link href="/investments" className="btn-primary">
            <TrendingUp className="h-4 w-4" /> Add investment
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05 }}
            className="card p-5 relative overflow-hidden group"
          >
            <div className={cn("absolute -top-12 -right-12 h-32 w-32 rounded-full bg-gradient-to-br opacity-10 group-hover:opacity-20 transition-opacity blur-2xl", stat.gradient)} />
            <div className="relative flex items-start justify-between">
              <div>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">{stat.label}</p>
                <p className="text-2xl font-bold mt-2 tabular-nums">{stat.value}</p>
                <div className="flex items-center gap-1 mt-2 text-xs">
                  {stat.positive ? (
                    <ArrowUpRight className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3 text-amber-500" />
                  )}
                  <span className="text-slate-500 dark:text-slate-400">{stat.change}</span>
                </div>
              </div>
              <div className={cn("h-10 w-10 rounded-xl bg-gradient-to-br flex items-center justify-center text-white shadow-lg", stat.gradient)}>
                <stat.icon className="h-5 w-5" />
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Main charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trend chart */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="card p-6 lg:col-span-2"
        >
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-semibold">Cash Flow</h3>
              <p className="text-sm text-slate-500">Last 6 months</p>
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
            </div>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyData}>
                <defs>
                  <linearGradient id="invest" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="expense" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(148 163 184 / 0.2)" vertical={false} />
                <XAxis dataKey="month" stroke="rgb(148 163 184)" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis
                  stroke="rgb(148 163 184)"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => (v >= 1000 ? `${v / 1000}K` : v.toString())}
                />
                <Tooltip
                  formatter={(value: number) => formatCurrency(value)}
                  contentStyle={{ borderRadius: 12, border: "none", boxShadow: "0 10px 30px rgba(0,0,0,0.1)" }}
                />
                <Area type="monotone" dataKey="investments" stroke="#6366f1" strokeWidth={2} fill="url(#invest)" />
                <Area type="monotone" dataKey="expenses" stroke="#f59e0b" strokeWidth={2} fill="url(#expense)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>

        {/* Category breakdown */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="card p-6"
        >
          <h3 className="text-lg font-semibold mb-1">Spending by Category</h3>
          <p className="text-sm text-slate-500 mb-4">Top 6 categories</p>
          {categoryData.length > 0 ? (
            <>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={categoryData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                      {categoryData.map((_, i) => (
                        <Cell key={i} fill={CATEGORY_COLORS[i]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-2 mt-4">
                {categoryData.slice(0, 4).map((c, i) => (
                  <div key={c.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[i] }} />
                      <span className="truncate text-slate-600 dark:text-slate-400">{c.name}</span>
                    </div>
                    <span className="font-medium tabular-nums">{formatCurrency(c.value)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-48 flex items-center justify-center text-sm text-slate-500">No expenses yet</div>
          )}
        </motion.div>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Founder contributions */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
          className="card p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold">Founder Contributions</h3>
              <p className="text-sm text-slate-500">Who's invested what</p>
            </div>
            <Users className="h-5 w-5 text-slate-400" />
          </div>
          <div className="space-y-3">
            {founderContributions.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-6">No investments yet</p>
            ) : (
              founderContributions.slice(0, 5).map((f, i) => {
                const pct = totalInvestments > 0 ? (f.amount / totalInvestments) * 100 : 0;
                return (
                  <div key={f.name} className="space-y-1.5">
                    <div className="flex items-center gap-3">
                      <Avatar name={f.name} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{f.name}</p>
                      </div>
                      <p className="text-sm font-semibold tabular-nums">{formatCurrency(f.amount)}</p>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden ml-10">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.8, delay: 0.5 + i * 0.1 }}
                        className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500"
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </motion.div>

        {/* Upcoming tasks */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.5 }}
          className="card p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold">Upcoming Tasks</h3>
              <p className="text-sm text-slate-500">{pendingTasks} pending</p>
            </div>
            <Link href="/tasks" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="space-y-3">
            {upcomingTasks.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-6">No pending tasks</p>
            ) : (
              upcomingTasks.map((task) => (
                <Link
                  key={task.id}
                  href="/tasks"
                  className="block p-3 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-brand-300 dark:hover:border-brand-700 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition group"
                >
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      "h-7 w-7 rounded-lg flex items-center justify-center shrink-0",
                      task.priority === "urgent" && "bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-300",
                      task.priority === "high" && "bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-300",
                      task.priority === "medium" && "bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-300",
                      task.priority === "low" && "bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                    )}>
                      {task.status === "in_progress" ? <CircleDot className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium group-hover:text-brand-600 dark:group-hover:text-brand-400 transition truncate">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-xs text-slate-500 truncate">{task.assignedToName}</p>
                        <span className="text-slate-300">·</span>
                        <p className="text-xs text-slate-500 truncate">Due {format(new Date(task.deadline), "MMM dd")}</p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </motion.div>

        {/* Recent activity */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.6 }}
          className="card p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold">Recent Activity</h3>
              <p className="text-sm text-slate-500">Live team updates</p>
            </div>
            <Link href="/activities" className="text-xs text-brand-600 hover:underline flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="space-y-3">
            {recentActivities.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-6">No activity yet</p>
            ) : (
              recentActivities.map((activity) => (
                <div key={activity.id} className="flex items-start gap-3">
                  <Avatar name={activity.userName} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 dark:text-slate-300 leading-tight">{activity.message}</p>
                    <p className="text-xs text-slate-400 mt-1">{formatRelativeTime(activity.createdAt)}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
