"use client";

/**
 * Expenses chart split out so expenses-client.tsx can next/dynamic it with
 * ssr:false — keeps Recharts (~200KB) out of the initial /expenses bundle.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCurrency } from "@/lib/utils";

const C_PINK = "#FFB3DB";
const C_AMBER = "#f59e0b";
const C_SLATE = "#94a3b8";

const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid rgb(var(--border))",
  background: "rgb(var(--card))",
  color: "rgb(var(--fg))",
  boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
};

export function CategoryBreakdownBar({
  data,
}: {
  data: Array<{ category: string; amount: number }>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        margin={{ top: 5, right: 5, left: 0, bottom: 5 }}
        role="img"
        aria-label="Spend grouped by category"
      >
        <defs>
          <linearGradient id="expenseGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C_PINK} />
            <stop offset="100%" stopColor={C_AMBER} stopOpacity={0.6} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={C_SLATE}
          strokeOpacity={0.18}
          vertical={false}
        />
        <XAxis
          dataKey="category"
          stroke={C_SLATE}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          angle={-15}
          textAnchor="end"
          height={60}
        />
        <YAxis
          stroke={C_SLATE}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString())}
        />
        <Tooltip formatter={(v: number) => formatCurrency(v)} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="amount" fill="url(#expenseGrad)" radius={[8, 8, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
