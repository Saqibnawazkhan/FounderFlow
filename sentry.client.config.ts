/**
 * Sentry — browser-side init.
 *
 * Runs once when the client bundle loads. No-op if SENTRY_DSN isn't set, so
 * day-to-day dev and unconfigured deployments behave identically to having
 * no Sentry SDK installed at all.
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

if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NODE_ENV,
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
