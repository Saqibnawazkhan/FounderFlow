/*
 * Run a command against the LOCAL database, and refuse to run it against
 * anything else.
 *
 * WHY THIS EXISTS — read this before "simplifying" it away.
 *
 * The Prisma CLI resolves DATABASE_URL by auto-loading the root `.env`. It does
 * NOT read `.env.local` (that is a Next.js convention, not a dotenv one), and
 * this Prisma version has no `--env-file` flag. The root `.env` points at the
 * hosted Supabase project. So before this wrapper existed:
 *
 *     npm run db:reset:local   ->   prisma migrate reset --force
 *
 * resolved to the PRODUCTION connection string and would have dropped and
 * recreated the live schema, without a prompt, from a command whose name ends
 * in "local". The seed guard in prisma/seed.ts would have refused to re-seed
 * afterwards — which is no consolation, because the drop happens first.
 *
 * The fix is not just "pass the right URL". It is that the wrong URL must be
 * unreachable: localDatabaseUrl() throws on any non-loopback host, so if
 * .env.local is missing or has been repointed at a hosted database for a
 * one-off inspection, this exits non-zero instead of running the command.
 * There is deliberately NO fallback to process.env.
 *
 * Usage (from package.json, never by hand):
 *     node scripts/db-local.mjs prisma migrate dev
 *     node scripts/db-local.mjs tsx prisma/seed.ts
 */

import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localDatabaseUrl } from "./_local-db.mjs";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("scripts/db-local.mjs: nothing to run.");
  console.error("  usage: node scripts/db-local.mjs <command> [args…]");
  process.exit(2);
}

let url;
let directUrl;
try {
  url = localDatabaseUrl("DATABASE_URL");
  // DIRECT_URL is what `prisma migrate` uses (pgbouncer cannot speak the
  // migration protocol). Locally both point at the same container, but read it
  // separately rather than aliasing: if .env.local ever grows a real split,
  // silently reusing DATABASE_URL here would run migrations through a pooler.
  directUrl = localDatabaseUrl("DIRECT_URL");
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  console.error("  Nothing was run. Check .env.local, then try again.\n");
  process.exit(1);
}

console.log(`  → ${new URL(url).host} (local)\n`);

// `prisma` and `tsx` are .bin shims, which on Windows are .cmd files that only
// a shell can execute. npm puts node_modules/.bin on PATH when it runs a
// script, but this file is also worth being able to run by hand — and the
// first time it was, it died with "'prisma' is not recognized". So prepend the
// bin directory ourselves rather than inheriting whatever the caller had.
const binDir = join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", ".bin");
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";

// One string, not (command, args[]) with shell:true — that combination raises
// DEP0190 because Node concatenates the args into the shell line without
// escaping them. Concatenating deliberately, from values that only ever come
// out of package.json, is the same thing said honestly.
const line = argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");

const child = spawn(line, {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    [PATH_KEY]: `${binDir}${delimiter}${process.env[PATH_KEY] ?? ""}`,
    DATABASE_URL: url,
    DIRECT_URL: directUrl,
  },
});

child.on("error", (err) => {
  console.error(`scripts/db-local.mjs: could not start "${argv[0]}": ${err.message}`);
  process.exit(1);
});
// Surface the child's exit code, so a failed migration still fails the build.
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
