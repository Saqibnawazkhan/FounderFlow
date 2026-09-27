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
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";

const C_PRIMARY = "#10B981";
const C_FOREST = "#047857";
const C_MINT = "#6EE7B7";
const C_DEEP = "#065F46";
const C_SLATE = "#94a3b8";
const CATEGORY_PALETTE = [C_PRIMARY, C_FOREST, C_MINT, C_DEEP, "#34D399", "#64748B"];

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
  const money = useMoney();
  const n = useNumberFormat();
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
            <stop offset="5%" stopColor={C_FOREST} stopOpacity={0.45} />
            <stop offset="95%" stopColor={C_FOREST} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="g-expense" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={C_MINT} stopOpacity={0.4} />
            <stop offset="95%" stopColor={C_MINT} stopOpacity={0} />
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
          // The hand-rolled `(v / 1000).toFixed(0) + "K"` this replaces was wrong
          // in English before it was wrong in Urdu: PKR amounts clear a million
          // routinely, and it rendered 1,234,567 as "1235K" instead of "1.2M".
          // `compact` also abbreviates on the locale's own scale — Urdu groups by
          // ہزار / لاکھ, not thousand/million — which no digit swap can reach.
          tickFormatter={(v: number) => n.compact(v)}
          // Urdu's suffixes are words, so a tick is wider than "1.2M". Recharts
          // defaults this gutter to 60px, which "12.3 لاکھ" overruns and the SVG
          // viewport then clips. Headroom costs English ~16px of plot width and
          // saves Urdu an unreadable axis. See lib/format.ts's adopter caveat.
          width={76}
        />
        <Tooltip formatter={(v: number) => money(v)} contentStyle={TOOLTIP_STYLE} />
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
          stroke={C_FOREST}
          strokeWidth={2}
          fill="url(#g-revenue)"
        />
        <Area
          type="monotone"
          dataKey="expenses"
          stroke={C_MINT}
          strokeWidth={2}
          fill="url(#g-expense)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function CategoryPieChart({ data }: { data: Array<{ name: string; value: number }> }) {
  const money = useMoney();
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
            .map((d) => `${d.name}: ${money(d.value)}`)
            .join(", ")}`}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => money(v)} contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}
