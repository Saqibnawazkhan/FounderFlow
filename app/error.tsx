"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route error:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-slate-500">Error</p>
        <h1 className="text-3xl font-bold">Something went wrong</h1>
        <p className="text-slate-500 dark:text-slate-400">
          An unexpected error occurred while rendering this page. The team has been notified.
        </p>
        {error.digest && (
          <p className="font-mono text-xs text-slate-400">Reference: {error.digest}</p>
        )}
        <div className="flex items-center justify-center gap-3 pt-4">
          <button
            onClick={reset}
            className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 dark:bg-white dark:text-slate-900"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-full border border-slate-300 px-5 py-2 text-sm font-medium transition-colors hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
