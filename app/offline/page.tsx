/**
 * /offline — the page the service worker falls back to when a navigation
 * request fails (typically: no network). Kept fully static so it works
 * with zero JS + no DB calls — the visitor is offline, after all.
 *
 * sw.js precaches this page on install so it's available without a network
 * round-trip even on the very first offline navigation.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles, WifiOff } from "lucide-react";

export const metadata: Metadata = {
  title: "Offline",
  description: "You're offline. Reconnect to keep working.",
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bg px-6 py-12 text-center">
      <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
          <Sparkles className="h-4 w-4 text-primary-fg" aria-hidden="true" />
        </div>
        <span className="text-base font-bold tracking-tight">FounderFlow</span>
      </Link>

      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-warning/10">
        <WifiOff className="h-7 w-7 text-warning" aria-hidden="true" />
      </div>
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">Offline</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">You&apos;re offline</h1>
      {/* Copy fix (audit N10): the SW intentionally does NOT cache document
          pages (navigations are network-first so auth/session state never
          goes stale) — so don't promise "cached pages still work". Nothing
          was lost, though: unsent form input survives in the open tab. */}
      <p className="mt-3 max-w-md text-sm text-fg-muted">
        FounderFlow needs an internet connection to load your workspace. Nothing was lost — any tab
        you already have open keeps its state, and we&apos;ll pick up right where you left off once
        you reconnect.
      </p>

      {/* Plain anchor (not Link) so it doesn't try to prefetch through the SW. */}
      <a
        href="/dashboard"
        className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-transform hover:scale-[1.02] active:scale-95"
      >
        Try again
      </a>
    </main>
  );
}
