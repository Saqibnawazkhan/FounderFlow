/**
 * Where to send somebody the moment they finish signing in (auth-017).
 *
 * THE PROBLEM THIS EXISTS FOR. `authorized()` in auth.config.ts returns `false`
 * for an unauthenticated request to a non-public route. next-auth's middleware
 * wrapper then clones the request URL, swaps the pathname for `pages.signIn`,
 * and sets `callbackUrl` to the FULL original href
 * (node_modules/next-auth/lib/index.js:177). So the destination survives the
 * bounce intact — and `app/login/page.tsx` used to discard it with a hard-coded
 * `window.location.href = "/dashboard"`. Every emailed notification link and
 * every bookmark lost its destination the moment a session expired;
 * `scripts/qa-auth-and-sessions.mjs:1305` records it from a live browser run.
 *
 * WHY IT IS A NAMED DECISION AND NOT THREE LINES IN THE COMPONENT. A redirect
 * target read out of a query parameter is an open redirect unless it is
 * validated. `/login?callbackUrl=https://evil.example/harvest` is a link that
 * genuinely starts on this app's own origin, and following it hands a
 * just-authenticated founder to a replica of their own finance app at the exact
 * moment they expect a page they do not recognise. The validation therefore
 * lives in one pure, unit-tested place — the same reason `appOrigin()` in
 * lib/env.ts is one function rather than a `??` in nine files.
 *
 * THE RULE, in one sentence: resolve the candidate against the origin we are
 * actually running on, demand the resolved origin match, and demand the
 * resolved path start with a route this app serves.
 *
 * Both halves matter. Origin alone is not enough — `/wp-admin` and
 * `/api/cron/purge-soft-deleted` are same-origin and are not places a person
 * lands. Path alone is not enough either, obviously. And doing the path check on
 * the RESOLVED pathname rather than the raw string is what stops
 * `/dashboard/../wp-admin`, which begins with an allowed segment and ends
 * somewhere else.
 *
 * A consequence worth stating rather than discovering: because the allow-list is
 * exactly the authenticated `(app)` group, every auth page is rejected for free.
 * `/login?callbackUrl=/login` — reachable, since the auth pages are public —
 * would otherwise produce a sign-in that visibly does nothing.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: role checks. A member who was bounced off
 * /expenses is sent back to /expenses, and the middleware's own role gate then
 * redirects them to /tasks (auth.config.ts). One extra hop, and the role
 * decision stays in the one place that has a trustworthy role claim — the client
 * has only what the user could edit.
 */

/** Where a sign-in with nothing to restore goes. */
export const POST_LOGIN_DEFAULT = "/dashboard";

/**
 * First path segments a post-login redirect may land on: the authenticated
 * route group, and nothing else.
 *
 * Kept as data rather than inferred at runtime because this has to work in the
 * browser bundle, where there is no filesystem. Drift is the obvious hazard — a
 * route added next quarter would silently become a deep link that resolves to
 * /dashboard, which looks like nothing at all — so the list is compared against
 * the real `app/(app)` directory listing by
 * tests/lib/auth/post-login-redirect.test.ts, in both directions.
 */
export const POST_LOGIN_ALLOWED_SEGMENTS: readonly string[] = [
  "activities",
  "budgets",
  "chat",
  "dashboard",
  "expenses",
  "investments",
  "notifications",
  "projects",
  "recurring",
  "reports",
  "revenue",
  "settings",
  "tasks",
  "team",
  "time",
];

/**
 * The same-origin, in-app path to navigate to after a successful sign-in, or
 * `fallback` if the candidate is missing, malformed, off-origin, or not a page
 * this app serves. Never throws, and never returns anything but an absolute
 * in-app path: a broken redirect target must degrade to the dashboard, not to an
 * error screen on top of a successful login.
 *
 * @param rawCallbackUrl the `callbackUrl` query parameter, exactly as received
 * @param currentOrigin  the origin we are running on — `window.location.origin`
 */
export function safePostLoginPath(
  rawCallbackUrl: string | null | undefined,
  currentOrigin: string,
  fallback: string = POST_LOGIN_DEFAULT
): string {
  const candidate = typeof rawCallbackUrl === "string" ? rawCallbackUrl.trim() : "";
  if (candidate === "") return fallback;

  // Control characters. Browsers STRIP tab, CR and LF from a URL before parsing
  // it, so `java\tscript:alert(1)` is `javascript:alert(1)` by the time it
  // reaches a navigation and must not survive a check done on the raw string.
  // A char-code loop rather than a regex: `\x00-\x1f` in a literal trips
  // eslint's no-control-regex, and ES5 is the effective tsc target here.
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return fallback;
  }

  // A backslash is a forward slash to every browser's URL parser, so
  // `/\evil.example` is `//evil.example`: protocol-relative, and off-origin. The
  // resolution below catches it too; this is here so the reason is legible and
  // so the check does not depend on one parser's quirk handling.
  if (candidate.indexOf("\\") !== -1) return fallback;
  if (candidate.charAt(0) === "/" && candidate.charAt(1) === "/") return fallback;

  let here: URL;
  let target: URL;
  try {
    here = new URL(currentOrigin);
    target = new URL(candidate, here);
  } catch {
    return fallback;
  }

  // `origin` is scheme + host + port, compared whole. That is what makes
  // `https://app.founderflow.com.evil.example`, `https://evil.app.founderflow.com`
  // and `http://localhost:3000@evil.example` all fail: none of them shares an
  // origin with us, however much of ours their string contains. A non-special
  // scheme such as `javascript:` or `data:` has the origin "null", so it fails
  // here too rather than needing its own scheme deny-list.
  if (target.origin !== here.origin) return fallback;

  const segment = target.pathname.split("/")[1];
  if (POST_LOGIN_ALLOWED_SEGMENTS.indexOf(segment) === -1) return fallback;

  return target.pathname + target.search + target.hash;
}
