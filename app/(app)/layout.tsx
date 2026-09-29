"use client";

/**
 * Authenticated app shell — sidebar + topbar wrapping every protected page.
 *
 * Auth is enforced by middleware.ts (server-side, runs before any RSC paints),
 * so this layout DOESN'T re-gate on `currentUser`. The old `useEffect → router.replace("/login")`
 * guard raced with providers.tsx's session hydration and bounced legit users
 * to /dashboard via the /login redirect-when-signed-in layout.
 *
 * If `currentUser` is briefly empty (Zustand hydrating from session), we show
 * a tiny loading state so the layout doesn't flash with an empty avatar.
 *
 * WHY THE SHELL IS VIEWPORT-LOCKED (`h-dvh overflow-hidden`):
 * The document used to be the scroll container, which makes a fixed-height
 * page (a chat rail + message list that scroll independently with a composer
 * pinned to the bottom) impossible — any inner `h-full` has no definite
 * height to resolve against, and the composer rides the document scroll.
 * Moving the scrollport onto <main> gives every page a definite height while
 * leaving the chrome (Topbar / VerifyEmailBanner / Breadcrumbs) outside the
 * scrollport, so it stays put instead of relying on `sticky`.
 * `h-dvh`, not `h-screen`: `100vh` ignores mobile browser chrome and would
 * push the last ~60px of content under the URL bar.
 */

import { useStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { VerifyEmailBanner } from "@/components/layout/verify-email-banner";
import { PreferenceHydrator } from "@/components/layout/preference-hydrator";
import { CompanyHydrator } from "@/components/layout/company-hydrator";
import { PushBridge } from "@/components/push/push-bridge";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { cn } from "@/lib/utils";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);

  if (!currentUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-pulse rounded-xl bg-primary" />
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            Loading workspace…
          </p>
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}

function AppShell({ children }: { children: React.ReactNode }) {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  return (
    <div className="flex h-dvh overflow-hidden bg-bg">
      <Sidebar />
      <div
        className={cn(
          // WHY LOGICAL, NOT `lg:ml-*`: <Sidebar> is `fixed start-0 … border-e`
          // (components/layout/sidebar.tsx), so the rail sits on the READING-START
          // edge — left in English, right in Urdu. This column reserves the gutter
          // it occupies, and the two have to name the SAME edge. A physical
          // `lg:ml-64` reserves the left gutter in both directions, so in Urdu the
          // rail overlays the content on the right while an empty 16rem strip sits
          // on the left. That is the other half of the sidebar mirror.
          //
          // The transition names the logical property for the same reason:
          // `transition-[margin-left]` watches an edge that never changes once the
          // offset is `ms-*`, so the collapse would animate in English and snap in
          // Urdu — a silent regression in the direction nobody tests.
          //
          // Preferring the logical utility over an `rtl:` override is deliberate:
          // Tailwind emits `rtl:` AFTER `lg:` in the stylesheet, so an
          // `lg:ml-64 rtl:mr-64` pair loses at every breakpoint (the trap
          // documented at sidebar.tsx's mobile transform). `lg:ms-64` needs no
          // variant at all, so there is no ordering left to get wrong.
          "flex min-h-0 min-w-0 flex-1 flex-col transition-[margin-inline-start] duration-300",
          collapsed ? "lg:ms-16" : "lg:ms-64"
        )}
      >
        <Topbar />
        <VerifyEmailBanner />
        <PreferenceHydrator />
        <CompanyHydrator />
        <PushBridge />
        <Breadcrumbs />
        {/* The one scrollport in the app shell. `min-h-0` lets it shrink
            below its content inside the flex column; `overflow-y-auto` is
            what makes a child's `h-full` mean "the visible page". */}
        {/* `tabIndex={-1}` is what makes the root layout's "Skip to main
            content" actually move focus (a11y-008). A fragment jump to a
            non-focusable element only moves the sequential focus navigation
            starting point — `document.activeElement` stays on <body>, so
            nothing is announced and a screen reader is not taken anywhere.
            -1 keeps it out of the Tab order. */}
        <main
          id="main"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6 lg:p-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
