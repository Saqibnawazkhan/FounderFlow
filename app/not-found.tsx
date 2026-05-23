import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md space-y-4 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-slate-500">404</p>
        <h1 className="text-3xl font-bold">Page not found</h1>
        <p className="text-slate-500 dark:text-slate-400">
          We couldn&apos;t find what you were looking for. The link may be broken or the page may
          have moved.
        </p>
        <div className="pt-4">
          <Link
            href="/"
            className="inline-flex items-center rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 dark:bg-white dark:text-slate-900"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
