"use client";

/**
 * SplitTextReveal — CSS-only per-word stagger.
 *
 * Splits the children string into words, wraps each in an inline-block span,
 * and animates them up with staggered transition-delay. No SplitType, no GSAP.
 *
 * Respects prefers-reduced-motion globally via the .01ms rule in globals.css.
 */

import { cn } from "@/lib/utils";

interface SplitTextProps {
  text: string;
  className?: string;
  /** ms between word reveals. */
  stagger?: number;
  /** Additional delay before the whole reveal starts (ms). */
  delay?: number;
  /** Element tag to render as (defaults to span). */
  as?: "h1" | "h2" | "h3" | "p" | "span";
}

export function SplitText({
  text,
  className,
  stagger = 50,
  delay = 0,
  as: Tag = "span",
}: SplitTextProps) {
  const words = text.split(" ");
  return (
    <Tag className={cn("inline-block", className)}>
      {words.map((word, i) => (
        <span
          key={`${word}-${i}`}
          className={cn(
            "inline-block overflow-hidden align-baseline",
            i < words.length - 1 && "mr-[0.25em]"
          )}
        >
          <span
            className="inline-block animate-reveal-up"
            style={{
              animationDelay: `${delay + i * stagger}ms`,
              animationFillMode: "both",
            }}
          >
            {word}
          </span>
        </span>
      ))}
    </Tag>
  );
}
