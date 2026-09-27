/*
 * The one module that knows how to reach the LOCAL dev database, and refuses
 * to reach anything else.
 *
 * Why this exists: `new PrismaClient()` and the Prisma CLI both resolve
 * DATABASE_URL by auto-loading the ROOT `.env`, and that file points at the
 * hosted Supabase project. Next.js reads `.env.local` first; Prisma does NOT.
 * So a script that does `new PrismaClient()`, or an npm script that shells out
 * to `prisma`, reads and writes PRODUCTION, silently, from a laptop — while
 * the command it is spelled as says "local".
 *
 * Two consumers, one rule:
 *   • localDb()           — a PrismaClient pinned to the local database.
 *   • localDatabaseUrl()  — the raw URL, for scripts/db-local.mjs to inject
 *                           into a child process's environment.
 *
 * The loopback check lives HERE rather than in each caller on purpose. It is
 * the only thing standing between `npm run db:reset:local` and a dropped
 * production schema, and a rule copied into six call sites is a rule that
 * stops being true in one of them.
 */

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

/** Pull one key out of an env file without pulling in a dotenv dependency. */
function readEnvLocal(key) {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

/** Hosts we are willing to mutate. Anything else is somebody's real data. */
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

/**
 * The local database URL, having proved it is local.
 *
 * @param {string} [key] "DATABASE_URL" or "DIRECT_URL".
 * @returns {string}
 * @throws if `.env.local` is missing, the key is absent, or the host is remote.
 */
export function localDatabaseUrl(key = "DATABASE_URL") {
  const url = readEnvLocal(key);
  if (!url) {
    throw new Error(`scripts/_local-db.mjs: no ${key} in .env.local — is the file there?`);
  }

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`scripts/_local-db.mjs: ${key} in .env.local is not a valid URL`);
  }

  // The whole point. If someone repoints .env.local at a hosted database for
  // a one-off inspection, every destructive path must refuse rather than
  // quietly mutate it. Note what is NOT done here: we never fall back to
  // process.env.DATABASE_URL. A fallback would restore the exact hazard this
  // file exists to remove, the first time .env.local went missing.
  if (!LOOPBACK.includes(host)) {
    throw new Error(
      `scripts/_local-db.mjs: refusing to run against non-local host "${host}". ` +
        "This path mutates data; point .env.local back at the docker Postgres."
    );
  }

  return url;
}

/**
 * @returns {PrismaClient} pinned to the local dev database.
 * @throws if `.env.local` is missing, or its DATABASE_URL is not loopback.
 */
export function localDb() {
  return new PrismaClient({ datasourceUrl: localDatabaseUrl("DATABASE_URL") });
}
