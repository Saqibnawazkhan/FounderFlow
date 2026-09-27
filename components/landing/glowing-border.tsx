"use client";

/**
 * GlowingBorder — port of 21st.dev / Aceternity GlowingEffect.
 *
 * Mouse-tracked conic-gradient border that lights up when the cursor approaches.
 * Wrap any element with `relative` positioning. The glow renders behind via
 * `mix-blend-mode: lighten` so it picks up the underlying background.
 *
 * Tracking is shared, not per-instance. The original version gave every card
 * its own `pointermove` + `scroll` window listener, each calling
 * getBoundingClientRect() on the card during the event — three cards meant
 * three forced layout reads on every single mouse move, interleaved with style
 * writes. The registry below keeps one listener pair for the whole page, caches
 * rects until something actually invalidates them (scroll / resize), and splits
 * each frame into a read pass then a write pass so the browser never has to
 * re-layout mid-loop.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/* ── Shared pointer-tracking registry ─────────────────────────────────────── */

interface Subscriber {
  /** The glow overlay element; its parent is the card we measure. */
  el: HTMLDivElement;
  proximity: number;
  inactiveZone: number;
  rect: DOMRect | null;
}

const subscribers = new Set<Subscriber>();

let pointerX = 0;
let pointerY = 0;
let framePending = false;
let rectsStale = true;
let attached = false;

function schedule() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(flush);
}

function flush() {
  framePending = false;

  // Pass 1 — read. Every layout query happens here, together, so the browser
  // does at most one reflow for the whole frame.
  if (rectsStale) {
    subscribers.forEach((sub) => {
      sub.rect = sub.el.parentElement?.getBoundingClientRect() ?? null;
    });
    rectsStale = false;
  }

  // Pass 2 — write. Only custom properties, which never invalidate layout.
  subscribers.forEach((sub) => {
    const rect = sub.rect;
    if (!rect) return;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(pointerX - cx, pointerY - cy);
    const maxDist = Math.hypot(rect.width / 2, rect.height / 2) + sub.proximity;
    const inactiveR = ((rect.width + rect.height) / 4) * sub.inactiveZone;

    const intensity = dist > maxDist || dist < inactiveR ? 0 : 1 - dist / maxDist;
    const angle = (Math.atan2(pointerY - cy, pointerX - cx) * 180) / Math.PI + 90;

    sub.el.style.setProperty("--glow-opacity", String(intensity));
    sub.el.style.setProperty("--glow-angle", `${angle}deg`);
  });
}

function onPointerMove(e: PointerEvent) {
  pointerX = e.clientX;
  pointerY = e.clientY;
  schedule();
}

/** Scroll and resize move the cards under a stationary cursor, so both the
 *  cached rects and the glow need recomputing — but nothing else does. */
function invalidate() {
  rectsStale = true;
  schedule();
}

function subscribe(sub: Subscriber) {
  subscribers.add(sub);
  rectsStale = true;

  if (!attached) {
    attached = true;
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("scroll", invalidate, { passive: true });
    window.addEventListener("resize", invalidate, { passive: true });
  }

  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0 && attached) {
      attached = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", invalidate);
      window.removeEventListener("resize", invalidate);
    }
  };
}

/* ── Component ────────────────────────────────────────────────────────────── */

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

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;

    // A coarse pointer has no hover to track — skip the listeners entirely on
    // touch devices, where this effect can never fire anyway.
    if (window.matchMedia?.("(hover: none)").matches) return;

    return subscribe({ el, proximity, inactiveZone, rect: null });
  }, [disabled, proximity, inactiveZone]);

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
            rgb(var(--forest)) ${spread}deg,
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
