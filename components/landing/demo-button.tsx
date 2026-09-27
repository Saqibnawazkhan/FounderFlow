"use client";

/**
 * DemoButton — "try the live demo" CTA, used four times on the landing page.
 *
 * The demo seeds a full workspace out of the Zustand store, which drags in
 * lib/seed.ts and the i18n strings. Those are imported lazily on click rather
 * than at module scope so a visitor who never presses the button never pays
 * for the demo dataset. The router push waits on the same dynamic import, so
 * the store is guaranteed seeded before /dashboard mounts.
 */

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export function DemoButton({ children, className }: { children: ReactNode; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleDemo() {
    if (busy) return;
    setBusy(true);
    try {
      const { useStore } = await import("@/lib/store");
      useStore.getState().loginDemo();
      router.push("/dashboard");
    } catch {
      // Chunk failed to load (offline, stale deploy). Let the dashboard route
      // handle the unauthenticated case rather than leaving the button dead.
      router.push("/dashboard");
    }
  }

  // The click downloads a chunk before anything navigates. On a slow
  // connection that is dead air, so the button says what it is doing rather
  // than looking broken.
  return (
    <button
      type="button"
      onClick={handleDemo}
      className={className}
      aria-busy={busy}
      aria-live="polite"
    >
      {busy ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading demo…
        </>
      ) : (
        children
      )}
    </button>
  );
}
