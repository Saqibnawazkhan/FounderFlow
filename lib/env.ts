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

const envSchema = z.object({
  // The localhost default stays, for two reasons. Local dev and every preview
  // build legitimately have no canonical origin, and this module throws on a
  // failed parse — making it required outright would break `next dev` and every
  // PR deploy. And it would buy nothing today: six call sites
  // (lib/actions/password-reset.ts, lib/actions/team.ts,
  // lib/actions/email-change.ts, lib/email/verification.ts, lib/notify/email.ts,
  // lib/lemonsqueezy/config.ts) each repeat `?? "http://localhost:3000"`
  // themselves, so the fallback would simply move. Routing those through
  // `env.NEXT_PUBLIC_APP_URL` is the follow-up that makes this the only
  // fallback decision in the codebase; until then see the production
  // assertion below, which is what stops the default reaching a customer.
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: optionalUrl,

  EMAIL_VERIFICATION_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  EMAIL_FROM: z.string().optional(),

  SENTRY_DSN: optionalUrl,
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
