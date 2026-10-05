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
import {
  CHART_AXIS,
  CHART_SERIES,
  CHART_TOOLTIP_STYLE,
  categoricalAt,
} from "@/lib/colors/categorical";

/**
 * Colours come from lib/colors/categorical.ts and resolve to
 * `rgb(var(--cat-N))`, never to a hex literal. Two defects closed by that one
 * change:
 *
 *   • The pie's palette was SIX colours for TEN `EXPENSE_CATEGORIES`, so four
 *     categories were drawn in a colour another category in the same pie was
 *     already using — two slices, identical fill, nothing to tell them apart.
 *   • A hex does not respond to the theme. The old emerald ramp (emerald-500,
 *     emerald-700, emerald-300, emerald-800) was also one hue at four
 *     lightnesses: one band under deuteranopia, four greys in greyscale, and
 *     the emerald-700 slice stayed a dark forest green on a charcoal card.
 *
 * A bare six-digit hex literal anywhere in this file is now a test failure —
 * see tests/lib/colors/categorical-palette.test.ts. Reach for a token.
 */

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
            <stop offset="5%" stopColor={CHART_SERIES.investments} stopOpacity={0.5} />
            <stop offset="95%" stopColor={CHART_SERIES.investments} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="g-revenue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_SERIES.revenue} stopOpacity={0.45} />
            <stop offset="95%" stopColor={CHART_SERIES.revenue} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="g-expense" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={CHART_SERIES.expenses} stopOpacity={0.4} />
            <stop offset="95%" stopColor={CHART_SERIES.expenses} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={CHART_AXIS}
          strokeOpacity={0.18}
          vertical={false}
        />
        <XAxis
          dataKey="month"
          stroke={CHART_AXIS}
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke={CHART_AXIS}
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
        <Tooltip formatter={(v: number) => money(v)} contentStyle={CHART_TOOLTIP_STYLE} />
        <Area
          type="monotone"
          dataKey="investments"
          stroke={CHART_SERIES.investments}
          strokeWidth={2}
          fill="url(#g-invest)"
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke={CHART_SERIES.revenue}
          strokeWidth={2}
          fill="url(#g-revenue)"
        />
        <Area
          type="monotone"
          dataKey="expenses"
          stroke={CHART_SERIES.expenses}
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
            <Cell key={i} fill={categoricalAt(i)} />
          ))}
        </Pie>
        <Tooltip formatter={(v: number) => money(v)} contentStyle={CHART_TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}
