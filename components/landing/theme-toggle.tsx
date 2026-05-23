"use client";

/**
 * ThemeToggle — standalone light/dark switch backed by the Zustand store.
 *
 * Used on public surfaces (landing, login, signup) where the topbar isn't
 * mounted. Inside the app shell, the topbar's own toggle is preferred.
 */

import { Moon, Sun } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
  /** Visual size of the toggle. */
  size?: "sm" | "md";
}

export function ThemeToggle({ className, size = "md" }: ThemeToggleProps) {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);

  const isDark = theme === "dark";
  const dim = size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const iconDim = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}
      title={`Switch to ${isDark ? "light" : "dark"} theme`}
      className={cn(
        "relative inline-flex items-center justify-center rounded-full",
        "border border-glass/[0.10] bg-glass/[0.04] text-fg-muted",
        "transition-colors duration-200 hover:bg-glass/[0.08] hover:text-fg",
        "active:scale-95",
        dim,
        className
      )}
    >
      {/* Cross-fade between sun and moon */}
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
