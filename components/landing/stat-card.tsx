"use client";

/**
 * StatCard — Stitch metric card pattern.
 *
 * Layout: optional top icon, large mono number bottom-left, uppercase label
 * underneath the number. Hover lifts a subtle border highlight.
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  value: string;
  label: string;
  icon?: LucideIcon;
  /** Optional accent for the label color. */
  tone?: "primary" | "cyan" | "pink" | "muted";
  children?: React.ReactNode;
  className?: string;
}

export function StatCard({
  value,
  label,
  icon: Icon,
  tone = "primary",
  children,
  className,
}: StatCardProps) {
  const toneClass =
    tone === "cyan"
      ? "text-cyan-strong"
      : tone === "pink"
        ? "text-pink-strong"
        : tone === "muted"
          ? "text-fg-muted"
          : "text-primary-strong";

  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface p-6",
        "transition-colors duration-300 hover:border-primary/40",
        className
      )}
    >
      {/* Subtle hover gradient sweep (Stitch pattern) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br from-primary/0 via-primary/[0.06] to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100"
      />

      {Icon && <Icon className="relative z-10 h-5 w-5 text-fg-muted" aria-hidden="true" />}

      <div className="relative z-10 mt-8 font-mono">
        <div className="text-3xl font-bold leading-none text-fg">{value}</div>
        <div className={cn("mt-2 text-xs font-bold uppercase tracking-widest", toneClass)}>
          {label}
        </div>
      </div>

      {children && <div className="relative z-10 mt-4">{children}</div>}
    </div>
  );
}
