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

import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

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

async function probeTasks(page) {
  // domcontentloaded (not networkidle2): a killed session renders the error
  // boundary + fires client-side action errors, so the page never goes idle.
  try {
    await page.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch {
    /* navigation may not fully settle on the error page — read the DOM below */
  }
  // Poll up to ~6s for a definitive state (authed content, error boundary, or
  // a /login bounce) since the error boundary paints after hydration.
  let body = "";
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    body = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (body.includes("Something broke loading this page")) break;
    if (page.url().includes("/login")) break;
  }
  const errored = body.includes("Something broke loading this page");
  const onLogin = page.url().includes("/login");
  return { url: page.url(), errored, onLogin };
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
const authed = (p) => !p.errored && !p.onLogin;
const killed = (p) => p.errored || p.onLogin;

try {
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
  const aOk = authed(aBefore) && killed(aAfter);
  console.log(`  => ${aOk ? "PASS" : "FAIL"} (authed before, session killed after)`);
  pass = pass && aOk;

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
  const bOk = authed(bBefore) && killed(bAfter);
  console.log(`  => ${bOk ? "PASS" : "FAIL"} (authed before, session killed after)`);
  pass = pass && bOk;
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
