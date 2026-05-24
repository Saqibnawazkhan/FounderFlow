/**
 * Tiny wrapper so server actions can log errors locally AND ship them to
 * Sentry with consistent tagging in one call. Sentry's captureException is
 * a no-op when SENTRY_DSN is unset, so this is safe to call unconditionally.
 *
 * Usage:
 *   try { ... } catch (e) {
 *     captureServerError(e, { action: "signupAction", input });
 *     return { success: false, error: "..." };
 *   }
 */

import * as Sentry from "@sentry/nextjs";

export function captureServerError(
  err: unknown,
  context: { action: string; extra?: Record<string, unknown> } = { action: "unknown" }
): void {
  // Local log so we still see it in Vercel function logs even without Sentry.
  // eslint-disable-next-line no-console
  console.error(`[${context.action}] failed:`, err);

  Sentry.captureException(err, {
    tags: { boundary: "server-action", action: context.action },
    extra: context.extra,
  });
}
