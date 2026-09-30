// Smoke the /dashboard home screen: it must render, not hit the (app) error
// boundary.
//
// The product owner reported "Something broke loading this page" on /dashboard.
// This script reproduces that in a real browser, and — when the boundary DOES
// fire — clicks SHOW TECHNICAL DETAILS and prints the message/digest/stack so
// the cause is read rather than guessed.
//
//   1. Sign in as the seeded demo admin.
//   2. Load /dashboard, collecting console + pageerror + failed requests.
//   3. Assert the error boundary is absent and the KPI cards are present.
//   4. Repeat with ?ff_locale=ur (the locale path the new date code took),
//      if LOCALE_PASS=1.
//
// Read-only: creates and deletes nothing.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT =
  process.env.OUT ??
  "C:/Users/USER/AppData/Local/Temp/claude/c--Users-USER-FounderFlow/a350ed98-2437-4633-a2cf-29400c1d6a28/scratchpad/a3";
const EMAIL = process.env.SMOKE_EMAIL ?? "demo@founderflow.app";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "demo123";

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setVal(page, selector, val) {
  await page.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("no element for " + sel);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    val
  );
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();

const log = [];
page.on("console", (m) => log.push(`CONSOLE[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => log.push(`PAGEERROR ${e.message}`));
page.on("requestfailed", (r) => log.push(`REQFAILED ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url()}`);
});

/** Loads a path and reports whether the (app) error boundary fired, with detail. */
async function visit(page, path, tag) {
  log.length = 0;
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 60000 });
  // Recharts is lazy (next/dynamic, ssr:false); scroll it into view and give
  // the chunk time to land, or the x-axis assertion below tests the skeleton.
  await sleep(2500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  const probe = async () =>
    page.evaluate(() => {
      const bodyText = document.body.innerText;
      const boundary = bodyText.includes("Something broke loading this page");
      const btns = Array.from(document.querySelectorAll("button"));
      // The KPI labels are CSS-uppercased, so innerText yields "BALANCE" —
      // match case-insensitively or this asserts nothing about the product.
      const has = (s) => new RegExp(s, "i").test(bodyText);
      // Cash-flow x-axis ticks. This is the SILENT half of the same bug:
      // `getMonthlyTotals(CASH_FLOW_MONTHS, now)` received `{}` rather than 6,
      // so `span` was NaN, the bucket loop never ran, and `rollups.monthly`
      // came back empty. `cashFlowSeries` returns `rollups.monthly` verbatim
      // when `rollups` is present — it does NOT fall back to the row array —
      // so the chart would have been blank even if the page had survived.
      const ticks = Array.from(
        document.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick-value")
      ).map((t) => t.textContent.trim());
      return {
        boundary,
        url: location.href,
        hasBalance: has("balance"),
        hasOpenTasks: has("open tasks"),
        hasWelcome: /Welcome back/i.test(bodyText),
        // A real money figure, not a zero placeholder.
        hasMoney: /\d[\d,]*\.\d\d/.test(bodyText),
        cashFlowTicks: ticks,
        detailsBtn: btns.some((b) => /technical details/i.test(b.innerText)),
      };
    });

  let info = await probe();

  let detail = null;
  if (info.boundary && info.detailsBtn) {
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) =>
        /technical details/i.test(x.innerText)
      );
      b?.click();
    });
    await sleep(400);
    detail = await page.evaluate(() => document.body.innerText);
  }

  await page.screenshot({ path: `${OUT}/dashboard-${tag}.png`, fullPage: true });

  console.log(`\n── ${tag} :: ${path} -> ${info.url}`);
  console.log(
    `   boundary=${info.boundary} balance=${info.hasBalance} tasks=${info.hasOpenTasks} ` +
      `welcome=${info.hasWelcome} money=${info.hasMoney}`
  );
  console.log(
    `   cash-flow x-axis (${info.cashFlowTicks.length} buckets): ${info.cashFlowTicks.join(" ") || "(EMPTY)"}`
  );
  if (detail) {
    console.log("   ─── TECHNICAL DETAILS ───");
    console.log(
      detail
        .split("\n")
        .map((l) => "   | " + l)
        .join("\n")
    );
  }
  if (log.length) {
    console.log("   ─── console/network ───");
    for (const l of log.slice(0, 60)) console.log("   " + l);
  }
  return info;
}

let pass = true;
try {
  // ── sign in ──
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(700);
  await setVal(page, 'input[name="email"]', EMAIL);
  await setVal(page, 'input[name="password"]', PASSWORD);
  await sleep(200);
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  // Dev-mode first compile of /login + /dashboard is slow; poll instead of a
  // fixed wait, because closing the browser mid-flight shows up as a bogus
  // "Error: aborted" in the server log and looks like a login failure.
  for (let i = 0; i < 60 && page.url().includes("/login"); i++) await sleep(1000);
  console.log(`after login -> ${page.url()}`);
  await page.screenshot({ path: `${OUT}/after-login.png` });
  if (page.url().includes("/login")) {
    console.log("LOGIN FAILED — body follows");
    console.log(await page.evaluate(() => document.body.innerText.slice(0, 1500)));
    throw new Error("could not sign in");
  }

  const en = await visit(page, "/dashboard", "en");
  if (en.boundary) pass = false;
  if (!en.hasBalance || !en.hasOpenTasks || !en.hasWelcome || !en.hasMoney) pass = false;
  // CASH_FLOW_MONTHS is 6, and the chart must have that many buckets.
  if (en.cashFlowTicks.length !== 6) {
    console.log(`   FAIL: expected 6 cash-flow buckets, got ${en.cashFlowTicks.length}`);
    pass = false;
  }

  if (process.env.LOCALE_PASS === "1") {
    // The locale is NOT a query param — `useLocale()` reads the zustand store
    // (lib/store.ts:36), persisted under "founderflow-storage". A first draft
    // of this script loaded `/dashboard?ff_locale=ur` and asserted against it;
    // the param is ignored, so that pass proved nothing. Write the store and
    // reload instead, then VERIFY the switch took before trusting the result.
    await page.evaluate(() => {
      const key = "founderflow-storage";
      const raw = window.localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
      parsed.state = { ...parsed.state, locale: "ur" };
      window.localStorage.setItem(key, JSON.stringify(parsed));
    });

    const ur = await visit(page, "/dashboard", "ur");

    // Did the locale actually change? `dir` follows the locale outright
    // (components/providers.tsx:113), so rtl is the observable proof. `lang`
    // deliberately stays "en" while Urdu coverage is partial, so it is NOT the
    // signal to test here.
    const applied = await page.evaluate(() => ({
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      stored: JSON.parse(window.localStorage.getItem("founderflow-storage") || "{}")?.state?.locale,
    }));
    console.log(
      `   locale switch: stored=${applied.stored} dir=${applied.dir} lang=${applied.lang}`
    );
    if (applied.stored !== "ur" || applied.dir !== "rtl") {
      console.log("   FAIL: the Urdu pass did not actually switch locale — it proves nothing");
      pass = false;
    }

    if (ur.boundary) pass = false;
    if (!ur.hasWelcome) pass = false;
    if (ur.cashFlowTicks.length !== 6) pass = false;
  }
} catch (e) {
  pass = false;
  console.error("SMOKE ERROR:", e.message);
} finally {
  await browser.close();
}

console.log(`\n${pass ? "PASS" : "FAIL"} — screenshots in ${OUT}`);
process.exit(pass ? 0 : 1);
