"use client";

/**
 * MarketingThemeToggle — light/dark switch scoped to the landing page.
 *
 * The marketing surface is light-first by design, independent of whatever the
 * app shell is set to: `app/page.tsx` renders `data-theme="light"` on its root
 * server-side, so the page paints light with no flash and no JS. This toggle
 * flips that attribute locally, and mirrors the choice into the Zustand store
 * so a visitor who prefers dark carries it into the product after signup.
 *
 * The store is imported lazily — it is not needed to render the page, only to
 * record a preference the visitor actively expressed.
 */

import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

export function MarketingThemeToggle({
  className,
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md";
}) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const isDark = theme === "dark";

  function toggle() {
    const next = isDark ? "light" : "dark";
    setTheme(next);

    // The landing root carries data-theme; flipping it re-declares the token
    // set for this subtree only.
    document.querySelector("[data-marketing]")?.setAttribute("data-theme", next);

    void import("@/lib/store").then(({ useStore }) => useStore.getState().setTheme(next));
  }

  const dim = size === "sm" ? "h-9 w-9" : "h-10 w-10";
  const iconDim = size === "sm" ? "h-4 w-4" : "h-[18px] w-[18px]";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Switch to ${isDark ? "light" : "dark"} theme`}
      className={cn(
        "relative inline-flex items-center justify-center rounded-xl",
        "border border-border bg-surface text-fg-muted",
        "transition-colors duration-200 hover:bg-surface-hover hover:text-fg",
        "active:scale-95",
        dim,
        className
      )}
    >
      <Sun
        aria-hidden="true"
        className={cn(
          iconDim,
          "absolute transition-all duration-300",
          isDark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0"
        )}
      />
      <Moon
        aria-hidden="true"
        className={cn(
          iconDim,
          "absolute transition-all duration-300",
          isDark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
        )}
      />
    </button>
  );
}
