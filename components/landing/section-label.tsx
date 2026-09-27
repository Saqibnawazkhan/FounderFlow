/**
 * SectionLabel — the kicker above a section heading.
 *
 * Replaces PillBadge on the marketing page. The pill version — rounded chip,
 * tinted background, pulsing dot, wide-tracked mono — is a stock generated-UI
 * signature: three ornaments doing the job of one small piece of type. This is
 * just the type. Colour carries the tone, weight carries the emphasis, and
 * nothing pulses.
 *
 * Sans rather than mono, and 0.1em tracking rather than 0.18em, so it reads as
 * a magazine kicker instead of a status chip. Works centred or left-aligned
 * because there is no ornament to balance around.
 *
 * Server component — no hooks, no handlers, no browser APIs. Keep it that way:
 * the landing page renders it to HTML and it never reaches the client bundle.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionLabel({
  children,
  tone = "primary",
  className,
}: {
  children: ReactNode;
  tone?: "primary" | "forest" | "mint" | "muted";
  className?: string;
}) {
  const toneClass = {
    primary: "text-primary-strong",
    forest: "text-forest-strong",
    mint: "text-mint-strong",
    muted: "text-fg-muted",
  }[tone];

  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-[0.1em]", toneClass, className)}>
      {children}
    </p>
  );
}
