"use client";

/**
 * The /dashboard announcement banner — channel 1 of the "just got cooler"
 * announcement, and the one that actually reaches people. Push needs the user
 * to have granted permission AND to hold a live `PushSubscription` row, and
 * nothing in this product has ever asked them to; the banner needs them to open
 * the app.
 *
 * Copy and dismissal key both come from lib/announce/announcement.ts, which the
 * push route reads too — one announcement, two channels, one set of words.
 *
 * ── NO DATABASE, AND THAT IS THE DESIGN ──────────────────────────────────────
 * Dismissal is a per-browser `localStorage` flag. A durable per-user marker
 * would mean a row written against every existing customer for a cosmetic
 * banner, and per-device is the honest scope for something whose entire state
 * lives in a browser: dismissing on a laptop says nothing about a phone.
 *
 * ── NOTHING IN THE FIRST PAINT ───────────────────────────────────────────────
 * /dashboard is a Server Component (./page.tsx) and the first paint is server
 * HTML. The server has no `localStorage`, so it cannot know whether THIS browser
 * already dismissed this announcement — anything it emitted here would flash on
 * every dashboard load for the people who had already dismissed it, who are by
 * definition the ones who load the page most. So the server (and React's
 * hydration pass, which must match it byte for byte) renders nothing at all, and
 * the decision is taken in an effect afterwards.
 *
 * `useHydrated()` is this repo's existing signal for exactly that, and its
 * docstring explains why `typeof window !== "undefined"` is NOT a substitute: it
 * is already true DURING hydration, so it would render a tree the server never
 * sent and React would discard the subtree on the mismatch. The cost is that a
 * first-time reader sees the banner appear one frame late, which is the correct
 * trade — a late banner is a non-event, a flashing one is a bug report.
 *
 * ── STORAGE MAY NOT BE THERE ─────────────────────────────────────────────────
 * `localStorage` throws in a private window and can be blocked outright, on the
 * accessor itself and not only on the value. Every read and write is wrapped, in
 * the shape `components/layout/verify-email-banner.tsx` already uses for its
 * `sessionStorage` dismissal, and the failure direction is OPEN: if the flag
 * cannot be READ the banner shows (a cosmetic banner seen twice costs nothing; a
 * dashboard that throws costs a customer), and if it cannot be WRITTEN the
 * dismissal still works for the life of the page and simply will not persist.
 *
 * ── LOOK ─────────────────────────────────────────────────────────────────────
 * Styled after `components/layout/verify-email-banner.tsx`, the nearest existing
 * component, with its `warning` tokens swapped for `primary`: this is good news,
 * not a nag. Every colour is an existing design token
 * (`primary` / `primary-strong` / `fg` / `fg-muted` / `border` / `glass`), so
 * dark mode follows from the CSS variables with nothing theme-specific here.
 *
 * ── a11y ─────────────────────────────────────────────────────────────────────
 * `role="status"` with the default polite live region: it reports something
 * already settled and must not steal focus or interrupt a screen reader
 * mid-sentence — the same call `comment-thread.tsx` and `tasks-client.tsx`
 * document. The dismiss control is a real `<button type="button">` with a
 * visible-to-AT name, not an icon with a click handler.
 *
 * Covered by tests/components/announcement-banner.test.tsx, including the
 * server-renders-to-empty property via `renderToStaticMarkup`.
 */

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import { ANNOUNCEMENT, ANNOUNCEMENT_STORAGE_KEY } from "@/lib/announce/announcement";

/** Has this browser already dismissed this announcement? Never throws. */
function alreadyDismissed(): boolean {
  try {
    return window.localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY) === "1";
  } catch {
    // Blocked or unavailable. Fail OPEN — see the header.
    return false;
  }
}

export function AnnouncementBanner() {
  const hydrated = useHydrated();
  const [dismissed, setDismissed] = useState(false);

  // Read the flag once, after hydration. In an effect rather than a lazy
  // `useState` initialiser: the initialiser runs during the hydration render,
  // where it would produce markup the server never sent.
  useEffect(() => {
    if (alreadyDismissed()) setDismissed(true);
  }, []);

  function dismiss() {
    // State first, so the banner goes away even if the write throws.
    setDismissed(true);
    try {
      window.localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY, "1");
    } catch {
      /* Private window or blocked storage: it will be back next load. */
    }
  }

  if (!hydrated || dismissed) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-6"
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong" aria-hidden="true" />
        <p className="text-sm text-fg">
          <span className="font-semibold">{ANNOUNCEMENT.title}</span>{" "}
          <span className="text-fg-muted">{ANNOUNCEMENT.body}</span>
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="flex h-7 w-7 shrink-0 items-center justify-center self-end rounded-lg text-fg-muted transition-colors hover:bg-glass/[0.08] hover:text-fg sm:self-auto"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
