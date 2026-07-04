import Link from "next/link";
import { CheckSquare, LayoutDashboard, Search } from "lucide-react";

/**
 * Global 404. Audit N10: instead of a dead-end "the link may be broken",
 * offer the destinations a lost user most likely wanted. Kept as a server
 * component (no role check) — the links themselves are middleware-gated,
 * so a member clicking Dashboard just gets bounced to their home.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-6 text-fg">
      <div className="max-w-md space-y-4 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-fg-muted">404</p>
        <h1 className="text-3xl font-bold">Page not found</h1>
        <p className="text-fg-muted">
          We couldn&apos;t find what you were looking for. The link may be broken or the page may
          have moved.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-4">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
            Dashboard
          </Link>
          <Link
            href="/tasks"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            <CheckSquare className="h-4 w-4" aria-hidden="true" />
            Tasks
          </Link>
          <Link
            href="/projects"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-5 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            Projects
          </Link>
        </div>
        <p className="pt-2 text-xs text-fg-muted">
          Tip: press{" "}
          <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px]">
            Ctrl
          </kbd>{" "}
          +{" "}
          <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px]">
            K
          </kbd>{" "}
          anywhere in the app to jump to any page.
        </p>
      </div>
    </main>
  );
}
