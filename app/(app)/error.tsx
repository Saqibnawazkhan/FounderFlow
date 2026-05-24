"use client";

/**
 * Error boundary for the authenticated app shell. Catches client-side errors
 * inside /dashboard, /expenses, /tasks etc. without escalating to the global
 * error boundary (which would unmount the whole layout). Shows the error
 * message + digest so we can actually debug instead of staring at a black
 * "Application error" screen.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import * as Sentry from "@sentry/nextjs";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    // Send to server logs so we can read it in Vercel even without DevTools.
    console.error("(app) route error:", error);
    // Report to Sentry. The SDK no-ops if SENTRY_DSN isn't set so this is
    // safe to call unconditionally.
    Sentry.captureException(error, {
      tags: { boundary: "app-route" },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10">
        <AlertTriangle className="h-6 w-6 text-danger" aria-hidden="true" />
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">Error</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight">Something broke loading this page</h1>
      <p className="mt-3 text-sm text-fg-muted">
        We caught the error so the rest of the app still works. You can retry, head back to the
        dashboard, or expand the details below.
      </p>

      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-transform hover:scale-[1.02] active:scale-95"
        >
          <RefreshCcw className="h-4 w-4" aria-hidden="true" /> Try again
        </button>
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
        >
          Dashboard
        </Link>
      </div>

      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="mt-8 font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted hover:text-fg"
      >
        {showDetails ? "Hide" : "Show"} technical details
      </button>

      {showDetails && (
        <div className="mt-4 w-full overflow-hidden rounded-xl border border-border bg-surface text-left">
          <div className="border-b border-border px-4 py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
              Message
            </p>
            <p className="mt-1 break-words text-sm text-fg">{error.message}</p>
          </div>
          {error.digest && (
            <div className="border-b border-border px-4 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                Digest
              </p>
              <p className="mt-1 font-mono text-xs text-fg-muted">{error.digest}</p>
            </div>
          )}
          {error.stack && (
            <div className="px-4 py-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-fg-muted">
                Stack
              </p>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-fg-muted">
                {error.stack}
              </pre>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
