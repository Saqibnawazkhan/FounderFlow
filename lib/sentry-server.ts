/**
 * Tiny wrapper so server actions can log errors locally AND ship them to
 * Sentry with consistent tagging in one call. Sentry's captureException is
 * a no-op when SENTRY_DSN is unset, so this is safe to call unconditionally.
 *
 * Usage:
 *   try { ... } catch (e) {
 *     captureServerError(e, {
 *       action: "signupAction",
 *       userId: session.user.id,
 *       companyId: session.user.companyId,
 *       extra: { input },
 *     });
 *     return { success: false, error: "..." };
 *   }
 *
 * `userId` and `companyId` are first-class params instead of stashed in
 * `extra` because triage needs them on every issue. Sentry's `user.id`
 * also unlocks the "Affected users" widget — that's how we tell "one bug
 * hit one user" apart from "one bug hit 500 users."
 */

import * as Sentry from "@sentry/nextjs";

export function captureServerError(
  err: unknown,
  context: {
    action: string;
    /** Caller's user id — auto-populated as Sentry user context. */
    userId?: string;
    /** Caller's company id — auto-populated as a Sentry tag. */
    companyId?: string;
    extra?: Record<string, unknown>;
  } = { action: "unknown" }
): void {
  // Local log so we still see it in Vercel function logs even without Sentry.
  // eslint-disable-next-line no-console
  console.error(`[${context.action}] failed:`, err);

  Sentry.captureException(err, {
    tags: {
      boundary: "server-action",
      action: context.action,
      ...(context.companyId ? { companyId: context.companyId } : {}),
    },
    user: context.userId ? { id: context.userId } : undefined,
    extra: context.extra,
  });
}
