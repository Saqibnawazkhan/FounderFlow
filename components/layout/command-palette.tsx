"use client";

/**
 * Command palette — the actual behavior behind the topbar search input and
 * the global ⌘K / Ctrl-K shortcut.
 *
 * Scope for the P0 pass: fuzzy-jump across primary nav destinations. Later
 * phases can bolt on recents, quick-actions ("new task", "log expense"), and
 * cross-content search (tasks/projects/comments) without changing the shell.
 *
 * Interaction model:
 *  - ⌘K / Ctrl-K anywhere opens the palette (mounted globally in Topbar).
 *  - Escape or backdrop click closes.
 *  - Arrow up/down cycles items, Enter navigates, Tab wraps.
 *  - Query normalizes to lowercase and matches label OR href tail, so a user
 *    can type "tasks" or "tasks page" or "/tas" and land the same result.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight, Command } from "lucide-react";
import { NAV_ITEMS } from "@/lib/nav";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import { isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";
import { useStore } from "@/lib/store";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const t = useT();
  const currentUser = useStore((s) => s.currentUser);
  const role: Role = (currentUser?.role as Role | undefined) ?? "member";
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset query + active index every time the palette opens so a user who
  // fired Cmd-K, typed something, closed, then re-opened gets a fresh sheet.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const visibleItems = useMemo(
    () => (role === "member" ? NAV_ITEMS.filter((i) => !isMemberBlockedRoute(i.href)) : NAV_ITEMS),
    [role]
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = visibleItems.map((item) => ({ ...item, label: t.nav[item.labelKey] }));
    if (!q) return items;
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || i.href.toLowerCase().includes(q)
    );
  }, [query, visibleItems, t]);

  // Clamp activeIdx when the filtered result set shrinks (typing "z" after
  // sitting on item 8 shouldn't leave `activeIdx=8` pointing off the end).
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results.length, activeIdx]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (results.length ? (i + 1) % results.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const pick = results[activeIdx];
        if (pick) navigate(pick.href);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // navigate is stable-enough (router ref); results/activeIdx are the real deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, activeIdx]);

  function navigate(href: string) {
    onClose();
    router.push(href);
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.common.search}
      className="fixed inset-0 z-modal flex items-start justify-center px-4 pt-24 md:pt-32"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
      />

      {/* Sheet */}
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-card-hover">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-fg-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.common.search}
            aria-label={t.common.search}
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
          />
          <kbd className="hidden items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-fg-muted sm:inline-flex">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="scrollbar-thin max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-fg-muted">
              {t.common.noResults ?? "No results"}
            </div>
          ) : (
            results.map((item, i) => {
              const Icon = item.icon;
              const active = i === activeIdx;
              return (
                <button
                  key={item.href}
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => navigate(item.href)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    active ? "bg-primary/10 text-fg" : "text-fg-muted hover:bg-surface-hover"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1 font-medium">{item.label}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-fg-muted">
                    {item.href}
                  </span>
                  {active && (
                    <ArrowRight className="h-3.5 w-3.5 text-primary-strong" aria-hidden="true" />
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-bg/40 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <Command className="h-3 w-3" aria-hidden="true" /> K
          </span>
          <span>↑ ↓ to move · ↵ to open</span>
        </div>
      </div>
    </div>
  );
}
