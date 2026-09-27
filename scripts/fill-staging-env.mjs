/*
 * Fill .env.staging's DATABASE_URL and DIRECT_URL from a host + password,
 * doing the URL-encoding correctly.
 *
 * WHY THIS EXISTS: the password goes into a connection string, so every
 * reserved character has to be percent-encoded. An unencoded `@` is the classic
 * one — it terminates the userinfo section early, so the host silently becomes
 * whatever followed it, and the failure reads as "wrong credentials" rather
 * than "malformed URL". `#` truncates at the fragment. `/` breaks the path.
 * Hand-encoding works until the day it doesn't, and the error does not point at
 * the cause.
 *
 * It also encodes the ONE asymmetry that is easy to get backwards:
 *   DATABASE_URL -> transaction pooler, port 6543, pgbouncer=true REQUIRED
 *                   (transaction mode cannot do prepared statements, which
 *                   Prisma uses by default)
 *   DIRECT_URL   -> session pooler,     port 5432, NO params
 *                   (migrations need a real session)
 * Both use the SAME host and the `postgres.<ref>` username form. Session pooler
 * is deliberate, not interchangeable with "Direct connection"
 * (db.<ref>.supabase.co): per Supabase's docs the direct endpoint is IPv6-only
 * unless the project buys the IPv4 add-on, and GitHub Actions runners are
 * IPv4-only — so a direct-connection DIRECT_URL breaks the staging-migrate job.
 *
 * The password is read from the environment, never an argument, so it does not
 * land in shell history or a process list. It is never printed.
 *
 * Usage:
 *   SB_HOST='aws-0-ap-southeast-1.pooler.supabase.com' SB_PW='raw-password' \
 *     node scripts/fill-staging-env.mjs
 *
 *   ...and on PowerShell:
 *   $env:SB_HOST='...'; $env:SB_PW='...'; node scripts/fill-staging-env.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENV_PATH = new URL("../.env.staging", import.meta.url);

const host = process.env.SB_HOST?.trim();
const pw = process.env.SB_PW;

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!host || !pw) {
  die(
    "set both SB_HOST and SB_PW.\n\n" +
      "    SB_HOST='aws-0-ap-southeast-1.pooler.supabase.com'   (Connect -> Transaction pooler)\n" +
      "    SB_PW='your-raw-password'                            (never pre-encoded)"
  );
}
if (!existsSync(ENV_PATH)) {
  die("no .env.staging. Copy .env.staging.example to .env.staging first.");
}

// Catch the two hosts that are NOT the shared pooler, since both produce a
// working-looking local setup that fails in CI or refuses prepared statements.
if (host.startsWith("db.") || host.endsWith(".supabase.co")) {
  die(
    `"${host}" is the DIRECT connection endpoint, not the shared pooler.\n\n` +
      "    Supabase's direct endpoint is IPv6-only without the IPv4 add-on, and\n" +
      "    GitHub Actions runners are IPv4-only — the staging-migrate job could not\n" +
      "    connect. Use the host from Connect -> Transaction pooler, which looks\n" +
      "    like aws-0-<region>.pooler.supabase.com."
  );
}
if (!/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
  die(
    `"${host}" does not look like a Supabase shared-pooler host.\n\n` +
      "    Expected aws-<index>-<region>.pooler.supabase.com — copy it verbatim\n" +
      "    from the dashboard; the index varies per project."
  );
}

const src = readFileSync(ENV_PATH, "utf8");

// Prefer SB_REF, then fall back to a ref already in the file. The fallback
// exists so a password rotation needs only SB_HOST + SB_PW; SB_REF exists
// because on the FIRST run the file still holds `postgres.<staging-ref>` from
// the template, and reading that gives you a connection string addressed to a
// project called "staging-ref". The first version of this script had only the
// fallback and refused to run at all on a fresh file.
const ref = process.env.SB_REF?.trim() || src.match(/postgres\.([a-z0-9]{16,})/)?.[1];
if (!ref) {
  die(
    "no project ref.\n\n" +
      "    Pass SB_REF='<your-project-ref>' — it is the 20-character id in your\n" +
      "    Supabase URL (dashboard/project/<ref>). On later runs it is read back\n" +
      "    out of .env.staging automatically."
  );
}
if (!/^[a-z0-9]{16,}$/.test(ref)) {
  die(`"${ref}" does not look like a Supabase project ref (expected ~20 lowercase letters/digits).`);
}

const user = `postgres.${ref}`;
const secret = encodeURIComponent(pw);

const databaseUrl = `postgresql://${user}:${secret}@${host}:6543/postgres?pgbouncer=true&connection_limit=1`;
const directUrl = `postgresql://${user}:${secret}@${host}:5432/postgres`;

let out = src;
let replaced = 0;
for (const [key, value] of [
  ["DATABASE_URL", databaseUrl],
  ["DIRECT_URL", directUrl],
]) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (!re.test(out)) die(`no ${key}= line in .env.staging.`);
  out = out.replace(re, `${key}="${value}"`);
  replaced += 1;
}

writeFileSync(ENV_PATH, out, "utf8");

// Deliberately prints the shape, never the secret.
console.log(`\n  ✓ wrote ${replaced} lines to .env.staging`);
console.log(`    host     ${host}`);
console.log(`    user     ${user}`);
console.log(`    password ${"•".repeat(12)} (${pw.length} chars, percent-encoded)`);
console.log(`    encoded  ${secret === pw ? "no change needed" : "yes — contained reserved characters"}`);
console.log(`\n  Next:  npm run db:migrate:staging\n`);
