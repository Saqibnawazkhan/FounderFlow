/**
 * Environment validation.
 *
 * SCOPE, READ THIS BEFORE TRUSTING IT. This is still NOT app-wide validation and
 * must not be cited as though it were: `process.env` is read directly in ~30
 * other places, so a var missing here is a var missing almost everywhere. The
 * build-time gate in `scripts/vercel-build.mjs` is what actually stands between a
 * misconfigured Production scope and a live deploy; the production assertion at
 * the bottom of this file is a second line for the one var whose absence is
 * invisible until a customer clicks a dead link.
 *
 * What DID change, 2026-09-29: this used to say "only `app/robots.ts` and
 * `app/sitemap.ts` import this module", and that is no longer true. Wiring
 * `appOrigin()` into its call sites (prodready-004) added `app/layout.tsx`,
 * `app/page.tsx`, `lib/email/verification.ts`, `lib/notify/email.ts` and
 * `lib/lemonsqueezy/config.ts`. `app/layout.tsx` is the root layout, so the
 * module — and therefore the parse below and the production assertion at the
 * bottom — now evaluates on every route rather than on two static files. Read
 * that sentence as history, not as a census: more importers have arrived since,
 * and the current set is the enforced IMPORTERS block beside the production
 * assertion at the bottom of this file.
 *
 * That widening is deliberate and costs nothing in practice: `robots.ts` and
 * `sitemap.ts` are statically generated, so this module already evaluated during
 * every `next build`, and anything that throws here already failed the build
 * before a deploy could serve it. The gain is that a production deploy with a
 * loopback origin can no longer be saved by someone deleting the sitemap.
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
  // The localhost default stays. Local dev and every preview build legitimately
  // have no canonical origin, and this module throws on a failed parse — making
  // it required outright would break `next dev` and every PR deploy. What makes
  // that default safe is that a *production* deploy cannot reach it:
  // NEXT_PUBLIC_APP_URL is in `requiredProdEnv` in scripts/vercel-build.mjs (the
  // build fails without it) and `productionAppUrlProblem` below rejects a
  // loopback value even when one is present.
  //
  // HISTORY, because the shape of the error is this repo's recurring one. Until
  // 2026-09-28 this comment said SEVEN call sites read the origin for
  // themselves; it was then corrected to TEN, listing the seven that repeated
  // `?? "http://localhost:3000"`, the two that read the validated value, and
  // app/page.tsx, which fell back to a hard-coded deployment hostname instead.
  // Both versions were accurate when written and both described a problem that
  // no longer exists: as of 2026-09-29 `appOrigin()` is actually WIRED, so the
  // duplication the comment existed to measure is down to the three sites named
  // below — and that residue is machine-checked rather than remembered.
  //
  // RAW READERS REMAINING (ceiling, enforced by tests/lib/env/app-origin-call-sites.test.ts):
  //   lib/actions/password-reset.ts
  //   lib/actions/email-change.ts
  //   lib/actions/team.ts
  //
  // Those three belong to another agent in the same wave and may already be
  // done; the list is enforced as a CEILING, so it is true either way. What the
  // test refuses is a file OUTSIDE it reading `process.env.NEXT_PUBLIC_APP_URL`
  // directly — which is how the duplication came back last time, one reasonable
  // one-liner at a time. If you genuinely need the raw value, add the file here
  // so the next reader is not misled.
  //
  // Everything else now goes through `appOrigin()`. That list is NOT repeated
  // here: every module importing this one imports it for `appOrigin`, so the
  // enforced IMPORTERS block beside the production assertion at the bottom of
  // this file already is the list, derived from the import graph rather than
  // typed out. A second hand-written copy is how this very comment came to omit
  // lib/email/templates/security-notice.ts (prodready-016).
  NEXT_PUBLIC_APP_URL: z.string().url().default(LOCAL_DEV_ORIGIN),

  DATABASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: optionalUrl,

  // auth-018. RESERVED, AND REFUSED IN THE ON POSITION. Read
  // `emailVerificationFlagProblem` below before touching this: the name is kept
  // deliberately, but setting it to "true" stops the boot, because the gate it
  // names has never existed and a flag that looks like it works is worse than no
  // flag. The parsed value is therefore always `false`.
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

/**
 * Why a deploy must not accept `EMAIL_VERIFICATION_REQUIRED=true`, or null if the
 * flag is off or absent (auth-018).
 *
 * THE STATE OF PLAY, measured rather than remembered. The soft gate shipped
 * 2026-07-04: `User.emailVerifiedAt`, an HMAC-signed link, a `/verify-email`
 * page, a dismissible banner with a Resend button. The HARD gate never shipped.
 * Nothing in this repo reads `emailVerifiedAt` as a permission — the only reads
 * are `lib/actions/email-verification.ts` (report status, stamp the column) and
 * `lib/actions/email-change.ts` (stamp it on a confirmed change). A sweep for a
 * code reference to this variable outside this file returns zero hits, and
 * `tests/lib/env/verification-flag.test.ts` keeps that measurement honest.
 *
 * So until today the flag was a switch with nothing on the other end. That is a
 * specific, expensive failure and not a cosmetic one: an operator sets it,
 * believes unverified accounts cannot reach the product, and every unverified
 * account can. A false security belief is worse than a missing feature, because
 * it stops anyone looking. `prisma/schema.prisma:92`, `FaultsAudit.md:88` and
 * `CODEBASE-AUDIT.md:189` all record the reservation — and none of them is the
 * file somebody reads while typing an environment variable into a dashboard.
 *
 * WHY REFUSE RATHER THAN IMPLEMENT. Enforcing verification is a product decision
 * with a customer-visible blast radius, not a bug fix. Every account that has not
 * clicked its link is unverified, because nothing ever required it — so switching
 * the gate on locks out paying customers on the next deploy, with no back-fill
 * and no grace period, on a product days from taking real money. Whoever owns the
 * product decides that, and it needs at minimum: a deliberate back-fill of
 * `emailVerifiedAt` for accounts that predate the requirement, a grace window, a
 * check in `authorize()` plus a `verified` claim on the token so middleware can
 * act on it without a database read, and a path for an invited teammate — whose
 * address is already proven by the invite link they clicked — not to be caught by
 * it. None of that is a configuration change.
 *
 * WHY REFUSE RATHER THAN DELETE. Deleting the name would make
 * `prisma/schema.prisma:92` and the two audit documents point at nothing, which
 * is the dangling reference the 2026-09-23 audit explicitly declined to create —
 * and the next person would reinvent the same dead switch. Keeping the name and
 * refusing the on position preserves the reservation and removes the trap.
 *
 * Deliberately unconditional, unlike `productionAppUrlProblem`: an operator who
 * sets this locally is forming the same false belief as one who sets it in
 * Vercel, and should learn at the same volume. On a production Vercel build this
 * throws during `next build`, so the deploy fails and the previous deployment
 * keeps serving — the fail-closed posture the rest of this layer uses.
 *
 * Takes the RAW value so it is unit-testable without mutating `process.env`.
 */
export function emailVerificationFlagProblem(raw: string | undefined): string | null {
  if ((raw === undefined ? "" : raw.trim()) !== "true") return null;
  return (
    'EMAIL_VERIFICATION_REQUIRED is set to "true", but the hard gate it names has never been ' +
    "implemented: nothing in this app reads User.emailVerifiedAt as a permission, so the flag " +
    "grants no protection whatsoever and believing it does is worse than not having it. Unset " +
    "it, or set it to false, to boot. Turning verification into a requirement is a product " +
    "decision, not a configuration change — with no back-fill it would lock out every existing " +
    "customer who has not clicked their link, on the next deploy, with no grace period. See " +
    "emailVerificationFlagProblem in lib/env.ts for what a real gate would have to change."
  );
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

// Every environment, not just production — see emailVerificationFlagProblem for
// why an operator who sets this locally needs the same answer as one who sets it
// in Vercel. Placed before the production block so the more specific complaint
// wins when a deploy has both problems.
const verificationFlagProblem = emailVerificationFlagProblem(
  process.env.EMAIL_VERIFICATION_REQUIRED
);
if (verificationFlagProblem) {
  console.error("Invalid environment:", verificationFlagProblem);
  throw new Error(`Invalid environment: ${verificationFlagProblem}`);
}

// Production-only. `robots.ts` and `sitemap.ts` are statically generated, so on
// a production Vercel build this throw happens during `next build` and fails
// the deploy — which is the outcome we want, and the reason it is safe to be
// this blunt. NOTE the runtime blast radius changed with prodready-004: eleven
// modules now import this one, including app/layout.tsx (the root layout), so a
// runtime throw here takes EVERY route rather than just /robots.txt and
// /sitemap.xml. That is still the outcome we want — a production deploy with no
// canonical origin emits broken links in every email — but it is no longer the
// small, contained failure this comment used to promise.
// A localhost sitemap is also why the marketing site would be unindexable.
//
// That sentence said "nine" until 2026-10-04 (prodready-016), by which time two
// more modules had started importing this one. An under-count here is an
// under-statement of how much of the product a throw in this file takes down,
// which is the one thing this paragraph exists to tell the next reader. It is
// therefore no longer remembered: the list below is compared against the real
// import graph, and the number in the sentence above against its length, so an
// importer cannot be added without this paragraph being corrected in the same
// edit. Every entry imports this module for `appOrigin`, so this is also the
// complete list of `appOrigin()` call sites.
//
// IMPORTERS (derived and enforced by tests/lib/env/self-description.test.ts):
//   app/layout.tsx
//   app/page.tsx
//   app/robots.ts
//   app/sitemap.ts
//   lib/actions/email-change.ts
//   lib/actions/password-reset.ts
//   lib/actions/team.ts
//   lib/email/templates/security-notice.ts
//   lib/email/verification.ts
//   lib/lemonsqueezy/config.ts
//   lib/notify/email.ts
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
 * built by concatenation: `` `${origin}/reset-password/${token}` ``. Copying the
 * origin out of a browser address bar gives you `https://app.founderflow.com/`,
 * which is a perfectly valid `.url()` and passes every other check in this file —
 * and every call site that concatenated onto it emitted
 * `https://app.founderflow.com//reset-password/<token>`. A doubled slash in a
 * path is the sort of URL that works in one mail client and 404s in the next,
 * and it lands on a locked-out customer clicking a single-use link.
 *
 * Until 2026-09-29 this function had ZERO callers while prodready-004 was
 * recorded as fixed. It is now called by the sites listed against
 * NEXT_PUBLIC_APP_URL above; see the ceiling block there for what is left.
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
  // `appOrigin(someRawString)` call — and for the call sites still reading
  // `process.env` directly (the ceiling block above), which bypass the schema
  // entirely, so for them a whitespace value really does become a bare-path link.
  return (value === "" ? LOCAL_DEV_ORIGIN : value).replace(/\/+$/, "");
}
