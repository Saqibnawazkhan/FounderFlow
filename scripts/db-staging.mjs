/*
 * Run a command against the STAGING database, and refuse to run it against
 * anything else. The staging sibling of scripts/db-local.mjs.
 *
 * Read scripts/_staging-db.mjs for why this exists: `db:migrate:staging` was a
 * bare `prisma migrate deploy`, which resolved the ROOT `.env` — production —
 * while CLAUDE.md claimed every `db:*` script was wrapped.
 *
 * In CI, the credentials come from repo secrets rather than a file, so
 * STAGING_DATABASE_URL / STAGING_DIRECT_URL in the environment are honoured
 * INSTEAD of .env.staging. That is not a fallback to `.env`: both variables
 * must be present and explicitly named for staging, and if neither the file nor
 * the pair exists this exits 78 (EX_CONFIG) so a workflow can treat "staging is
 * not provisioned yet" as a skip rather than a failure.
 *
 * Usage (from package.json, never by hand):
 *     node scripts/db-staging.mjs prisma migrate deploy
 */

import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { stagingDatabaseUrls } from "./_staging-db.mjs";

/** Exit code a CI job can read as "not configured", distinct from a failure. */
const EX_CONFIG = 78;

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("scripts/db-staging.mjs: nothing to run.");
  console.error("  usage: node scripts/db-staging.mjs <command> [args…]");
  process.exit(2);
}

const fromCi = process.env.STAGING_DATABASE_URL && process.env.STAGING_DIRECT_URL;
const hasFile = existsSync(new URL("../.env.staging", import.meta.url));

let databaseUrl;
let directUrl;
let host;

if (fromCi) {
  // CI path. The secrets are named STAGING_* precisely so that a workflow
  // cannot hand us production's DATABASE_URL by inheriting the ambient one.
  databaseUrl = process.env.STAGING_DATABASE_URL;
  directUrl = process.env.STAGING_DIRECT_URL;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    console.error("\n  ✗ STAGING_DATABASE_URL is not a valid URL.\n");
    process.exit(1);
  }
  console.log(`  → ${host} (staging, from CI secrets)\n`);
} else if (!hasFile) {
  console.log("\n  — staging is not provisioned: no .env.staging, and no");
  console.log("    STAGING_DATABASE_URL / STAGING_DIRECT_URL in the environment.");
  console.log("    See .env.staging.example for the runbook. Nothing was run.\n");
  process.exit(EX_CONFIG);
} else {
  try {
    const urls = stagingDatabaseUrls();
    databaseUrl = urls.databaseUrl;
    directUrl = urls.directUrl;
    host = urls.host;
  } catch (err) {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    console.error("  Nothing was run.\n");
    process.exit(1);
  }
  console.log(`  → ${host} (staging, from .env.staging)\n`);
}

// Same .bin/PATH and single-command-string reasoning as scripts/db-local.mjs —
// see the comments there before changing either.
const binDir = join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", ".bin");
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const line = argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");

const child = spawn(line, {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    [PATH_KEY]: `${binDir}${delimiter}${process.env[PATH_KEY] ?? ""}`,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
  },
});

child.on("error", (err) => {
  console.error(`scripts/db-staging.mjs: could not start "${argv[0]}": ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
