"use client";

/**
 * DashboardStat — Stitch-style metric card with optional delta indicator.
 *
 * Used across dashboard, expenses, investments, reports — anywhere a "headline
 * number with a small context label" pattern shows up. Same visual language as
 * the landing-page StatCard but with a delta arrow.
 */

import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DashboardStatProps {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "primary" | "cyan" | "pink";
  delta?: "positive" | "negative" | "neutral";
  deltaLabel?: string;
  className?: string;
  /** Override the value's size/typography (e.g. smaller on a 2-col mobile grid). */
  valueClassName?: string;
}

export function DashboardStat({
  label,
  value,
  icon: Icon,
  tone = "primary",
  delta = "neutral",
  deltaLabel,
  className,
  valueClassName = "text-3xl",
}: DashboardStatProps) {
  const toneText =
    tone === "cyan"
      ? "text-cyan-strong"
      : tone === "pink"
        ? "text-pink-strong"
        : "text-primary-strong";
  const toneFill =
    tone === "cyan" ? "bg-cyan/10" : tone === "pink" ? "bg-pink/10" : "bg-primary/10";

  const DeltaIcon =
    delta === "positive" ? ArrowUpRight : delta === "negative" ? ArrowDownRight : ArrowRight;
  const deltaClass =
    delta === "positive" ? "text-success" : delta === "negative" ? "text-danger" : "text-fg-muted";

  return (
    <div
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-surface p-5",
        "transition-colors duration-300 hover:border-primary/30",
        className
      )}
    >
      {/* Hover gradient sweep — Stitch pattern */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br from-primary/0 via-primary/[0.05] to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
      />

      <div className="relative flex items-start justify-between">
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
          {label}
        </p>
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", toneFill)}>
          <Icon className={cn("h-4 w-4", toneText)} aria-hidden="true" />
        </div>
      </div>

      <p
        className={cn(
          "relative mt-4 font-mono font-bold tabular-nums leading-none text-fg",
          valueClassName
        )}
      >
        {value}
      </p>

      {deltaLabel && (
        <div className="relative mt-3 flex items-center gap-1.5 text-xs">
          <DeltaIcon className={cn("h-3 w-3", deltaClass)} aria-hidden="true" />
          <span className="text-fg-muted">{deltaLabel}</span>
        </div>
      )}
    </div>
  );
}
