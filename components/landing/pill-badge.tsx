/**
 * PillBadge — Stitch hero badge pattern.
 *
 * Pill with a leading status dot + mono uppercase label. Used above the hero
 * headline ("BUILT FOR CO-FOUNDERS") and as section markers.
 *
 * Server component — no hooks, no handlers, no browser APIs. Keep it that way:
 * the landing page renders it to HTML and it never reaches the client bundle.
 */

import { cn } from "@/lib/utils";

interface PillBadgeProps {
  children: React.ReactNode;
  /** Show the leading pulsing dot. */
  dot?: boolean;
  /** Color tone. */
  tone?: "primary" | "forest" | "mint";
  className?: string;
}

export function PillBadge({ children, dot = true, tone = "primary", className }: PillBadgeProps) {
  const toneClasses = {
    primary: "border-primary/30 bg-primary/10 text-primary-strong",
    forest: "border-forest/30 bg-forest/10 text-forest-strong",
    mint: "border-mint/30 bg-mint/10 text-mint-strong",
  }[tone];

  const dotClass = {
    primary: "bg-primary",
    forest: "bg-forest",
    mint: "bg-mint",
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
