"use client";

/**
 * Reports charts split out so reports-client.tsx can next/dynamic them with
 * ssr:false — keeps Recharts (~200KB) out of the initial /reports bundle.
 *
 * Each chart takes the workspace `currency` as a prop and hands it to `useMoney`
 * (rep-011). Without it these tooltips read the store's `currentCompany`, which is
 * hydrated by a two-hop async chain and answers "PKR" until it lands — so a USD
 * workspace's first hover showed rupees. reports-client.tsx has the authoritative
 * value from its Server Component and passes it down; see lib/hooks/useMoney.ts
 * for why the prop takes precedence over the store rather than filling in for it.
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
import { useMoney } from "@/lib/hooks/useMoney";
import { useNumberFormat } from "@/lib/i18n/use-t";

const C_PRIMARY = "#10B981";
const C_FOREST = "#047857";
const C_MINT = "#6EE7B7";
const C_DEEP = "#065F46";
const C_SLATE = "#94a3b8";
export const PALETTE = [
  C_PRIMARY,
  C_FOREST,
  C_MINT,
  C_DEEP,
  "#34D399",
  "#64748B",
  "#334155",
  "#A7F3D0",
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
  currency,
}: {
  data: Array<{ month: string; investments: number; expenses: number; revenue: number }>;
  currency?: string;
}) {
  const money = useMoney(currency);
  const n = useNumberFormat();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        role="img"
        aria-label="Monthly money in (investments, revenue) versus expenses"
      >
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
          // The `Math.abs` guard the old formatter needed is gone: ICU's compact
          // notation signs the number itself, so -1,234,567 comes back "-1.2M"
          // rather than the "-1235K" the hand-rolled divide produced.
          tickFormatter={(v: number) => n.compact(v)}
          // Room for Urdu's word suffixes (ہزار / لاکھ), which overrun recharts'
          // 60px default gutter. See lib/format.ts's adopter caveat.
          width={76}
        />
        <Tooltip formatter={(v: number) => money(v)} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="investments" fill={C_PRIMARY} radius={[8, 8, 0, 0]} />
        <Bar dataKey="revenue" fill={C_FOREST} radius={[8, 8, 0, 0]} />
        <Bar dataKey="expenses" fill={C_MINT} radius={[8, 8, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoriesPieChart({
  data,
  currency,
}: {
  data: Array<{ name: string; value: number }>;
  currency?: string;
}) {
  const money = useMoney(currency);
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
        <Tooltip formatter={(v: number) => money(v)} contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function FoundersHorizontalBar({
  data,
  currency,
}: {
  data: Array<{ name: string; investments: number; expenses: number }>;
  currency?: string;
}) {
  const money = useMoney(currency);
  const n = useNumberFormat();
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
          // Same swap as the cash-flow chart above. This axis is horizontal, so
          // the Urdu word suffix costs plot width rather than gutter — recharts
          // sizes a horizontal number axis from the container, so no `width`
          // override is needed or wanted here.
          tickFormatter={(v: number) => n.compact(v)}
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
        <Tooltip formatter={(v: number) => money(v)} contentStyle={TOOLTIP_STYLE} />
        <Bar dataKey="investments" fill={C_PRIMARY} radius={[0, 4, 4, 0]} />
        <Bar dataKey="expenses" fill={C_MINT} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
