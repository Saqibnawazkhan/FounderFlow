/**
 * Sentry — Node runtime init (server actions, RSC, route handlers).
 *
 * No-op if SENTRY_DSN is unset. Server-side errors get the userId + email
 * + companyId attached via setUser() at request boundaries in the actions.
 *
 * `SENTRY_DSN` is correct here and `NEXT_PUBLIC_SENTRY_DSN` is correct in
 * `sentry.client.config.ts`: they are the two halves of one configuration, not
 * alternatives. `scripts/vercel-build.mjs` refuses a production build that sets
 * one and not the other — see the note there and in the client config.
 *
 * Note this file is only bundled when `next.config.js` applies
 * `withSentryConfig`, which today also requires the three source-map upload
 * vars. As of 2026-09-28 the live Vercel project has no Sentry variable in any
 * scope, so nothing here has ever run in production.
 */

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN;

/**
 * Which deployment this error came from.
 *
 * NOT `NODE_ENV`: `next build` sets NODE_ENV=production for PREVIEW deploys
 * too, so keying off it files every pull-request failure under Sentry's
 * "production" environment, and the first thing anyone wants during a real
 * incident — "is this a customer or a branch?" — is exactly what that loses.
 * NODE_ENV remains the fallback for local dev and self-hosting, where there is
 * no Vercel environment to read.
 */
const DEPLOY_ENVIRONMENT = process.env.VERCEL_ENV || process.env.NODE_ENV;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: DEPLOY_ENVIRONMENT,
    tracesSampleRate: 0.1,
    // Server actions can throw arbitrary errors from Prisma, bcrypt,
    // NextAuth, etc. The breadcrumbs + stack are usually enough — we don't
    // need profiling for a small SaaS.
  });
}
