"use client";

/**
 * InView — the landing page's entire motion runtime.
 *
 * Sets `data-visible` on its own element the first time it scrolls into view,
 * then stops observing. Every reveal, stagger and bar-growth animation on the
 * marketing page is CSS keyed off that one attribute (see the "Landing
 * scroll-reveal" block in globals.css), which is why the page ships no
 * animation library at all.
 *
 * Children stay server components — they're passed through as `children`, so
 * wrapping a section in <InView> costs one client boundary, not one per card.
 */

import { useEffect, useRef, type ElementType, type ReactNode } from "react";

interface InViewProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Render as something other than a div (e.g. "section", "ul"). */
  as?: ElementType;
  /** rootMargin — negative bottom inset delays the trigger until properly in view. */
  margin?: string;
  id?: string;
  "aria-label"?: string;
}

export function InView({
  children,
  className,
  style,
  as: Tag = "div",
  margin = "0px 0px -80px 0px",
  ...rest
}: InViewProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // No IntersectionObserver (very old browsers, some test runners): show the
    // content immediately rather than leaving an invisible page behind.
    if (typeof IntersectionObserver === "undefined") {
      el.setAttribute("data-visible", "");
      return;
    }

    // Already on screen at mount (above the fold) — reveal without waiting for
    // a scroll event, otherwise the hero-adjacent sections sit blank.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-visible", "");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: margin }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [margin]);

  return (
    <Tag ref={ref} className={className} style={style} {...rest}>
      {children}
    </Tag>
  );
}
