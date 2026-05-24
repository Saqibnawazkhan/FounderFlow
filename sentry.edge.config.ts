/**
 * Sentry — Edge runtime init. Used by middleware (auth.config.ts gate).
 *
 * No-op if SENTRY_DSN is unset. Edge runtime is tiny and synchronous; we
 * keep the config minimal to avoid bloat on every request.
 */

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.05, // edge runs on every request; sample lighter
  });
}
