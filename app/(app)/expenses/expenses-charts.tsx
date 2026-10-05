"use client";

/**
 * Expenses chart split out so expenses-client.tsx can next/dynamic it with
 * ssr:false — keeps Recharts (~200KB) out of the initial /expenses bundle.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";
import { CHART_AXIS, CHART_TOOLTIP_STYLE, categoricalAt } from "@/lib/colors/categorical";

/**
 * THIS FILE IS WHERE ui-016 LIVED. Its bar used a mint -> amber gradient while
 * /dashboard and /reports used the emerald ramp, so the same workspace's spend
 * was a different colour on two screens a customer clicks between — and all
 * three sets were private hex literals, so none of them responded to the theme
 * toggle either.
 *
 * Both halves are fixed by reading lib/colors/categorical.ts: one palette,
 * shared with the other two chart files, resolving to `rgb(var(--cat-N))` so a
 * `.dark` flip re-paints the bars.
 *
 * Amber specifically had to go. This is a SINGLE-SERIES chart — one bar per
 * category, all the same quantity — so a two-hue gradient was never encoding
 * anything, and the hue it reached for is the semantic over-budget amber. A bar
 * that is amber because it is a bar, next to budget pills that are amber
 * because the budget is blown, is a colour that means two things on one screen.
 * It is now the first categorical hue, emerald, fading on its own OPACITY: the
 * brand colour leads, and nothing in the fill pretends to carry a second
 * dimension.
 *
 * A bare six-digit hex literal anywhere in this file is now a test failure —
 * see tests/lib/colors/categorical-palette.test.ts.
 */
const C_BAR = categoricalAt(0);

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
            <stop offset="0%" stopColor={C_BAR} stopOpacity={0.95} />
            <stop offset="100%" stopColor={C_BAR} stopOpacity={0.35} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke={CHART_AXIS}
          strokeOpacity={0.18}
          vertical={false}
        />
        <XAxis
          dataKey="category"
          stroke={CHART_AXIS}
          fontSize={11}
          tickLine={false}
          axisLine={false}
          angle={-15}
          textAnchor="end"
          height={60}
        />
        <YAxis
          stroke={CHART_AXIS}
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
        <Tooltip formatter={(v: number) => money(v)} contentStyle={CHART_TOOLTIP_STYLE} />
        <Bar dataKey="amount" fill="url(#expenseGrad)" radius={[8, 8, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
