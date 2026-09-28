/**
 * Structural guard: the production build refuses a misconfigured Production
 * scope, and keeps refusing it.
 *
 * WHAT THIS DEFENDS. Four findings from the production-readiness audit are the
 * same bug wearing different labels: a var that is optional in `lib/env.ts`
 * (because local dev and preview must run without it) is forgotten in Vercel's
 * Production scope, the build goes GREEN, and the failure surfaces later as
 * something no one recognises as a config problem:
 *
 *   prodready-002  RATE_LIMIT_DISABLED=true switches off every limiter in
 *                  lib/rate-limit.ts — including the login throttle that
 *                  landed hours ago to close a P0 brute-force hole. One line
 *                  in a dashboard, no runtime signal anywhere.
 *   prodready-003  no CRON_SECRET → all three nightly jobs 500 for ever.
 *                  Recurring revenue/expense rules never materialize, so every
 *                  customer's ledger, runway and budget figures drift from
 *                  reality. Money wrong, quietly, is the worst class of bug
 *                  this product can have.
 *   prodready-004  no NEXT_PUBLIC_APP_URL → every invite, reset and
 *                  verification link says http://localhost:3000. It is inlined
 *                  at BUILD time, so it cannot be fixed without a redeploy.
 *   prodready-005  no GMAIL_USER / GMAIL_APP_PASSWORD → lib/email/send.ts logs
 *                  the message and reports success, so a locked-out customer
 *                  is told to check an inbox nothing was sent to.
 *   prodready-006  HALF a Sentry configuration — SENTRY_DSN without
 *                  NEXT_PUBLIC_SENTRY_DSN or the reverse. Not a missing var but
 *                  a lying one: the dashboard receives events, looks alive, and
 *                  is missing an entire half of the application, so nobody goes
 *                  looking for the gap. This is the one case here that is
 *                  refused while its absence only warns.
 *
 * WHY A TEST AND NOT JUST THE GUARD. The guard lives in a build script that
 * never runs on a developer's machine and whose output nobody reads while it is
 * passing. That is the profile of code that gets deleted in a hurry during an
 * incident ("the build won't go through, drop the check") and never comes back.
 * These assertions make removing it a visible, deliberate edit.
 *
 * HOW IT IS CHECKED. Two layers, and both are needed:
 *   - BEHAVIOUR. `productionEnvProblems` is pure and exported, so the real
 *     decision is driven with real environments here rather than asserted
 *     about. A test that only grepped for the string "CRON_SECRET" would stay
 *     green if the check were inverted.
 *   - WIRING. A correct decision function that nothing calls, calls too late,
 *     or calls on preview builds too, is not a guard. So the script's own shape
 *     is asserted: the gate is inside the production branch, it runs before
 *     `prisma migrate deploy` (the one irreversible step), it exits non-zero,
 *     the else-branch does NOT run it, `main()` is actually invoked, and
 *     `vercel.json` still points its buildCommand at this script.
 *
 * PROVEN NON-VACUOUS by planting violations: deleting the CRON_SECRET entry,
 * inverting the RATE_LIMIT_DISABLED comparison, and moving the gate after the
 * migrate step each failed a named assertion here. If you change the guard,
 * plant one again — "the tests still pass" means nothing until you have seen
 * them fail.
 *
 * The prodready-006 and prodready-004 cases were proven the other way round,
 * which is stronger: the assertions were written first and watched fail against
 * the unfixed code — 5 red for 006 ("expected 0 to be greater than 0",
 * "productionEnvWarnings is never called — the warnings are dead code",
 * "expected 0 to be greater than 1") and 3 red for 004 ("appOrigin is not a
 * function") — before any of it was wired up.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isDirectInvocation,
  isLoopbackUrl,
  productionEnvProblems,
  productionEnvWarnings,
} from "@/scripts/vercel-build.mjs";
import { appOrigin, productionAppUrlProblem } from "@/lib/env";

const ROOT = process.cwd();
const BUILD_SCRIPT = "scripts/vercel-build.mjs";

/**
 * A Production scope with nothing wrong with it. Every case below is this minus
 * or plus one thing, so a failure names the one thing.
 *
 * DATABASE_URL deliberately carries `pgbouncer=true` on port 6543: that is the
 * CORRECT shape for the runtime pooler, and the DIRECT_URL rule must not be
 * applied to it. Getting that backwards would fail every real deploy.
 */
const HEALTHY_PROD_ENV: Record<string, string> = {
  DATABASE_URL: "postgresql://postgres:pw@db.example.supabase.co:6543/postgres?pgbouncer=true",
  DIRECT_URL: "postgresql://postgres:pw@db.example.supabase.co:5432/postgres",
  AUTH_SECRET: "0123456789abcdef0123456789abcdef0123456789ab",
  CRON_SECRET: "cron-0123456789abcdef0123456789abcdef",
  NEXT_PUBLIC_APP_URL: "https://app.founderflow.com",
  GMAIL_USER: "noreply@founderflow.com",
  GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
};

/**
 * The vars a production deploy cannot work without. Duplicated from the script
 * on purpose — if this list and the script's disagree, one of them is wrong and
 * the point of the test is to say so.
 */
const REQUIRED_NAMES = [
  "DATABASE_URL",
  "DIRECT_URL",
  "AUTH_SECRET",
  "CRON_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "GMAIL_USER",
  "GMAIL_APP_PASSWORD",
];

function envWithout(name: string): Record<string, string> {
  const copy: Record<string, string> = {};
  const keys = Object.keys(HEALTHY_PROD_ENV);
  for (const key of keys) {
    if (key !== name) copy[key] = HEALTHY_PROD_ENV[key]!;
  }
  return copy;
}

function envWith(name: string, value: string): Record<string, string> {
  const copy = envWithout(name);
  copy[name] = value;
  return copy;
}

function buildScriptSource(): string {
  return readFileSync(join(ROOT, BUILD_SCRIPT), "utf8");
}

describe("production build env gate (a green build that is broken is an outage)", () => {
  it("passes a fully configured Production scope", () => {
    // Guards the guard. Every case below is HEALTHY_PROD_ENV minus one thing,
    // so if the baseline itself is rejected the whole file is asserting noise —
    // and worse, a real deploy would be refused for no reason.
    expect(
      productionEnvProblems(HEALTHY_PROD_ENV),
      "a correct Production environment was rejected; this would block every deploy"
    ).toEqual([]);
  });

  it("refuses the build for every var whose absence fails silently at runtime", () => {
    // THE assertion, one case per finding. Each of these builds green today
    // without the gate, which is the entire reason the gate exists.
    for (const name of REQUIRED_NAMES) {
      const problems = productionEnvProblems(envWithout(name));
      expect(
        problems.length,
        `removing ${name} from the Production scope did not stop the build`
      ).toBeGreaterThan(0);
      expect(
        problems.join("\n"),
        `the refusal does not name ${name}, so nobody reading the build log knows what to set`
      ).toContain(name);
    }
  });

  it("requires exactly these seven, so the list cannot shrink unnoticed", () => {
    // An empty environment must produce one problem per required var and
    // nothing else (no value rule fires on a blank value). Pinning the count
    // means deleting an entry from REQUIRED_PROD_ENV — the cheap move during an
    // incident — fails here rather than passing quietly.
    const problems = productionEnvProblems({});
    expect(
      problems.length,
      "the required-var list changed size. If you added one: add it to REQUIRED_NAMES " +
        "here and bump this number. If you removed one: say in a comment why that var is " +
        "no longer needed in production. Never edit only one side.\n" +
        problems.join("\n")
    ).toBe(REQUIRED_NAMES.length);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // The realistic shape of the mistake. Vercel lets you save a var with no
    // value, and `.env.local.example` ships GMAIL_USER="" so the slot is
    // visible without opting in — so "" is what a half-done copy looks like.
    expect(productionEnvProblems(envWith("CRON_SECRET", "")).join("\n")).toContain("CRON_SECRET");
    expect(productionEnvProblems(envWith("GMAIL_USER", "   ")).join("\n")).toContain("GMAIL_USER");
  });

  it("refuses a production build with RATE_LIMIT_DISABLED switched on", () => {
    // prodready-002. Two audit agents found this independently. The flag makes
    // consume() return { allowed: true } for every limiter in the file, so the
    // 5/60s auth bucket stops existing and credential stuffing against a
    // finance product runs unthrottled with nothing in Sentry to show it.
    const problems = productionEnvProblems(envWith("RATE_LIMIT_DISABLED", "true"));
    expect(
      problems.length,
      "a production build was allowed to proceed with every rate limiter disabled"
    ).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("RATE_LIMIT_DISABLED");
    // The message has to say what was switched off, not just which var is wrong.
    expect(problems.join("\n").toLowerCase()).toContain("brute-force");
  });

  it("accepts RATE_LIMIT_DISABLED when it is absent or explicitly false", () => {
    // `.env.local.example` and `.env.staging.example` both pin it to "false" so
    // local dev runs WITH the limiter. That spelling must not fail a deploy.
    expect(productionEnvProblems(envWith("RATE_LIMIT_DISABLED", "false"))).toEqual([]);
    expect(productionEnvProblems(HEALTHY_PROD_ENV)).toEqual([]);
  });

  it("refuses the other spellings of yes, because they say what was meant", () => {
    // lib/rate-limit.ts only honours exactly "true", so `1` does not currently
    // disable anything — but someone typed it intending to, and the next person
    // to "fix the flag that isn't working" completes the hole. Refuse intent.
    for (const spelling of ["1", "yes", "on", "TRUE", " true "]) {
      expect(
        productionEnvProblems(envWith("RATE_LIMIT_DISABLED", spelling)).join("\n"),
        `RATE_LIMIT_DISABLED="${spelling}" was allowed through`
      ).toContain("RATE_LIMIT_DISABLED");
    }
  });

  it("refuses a loopback or malformed NEXT_PUBLIC_APP_URL", () => {
    // prodready-004's likelier half: not forgotten, but copied out of
    // .env.local.example. A presence check passes and every e-mail link then
    // points at the customer's own machine.
    for (const bad of ["http://localhost:3000", "http://127.0.0.1:3000", "https://x.localhost"]) {
      expect(
        productionEnvProblems(envWith("NEXT_PUBLIC_APP_URL", bad)).join("\n"),
        `NEXT_PUBLIC_APP_URL="${bad}" was accepted for a production build`
      ).toContain("NEXT_PUBLIC_APP_URL");
    }
    expect(
      productionEnvProblems(envWith("NEXT_PUBLIC_APP_URL", "app.founderflow.com")).join("\n"),
      "a bare host with no scheme is not an origin — string concatenation would produce " +
        "app.founderflow.com/invite/<token>, which is not a link"
    ).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("names the loopback hosts and nothing else", () => {
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackUrl("http://127.1.2.3/")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:3000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
    expect(isLoopbackUrl("https://app.localhost")).toBe(true);
    expect(isLoopbackUrl("https://app.founderflow.com")).toBe(false);
    // Not a URL at all is not a loopback — the URL rule reports that instead,
    // and returning true here would give the wrong message for it.
    expect(isLoopbackUrl("app.founderflow.com")).toBe(false);
    // The near-miss: a real host whose NAME contains localhost.
    expect(isLoopbackUrl("https://localhost-tools.founderflow.com")).toBe(false);
  });

  it("refuses a transaction-pooler DIRECT_URL, and leaves DATABASE_URL alone", () => {
    // The 2026-07-03 outage fix depends on DIRECT_URL being a session/direct
    // connection: pgbouncer cannot run the migration protocol. Without this the
    // build still fails, but with a Prisma advisory-lock error that reads like a
    // database problem rather than a config one.
    expect(
      productionEnvProblems(
        envWith("DIRECT_URL", "postgresql://postgres:pw@db.x.supabase.co:6543/postgres")
      ).join("\n")
    ).toContain("DIRECT_URL");
    expect(
      productionEnvProblems(
        envWith(
          "DIRECT_URL",
          "postgresql://postgres:pw@db.x.supabase.co:5432/postgres?pgbouncer=true"
        )
      ).join("\n")
    ).toContain("DIRECT_URL");
    // And the pooler on DATABASE_URL is correct, not a problem.
    expect(productionEnvProblems(HEALTHY_PROD_ENV)).toEqual([]);
  });

  it("reports every problem at once rather than the first", () => {
    // A Vercel build takes minutes. Discovering four missing vars one redeploy
    // at a time is how a launch evening disappears.
    const problems = productionEnvProblems({
      RATE_LIMIT_DISABLED: "true",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
    expect(problems.length).toBeGreaterThan(5);
    const joined = problems.join("\n");
    expect(joined).toContain("CRON_SECRET");
    expect(joined).toContain("GMAIL_APP_PASSWORD");
    expect(joined).toContain("RATE_LIMIT_DISABLED");
    expect(joined).toContain("NEXT_PUBLIC_APP_URL");
  });
});

describe("the gate's wiring (a decision nothing calls is not a guard)", () => {
  it("runs the env gate only on production builds", () => {
    // Preview deploys legitimately have no CRON_SECRET and no Gmail
    // credentials. Applying these assertions to them would turn every PR red
    // and get the whole gate deleted within a week, so the production-only
    // placement is part of the guard, not an implementation detail.
    const src = buildScriptSource();
    const prodBranch = src.indexOf("if (IS_PROD_BUILD)");
    const call = src.indexOf("productionEnvProblems(process.env)");
    const elseBranch = src.indexOf("} else {", prodBranch);

    expect(prodBranch, "the VERCEL_ENV production branch is gone").toBeGreaterThan(-1);
    expect(call, "nothing calls productionEnvProblems — the gate is dead code").toBeGreaterThan(-1);
    expect(elseBranch, "the non-production branch is gone").toBeGreaterThan(-1);
    expect(
      call > prodBranch && call < elseBranch,
      "the env gate is not inside the production-only branch, so preview builds are " +
        "subject to it too"
    ).toBe(true);

    // Exactly one call site: a second one outside the branch would reintroduce
    // the preview-build regression this assertion exists to prevent.
    const occurrences = src.split("productionEnvProblems(process.env)").length - 1;
    expect(occurrences, "productionEnvProblems is called more than once").toBe(1);
  });

  it("gates before the irreversible step, and exits non-zero", () => {
    // Ordering matters twice over. A migration is the one thing in this script
    // that cannot be undone by failing the build, so it must not be applied on
    // the strength of an environment about to be rejected. And `next build`
    // must come after both, or a refused environment still ships.
    const src = buildScriptSource();
    const call = src.indexOf("productionEnvProblems(process.env)");
    const exit = src.indexOf("process.exit(1)", call);
    const migrate = src.indexOf('"migrate", "deploy"');
    const nextBuild = src.lastIndexOf('"next", "build"');
    const elseBranch = src.indexOf("} else {", src.indexOf("if (IS_PROD_BUILD)"));

    expect(exit, "the gate collects problems and then does nothing about them").toBeGreaterThan(-1);
    expect(exit).toBeLessThan(migrate);
    expect(
      call < migrate,
      "prisma migrate deploy runs before the env gate — a rejected environment would " +
        "still have had its migrations applied to production"
    ).toBe(true);
    expect(migrate).toBeLessThan(elseBranch);
    expect(nextBuild, "next build is gone from the script").toBeGreaterThan(elseBranch);
  });

  it("still invokes main(), and vercel.json still invokes the script", () => {
    // The two ways this guard becomes decoration without anyone touching the
    // guard: the script stops calling main(), or vercel.json stops calling the
    // script. Both leave every assertion above green.
    const src = buildScriptSource();
    expect(
      /if\s*\(isDirectInvocation\(process\.argv\[1\]\)\)\s*main\(\);/.test(src),
      "the entry-point call is gone — the script now exports functions and does nothing"
    ).toBe(true);

    const vercelJson = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      buildCommand?: string;
      crons?: { path: string }[];
    };
    expect(
      vercelJson.buildCommand,
      "vercel.json no longer builds through this script, so neither the env gate nor " +
        "`prisma migrate deploy` runs on a production deploy"
    ).toBe("node scripts/vercel-build.mjs");

    // CRON_SECRET is required because these exist. If the crons go, revisit it.
    expect(
      (vercelJson.crons ?? []).length,
      "the cron list changed; CRON_SECRET is required in production because three " +
        "nightly jobs authenticate with it"
    ).toBe(3);
  });

  it("does not run the build when it is imported rather than executed", () => {
    // This file imports the script. If the entry-point check were wrong in that
    // direction, running the test suite would kick off `npx next build`.
    // Getting it wrong the OTHER way is worse: a production deploy that quietly
    // skips both the migrate step and the build, producing no output at all.
    // So both shapes are pinned here rather than reasoned about.
    expect(isDirectInvocation("scripts/vercel-build.mjs")).toBe(true);
    expect(isDirectInvocation("/vercel/path0/scripts/vercel-build.mjs")).toBe(true);
    expect(isDirectInvocation("C:\\Users\\USER\\FounderFlow\\scripts\\vercel-build.mjs")).toBe(
      true
    );
    expect(
      isDirectInvocation(
        "C:\\Users\\USER\\FounderFlow\\node_modules\\vitest\\dist\\workers\\forks.js"
      )
    ).toBe(false);
    expect(isDirectInvocation("/repo/node_modules/vitest/dist/workers/forks.js")).toBe(false);
    expect(isDirectInvocation(undefined as unknown as string)).toBe(false);
    expect(isDirectInvocation("")).toBe(false);
    // And the real invocation this process made must be the non-script one, or
    // the import above would have spawned a build.
    expect(isDirectInvocation(process.argv[1] ?? "")).toBe(false);
  });
});

describe("prodready-006 — half-configured Sentry is worse than none", () => {
  /**
   * The finding: `sentry.client.config.ts` reads `NEXT_PUBLIC_SENTRY_DSN`, while
   * `lib/env.ts` validates only `SENTRY_DSN`, `next.config.js` gates on
   * `SENTRY_DSN`, and CLAUDE.md's Vercel table names neither. So the browser DSN
   * can be absent from a deploy that looks fully configured, and every
   * client-side crash a paying customer hits — the whole `(app)` error boundary
   * and the root fatal boundary, which tells the user "The team has been
   * notified" — is invisible.
   *
   * Confirmed against the live project on 2026-09-28: `vercel env ls production`
   * lists AUTH_SECRET, DATABASE_URL, DIRECT_URL, CRON_SECRET, GMAIL_USER,
   * GMAIL_APP_PASSWORD, NEXT_PUBLIC_APP_URL, the VAPID set and the LemonSqueezy
   * set — and no Sentry variable of any kind, in any scope.
   *
   * WHY THIS IS A WARNING AND NOT A REQUIRED VAR. Blind triage is bad; a build
   * that refuses to deploy because an observability tool is not set up is worse,
   * and this project is days from taking paying customers with no Sentry
   * configured at all. So "no Sentry" is a choice the build states out loud, and
   * only the self-misrepresenting case — half of it configured — is refused.
   */
  it("refuses a production build with the server DSN set and the browser DSN missing", () => {
    const problems = productionEnvProblems(
      envWith("SENTRY_DSN", "https://abc@o1.ingest.sentry.io/2")
    );
    expect(
      problems.length,
      "SENTRY_DSN alone builds green. Server errors report, every browser crash is " +
        "silently dropped, and the error screen still says 'The team has been notified'."
    ).toBeGreaterThan(0);
    expect(
      problems.join("\n"),
      "the refusal does not name NEXT_PUBLIC_SENTRY_DSN, so nobody reading the build log " +
        "knows which variable to add"
    ).toContain("NEXT_PUBLIC_SENTRY_DSN");
  });

  it("refuses the mirror case too", () => {
    const problems = productionEnvProblems(
      envWith("NEXT_PUBLIC_SENTRY_DSN", "https://abc@o1.ingest.sentry.io/2")
    );
    expect(
      problems.join("\n"),
      "the browser DSN alone means every server action, RSC and route handler failure goes " +
        "unreported while the dashboard looks alive"
    ).toContain("SENTRY_DSN");
  });

  it("accepts both set, and accepts neither", () => {
    const both = envWith("SENTRY_DSN", "https://abc@o1.ingest.sentry.io/2");
    both.NEXT_PUBLIC_SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    expect(
      productionEnvProblems(both),
      "a correctly configured Sentry pair was rejected; this would block every deploy"
    ).toEqual([]);
    // And the current state of the live project must still deploy.
    expect(
      productionEnvProblems(HEALTHY_PROD_ENV),
      "a deploy with no Sentry at all is now refused. Observability is not configured on " +
        "this project today, so this would block the launch deploy over a warning."
    ).toEqual([]);
  });

  it("says out loud that nothing is reporting, rather than saying nothing", () => {
    const warnings = productionEnvWarnings(HEALTHY_PROD_ENV);
    expect(
      warnings.join("\n"),
      "a production build with no Sentry DSN prints nothing about it. 'The team has been " +
        "notified' is on the customer-facing error screen; the build log is the one place " +
        "the truth would be noticed."
    ).toContain("SENTRY_DSN");
  });

  it("warns that a DSN without the upload trio reports nothing at all today", () => {
    // next.config.js only applies withSentryConfig when SENTRY_DSN AND
    // SENTRY_AUTH_TOKEN AND SENTRY_ORG AND SENTRY_PROJECT are all set, and that
    // wrapper is what injects sentry.client.config.ts / sentry.server.config.ts
    // into the build. So a DSN pair on its own produces no SDK at all — the
    // most misleading possible state, because the dashboard exists and is empty.
    const env = envWith("SENTRY_DSN", "https://abc@o1.ingest.sentry.io/2");
    env.NEXT_PUBLIC_SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    const warnings = productionEnvWarnings(env).join("\n");
    expect(
      warnings,
      "setting only the DSNs gives you a Sentry project that stays empty for ever, because " +
        "next.config.js does not apply withSentryConfig without the upload variables"
    ).toContain("SENTRY_AUTH_TOKEN");
    // And with everything set, nothing to say.
    env.SENTRY_AUTH_TOKEN = "sntrys_x";
    env.SENTRY_ORG = "founderflow";
    env.SENTRY_PROJECT = "founderflow-web";
    expect(
      productionEnvWarnings(env).join("\n"),
      "a fully configured Sentry still produces a warning, which trains people to ignore them"
    ).not.toContain("SENTRY");
  });

  it("prints the warnings on a production build without failing it", () => {
    const src = buildScriptSource();
    const prodBranch = src.indexOf("if (IS_PROD_BUILD)");
    const call = src.indexOf("productionEnvWarnings(process.env)");
    const elseBranch = src.indexOf("} else {", prodBranch);
    expect(
      call,
      "productionEnvWarnings is never called — the warnings are dead code"
    ).toBeGreaterThan(-1);
    expect(
      call > prodBranch && call < elseBranch,
      "the warnings are emitted outside the production-only branch, so every preview build " +
        "prints them too"
    ).toBe(true);
    // The whole point is that they do not block. A `process.exit` between the
    // warning call and the migrate step would turn a warning into a gate.
    const between = src.slice(call, src.indexOf('"migrate", "deploy"'));
    expect(
      /process\.exit/.test(between),
      "a warning now exits the build. Warnings must never fail a deploy, or the next " +
        "person deletes the whole mechanism during an incident."
    ).toBe(false);
  });

  it("makes lib/env.ts aware the browser DSN exists", () => {
    // It validated only SENTRY_DSN, so the browser DSN was a variable no part of
    // the repo had ever named — which is why it could be missing from a deploy
    // that looked complete.
    const src = readFileSync(join(ROOT, "lib/env.ts"), "utf8");
    const schemaAndParse = src.split("NEXT_PUBLIC_SENTRY_DSN").length - 1;
    expect(
      schemaAndParse,
      "lib/env.ts must name NEXT_PUBLIC_SENTRY_DSN twice — once in the schema and once in " +
        "the safeParse payload. Declaring it in only one of the two is the half-wiring " +
        "that makes the value silently undefined."
    ).toBeGreaterThan(1);
  });

  it("reads the browser DSN from a NEXT_PUBLIC_ variable", () => {
    // Not stylistic: a non-NEXT_PUBLIC_ variable is not inlined into the client
    // bundle, so reading SENTRY_DSN here compiles to undefined in the browser and
    // the SDK never initialises.
    const src = readFileSync(join(ROOT, "sentry.client.config.ts"), "utf8");
    expect(
      /process\.env\.NEXT_PUBLIC_SENTRY_DSN/.test(src),
      "sentry.client.config.ts reads a server-only variable, which is undefined in the browser"
    ).toBe(true);
  });

  it("tags events with the deployment, not with NODE_ENV", () => {
    // `next build` sets NODE_ENV=production for PREVIEW deploys too, so every
    // preview crash lands in Sentry's "production" environment and triage cannot
    // tell a paying customer's error from a pull request's.
    for (const file of ["sentry.client.config.ts", "sentry.server.config.ts"]) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(
        /VERCEL_ENV/.test(src),
        `${file} sets Sentry's environment from NODE_ENV alone, so preview deploys report ` +
          "as production and post-launch triage cannot separate them"
      ).toBe(true);
    }
  });
});

describe("lib/env.ts production assertion (the second line for the e-mail origin)", () => {
  it("distinguishes unset from set-to-localhost, and accepts a real origin", () => {
    // Both produce the same customer-visible failure, but not the same fix, so
    // the message has to tell them apart. The raw value is what carries that
    // information — after the schema's .default() they are identical.
    const unset = productionAppUrlProblem(undefined);
    expect(unset, "an unset origin passed the production check").toBeTruthy();
    expect(unset!).toContain("not set");
    expect(unset!, "the message must say the var is inlined at build time").toContain("BUILD");

    const loopback = productionAppUrlProblem("http://localhost:3000");
    expect(loopback, "a localhost origin passed the production check").toBeTruthy();
    expect(loopback!).toContain("loopback");

    expect(productionAppUrlProblem("")).toBeTruthy();
    expect(productionAppUrlProblem("https://app.founderflow.com")).toBeNull();
  });

  it("only applies the assertion on a production deployment", () => {
    // `next dev` and every preview build have no canonical origin, and this
    // module throws on a failed check — applying it everywhere would break
    // local development. The gate is VERCEL_ENV, read at module load.
    const src = readFileSync(join(ROOT, "lib/env.ts"), "utf8");
    expect(
      /VERCEL_ENV\s*===\s*"production"/.test(src),
      "lib/env.ts no longer keys its production assertion off VERCEL_ENV"
    ).toBe(true);
    expect(
      /if\s*\(IS_PRODUCTION_DEPLOY\)/.test(src),
      "the production assertion is no longer guarded, so preview and local builds now " +
        "throw when NEXT_PUBLIC_APP_URL is unset"
    ).toBe(true);
    expect(
      src.indexOf("productionAppUrlProblem(process.env.NEXT_PUBLIC_APP_URL)"),
      "nothing calls productionAppUrlProblem — the assertion is dead code"
    ).toBeGreaterThan(-1);
  });
});

describe("prodready-004 — one place that decides the canonical origin", () => {
  /**
   * The build gate above stops a production deploy with no NEXT_PUBLIC_APP_URL.
   * What it cannot fix is that SEVEN call sites each decide the fallback for
   * themselves — `app/layout.tsx:25`, `lib/actions/password-reset.ts:60`,
   * `lib/actions/team.ts:55`, `lib/actions/email-change.ts:100`,
   * `lib/email/verification.ts:17`, `lib/notify/email.ts:23` and
   * `lib/lemonsqueezy/config.ts:27` — so the next one added gets it wrong, and a
   * reader cannot answer "what origin do e-mails use?" from one place.
   *
   * The second, quieter bug those seven copies hide: only `team.ts` strips a
   * trailing slash. Every link is built by string concatenation onto this value,
   * so a Production value saved as `https://app.founderflow.com/` — which is what
   * copying the origin out of a browser address bar gives you — produces
   * `https://app.founderflow.com//reset-password/<token>` from the other six.
   * A protocol-relative-looking double slash in a path is the kind of URL that
   * works in one mail client and 404s in the next, and the failure lands on a
   * locked-out customer clicking a one-time link.
   *
   * So the accessor normalises, and it is the ONE decision. These assertions are
   * about lib/env.ts alone; routing the seven sites through it is a separate
   * change to files this slice does not own.
   */
  it("strips a trailing slash, so concatenated links never contain a double slash", () => {
    expect(
      appOrigin("https://app.founderflow.com/"),
      "a Production origin saved with a trailing slash produces " +
        "https://app.founderflow.com//invite/<token> at six of the seven call sites"
    ).toBe("https://app.founderflow.com");
    expect(appOrigin("https://app.founderflow.com//")).toBe("https://app.founderflow.com");
    expect(appOrigin("https://app.founderflow.com")).toBe("https://app.founderflow.com");
    // A path prefix is legitimate (a reverse-proxied sub-path) and must survive.
    expect(appOrigin("https://founderflow.com/app/")).toBe("https://founderflow.com/app");
  });

  it("falls back for local dev, and treats an empty value as unset", () => {
    // `next dev` and preview builds have no canonical origin; an empty string is
    // the shape of "I added the variable in Vercel and forgot the value", and
    // the seven `??` sites all let it through as a valid origin today.
    expect(appOrigin(undefined)).toBe("http://localhost:3000");
    expect(
      appOrigin("   "),
      "a whitespace-only NEXT_PUBLIC_APP_URL was used as the origin, so every e-mail link " +
        "would be a bare path"
    ).toBe("http://localhost:3000");
  });

  it("reads the environment when called with no argument", () => {
    // The zero-arg call is what the seven call sites will use; the argument
    // exists so the decision is testable without mutating process.env.
    const origin = appOrigin();
    expect(origin.length, "appOrigin() returned an empty origin").toBeGreaterThan(0);
    expect(
      origin.endsWith("/"),
      "appOrigin() returned a trailing slash, which is the whole thing it exists to prevent"
    ).toBe(false);
  });
});
