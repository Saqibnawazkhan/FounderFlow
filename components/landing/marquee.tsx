"use client";

/**
 * Marquee — infinite horizontal scroll, pure CSS.
 *
 * Duplicates children once so the animation can loop seamlessly via -50%
 * translate. Edges fade with a webkit-mask gradient.
 *
 * Mobile: animation continues but at the same speed (cheap). Disable via
 * `pauseOnMobile` if you want.
 */

import { cn } from "@/lib/utils";

interface MarqueeProps {
  children: React.ReactNode;
  /** Seconds for one full loop. */
  speed?: number;
  /** Reverse direction. */
  reverse?: boolean;
  className?: string;
  /** Pause on hover (desktop only). */
  pauseOnHover?: boolean;
}

export function Marquee({
  children,
  speed = 40,
  reverse = false,
  pauseOnHover = true,
  className,
}: MarqueeProps) {
  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden",
        "[mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]",
        "[-webkit-mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]",
        className
      )}
    >
      <div
        className={cn(
          "flex w-max gap-12 will-change-transform",
          reverse && "[animation-direction:reverse]",
          pauseOnHover && "group-hover:[animation-play-state:paused]"
        )}
        style={{
          animation: `marquee ${speed}s linear infinite`,
        }}
      >
        <div className="flex shrink-0 items-center gap-12">{children}</div>
        <div className="flex shrink-0 items-center gap-12" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}
