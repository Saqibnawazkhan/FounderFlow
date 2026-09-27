/*
 * The one module that knows how to reach the STAGING database, and refuses to
 * reach anything else.
 *
 * WHY THIS EXISTS — and why it is a separate file from _local-db.mjs.
 *
 * `db:migrate:staging` was, until 2026-09-26, the bare string
 * `prisma migrate deploy`. Every other data-touching `db:*` script goes through
 * scripts/db-local.mjs; this one did not, and CLAUDE.md nonetheless claimed the
 * wrapper covered "every `db:*` npm script". It did not.
 *
 * The consequence: the Prisma CLI resolves DATABASE_URL from the ROOT `.env`
 * (it does not read `.env.local` — that is a Next.js convention), and that file
 * held the PRODUCTION Supabase credentials. So `npm run db:migrate:staging`
 * applied migrations directly to production, silently, from a command named
 * after an environment that has never existed. It fails closed today only
 * because `.env` was emptied hours earlier — which is luck, not a guard, and
 * would stop being true the moment anyone put a value back.
 *
 * _local-db.mjs cannot be reused here, because its rule is the opposite of the
 * one staging needs: it requires a LOOPBACK host, and staging is by definition
 * a remote Supabase project. So the rule here is not "where is it" but "has
 * someone SAID this is staging":
 *
 *   • `.env.staging` must exist. No fallback to `.env`, ever — a fallback is
 *     precisely the hazard this file removes.
 *   • it must declare `FF_ENV="staging"`. This is the two-key-launch idea from
 *     prisma/seed.ts's prod escape hatch: a declaration cannot be satisfied by
 *     accident, whereas a hostname pattern can (staging and production are both
 *     `*.pooler.supabase.com`, so no URL-shape check can tell them apart).
 *   • no unfilled `<placeholder>` may survive from .env.staging.example.
 *   • no host may match one named in the root `.env`. If someone pastes the
 *     production connection string in here, the declaration is a lie and this
 *     is the check that catches it.
 */

import { existsSync, readFileSync } from "node:fs";

const STAGING_PATH = new URL("../.env.staging", import.meta.url);
const ROOT_ENV_PATH = new URL("../.env", import.meta.url);

/** Parse an env file into a plain object. No dotenv dependency. */
function parseEnvFile(url) {
  if (!existsSync(url)) return null;
  const out = {};
  for (const line of readFileSync(url, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Hostnames named by any postgres URL in the root `.env`. */
function rootEnvHosts() {
  const env = parseEnvFile(ROOT_ENV_PATH);
  if (!env) return [];
  const hosts = [];
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value !== "string" || !value.startsWith("postgres")) continue;
    try {
      const host = new URL(value).hostname;
      if (host && hosts.indexOf(host) === -1) hosts.push(host);
    } catch {
      /* not a URL; nothing to compare */
    }
  }
  return hosts;
}

/**
 * The decision, as a pure function — no filesystem, no process.env.
 *
 * Split out from the IO shell below for the same reason
 * lib/auth/session-version.ts keeps `sessionTokenStillValid` pure: the
 * interesting cases here are "someone declared staging and pasted the
 * production URL" and "someone left a placeholder in", and neither can be
 * exercised through a function that reads two fixed paths off disk. A guard
 * that cannot be tested is a guard nobody has checked.
 *
 * @param {Record<string,string>|null} env parsed `.env.staging`, or null if absent.
 * @param {string[]} prodHosts hostnames named by postgres URLs in the root `.env`.
 * @returns {{ databaseUrl: string, directUrl: string, host: string }}
 * @throws with an actionable message if any condition is unmet.
 */
export function decideStagingUrls(env, prodHosts = []) {
  if (!env) {
    throw new Error(
      "no .env.staging in the repo root.\n\n" +
        "    Staging has never been provisioned. .env.staging.example carries the\n" +
        "    runbook: create a SECOND Supabase project (never the production one),\n" +
        "    copy the example to .env.staging, and fill it in.\n\n" +
        "    Deliberately NOT falling back to .env — that file is how this command\n" +
        "    used to migrate production."
    );
  }

  if (env.FF_ENV !== "staging") {
    throw new Error(
      'refusing to run: .env.staging does not declare FF_ENV="staging".\n\n' +
        "    Staging and production are both *.pooler.supabase.com, so no check on\n" +
        "    the URL's shape can tell them apart. The declaration is the only thing\n" +
        "    that can, and it has to be made deliberately."
    );
  }

  for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
    const value = env[key];
    if (!value) {
      throw new Error(`refusing to run: no ${key} in .env.staging.`);
    }
    if (value.includes("<") || value.includes(">")) {
      throw new Error(
        `refusing to run: ${key} in .env.staging still contains a template\n` +
          "    placeholder from .env.staging.example. Fill in the real values."
      );
    }
    try {
      new URL(value);
    } catch {
      throw new Error(`refusing to run: ${key} in .env.staging is not a valid URL.`);
    }
  }

  for (const key of ["DATABASE_URL", "DIRECT_URL"]) {
    const host = new URL(env[key]).hostname;
    if (prodHosts.indexOf(host) !== -1) {
      throw new Error(
        `refusing to run: ${key} in .env.staging names "${host}", which the root\n` +
          "    .env also names. That is production, whatever FF_ENV says. Staging\n" +
          "    must be a separate Supabase project — see .env.staging.example."
      );
    }
  }

  return {
    databaseUrl: env.DATABASE_URL,
    directUrl: env.DIRECT_URL,
    host: new URL(env.DATABASE_URL).hostname,
  };
}

/**
 * The IO shell: read the two files, then hand the decision to the pure
 * function above. Deliberately thin — everything worth testing is in
 * decideStagingUrls, and everything here is a file read.
 *
 * @returns {{ databaseUrl: string, directUrl: string, host: string }}
 */
export function stagingDatabaseUrls() {
  return decideStagingUrls(parseEnvFile(STAGING_PATH), rootEnvHosts());
}

/** Exported for the test: hostnames the root `.env` names. */
export { rootEnvHosts };
