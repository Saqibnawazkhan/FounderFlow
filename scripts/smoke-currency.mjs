// Smoke the signup-time currency selection.
//
//   1. Sign up a fresh workspace choosing USD as the currency.
//   2. Assert the new Company row was created with currency = USD.
//   3. Assert the app renders amounts with the "$" symbol (not PKR).
//   4. Delete the throwaway workspace (it's not the demo seed, so reseed
//      wouldn't remove it).

import puppeteer from "puppeteer-core";
import { execSync } from "node:child_process";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const EMAIL = "currency-smoke@founderflow.test";
const COMPANY = "CurrencySmoke Co";

function psql(sql) {
  return execSync("docker exec -i founderflow-postgres psql -U founderflow -d founderflow -tA", {
    input: sql,
    encoding: "utf8",
  }).trim();
}

// Remove any leftover throwaway workspace from a prior run (and after this one).
function cleanup() {
  // Email verification uses stateless signed tokens (no DB table), so only
  // Activity, User, and Company need clearing. Company delete cascades User.
  const sql = `
    DELETE FROM "Activity" WHERE "companyId" IN (SELECT "companyId" FROM "User" WHERE email='${EMAIL}');
    DELETE FROM "Company" WHERE id IN (SELECT "companyId" FROM "User" WHERE email='${EMAIL}');
    DELETE FROM "User" WHERE email='${EMAIL}';
    DELETE FROM "Company" WHERE name='${COMPANY}';`;
  try {
    psql(sql);
  } catch (e) {
    console.error("cleanup warning:", e.message);
  }
}

async function setVal(page, selector, val, isSelect = false) {
  await page.evaluate(
    (sel, v, sl) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for " + sel);
      const proto = sl ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event(sl ? "change" : "input", { bubbles: true }));
    },
    selector,
    val,
    isSelect
  );
}

cleanup(); // start clean

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
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 800));

  // Every field is registered + in the DOM across both wizard steps, so fill
  // them all (incl. the step-2 currency picker) and submit the form directly.
  await setVal(page, 'input[name="name"]', "Currency Tester");
  await setVal(page, 'input[name="email"]', EMAIL);
  await setVal(page, 'input[name="password"]', "Secret123");
  await setVal(page, 'input[name="companyName"]', COMPANY);
  await setVal(page, 'select[name="currency"]', "USD", true);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`  after signup submit -> ${page.url()}`);
  await page.screenshot({ path: `${OUT}/currency-signup.png` });

  // DB: the new workspace should be USD.
  const dbCurrency = psql(`SELECT currency FROM "Company" WHERE name='${COMPANY}';`);
  console.log(`  DB: new workspace currency = ${dbCurrency || "(none created)"}`);
  const dbOk = dbCurrency === "USD";

  // Display: land on the dashboard and check the "$" currency symbol renders.
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2500));
  const body = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: `${OUT}/currency-signup-dash.png` });
  const displayOk = body.includes("$") && !body.includes("PKR");
  console.log(`  display: dashboard shows $=${body.includes("$")}, no PKR=${!body.includes("PKR")}`);

  pass = dbOk && displayOk;
  console.log(`  => ${pass ? "PASS" : "FAIL"}`);
} finally {
  await browser.close();
  cleanup(); // remove the throwaway workspace
  const left = psql(`SELECT count(*) FROM "User" WHERE email='${EMAIL}';`);
  console.log(`(cleanup: leftover test users = ${left})`);
}

console.log(`\n${pass ? "✅ ALL PASS" : "❌ FAILURES"} — signup currency`);
process.exit(pass ? 0 : 1);
