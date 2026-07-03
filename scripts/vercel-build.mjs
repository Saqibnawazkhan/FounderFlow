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
  if (!process.env.DIRECT_URL) {
    console.error(
      "[vercel-build] DIRECT_URL is not set. Prisma migrate needs a direct " +
        "connection (port 5432) — the pgbouncer transaction pooler will not work. " +
        "Set DIRECT_URL in Vercel → Project Settings → Environment Variables → " +
        "Production scope, then redeploy."
    );
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
