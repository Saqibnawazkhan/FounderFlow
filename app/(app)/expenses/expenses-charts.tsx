"use client";

/**
 * Expenses chart split out so expenses-client.tsx can next/dynamic it with
 * ssr:false — keeps Recharts (~200KB) out of the initial /expenses bundle.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";

const C_MINT = "#6EE7B7";
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
  currency,
}: {
  data: Array<{ category: string; amount: number }>;
  /** `Company.currency`, forwarded from the page's Server Component by
   *  expenses-client.tsx (transactions-ledger-006) — the same value the table and
   *  the amount input beside this chart use. Reading the store here instead would
   *  put rupees in this tooltip while the row above it said dollars, for as long
   *  as CompanyHydrator's round-trip takes. */
  currency: string;
}) {
  const money = useMoney(currency);
  const n = useNumberFormat();
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
            <stop offset="0%" stopColor={C_MINT} />
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
          // Same swap as dashboard-charts: the old `(v / 1000).toFixed(0) + "K"`
          // printed "1235K" for a 1.23M spend even in English, and had no way to
          // reach Urdu's ہزار / لاکھ scale. `width` buys the word-suffixed Urdu
          // tick room recharts' 60px default does not give it.
          tickFormatter={(v: number) => n.compact(v)}
          width={76}
        />
        <Tooltip formatter={(v: number) => money(v)} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="amount" fill="url(#expenseGrad)" radius={[8, 8, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
