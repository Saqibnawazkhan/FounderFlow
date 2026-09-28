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
import { execSync } from "node:child_process";
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

// Run SQL against the local docker Postgres via stdin (no shell-quoting of the
// "User" identifier — that's what tripped PowerShell earlier).
function psql(sql) {
  execSync("docker exec -i founderflow-postgres psql -U founderflow -d founderflow", {
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

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
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

let pass = true;

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

  psql(`UPDATE "User" SET "deletedAt" = NULL WHERE email = 'fatima@nimbus.app';`);
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

  psql(`UPDATE "User" SET "sessionVersion" = 0 WHERE email = 'sarah@nimbus.app';`);
  pass = report("sessionVersion", bBefore, bAfter) && pass;
} finally {
  // Belt-and-braces: make sure the seed is restored even if something threw.
  try {
    psql(
      `UPDATE "User" SET "deletedAt" = NULL WHERE email = 'fatima@nimbus.app'; UPDATE "User" SET "sessionVersion" = 0 WHERE email = 'sarah@nimbus.app';`
    );
  } catch {}
  await browser.close();
}

console.log(`\n${pass ? "✅ ALL PASS" : "❌ FAILURES"} — session invalidation`);
process.exit(pass ? 0 : 1);
