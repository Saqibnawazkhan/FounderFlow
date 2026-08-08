// Smoke the multi-admin feature end-to-end.
//
//   Part 1: as admin, promote a member to admin via the /team dropdown +
//           confirmation dialog; assert the DB role flips.
//   Part 2: log in as that (now-admin) user and confirm they can reach a
//           finance page that members are bounced away from.
//
// Reverts the role afterwards so the seed stays clean.

import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const TARGET = "fatima@nimbus.app";

function psqlScalar(sql) {
  return execSync("docker exec -i founderflow-postgres psql -U founderflow -d founderflow -tA", {
    input: sql,
    encoding: "utf8",
  }).trim();
}

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
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

let pass = true;
try {
  // Baseline: target starts as a member.
  const startRole = psqlScalar(`SELECT role FROM "User" WHERE email = '${TARGET}';`);
  console.log(`baseline: ${TARGET} role = ${startRole}`);

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
  // Restore the seed regardless of outcome.
  try {
    psqlScalar(`UPDATE "User" SET role = 'member' WHERE email = '${TARGET}';`);
    console.log(`\n(restored ${TARGET} to member)`);
  } catch {}
  await browser.close();
}

console.log(`\n${pass ? "✅ ALL PASS" : "❌ FAILURES"} — multi-admin`);
process.exit(pass ? 0 : 1);
