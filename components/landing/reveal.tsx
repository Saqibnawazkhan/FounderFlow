/**
 * Reveal / Stagger / StaggerItem — the landing page's shared motion vocabulary.
 *
 * Server components. All three are thin wrappers that hand CSS the numbers it
 * needs (index, distance, delay) as custom properties; the actual animation
 * lives in globals.css and is triggered by <InView>'s `data-visible` flag.
 *
 * Reveal      — one block that fades + rises as a unit.
 * Stagger     — a container whose <StaggerItem> descendants play in sequence.
 * StaggerItem — one step of that sequence. Pure server markup, no observer.
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InView } from "./in-view";

/** Build the custom-property style object, omitting the defaults CSS already has. */
function vars(v: Record<string, number | string | undefined>): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val !== undefined) out[k] = typeof val === "number" ? `${val}` : val;
  }
  return out as CSSProperties;
}

export function Reveal({
  children,
  className,
  distance,
  delay,
  margin,
}: {
  children: ReactNode;
  className?: string;
  /** Rise distance in px (default 18). */
  distance?: number;
  /** Extra delay before this block starts, in ms. */
  delay?: number;
  /** IntersectionObserver rootMargin override. */
  margin?: string;
}) {
  return (
    <InView
      margin={margin}
      className={cn("reveal", className)}
      style={vars({
        "--reveal-y": distance === undefined ? undefined : `${distance}px`,
        "--reveal-delay": delay === undefined ? undefined : `${delay}ms`,
      })}
    >
      {children}
    </InView>
  );
}

export function Stagger({
  children,
  className,
  stagger,
  delay,
  margin,
}: {
  children: ReactNode;
  className?: string;
  /** ms between each item (default 70). */
  stagger?: number;
  /** ms before the first item (default 0). */
  delay?: number;
  /** IntersectionObserver rootMargin override. */
  margin?: string;
}) {
  return (
    <InView
      margin={margin}
      className={className}
      style={vars({
        "--reveal-stagger": stagger === undefined ? undefined : `${stagger}ms`,
        "--reveal-delay": delay === undefined ? undefined : `${delay}ms`,
      })}
    >
      {children}
    </InView>
  );
}

export function StaggerItem({
  children,
  className,
  index,
  distance,
}: {
  children: ReactNode;
  className?: string;
  /** Position in the sequence — drives the transition-delay. */
  index: number;
  /** Rise distance in px (default 18). */
  distance?: number;
}) {
  return (
    <div
      className={cn("reveal-item", className)}
      style={vars({
        "--reveal-i": index,
        "--reveal-y": distance === undefined ? undefined : `${distance}px`,
      })}
    >
      {children}
    </div>
  );
}
