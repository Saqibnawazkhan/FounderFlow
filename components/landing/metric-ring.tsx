/**
 * MetricRing — Stitch hero pattern: SVG circular progress with an inline value.
 *
 * Two concentric circles: faint track + emerald/forest stroke with stroke-dasharray
 * sized to the progress %. Used in hero metric cards and dashboard KPIs.
 *
 * Server component — no hooks, no handlers, no browser APIs. Keep it that way:
 * the landing page renders it to HTML and it never reaches the client bundle.
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface MetricRingProps {
  /** Progress fraction, 0-1. */
  value: number;
  /** Stroke gradient end-stop: "primary" (emerald) or "forest". */
  tone?: "primary" | "forest" | "mint";
  /** Center icon (lucide). */
  icon?: LucideIcon;
  /** Or center text override (e.g. "84"). */
  label?: string;
  className?: string;
}

export function MetricRing({
  value,
  tone = "primary",
  icon: Icon,
  label,
  className,
}: MetricRingProps) {
  const safe = Math.max(0, Math.min(1, value));
  const circumference = 2 * Math.PI * 45;
  const dashoffset = circumference * (1 - safe);

  // Both the stroke arc and the inner label use the text-safe `-strong` tone
  // so the ring stays readable on light surfaces, not just dark.
  const toneClass =
    tone === "forest"
      ? "text-forest-strong"
      : tone === "mint"
        ? "text-mint-strong"
        : "text-primary-strong";

  return (
    <div className={cn("relative flex h-24 w-24 items-center justify-center", className)}>
      <svg
        className="absolute inset-0 h-full w-full -rotate-90"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          className="text-fg/10"
        />
        <circle
          cx="50"
          cy="50"
          r="45"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashoffset}
          className={toneClass}
          style={{ transition: "stroke-dashoffset 600ms var(--ease-out-quint)" }}
        />
      </svg>
      <div className={cn("relative font-mono text-lg font-bold", toneClass)}>
        {Icon ? <Icon className="h-6 w-6" aria-hidden="true" /> : label}
      </div>
    </div>
  );
}
