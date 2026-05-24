/**
 * Next.js 14 instrumentation hook. Called once per worker on cold start.
 * Loads the correct Sentry runtime config — nodejs for server actions / RSC,
 * edge for middleware. The hook is a no-op when SENTRY_DSN isn't set because
 * the per-runtime config files gate their Sentry.init() calls on the env var.
 *
 * Required for Next.js to pick up sentry.server.config.ts and
 * sentry.edge.config.ts (the .client variant is auto-loaded via next.config).
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Next.js 14 picks up `onRequestError` from instrumentation.ts to capture
// unhandled errors in nested RSC trees. Sentry exports it as
// `captureRequestError` — alias the export. No-op when no DSN is set.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
