"use client";

/**
 * PillBadge — Stitch hero badge pattern.
 *
 * Pill with a leading status dot + mono uppercase label. Used above the hero
 * headline ("BUILT FOR CO-FOUNDERS") and as section markers.
 */

import { cn } from "@/lib/utils";

interface PillBadgeProps {
  children: React.ReactNode;
  /** Show the leading pulsing dot. */
  dot?: boolean;
  /** Color tone. */
  tone?: "primary" | "cyan" | "pink";
  className?: string;
}

export function PillBadge({ children, dot = true, tone = "primary", className }: PillBadgeProps) {
  const toneClasses = {
    primary: "border-primary/30 bg-primary/10 text-primary-strong",
    cyan: "border-cyan/30 bg-cyan/10 text-cyan-strong",
    pink: "border-pink/30 bg-pink/10 text-pink-strong",
  }[tone];

  const dotClass = {
    primary: "bg-primary",
    cyan: "bg-cyan",
    pink: "bg-pink",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-2 rounded-full border px-4 py-1.5",
        "font-mono text-[11px] font-bold uppercase tracking-[0.18em]",
        toneClasses,
        className
      )}
    >
      {dot && (
        <span className="relative flex h-2 w-2">
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              dotClass
            )}
          />
          <span className={cn("relative inline-flex h-2 w-2 rounded-full", dotClass)} />
        </span>
      )}
      {children}
    </span>
  );
}
