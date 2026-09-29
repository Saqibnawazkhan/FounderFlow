/**
 * The two cookies the pre-paint shell script reads (i18n-002).
 *
 * WHY THIS MODULE EXISTS AT ALL. `shellBootstrap` in app/layout.tsx applies the
 * theme class, `lang` and `dir` to <html> before first paint. Its only source
 * used to be the persisted Zustand snapshot in localStorage, which is empty in
 * exactly the case the bug is about — a new phone, a private window, cleared
 * site data. An Urdu user therefore got a full left-to-right English paint and
 * then watched the whole document flip once `PreferenceHydrator` had finished a
 * server round-trip. The durable value lives on `User.theme` / `User.locale`, so
 * on a first visit it is only knowable SERVER-SIDE.
 *
 * The root layout deliberately does not resolve it server-side: <html> is
 * rendered there and nowhere else, for every route including `/`, and calling
 * `cookies()` or `auth()` in it opts the whole app — marketing page included —
 * out of static generation. So the value is PRODUCED here, whenever the server
 * learns it (sign-in, sign-up, a preference change), and CONSUMED pre-paint.
 *
 * WHY IT IS NOT IN `lib/actions/appearance.ts`. That module is `"use server"`,
 * and every export of a `"use server"` module is a public POST endpoint with a
 * build-stable id that ships in the client bundle — see the header of
 * tests/lib/actions/use-server-exports.test.ts for the incident that taught this
 * repo the lesson. A `writeAppearanceCookiesAction` would be an unauthenticated
 * endpoint that writes cookies into any visitor's browser, which is worse than
 * the bug it would fix. A plain module both sides import is the prescribed
 * shape: the module boundary does the work the `export` keyword cannot.
 *
 * WHY THESE COOKIES ARE NOT HttpOnly — the one attribute that deserves an
 * argument. An inline <head> script has to read them through `document.cookie`,
 * which HttpOnly exists precisely to prevent, so HttpOnly here would make the
 * fix inert again. That is acceptable because of what they carry and what reads
 * them: a UI language and a colour scheme — no identity, no secret, nothing that
 * authorises anything, and nothing an attacker could not already observe by
 * looking at the rendered page. Read in the other direction, a forged value is
 * equally cheap: the bootstrap validates it against its own `LOCALES` list and
 * coerces anything else, so the worst a tampered cookie achieves is the wrong
 * text direction in the tamperer's own browser until hydration corrects it.
 * The session cookie, which does authorise things, stays HttpOnly and is
 * Auth.js's business, not this module's.
 */

import { cookies } from "next/headers";

import { captureServerError } from "@/lib/sentry-server";

export const THEME_COOKIE = "ff_theme";
export const LOCALE_COOKIE = "ff_locale";

/**
 * A year. The cookie is a cache of a durable row, so a short lifetime buys
 * nothing and costs the pre-paint on the one visit that needed it most — the
 * person who comes back to the app after a fortnight.
 */
export const APPEARANCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type AppearanceTheme = "light" | "dark";
export type AppearanceLocale = "en" | "ur";

export type Appearance = { theme: AppearanceTheme; locale: AppearanceLocale };

/**
 * What a brand-new row holds, mirroring `prisma/schema.prisma`
 * (`theme @default("dark")`, `locale @default("en")`). Duplicated because a
 * Prisma default is applied by the database and is not readable from the client
 * without a round-trip; `tests/lib/appearance/cookie-options.test.ts` parses the
 * schema and fails if the two ever disagree.
 */
export const DEFAULT_APPEARANCE: Appearance = { theme: "dark", locale: "en" };

/**
 * Both columns are plain `String`, so the database is wider than these unions —
 * a legacy row, a manual `UPDATE` or a future third locale rolled back can all
 * put something else there. Coerce at the boundary rather than trusting it, the
 * same way `getMyAppearanceAction` does and the same way the head script does
 * against its own `LOCALES` list.
 */
export function coerceTheme(value: unknown): AppearanceTheme {
  return value === "light" ? "light" : "dark";
}

export function coerceLocale(value: unknown): AppearanceLocale {
  return value === "ur" ? "ur" : "en";
}

export function coerceAppearance(row: { theme?: unknown; locale?: unknown } | null): Appearance {
  return { theme: coerceTheme(row?.theme), locale: coerceLocale(row?.locale) };
}

/**
 * `Secure` on HTTPS only, judged from `NODE_ENV` rather than from `VERCEL_ENV`.
 *
 * Deliberately NOT `isLiveDeployment()` (lib/billing/event-scope.ts), which
 * answers a different question — "does this deployment take real money?" — and
 * would leave the cookie non-Secure on preview deploys, which are served over
 * HTTPS and should carry the flag. This one is about transport: every Next.js
 * build that is not `next dev` is served over TLS in this project's deployments,
 * and `npm run dev` is plain HTTP on 127.0.0.1, where a `Secure` cookie is
 * dropped by the browser.
 *
 * `env` is a parameter so the decision is unit-testable without mutating
 * `process.env`.
 */
export function isSecureTransport(
  env: { NODE_ENV?: string } = process.env as { NODE_ENV?: string }
): boolean {
  return env.NODE_ENV === "production";
}

/** The attribute set, in one place, so the writer and its tests cannot drift. */
export function appearanceCookieOptions(): {
  path: string;
  maxAge: number;
  sameSite: "lax";
  httpOnly: false;
  secure: boolean;
} {
  return {
    // `/` or the cookie is absent on exactly the routes that matter.
    path: "/",
    maxAge: APPEARANCE_COOKIE_MAX_AGE,
    // Lax, not None: nothing cross-site reads these, and None would additionally
    // require Secure, which would break them on the local dev server.
    sameSite: "lax",
    // Load-bearing, not an oversight. See the module header.
    httpOnly: false,
    secure: isSecureTransport(),
  };
}

/**
 * Publish the signed-in user's appearance to the browser so the next document's
 * <head> script can apply it before first paint.
 *
 * NEVER THROWS. Every call site is a path where something more important has
 * already succeeded — a session has been minted, or a preference has been
 * saved — and turning that into an error over a repaint optimisation would be a
 * far worse bug than the one this closes. `cookies().set()` throws outright when
 * the response has already started streaming, so this is a real case and not
 * defensive decoration. The failure is reported, because a silent one would look
 * exactly like the unreachable state this module was written to end.
 */
export async function writeAppearanceCookies(input: {
  theme?: unknown;
  locale?: unknown;
}): Promise<void> {
  const appearance = coerceAppearance(input);
  try {
    const jar = await cookies();
    const options = appearanceCookieOptions();
    jar.set(THEME_COOKIE, appearance.theme, options);
    jar.set(LOCALE_COOKIE, appearance.locale, options);
  } catch (e) {
    captureServerError(e, { action: "writeAppearanceCookies" });
  }
}

/**
 * Forget the appearance on sign-out.
 *
 * This is the half that is easiest to leave out and the one a customer is most
 * likely to notice: without it, the next person to use a shared browser gets the
 * previous user's language and colour scheme painted before hydration, on the
 * login page, while signed out. `path` is passed explicitly because a delete
 * only matches a cookie with the same path.
 *
 * Never throws, for the same reason as the writer: the session is already gone.
 */
export async function clearAppearanceCookies(): Promise<void> {
  try {
    const jar = await cookies();
    jar.delete({ name: THEME_COOKIE, path: "/" });
    jar.delete({ name: LOCALE_COOKIE, path: "/" });
  } catch (e) {
    captureServerError(e, { action: "clearAppearanceCookies" });
  }
}
