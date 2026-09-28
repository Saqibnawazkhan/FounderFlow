/**
 * Environment validation.
 *
 * SCOPE, READ THIS BEFORE TRUSTING IT. Only `app/robots.ts` and
 * `app/sitemap.ts` import this module. It is NOT app-wide validation and must
 * not be cited as though it were: `process.env` is read directly in ~30 other
 * places, so a var missing here is a var missing everywhere, and only these two
 * routes will say so. The build-time gate in `scripts/vercel-build.mjs` is what
 * actually stands between a misconfigured Production scope and a live deploy;
 * the production assertion at the bottom of this file is a second line for the
 * one var whose absence is invisible until a customer clicks a dead link.
 */

import { z } from "zod";

// Treat empty-string envs the same as unset — `.env.local.example` ships
// with `SENTRY_DSN=""` etc. so devs can see the slot without opting into
// the feature, and z.string().url() would otherwise reject "" as invalid.
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

/**
 * The origin to use when there is no canonical one: local dev and preview
 * builds, which legitimately have none. Declared once so `appOrigin` and the
 * schema default cannot drift apart.
 */
const LOCAL_DEV_ORIGIN = "http://localhost:3000";

const envSchema = z.object({
  // The localhost default stays, for two reasons. Local dev and every preview
  // build legitimately have no canonical origin, and this module throws on a
  // failed parse — making it required outright would break `next dev` and every
  // PR deploy. And a required var here would buy nothing while TEN call sites
  // read the origin for themselves, seven of them repeating
  // `?? "http://localhost:3000"`:
  //
  //   app/layout.tsx:25 (metadataBase)   lib/actions/password-reset.ts:60
  //   lib/actions/team.ts:55             lib/actions/email-change.ts:100
  //   lib/email/verification.ts:17       lib/notify/email.ts:23
  //   lib/lemonsqueezy/config.ts:27
  //
  // The other three do NOT use that fallback, and the differences matter:
  //   app/robots.ts:24 and app/sitemap.ts:5 read `env.NEXT_PUBLIC_APP_URL`
  //     directly, so they get the validated default above rather than a literal.
  //   app/page.tsx:53 falls back to a HARDCODED PRODUCTION DOMAIN
  //     (`|| "https://founderflow-seven.vercel.app"`), not to localhost. So the
  //     landing page's canonical and OG URLs silently point at that domain
  //     whenever the var is unset — and keep pointing at it if the deployment
  //     ever moves. That one is a latent bug, not just a duplicated default.
  //
  // (This said SEVEN and listed seven until 2026-09-28. An undercount here is
  // not cosmetic: this comment is the evidence base for deciding whether to make
  // the var required, and it was missing the only site with a non-localhost
  // fallback.) `appOrigin()` below is the one decision all of them are meant to
  // call; the production assertion further down is what stops the default
  // reaching a customer in the meantime.
  NEXT_PUBLIC_APP_URL: z.string().url().default(LOCAL_DEV_ORIGIN),

  DATABASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: optionalUrl,

  EMAIL_VERIFICATION_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  EMAIL_FROM: z.string().optional(),

  SENTRY_DSN: optionalUrl,

  // prodready-006. This module validated only SENTRY_DSN, so the variable
  // `sentry.client.config.ts` actually reads was a name no part of the repo had
  // ever declared — which is precisely how a deploy could look fully configured
  // for error reporting while every browser crash went nowhere. Declaring it
  // here does not make it required (it is not: see RECOMMENDED_PROD_ENV in
  // scripts/vercel-build.mjs, and the pair rule that refuses exactly one of
  // the two); it makes it a name the codebase knows about, and a malformed
  // value a parse error instead of a silent no-op.
  //
  // It has to carry the NEXT_PUBLIC_ prefix. A server-only variable is not
  // inlined into the client bundle, so reading SENTRY_DSN in browser code
  // compiles to `undefined` and the SDK never initialises.
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
});

/**
 * The live production deployment, as Vercel reports it. `preview` and unset
 * both mean "not production" — a preview deploy has no canonical origin of its
 * own and must not be held to one.
 */
const IS_PRODUCTION_DEPLOY = process.env.VERCEL_ENV === "production";

/**
 * Is this URL pointed at the machine it is running on?
 *
 * Exported and pure so the decision is unit-testable without mutating
 * process.env, and mirrored in `scripts/vercel-build.mjs` — the build gate has
 * to make the same call before `next build` runs, and cannot import a TS module
 * that pulls in zod.
 */
export function isLoopbackUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (host.slice(-10) === ".localhost") return true;
  return /^127\./.test(host);
}

/**
 * Why a production deployment must not accept this NEXT_PUBLIC_APP_URL, or null
 * if it is fine. Takes the RAW value so "unset" and "set to localhost" are
 * distinguishable — after the schema's `.default()` they are not.
 *
 * Both cases produce the identical customer-visible failure: every invite,
 * password-reset, e-mail-change and verification link in every e-mail points at
 * `http://localhost:3000`. The invited teammate cannot join, the locked-out
 * founder cannot get back in, and the LemonSqueezy checkout returns the buyer
 * to their own laptop after they have paid. Nothing logs, and the app looks
 * healthy from the outside.
 */
export function productionAppUrlProblem(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") {
    return (
      "NEXT_PUBLIC_APP_URL is not set on a production deployment, so every e-mail " +
      "link falls back to http://localhost:3000. It is a NEXT_PUBLIC_ var, i.e. inlined " +
      "at BUILD time — set it in Vercel → Production and redeploy; setting it without a " +
      "redeploy changes nothing."
    );
  }
  if (isLoopbackUrl(raw)) {
    return (
      `NEXT_PUBLIC_APP_URL is "${raw}", a loopback address, on a production ` +
      "deployment. That is the .env.local.example value; in production it means every " +
      "invite and password-reset link a customer receives points at their own machine."
    );
  }
  return null;
}

const parsed = envSchema.safeParse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_URL: process.env.AUTH_URL,
  EMAIL_VERIFICATION_REQUIRED: process.env.EMAIL_VERIFICATION_REQUIRED,
  EMAIL_FROM: process.env.EMAIL_FROM,
  SENTRY_DSN: process.env.SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
});

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables — see console");
}

// Production-only. `robots.ts` and `sitemap.ts` are statically generated, so on
// a production Vercel build this throw happens during `next build` and fails
// the deploy — which is the outcome we want, and the reason it is safe to be
// this blunt. On the unlikely runtime path it costs /robots.txt and
// /sitemap.xml rather than the app, because nothing else imports this module.
// A localhost sitemap is also why the marketing site would be unindexable.
if (IS_PRODUCTION_DEPLOY) {
  const problem = productionAppUrlProblem(process.env.NEXT_PUBLIC_APP_URL);
  if (problem) {
    console.error("Invalid production environment:", problem);
    throw new Error(`Invalid production environment: ${problem}`);
  }
}

export const env = parsed.data;

/**
 * The canonical origin, with no trailing slash — the ONE place that decides what
 * every e-mail link, `metadataBase` and checkout redirect is built onto
 * (prodready-004).
 *
 * WHY NORMALISATION IS THE POINT AND NOT A TIDY-UP. Every link in this app is
 * built by concatenation: `` `${origin}/reset-password/${token}` ``. Seven call
 * sites currently read `process.env.NEXT_PUBLIC_APP_URL` with their own
 * `?? "http://localhost:3000"`, and exactly one of them — `lib/actions/team.ts`
 * — strips a trailing slash. Copying the origin out of a browser address bar
 * gives you `https://app.founderflow.com/`, and the other six then emit
 * `https://app.founderflow.com//reset-password/<token>`. A doubled slash in a
 * path is the sort of URL that works in one mail client and 404s in the next,
 * and it lands on a locked-out customer clicking a single-use link.
 *
 * `raw` is a parameter, defaulting to the validated value, so the decision is
 * unit-testable without mutating `process.env`. Call it with no argument.
 *
 * Note this does NOT decide whether the value is acceptable — see
 * `productionAppUrlProblem` and the build gate in `scripts/vercel-build.mjs` for
 * that. This function always returns a usable origin, because a page that
 * throws is not an improvement on a page with a wrong link.
 */
export function appOrigin(raw: string | undefined = env.NEXT_PUBLIC_APP_URL): string {
  const value = raw === undefined ? "" : raw.trim();
  // A whitespace-only value is "I added the variable in Vercel and forgot the
  // value". Note what this branch can and cannot catch: reached through the
  // default argument it is effectively unreachable, because the schema above
  // validates with `.url()`, so `"   "` fails the parse and this module throws
  // before `appOrigin()` is ever called. It earns its place for the EXPLICIT
  // `appOrigin(someRawString)` call — and because the seven `??` sites read
  // `process.env` directly, bypassing the schema entirely, so for them a
  // whitespace value really does become a bare-path link.
  return (value === "" ? LOCAL_DEV_ORIGIN : value).replace(/\/+$/, "");
}
