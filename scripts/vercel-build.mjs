#!/usr/bin/env node
/**
 * Vercel build entry — the fix for the 2026-07-03 outage.
 *
 * What happened that day: the Decimal + soft-delete migrations shipped in
 * code and the generated Prisma client expected columns that didn't exist
 * on the production Supabase. Every RSC that touched those columns errored
 * → the site was down until someone ran `prisma migrate deploy` by hand.
 *
 * What this script does now: on every PRODUCTION build, apply pending
 * migrations first. If any migration fails, the whole build fails and
 * Vercel serves the previous deployment untouched. Preview builds skip
 * the migrate step because they don't (currently) have a separate DB and
 * shouldn't touch prod's schema.
 *
 * Env vars that need to exist on Vercel (Production scope):
 *   DATABASE_URL — pooler URL, port 6543 (runtime queries)
 *   DIRECT_URL   — session pooler / direct connection, port 5432
 *                  (`prisma migrate deploy` needs this; the pgbouncer
 *                  transaction pooler breaks migrations)
 *   VERCEL_ENV   — set automatically by Vercel; we gate on it
 *
 * Local dev never runs this — `npm run dev` and `npm run build` still call
 * `next` directly. This is Vercel-only.
 */

import { spawnSync } from "node:child_process";

const IS_PROD_BUILD = process.env.VERCEL_ENV === "production";

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

if (IS_PROD_BUILD) {
  // Fail the build (never a runtime outage) if a secret the app can't run
  // without is missing. lib/env.ts marks these optional so local/preview
  // don't need them, but a production deploy that forgets one otherwise
  // builds green and then throws on every request (Auth.js without
  // AUTH_SECRET, every query without DATABASE_URL). A failed build keeps the
  // previous deployment serving.
  const requiredProdEnv = {
    DATABASE_URL:
      "runtime queries (pooler URL, port 6543). Set it in Vercel → Settings → " +
      "Environment Variables → Production scope.",
    DIRECT_URL:
      "prisma migrate deploy needs a direct connection (port 5432) — the pgbouncer " +
      "transaction pooler breaks migrations. Set it in the Production scope.",
    AUTH_SECRET:
      "Auth.js signing secret. Without it every authenticated request throws. " +
      "Set it in the Production scope.",
  };
  const missing = Object.keys(requiredProdEnv).filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("[vercel-build] Missing required Production env var(s):");
    for (const k of missing) console.error(`  - ${k}: ${requiredProdEnv[k]}`);
    process.exit(1);
  }

  console.log("[vercel-build] Production build detected — applying pending migrations");
  run("npx", ["prisma", "migrate", "deploy"]);
  console.log("[vercel-build] Migrations up to date. Proceeding to next build.");
} else {
  console.log(
    `[vercel-build] Non-production build (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}) — skipping migrate step`
  );
}

run("npx", ["next", "build"]);
