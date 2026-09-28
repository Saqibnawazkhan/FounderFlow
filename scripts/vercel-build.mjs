#!/usr/bin/env node
/**
 * Vercel build entry — the fix for the 2026-07-03 outage, and since this wave
 * also the gate that stops a misconfigured production deploy reaching anyone.
 *
 * What happened on 2026-07-03: the Decimal + soft-delete migrations shipped in
 * code and the generated Prisma client expected columns that didn't exist
 * on the production Supabase. Every RSC that touched those columns errored
 * → the site was down until someone ran `prisma migrate deploy` by hand.
 *
 * What this script does now, on every PRODUCTION build and in this order:
 *   1. refuse the build if the Production environment is misconfigured, and
 *   2. apply pending migrations.
 * If either step fails the whole build fails, and Vercel serves the previous
 * deployment untouched. Preview builds skip both: they have no separate DB
 * (so they must not touch prod's schema) and they legitimately lack several of
 * the secrets below.
 *
 * ── WHY STEP 1 EXISTS ──────────────────────────────────────────────────────
 * Every var in REQUIRED_PROD_ENV is optional in `lib/env.ts`, because local
 * dev and preview must run without it. The consequence is that forgetting one
 * in Vercel's Production scope BUILDS GREEN and then fails at runtime, quietly,
 * in a way no customer reports as a bug:
 *
 *   - no AUTH_SECRET     → every authenticated request throws.
 *   - no DATABASE_URL    → every query throws.
 *   - no DIRECT_URL      → step 2 cannot run (see the pgbouncer note below).
 *   - no CRON_SECRET     → all three nightly jobs return 500 for ever. Nothing
 *                          materializes recurring revenue/expense rules, so
 *                          every customer's ledger, runway and budget figures
 *                          drift away from reality; running timers are never
 *                          auto-closed; soft-deleted workspaces are never
 *                          purged. The only trace is a 500 in the cron log.
 *   - no NEXT_PUBLIC_APP_URL → every invite, password-reset, e-mail-change and
 *                          verification link points at http://localhost:3000,
 *                          so invited teammates cannot join and locked-out
 *                          customers cannot get back in. It is a NEXT_PUBLIC_
 *                          var, i.e. baked into the bundle at build time —
 *                          setting it afterwards changes nothing until a
 *                          redeploy, which is exactly why it belongs here and
 *                          not in a runtime check.
 *   - no GMAIL_USER / GMAIL_APP_PASSWORD → `lib/email/send.ts` falls back to
 *                          logging the message and reports success, so
 *                          /forgot-password tells a locked-out customer to
 *                          check their inbox and sends nothing. Password reset
 *                          is the only self-service recovery path there is.
 *
 * A build that fails is a deploy that never happened. A build that succeeds
 * and is broken is an outage. That asymmetry is the whole argument for doing
 * this here rather than logging a warning at runtime.
 *
 * ── AND WHY A WARNING LIST TOO ─────────────────────────────────────────────
 * Not everything that is wrong with a Production scope should stop a deploy.
 * The asymmetry above cuts both ways: a build that refuses to ship because an
 * observability tool is not configured is its own kind of outage. So
 * REQUIRED_PROD_ENV holds the things that break customers, and
 * RECOMMENDED_PROD_ENV holds the things that leave the TEAM blind — printed
 * loudly, never fatal.
 *
 * The one exception, and the reason prodready-006 is a gate rather than a
 * warning: HALF a Sentry configuration. `SENTRY_DSN` without
 * `NEXT_PUBLIC_SENTRY_DSN` gives a deploy that reports server errors, drops
 * every browser crash, and still tells the customer "The team has been
 * notified" on the error screen. A state that misrepresents itself is worse
 * than a state that is plainly off, so it is refused.
 *
 * ── AND WHY A FORBIDDEN LIST ───────────────────────────────────────────────
 * `RATE_LIMIT_DISABLED=true` makes every limiter in `lib/rate-limit.ts` return
 * `{ allowed: true }` — including the login bucket that is the app's only
 * brute-force threshold. It is one line in a dashboard, it has no runtime
 * signal of any kind, and until this wave nothing anywhere stopped it being
 * set in the Production scope. A fail-open security switch that can be flipped
 * silently is not a knob, so a production build refuses to proceed with it on.
 *
 * ── Env vars this script reads ──────────────────────────────────────────────
 *   VERCEL_ENV — set automatically by Vercel; every gate here keys off it.
 *   Everything else: see REQUIRED_PROD_ENV / RECOMMENDED_PROD_ENV /
 *   FORBIDDEN_PROD_ENV / VALUE_RULES, which are the single source of truth.
 *   CLAUDE.md's "Vercel env vars this depends on" table now matches
 *   REQUIRED_PROD_ENV row for row, but it names no Sentry variable at all —
 *   SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN, SENTRY_AUTH_TOKEN, SENTRY_ORG and
 *   SENTRY_PROJECT are all missing from it. Trust these four objects, not the
 *   table, and add those five rows when you next touch the doc.
 *
 * Local dev never runs this — `npm run dev` and `npm run build` still call
 * `next` directly. This is Vercel-only.
 *
 * The decision functions are exported and unit-tested in
 * tests/lib/env/build-config.test.ts. A guard nobody can test is a guard
 * somebody deletes.
 */

import { spawnSync } from "node:child_process";

const IS_PROD_BUILD = process.env.VERCEL_ENV === "production";

/**
 * Secrets a production deploy cannot work without, each with the runtime
 * failure it prevents. The text is printed verbatim into the build log, so it
 * is written for whoever is staring at a red deploy at 2am.
 */
const REQUIRED_PROD_ENV = {
  DATABASE_URL:
    "runtime queries (pooler URL, port 6543). Set it in Vercel → Settings → " +
    "Environment Variables → Production scope.",
  DIRECT_URL:
    "prisma migrate deploy needs a direct connection (port 5432) — the pgbouncer " +
    "transaction pooler breaks migrations. Set it in the Production scope.",
  AUTH_SECRET:
    "Auth.js signing secret. Without it every authenticated request throws. " +
    "Set it in the Production scope.",
  CRON_SECRET:
    "the bearer token Vercel Cron sends, and the only thing guarding the three " +
    "nightly jobs. Without it materialize-recurring, sweep-time-entries and " +
    "purge-soft-deleted all return 500 every night — recurring rules never " +
    "materialize, so every ledger, runway and budget figure silently drifts.",
  NEXT_PUBLIC_APP_URL:
    "the canonical origin baked into every e-mail link and into metadataBase. " +
    "Without it invites, password resets and e-mail-change confirmations all " +
    "point at http://localhost:3000. NEXT_PUBLIC_ vars are inlined at BUILD " +
    "time, so this cannot be fixed by setting it later without a redeploy.",
  GMAIL_USER:
    "the SMTP account. With it unset lib/email/send.ts logs the message instead " +
    "of sending it and still reports success, so /forgot-password tells a " +
    "locked-out customer to check an inbox nothing was sent to.",
  GMAIL_APP_PASSWORD:
    "the SMTP app password. Same failure as GMAIL_USER — either both are set or " +
    "no mail leaves the building.",
};

/**
 * Vars a production deploy WORKS without, but whose absence leaves the team
 * unable to see what customers are hitting. Printed on every production build
 * and never fatal — see the header for why that asymmetry is deliberate.
 */
const RECOMMENDED_PROD_ENV = {
  SENTRY_DSN:
    "server-side error reporting (lib/sentry-server.ts, sentry.server.config.ts). " +
    "Without it every server-action, RSC and route-handler failure is visible only as a " +
    "line in a Vercel function log nobody is watching.",
  NEXT_PUBLIC_SENTRY_DSN:
    "browser-side error reporting (sentry.client.config.ts). Without it every client " +
    "crash — the whole (app) error boundary and the root fatal boundary — is invisible, " +
    "while app/error.tsx tells the customer \"The team has been notified\".",
};

/** The three vars @sentry/nextjs needs to upload source maps. */
const SENTRY_UPLOAD_ENV = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];

/**
 * Vars that must NOT be switched on in a production build, each with the
 * protection they switch off. Adding an entry is one line; that is deliberate,
 * because "which env var can silently disable a control?" should be answerable
 * by reading this object.
 */
const FORBIDDEN_PROD_ENV = {
  RATE_LIMIT_DISABLED:
    "a blanket bypass for every limiter in lib/rate-limit.ts, including the " +
    "login bucket that is the app's only brute-force threshold. Nothing logs " +
    'when it is on. Unset it (or set it to "false") in the Production scope; ' +
    "if you are debugging a limiter, do it on a preview deploy.",
};

/**
 * Values that look truthy to a human. `lib/rate-limit.ts` only honours exactly
 * `"true"`, but a Production var set to `1` or `yes` says what the person
 * MEANT, and the next reader is one "fix" away from making it bite. Refuse the
 * intent, not just the literal.
 */
const TRUTHY_VALUES = ["true", "1", "yes", "on"];

/**
 * Treat an empty string as unset. Vercel lets you save a var with no value,
 * and `.env.local.example` ships `GMAIL_USER=""` so devs can see the slot
 * without opting in — so an empty string is the single most likely shape of "I
 * added the variable and forgot the value". The old `!process.env[k]` filter
 * caught it too; this helper exists so the rule is stated once, and so a value
 * that is nothing but whitespace is caught as well.
 */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Is this URL pointed at the machine it is running on?
 *
 * Checked separately from "is it set", because the realistic accident is not an
 * empty NEXT_PUBLIC_APP_URL — it is the localhost value copied out of
 * `.env.local.example` into the Production scope, which passes a presence check
 * and then puts `http://localhost:3000` in a paying customer's invite e-mail.
 */
export function isLoopbackUrl(value) {
  let host;
  try {
    host = new URL(String(value)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]") return true;
  if (host.slice(-10) === ".localhost") return true;
  return /^127\./.test(host);
}

/**
 * Per-var value rules, for the vars where "present" is not the same as
 * "usable". Each returns a problem string, or null when the value is fine.
 * Only consulted once the var is known to be non-blank, so no rule has to
 * re-handle the missing case.
 */
const VALUE_RULES = {
  NEXT_PUBLIC_APP_URL(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return (
        `NEXT_PUBLIC_APP_URL is not an absolute URL (got "${value}"). It must be the ` +
        "full public origin, e.g. https://app.founderflow.com — every e-mail link is built " +
        "by concatenating onto it."
      );
    }
    if (isLoopbackUrl(value)) {
      return (
        `NEXT_PUBLIC_APP_URL points at a loopback host (${parsed.host}). That is the ` +
        ".env.local.example value; in production it means every invite and password-reset " +
        "link a customer receives points at their own machine."
      );
    }
    return null;
  },
  DIRECT_URL(value) {
    // Named because the failure is otherwise a Prisma error about advisory
    // locks that reads like a database problem rather than a config one.
    if (/pgbouncer=true/i.test(value) || /:6543(\/|\?|$)/.test(value)) {
      return (
        "DIRECT_URL looks like the pgbouncer transaction pooler (port 6543 / " +
        "pgbouncer=true). `prisma migrate deploy` needs the session pooler or a direct " +
        "connection on port 5432 — the transaction pooler cannot run the migration " +
        "protocol. DATABASE_URL is the one that wants 6543; DIRECT_URL is not."
      );
    }
    return null;
  },
};

/**
 * prodready-006. Why a MISMATCHED Sentry pair fails the build while an absent
 * one only warns.
 *
 * The two DSNs are not alternatives, they are the two halves of one thing.
 * `SENTRY_DSN` is read by `sentry.server.config.ts`; `NEXT_PUBLIC_SENTRY_DSN` is
 * read by `sentry.client.config.ts`, and it has to be `NEXT_PUBLIC_` because a
 * server-only variable is not inlined into the client bundle and would be
 * `undefined` in the browser. Setting one of them produces a Sentry project that
 * receives events, looks healthy, and is missing an entire half of the
 * application — which is strictly more misleading than a project that receives
 * nothing, because nobody goes looking for the gap.
 *
 * Returns the problem string, or null when the pair is consistent (both set, or
 * both absent — the latter is the warning list's business, not this one's).
 */
export function sentryDsnPairProblem(env) {
  const server = !isBlank(env.SENTRY_DSN);
  const browser = !isBlank(env.NEXT_PUBLIC_SENTRY_DSN);
  if (server === browser) return null;
  if (server) {
    return (
      "NEXT_PUBLIC_SENTRY_DSN is not set although SENTRY_DSN is. Server errors would " +
      "report and every browser crash would be dropped, while app/error.tsx keeps telling " +
      "the customer \"The team has been notified\". Set NEXT_PUBLIC_SENTRY_DSN to the same " +
      "DSN in the Production scope (it must carry the NEXT_PUBLIC_ prefix to reach the " +
      "browser bundle), or unset both."
    );
  }
  return (
    "SENTRY_DSN is not set although NEXT_PUBLIC_SENTRY_DSN is. Browser crashes would " +
    "report and every server action, RSC and route handler failure would be dropped — " +
    "including the ones that touch money. Set SENTRY_DSN in the Production scope, or " +
    "unset both."
  );
}

/**
 * Things that are worth saying about a Production scope but must never stop a
 * deploy. Pure and exported for the same reason as productionEnvProblems.
 */
export function productionEnvWarnings(env) {
  const warnings = [];

  const recommended = Object.keys(RECOMMENDED_PROD_ENV);
  for (const name of recommended) {
    if (isBlank(env[name])) {
      warnings.push(`${name} is not set — ${RECOMMENDED_PROD_ENV[name]}`);
    }
  }

  // The coupling that makes a DSN-only configuration report NOTHING today:
  // next.config.js applies withSentryConfig only when the DSN *and* all three
  // upload vars are present, and that wrapper is what injects
  // sentry.client.config.ts / sentry.server.config.ts into the build. So half a
  // configuration here is not "events without source maps", it is no SDK at all.
  // Remove this warning if next.config.js is ever changed to wrap on the DSN
  // alone — at that point a missing upload trio really would only cost readable
  // stack traces.
  const hasAnyDsn = !isBlank(env.SENTRY_DSN) || !isBlank(env.NEXT_PUBLIC_SENTRY_DSN);
  const missingUpload = SENTRY_UPLOAD_ENV.filter((name) => isBlank(env[name]));
  if (hasAnyDsn && missingUpload.length > 0) {
    warnings.push(
      `A Sentry DSN is set but ${missingUpload.join(", ")} ` +
        `${missingUpload.length === 1 ? "is" : "are"} not. next.config.js only applies ` +
        "withSentryConfig when the DSN and ALL THREE upload vars are present, and that " +
        "wrapper is what bundles the SDK — so as things stand this deploy reports nothing " +
        "at all while looking configured."
    );
  }

  return warnings;
}

/**
 * Every reason this production build must not proceed, as printable lines.
 *
 * Pure, and takes the environment as an argument, so the build's own
 * correctness is testable without setting process.env in a test runner. Returns
 * ALL problems rather than the first: a build takes minutes, and discovering
 * four missing vars one redeploy at a time is how a launch evening disappears.
 */
export function productionEnvProblems(env) {
  const problems = [];

  const required = Object.keys(REQUIRED_PROD_ENV);
  for (const name of required) {
    if (isBlank(env[name])) {
      problems.push(`${name} is not set — ${REQUIRED_PROD_ENV[name]}`);
    }
  }

  const forbidden = Object.keys(FORBIDDEN_PROD_ENV);
  for (const name of forbidden) {
    const value = String(env[name] ?? "")
      .trim()
      .toLowerCase();
    if (TRUTHY_VALUES.indexOf(value) !== -1) {
      problems.push(`${name} is set to "${env[name]}" — ${FORBIDDEN_PROD_ENV[name]}`);
    }
  }

  const checked = Object.keys(VALUE_RULES);
  for (const name of checked) {
    const value = env[name];
    if (isBlank(value)) continue; // already reported above if it is required
    const problem = VALUE_RULES[name](String(value));
    if (problem) problems.push(problem);
  }

  // prodready-006. A rule ACROSS two vars, which is why it cannot live in
  // VALUE_RULES (per-var) or REQUIRED_PROD_ENV (per-var, and neither DSN is
  // required): no Sentry at all is a choice this project has actually made, and
  // only the self-misrepresenting half-configuration is refused. See
  // sentryDsnPairProblem for the argument.
  const sentryPair = sentryDsnPairProblem(env);
  if (sentryPair) problems.push(sentryPair);

  return problems;
}

/**
 * Was this file run as `node scripts/vercel-build.mjs`, rather than imported?
 *
 * THE TRAP THIS AVOIDS, IN BOTH DIRECTIONS. The decision functions above are
 * exported so a test can drive them; importing this module must therefore NOT
 * run `next build`. But getting the check wrong the other way — deciding
 * "not the entry point" on a real Vercel build — would skip the migrate step
 * AND the build itself, producing a deploy with no output. So this matches the
 * script's own filename explicitly instead of comparing `import.meta.url` to
 * `process.argv[1]`, which differs by path normalisation, drive-letter casing
 * and symlink resolution, and fails closed in the dangerous direction.
 *
 * Vercel invokes `node scripts/vercel-build.mjs` (vercel.json buildCommand);
 * under vitest, argv[1] is node_modules/vitest/dist/workers/forks.js. Both
 * shapes are pinned in tests/lib/env/build-config.test.ts.
 */
export function isDirectInvocation(argv1) {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  return /(^|[\\/])vercel-build\.mjs$/.test(argv1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
  if (res.status !== 0) {
    // Non-zero exit → fail the build. Vercel keeps serving the previous
    // deployment when the build fails, so an outage-shaped migration
    // never reaches customers.
    process.exit(res.status ?? 1);
  }
}

function main() {
  if (IS_PROD_BUILD) {
    // Step 1: refuse a misconfigured Production environment. This runs BEFORE
    // `prisma migrate deploy` on purpose — a migration is the one irreversible
    // thing in this script, and it should not be applied on the strength of an
    // environment we are about to reject.
    const problems = productionEnvProblems(process.env);
    if (problems.length > 0) {
      console.error(
        `[vercel-build] Refusing to build: ${problems.length} problem(s) with the ` +
          "Production environment. Nothing has been deployed and nothing has been " +
          "migrated; Vercel keeps serving the previous deployment."
      );
      for (const problem of problems) console.error(`  - ${problem}`);
      console.error(
        "[vercel-build] Fix these in Vercel → Settings → Environment Variables → " +
          "Production, then redeploy. See the header of this file for what each one breaks."
      );
      process.exit(1);
    }

    // Step 1b: say out loud what is not configured, and carry on. Deliberately
    // AFTER the process.exit above and BEFORE the migrate step: a warning that
    // could stop a deploy is a gate, and the next person to meet one during an
    // incident deletes the mechanism rather than the entry. So nothing between
    // this call and `next build` is allowed to exit — pinned by
    // tests/lib/env/build-config.test.ts ("prints the warnings on a production
    // build without failing it").
    //
    // What it buys: the build log is the only place anyone would notice that
    // `app/error.tsx` says "The team has been notified" while no DSN exists.
    const warnings = productionEnvWarnings(process.env);
    if (warnings.length > 0) {
      console.warn(
        `[vercel-build] ${warnings.length} thing(s) worth knowing about this Production ` +
          "environment. None of them stops the deploy."
      );
      for (const warning of warnings) console.warn(`  ! ${warning}`);
    }

    // Step 2: the 2026-07-03 fix.
    console.log("[vercel-build] Production env checks passed");
    console.log("[vercel-build] Production build detected — applying pending migrations");
    run("npx", ["prisma", "migrate", "deploy"]);
    console.log("[vercel-build] Migrations up to date. Proceeding to next build.");
  } else {
    // Preview and local: no migrate, and NO production env assertions. Preview
    // deploys legitimately have no CRON_SECRET or Gmail credentials, and
    // failing their builds over it would make every PR red for no benefit.
    console.log(
      `[vercel-build] Non-production build (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}) — skipping migrate step and production env checks`
    );
  }

  run("npx", ["next", "build"]);
}

if (isDirectInvocation(process.argv[1])) main();
