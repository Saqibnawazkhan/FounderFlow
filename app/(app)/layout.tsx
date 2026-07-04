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
 */

import { useStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { VerifyEmailBanner } from "@/components/layout/verify-email-banner";
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
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col transition-[margin-left] duration-300",
          collapsed ? "lg:ml-16" : "lg:ml-64"
        )}
      >
        <Topbar />
        <VerifyEmailBanner />
        <main id="main" className="flex-1 overflow-x-hidden p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
