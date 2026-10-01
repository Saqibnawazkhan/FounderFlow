// Smoke the JWT session-invalidation feature end-to-end.
//
// A stateless JWT session used to stay valid until its cookie expired even
// after the user was soft-deleted. The auth jwt callback now re-checks the DB
// per request and kills the session on `deletedAt` or a `sessionVersion` bump.
//
// This drives a real browser:
//   Part A (deletedAt): log in as a member, confirm /tasks loads, soft-delete
//     them in the DB, reload — the same cookie must now be rejected.
//   Part B (sessionVersion): same, but invalidate via a version bump.
// Both mutations are reverted so the seed stays clean.
//
// ── WHAT "REJECTED" MEANS, AND WHY THIS FILE CHANGED (auth-002) ─────────────
//
// This probe used to accept EITHER outcome:
//
//     const errored = body.includes("Something broke loading this page");
//     const killed  = (p) => p.errored || p.onLogin;
//
// That string is app/(app)/error.tsx — the dead end a revoked session used to
// land in, because `requireScopedSession()` threw. Both of that card's CTAs
// re-enter the same loop, so a user whose password changed on another device was
// left on a permanent error screen. THAT is the bug auth-002 names, and
// lib/queries/session.ts now calls `redirect("/login")` instead.
//
// So the old pass condition demanded the bug: it passed against the fixed app,
// and it would have passed against a regression straight back to the error card.
//
// The decision now lives in scripts/_session-invalidation-contract.mjs, pure and
// asserted by tests/lib/auth/session-invalidation-probe.test.ts — so the pass
// condition itself is covered by the suite, with no dev server and no browser,
// instead of only being exercised when somebody remembers to run this file. Run
// order: the suite catches a wrong RULE, this script catches a wrong APP.

import puppeteer from "puppeteer-core";
import { psqlExec as psql, psqlScalar } from "./_local-psql.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTHED_TASKS_TEXT,
  ERROR_BOUNDARY_TEXT,
  checkSentinels,
  classifyProbe,
  scoreInvalidation,
} from "./_session-invalidation-contract.mjs";

/**
 * This script's own rate-limit bucket (audit harness-009). Every puppeteer
 * request in dev arrives with no forwarding header, so lib/client-ip.ts finds no
 * trusted address and lib/rate-limit.ts falls back to per-ACCOUNT limits — which
 * means two scripts signing in as the same seeded user share one 5-per-minute
 * budget, and whichever runs second reports "cannot sign in". A distinct address
 * per script is what lib/client-ip.ts already documents the harness as relying
 * on, and what every scripts/qa-*.mjs already does on 10.99.0.x.
 *
 * tests/ops/smoke-hygiene.test.ts asserts these are unique across the directory
 * and that every page created here is given one.
 */
const SMOKE_IP = "10.98.0.20";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Before touching a browser or the database: is this probe still pointed at
// strings the app actually renders? A silent non-match looks like a pass, so a
// moved marker stops the run rather than producing a green lie.
const sentinels = checkSentinels((rel) => {
  try {
    return fs.readFileSync(path.join(REPO, rel), "utf8");
  } catch {
    return null;
  }
});
if (!sentinels.ok) {
  console.error(`\n❌ ${sentinels.message}\n`);
  process.exit(2);
}

// Raw SQL against the LOCAL docker Postgres, through the one module allowed to
// shell out to psql. It pins the container as a literal and refuses the run when
// .env.local names a non-loopback host, so this path now carries the same host
// discipline `localDb()` gives the Prisma path — audit harness-004, where six
// smoke scripts (this one among them) reached the database with no host check at
// all. SQL goes in on stdin, so `"User"` needs no shell quoting.

async function login(page, email, pw) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.type("input[type=email]", email);
  await page.type("input[type=password]", pw);
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await new Promise((r) => setTimeout(r, 2800));
}

/**
 * Load /tasks and return `{ url, state }` — see `classifyProbe` for the four
 * states and why "unknown" is never a pass in either position.
 */
async function probeTasks(page) {
  // domcontentloaded (not networkidle2): a killed session used to render the
  // error boundary + fire client-side action errors, so the page never went
  // idle. Kept so a REGRESSION is still observable rather than timing out.
  try {
    await page.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {
    /* navigation may not fully settle on the error page — read the DOM below */
  }
  // Poll up to ~6s for a definitive state, since the error boundary and the
  // authed heading both paint after hydration.
  let state = "unknown";
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const body = await page.evaluate(() => document.body.innerText).catch(() => "");
    state = classifyProbe({ url: page.url(), body });
    if (state !== "unknown") break;
  }
  return { url: page.url(), state };
}

/** Print one part's verdict, naming WHICH half failed. */
function report(label, before, after) {
  const { pass, problems } = scoreInvalidation(before, after);
  if (pass) {
    console.log(`  => PASS (${label}: authed before, redirected to /login after)`);
    return true;
  }
  console.log(`  => FAIL (${label})`);
  for (const p of problems) console.log(`       - ${p}`);
  return false;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

let pass = true;

/**
 * RESTORE WHAT WAS READ, NOT WHAT WAS ASSUMED (audit harness-003).
 *
 * This script used to finish with `SET "sessionVersion" = 0` and
 * `SET "deletedAt" = NULL` -- literals, not the values it found. Per
 * lib/auth/session-version.ts, `sessionTokenStillValid` returns true when the
 * token's version matches the row's, and a legacy token carrying no version
 * field defaults to 0. So writing 0 over a version a password reset had
 * legitimately bumped to 3 would RE-VALIDATE every old token for that account,
 * resurrecting exactly the sessions the reset revoked. Restoring a tombstone to
 * NULL has the same shape: it un-deletes an account somebody deactivated on
 * purpose.
 *
 * psql -tA prints SQL NULL as the empty string, so an empty read restores NULL.
 */
function sqlLiteralOrNull(value) {
  return value === "" ? "NULL" : "'" + value.replace(/'/g, "''") + "'";
}

/** The two values this run is about to overwrite, read before it does. */
const SEED = {
  fatimaDeletedAt: psqlScalar(
    `SELECT COALESCE("deletedAt"::text, '') FROM "User" WHERE email = 'fatima@nimbus.app';`
  ),
  sarahSessionVersion: psqlScalar(
    `SELECT "sessionVersion" FROM "User" WHERE email = 'sarah@nimbus.app';`
  ),
};
console.log(
  `baseline: fatima deletedAt = ${JSON.stringify(SEED.fatimaDeletedAt)}, ` +
    `sarah sessionVersion = ${JSON.stringify(SEED.sarahSessionVersion)}`
);

/** Put both rows back exactly as they were found. Idempotent. */
function restoreSeed() {
  psql(
    `UPDATE "User" SET "deletedAt" = ${sqlLiteralOrNull(SEED.fatimaDeletedAt)} ` +
      `WHERE email = 'fatima@nimbus.app';`
  );
  // A bare integer, and refused if the baseline read did not look like one: a
  // blank or malformed read must not turn into a silent
  // `SET "sessionVersion" = 0`, which is the bug this block replaces.
  if (!/^[0-9]+$/.test(SEED.sarahSessionVersion)) {
    throw new Error(
      `refusing to restore sessionVersion from an unreadable baseline ` +
        `(${JSON.stringify(SEED.sarahSessionVersion)}) -- restore it by hand`
    );
  }
  psql(
    `UPDATE "User" SET "sessionVersion" = ${SEED.sarahSessionVersion} ` +
      `WHERE email = 'sarah@nimbus.app';`
  );
}

try {
  console.log(
    `\nProbe markers verified: "${AUTHED_TASKS_TEXT}" (live), ` +
      `"${ERROR_BOUNDARY_TEXT}" (auth-002 regression), redirect("/login") (pass).`
  );

  // ── Part A: deletedAt (soft-delete a member) ────────────────────────────
  console.log("\n== Part A: deletedAt invalidation (fatima@nimbus.app) ==");
  await login(page, "fatima@nimbus.app", "demo123");
  const aBefore = await probeTasks(page);
  console.log("  before delete:", JSON.stringify(aBefore));

  psql(`UPDATE "User" SET "deletedAt" = now() WHERE email = 'fatima@nimbus.app';`);
  const aAfter = await probeTasks(page);
  console.log("  after  delete:", JSON.stringify(aAfter));
  await page.screenshot({ path: `${OUT}/session-inval-A.png` });

  psql(
    `UPDATE "User" SET "deletedAt" = ${sqlLiteralOrNull(SEED.fatimaDeletedAt)} ` +
      `WHERE email = 'fatima@nimbus.app';`
  );
  pass = report("deletedAt", aBefore, aAfter) && pass;

  // ── Part B: sessionVersion bump ─────────────────────────────────────────
  console.log("\n== Part B: sessionVersion bump (sarah@nimbus.app) ==");
  await login(page, "sarah@nimbus.app", "demo123");
  const bBefore = await probeTasks(page);
  console.log("  before bump:", JSON.stringify(bBefore));

  psql(`UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE email = 'sarah@nimbus.app';`);
  const bAfter = await probeTasks(page);
  console.log("  after  bump:", JSON.stringify(bAfter));
  await page.screenshot({ path: `${OUT}/session-inval-B.png` });

  psql(
    `UPDATE "User" SET "sessionVersion" = ${SEED.sarahSessionVersion} ` +
      `WHERE email = 'sarah@nimbus.app';`
  );
  pass = report("sessionVersion", bBefore, bAfter) && pass;
} finally {
  // Belt-and-braces: make sure the seed is restored even if something threw.
  // A failure to restore is reported rather than swallowed: a run that left a
  // teammate tombstoned, or a session version rewritten, must not exit 0.
  try {
    restoreSeed();
  } catch (e) {
    console.error(`  FAIL  could not restore the seed rows -- ${e.message}`);
    pass = false;
  }
  await browser.close();
}

console.log(`\n${pass ? "✅ ALL PASS" : "❌ FAILURES"} — session invalidation`);
process.exit(pass ? 0 : 1);
