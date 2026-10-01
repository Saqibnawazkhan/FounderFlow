// Smoke the multi-admin feature end-to-end.
//
//   Part 1: as admin, promote a member to admin via the /team dropdown +
//           confirmation dialog; assert the DB role flips.
//   Part 2: log in as that (now-admin) user and confirm they can reach a
//           finance page that members are bounced away from.
//
// Reverts the role afterwards so the seed stays clean.

import puppeteer from "puppeteer-core";
import { psqlScalar } from "./_local-psql.mjs";

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
const SMOKE_IP = "10.98.0.14";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const TARGET = "fatima@nimbus.app";

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

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

/**
 * Baseline, read OUTSIDE the try so `finally` can restore what was actually
 * there (audit harness-003).
 *
 * The restore used to be `SET role = 'member'` -- a literal, not the value this
 * script read. Against any workspace where the target is a cofounder that
 * silently demotes them, and it did so even when the run had already FAILED on
 * `startRole === "member"`: a failing run corrupted the seed it was complaining
 * about. `startRole` was declared inside the try, so `finally` could not see it
 * even though the script had it.
 */
const startRole = psqlScalar(`SELECT role FROM "User" WHERE email = '${TARGET}';`);
console.log(`baseline: ${TARGET} role = ${startRole}`);

let pass = true;
try {

  // ── Part 1: promote via the /team UI ────────────────────────────────────
  console.log("\n== Part 1: promote member -> admin via /team ==");
  await login(page, "demo@founderflow.app", "demo123");
  await page.goto(`${BASE}/team`, { waitUntil: "networkidle2" });
  // Wait for the member cards to actually render (first compile + Zustand
  // hydration can lag well past networkidle on a cold dev server).
  await page.waitForSelector("article", { timeout: 25000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));

  // Assert the UI now offers an Admin option in the target's row, then select it.
  const uiState = await page.evaluate((email) => {
    const row = Array.from(document.querySelectorAll("article")).find((a) =>
      a.textContent?.includes(email)
    );
    if (!row) return { found: false };
    const select = row.querySelector("select");
    const hasAdminOption = !!select?.querySelector('option[value="admin"]');
    if (select && hasAdminOption) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value"
      ).set;
      setter.call(select, "admin");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { found: true, hasSelect: !!select, hasAdminOption };
  }, TARGET);
  console.log("  UI:", JSON.stringify(uiState));

  // Confirm dialog: click "Make admin".
  await new Promise((r) => setTimeout(r, 700));
  const confirmed = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) =>
      x.textContent?.includes("Make admin")
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  });
  console.log(`  confirm dialog "Make admin" clicked: ${confirmed}`);
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `${OUT}/multi-admin-1.png` });

  const afterRole = psqlScalar(`SELECT role FROM "User" WHERE email = '${TARGET}';`);
  console.log(`  ${TARGET} role now = ${afterRole}`);
  const p1 =
    uiState.hasAdminOption && confirmed && startRole === "member" && afterRole === "admin";
  console.log(`  => ${p1 ? "PASS" : "FAIL"} (admin option present, promotion persisted)`);
  pass = pass && p1;

  // ── Part 2: promoted user gains finance access ──────────────────────────
  // Fresh context so we're not still carrying the admin's session cookie
  // (logging in as fatima while authed would just redirect off /login).
  console.log("\n== Part 2: promoted user can reach a finance page ==");
  const ctx = await browser.createBrowserContext();
  const page2 = await ctx.newPage();
  await page2.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
  page2.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  await login(page2, TARGET, "demo123");
  await page2.goto(`${BASE}/expenses`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1200));
  const finalUrl = page2.url();
  await page2.screenshot({ path: `${OUT}/multi-admin-2.png` });
  // Members are bounced off /expenses to /tasks; an admin stays.
  const onExpenses = finalUrl.includes("/expenses");
  console.log(`  after promotion, /expenses -> ${finalUrl}`);
  const p2 = onExpenses;
  console.log(`  => ${p2 ? "PASS" : "FAIL"} (admin not bounced from finance)`);
  pass = pass && p2;
} finally {
  // Restore the role this run READ, regardless of outcome. A restore that
  // cannot be done is reported rather than swallowed: leaving a teammate with
  // the wrong role must not exit 0.
  try {
    if (/^[a-z_]+$/.test(startRole)) {
      psqlScalar(`UPDATE "User" SET role = '${startRole}' WHERE email = '${TARGET}';`);
      console.log(`\n(restored ${TARGET} to ${startRole})`);
    } else {
      console.error(
        `  FAIL  baseline role for ${TARGET} was unreadable ` +
          `(${JSON.stringify(startRole)}) -- restore it by hand`
      );
      pass = false;
    }
  } catch (e) {
    console.error(`  FAIL  could not restore ${TARGET}'s role -- ${e.message}`);
    pass = false;
  }
  await browser.close();
}

console.log(`\n${pass ? "✅ ALL PASS" : "❌ FAILURES"} — multi-admin`);
process.exit(pass ? 0 : 1);
