/**
 * Sentry — Edge runtime init. Used by middleware (auth.config.ts gate).
 *
 * No-op if SENTRY_DSN is unset. Edge runtime is tiny and synchronous; we
 * keep the config minimal to avoid bloat on every request.
 */

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN;

/**
 * Which deployment this error came from. Same expression as
 * `sentry.server.config.ts`, deliberately — all three runtime configs have to
 * agree or Sentry's environment filter is only true for two thirds of the
 * events.
 *
 * NOT `NODE_ENV`: `next build` sets NODE_ENV=production for PREVIEW deploys
 * too, so keying off it files every middleware failure on a pull request under
 * Sentry's "production" environment, and the first question of any real
 * incident — "is this a customer or a branch?" — is exactly what that loses.
 * `VERCEL_ENV` is a server-side name and the edge runtime is server-side, so
 * the browser-visible `NEXT_PUBLIC_VERCEL_ENV` mirror belongs only in the
 * client config. NODE_ENV remains the fallback for local dev and
 * self-hosting, where there is no Vercel environment to read.
 */
const DEPLOY_ENVIRONMENT = process.env.VERCEL_ENV || process.env.NODE_ENV;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: DEPLOY_ENVIRONMENT,
    tracesSampleRate: 0.05, // edge runs on every request; sample lighter
  });
}
