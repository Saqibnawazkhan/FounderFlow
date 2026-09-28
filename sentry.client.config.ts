/**
 * Sentry — browser-side init.
 *
 * Runs once when the client bundle loads. No-op if NEXT_PUBLIC_SENTRY_DSN isn't
 * set, so day-to-day dev and unconfigured deployments behave identically to
 * having no Sentry SDK installed at all.
 *
 * ── TWO THINGS TO KNOW BEFORE TRUSTING THIS FILE (prodready-006) ────────────
 *
 * 1. The DSN here MUST be `NEXT_PUBLIC_SENTRY_DSN`, not `SENTRY_DSN`. A
 *    server-only variable is not inlined into the client bundle, so reading
 *    `SENTRY_DSN` in this file compiles to `undefined` in the browser and the
 *    SDK silently never initialises. It is now declared in `lib/env.ts` and
 *    named in `scripts/vercel-build.mjs`, which REFUSES a production build that
 *    sets one of the two DSNs and not the other — a deploy that reports server
 *    errors and drops every browser crash, while `app/error.tsx` keeps telling
 *    the customer "The team has been notified", is worse than one with no Sentry
 *    at all, because nobody goes looking for the gap.
 *
 * 2. This file is only bundled when `next.config.js` applies
 *    `withSentryConfig`, and it does that only when SENTRY_DSN *and* all three
 *    of SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT are set. So setting the
 *    DSNs alone gives you a Sentry project that stays empty for ever. The
 *    production build warns about exactly that state (see
 *    `productionEnvWarnings`), but the fix is in `next.config.js` — decouple the
 *    runtime SDK from source-map upload — and that file is not owned here.
 *
 * As of 2026-09-28 the live Vercel project has NO Sentry variable in any scope,
 * so nothing in this file has ever run in production.
 *
 * Tunables (override via env if needed):
 *   • tracesSampleRate — % of navigations + interactions traced. 0.1 keeps
 *     the free tier from filling up in a few hours of real traffic.
 *   • replaysSessionSampleRate — % of sessions captured for Replay. We keep
 *     this low and bump replaysOnErrorSampleRate to 1.0 so every error gets
 *     replay context without storing replays for clean sessions.
 */

import * as Sentry from "@sentry/nextjs";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * Which deployment this crash came from.
 *
 * NOT `NODE_ENV`: `next build` sets NODE_ENV=production for PREVIEW deploys
 * too, so keying off it files every pull-request crash under Sentry's
 * "production" environment and post-launch triage cannot tell a paying
 * customer's error from one on a branch nobody has merged.
 *
 * `NEXT_PUBLIC_VERCEL_ENV` is the browser-visible copy of `VERCEL_ENV`
 * (production / preview / development), populated by Vercel's "Automatically
 * expose System Environment Variables" setting, which is on by default for
 * Next.js projects. The bare `VERCEL_ENV` is checked second so that this same
 * expression is correct if this module is ever evaluated server-side, and
 * NODE_ENV is the last resort for local dev and self-hosting, where there is no
 * Vercel environment to read.
 */
const DEPLOY_ENVIRONMENT =
  process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV;

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: DEPLOY_ENVIRONMENT,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    // Strip noisy resize/visibility events from breadcrumb trail.
    integrations: [
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
  });
}
