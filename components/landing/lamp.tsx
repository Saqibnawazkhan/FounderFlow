"use client";

/**
 * Lamp — port of 21st.dev / Aceternity Lamp section header.
 *
 * Conic-gradient light rays sweep down from a horizontal line at the top of the
 * container, with two blur layers creating the soft glow halo. Built CSS-only
 * (no framer) so it respects the Bigfolio rule for non-Radix UI.
 *
 * Pass the children that should sit inside the glow (heading + subtitle).
 */

import { cn } from "@/lib/utils";

interface LampProps {
  children: React.ReactNode;
  className?: string;
}

export function Lamp({ children, className }: LampProps) {
  return (
    <section
      className={cn(
        "relative isolate flex w-full flex-col items-center overflow-hidden",
        "py-24 md:py-32",
        className
      )}
    >
      {/* Light rays */}
      <div className="pointer-events-none absolute inset-0 flex items-start justify-center">
        <div
          aria-hidden="true"
          className="relative h-72 w-full max-w-3xl"
          style={{
            background:
              "conic-gradient(from 210deg at 50% 0%, transparent 0deg, rgb(var(--primary) / 0.25) 60deg, transparent 120deg, transparent 240deg, rgb(var(--cyan) / 0.25) 300deg, transparent 360deg)",
            filter: "blur(60px)",
          }}
        />
      </div>

      {/* Horizontal beam line */}
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-12 h-px w-72 -translate-x-1/2 bg-gradient-to-r from-transparent via-primary/70 to-transparent"
      />
      <div
        aria-hidden="true"
        className="absolute left-1/2 top-12 h-[2px] w-32 -translate-x-1/2 bg-primary blur-sm"
      />

      <div className="relative z-10 mt-12 flex flex-col items-center text-center">{children}</div>
    </section>
  );
}
