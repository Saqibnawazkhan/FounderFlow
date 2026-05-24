/*
 * Smoke test for the lightweight i18n layer.
 *
 * Flow:
 *  1. Open /settings via the existing demo workspace (loginDemo seed user).
 *  2. Verify the page renders in English (header text matches dict.en).
 *  3. Click the اردو locale toggle.
 *  4. Verify the page re-renders in Urdu (header text matches dict.ur) AND
 *     <html dir="rtl" lang="ur"> got applied by the Providers effect.
 *  5. Click English back, verify rollback.
 *
 * No DB writes. Pure UI smoke against the live dev server.
 */

import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log("== i18n smoke ==");

  // 1. Real Auth.js login with seed admin — the "demo" button only flips
  // Zustand, so it can't get past server middleware on protected routes.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", "demo@founderflow.app");
  await page.type("input[type=password]", "demo123");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }),
    page.click("button[type=submit]"),
  ]);
  ok("signed in as seed admin");

  // 2. Navigate to /settings and verify English header.
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle0" });
  const headingEn = await page.$eval("h1", (el) => el.textContent?.trim() || "");
  if (headingEn === "Settings") ok("English heading: Settings");
  else fail("English heading", `got "${headingEn}"`);

  const htmlDirEn = await page.$eval("html", (el) => el.getAttribute("dir") || "");
  const htmlLangEn = await page.$eval("html", (el) => el.getAttribute("lang") || "");
  if (htmlLangEn === "en" && (htmlDirEn === "ltr" || htmlDirEn === "")) {
    ok(`html lang=${htmlLangEn} dir=${htmlDirEn || "(unset)"}`);
  } else {
    fail("English html attrs", `lang=${htmlLangEn} dir=${htmlDirEn}`);
  }

  // 3. Click اردو toggle.
  const urduBtn = await page.waitForSelector("button[lang='ur']", { timeout: 5000 });
  await urduBtn.click();
  // Let the Zustand subscription propagate + Providers effect run.
  await new Promise((r) => setTimeout(r, 400));

  // 4. Verify Urdu heading + html attrs.
  const headingUr = await page.$eval("h1", (el) => el.textContent?.trim() || "");
  if (headingUr === "ترتیبات") ok("Urdu heading: ترتیبات");
  else fail("Urdu heading", `got "${headingUr}"`);

  const htmlDirUr = await page.$eval("html", (el) => el.getAttribute("dir") || "");
  const htmlLangUr = await page.$eval("html", (el) => el.getAttribute("lang") || "");
  if (htmlLangUr === "ur" && htmlDirUr === "rtl") {
    ok(`html lang=${htmlLangUr} dir=${htmlDirUr}`);
  } else {
    fail("Urdu html attrs", `lang=${htmlLangUr} dir=${htmlDirUr}`);
  }

  // 5. Click English back.
  const enBtn = await page.waitForSelector("button[lang='en']", { timeout: 5000 });
  await enBtn.click();
  await new Promise((r) => setTimeout(r, 400));
  const headingBack = await page.$eval("h1", (el) => el.textContent?.trim() || "");
  if (headingBack === "Settings") ok("rolled back to English");
  else fail("English rollback", `got "${headingBack}"`);

  // 6. Sidebar nav label sanity — verify it follows the toggle too.
  const dirAfter = await page.$eval("html", (el) => el.getAttribute("dir") || "");
  if (dirAfter === "ltr" || dirAfter === "") ok("html dir back to ltr");
  else fail("html dir rollback", `got "${dirAfter}"`);

  await browser.close();
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
