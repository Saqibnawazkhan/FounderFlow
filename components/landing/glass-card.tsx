/**
 * GlassCard — Stitch glass-morphism container.
 *
 * Uses the theme-aware `glass` token (inverts on light vs dark): on dark the
 * surface picks up a white tint, on light it picks up a dark tint, so the
 * card looks "carved out" of the background in either mode.
 *
 * Server component — no hooks, no handlers, no browser APIs. Keep it that way:
 * the landing page renders it to HTML and it never reaches the client bundle.
 */

import { cn } from "@/lib/utils";

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
}

export function GlassCard({ children, className }: GlassCardProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-glass/[0.08]",
        "bg-glass/[0.03] backdrop-blur-xl",
        "shadow-[0_10px_40px_rgb(0_0_0_/_0.12)] dark:shadow-[0_10px_40px_rgb(0_0_0_/_0.35)]",
        className
      )}
    >
      {children}
    </div>
  );
}
