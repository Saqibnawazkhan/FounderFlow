"use client";

/**
 * GlowingBorder — port of 21st.dev / Aceternity GlowingEffect.
 *
 * Mouse-tracked conic-gradient border that lights up when the cursor approaches.
 * Wrap any element with `relative` positioning. The glow renders behind via
 * `mix-blend-mode: lighten` so it picks up the underlying background.
 */

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface GlowingBorderProps {
  /** Detection range beyond the element edge, in px. */
  proximity?: number;
  /** Inner zone (0-1 of element radius) where the glow stays dormant. */
  inactiveZone?: number;
  /** Sweep angle of the conic gradient in degrees. */
  spread?: number;
  /** Always show a soft static glow (used for hero-tier cards). */
  glow?: boolean;
  /** Disable mouse tracking entirely. */
  disabled?: boolean;
  /** Stroke width in px. */
  borderWidth?: number;
  className?: string;
}

export function GlowingBorder({
  proximity = 64,
  inactiveZone = 0.7,
  spread = 40,
  glow = false,
  disabled = false,
  borderWidth = 1,
  className,
}: GlowingBorderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const raf = useRef<number | null>(null);

  const handle = useCallback(
    (e: PointerEvent | Event) => {
      if (disabled) return;
      const el = ref.current?.parentElement;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const isPointer = "clientX" in e;
      const x = isPointer ? (e as PointerEvent).clientX : rect.left + rect.width / 2;
      const y = isPointer ? (e as PointerEvent).clientY : rect.top + rect.height / 2;

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(x - cx, y - cy);
      const maxDist = Math.hypot(rect.width / 2, rect.height / 2) + proximity;
      const inactiveR = ((rect.width + rect.height) / 4) * inactiveZone;

      const intensity = dist > maxDist ? 0 : dist < inactiveR ? 0 : 1 - dist / maxDist;
      const angle = (Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90;

      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        if (!ref.current) return;
        ref.current.style.setProperty("--glow-opacity", String(intensity));
        ref.current.style.setProperty("--glow-angle", `${angle}deg`);
      });
    },
    [disabled, proximity, inactiveZone]
  );

  useEffect(() => {
    if (disabled) return;
    window.addEventListener("pointermove", handle, { passive: true });
    window.addEventListener("scroll", handle, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handle);
      window.removeEventListener("scroll", handle);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [handle, disabled]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit]",
        "transition-opacity duration-500",
        className
      )}
      style={
        {
          padding: borderWidth,
          opacity: glow ? 1 : "var(--glow-opacity, 0)",
          background: `conic-gradient(from var(--glow-angle, 0deg) at 50% 50%,
            transparent 0deg,
            rgb(var(--primary)) ${spread / 2}deg,
            rgb(var(--cyan)) ${spread}deg,
            transparent ${spread * 2}deg,
            transparent 360deg)`,
          WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
          WebkitMaskComposite: "xor" as unknown as string,
          maskComposite: "exclude",
        } as React.CSSProperties
      }
    />
  );
}
