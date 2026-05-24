"use client";

/**
 * Reports charts split out so reports-client.tsx can next/dynamic them with
 * ssr:false — keeps Recharts (~200KB) out of the initial /reports bundle.
 */

import {
  Bar,
  BarChart,
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
export const PALETTE = [
  C_PRIMARY,
  C_CYAN,
  C_PINK,
  C_AMBER,
  "#a78bfa",
  "#34d399",
  "#fb7185",
  "#facc15",
];

const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid rgb(var(--border))",
  background: "rgb(var(--card))",
  color: "rgb(var(--fg))",
  boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
};

export function CashFlowBarChart({
  data,
}: {
  data: Array<{ month: string; investments: number; expenses: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} role="img" aria-label="Monthly investments versus expenses">
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
          tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString())}
        />
        <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="investments" fill={C_PRIMARY} radius={[8, 8, 0, 0]} />
        <Bar dataKey="expenses" fill={C_PINK} radius={[8, 8, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoriesPieChart({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={90}
          paddingAngle={2}
          dataKey="value"
          stroke="rgb(var(--card))"
          strokeWidth={2}
          role="img"
          aria-label="Expense breakdown by category"
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function FoundersHorizontalBar({
  data,
}: {
  data: Array<{ name: string; investments: number; expenses: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        layout="vertical"
        margin={{ left: 20 }}
        role="img"
        aria-label="Investments and expenses by team member"
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={C_SLATE}
          strokeOpacity={0.18}
          horizontal={false}
        />
        <XAxis
          type="number"
          stroke={C_SLATE}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString())}
        />
        <YAxis
          type="category"
          dataKey="name"
          stroke={C_SLATE}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          width={70}
        />
        <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="investments" fill={C_PRIMARY} radius={[0, 4, 4, 0]} />
        <Bar dataKey="expenses" fill={C_PINK} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
