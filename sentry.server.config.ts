/**
 * Sentry — Node runtime init (server actions, RSC, route handlers).
 *
 * No-op if SENTRY_DSN is unset. Server-side errors get the userId + email
 * + companyId attached via setUser() at request boundaries in the actions.
 */

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.SENTRY_DSN;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    // Server actions can throw arbitrary errors from Prisma, bcrypt,
    // NextAuth, etc. The breadcrumbs + stack are usually enough — we don't
    // need profiling for a small SaaS.
  });
}
