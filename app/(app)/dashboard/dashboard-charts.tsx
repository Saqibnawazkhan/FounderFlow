"use client";

/**
 * Dashboard charts split out so dashboard-client.tsx can next/dynamic them
 * with ssr:false. Recharts is ~200KB gzipped; keeping it out of the initial
 * bundle drops /dashboard from 224KB → ~110KB and the chart still paints
 * fine after first interaction.
 */

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
import { formatCurrency } from "@/lib/utils";

const C_PRIMARY = "#b6f425";
const C_CYAN = "#70E6ED";
const C_PINK = "#FFB3DB";
const C_AMBER = "#f59e0b";
const C_SLATE = "#94a3b8";
const CATEGORY_PALETTE = [C_PRIMARY, C_CYAN, C_PINK, C_AMBER, "#a78bfa", "#34d399"];

const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid rgb(var(--border))",
  background: "rgb(var(--card))",
  color: "rgb(var(--fg))",
  boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
};

export function CashFlowChart({
  data,
}: {
  data: Array<{ month: string; investments: number; expenses: number; revenue: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={data}
        role="img"
        aria-label="Cash flow over the last 6 months. Investments and expenses by month."
      >
        <defs>
          <linearGradient id="g-invest" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={C_PRIMARY} stopOpacity={0.5} />
            <stop offset="95%" stopColor={C_PRIMARY} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="g-revenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={C_CYAN} stopOpacity={0.45} />
            <stop offset="95%" stopColor={C_CYAN} stopOpacity={0} />
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
        <XAxis dataKey="month" stroke={C_SLATE} fontSize={11} tickLine={false} axisLine={false} />
        <YAxis
          stroke={C_SLATE}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString())}
        />
        <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={TOOLTIP_STYLE} />
        <Area
          type="monotone"
          dataKey="investments"
          stroke={C_PRIMARY}
          strokeWidth={2}
          fill="url(#g-invest)"
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke={C_CYAN}
          strokeWidth={2}
          fill="url(#g-revenue)"
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
  );
}

export function CategoryPieChart({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={48}
          outerRadius={78}
          paddingAngle={3}
          dataKey="value"
          stroke="rgb(var(--card))"
          strokeWidth={2}
          role="img"
          aria-label={`Expense breakdown by category. ${data
            .map((d) => `${d.name}: ${formatCurrency(d.value)}`)
            .join(", ")}`}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export { CATEGORY_PALETTE };
