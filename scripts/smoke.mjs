// One-off smoke test: drives the dev server with puppeteer-core + system Chrome.
// Captures landing in both themes + the inner app shell pages after demo login.

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3003";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("CONSOLE ERR:", msg.text());
});

async function shoot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log("captured", name);
}

// --- 1. landing in dark (default) ---
await page.goto(BASE, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500)); // let SplitText animation finish
await shoot("01-landing-dark");

// --- 2. toggle to light ---
const lightToggle = await page.$('button[aria-label="Switch to light theme"]');
if (lightToggle) {
  await lightToggle.click();
  await new Promise((r) => setTimeout(r, 400));
  await shoot("02-landing-light");
}

// --- 3. login page (back to dark) ---
await page.evaluate(() => {
  const raw = localStorage.getItem("founderflow-storage");
  if (raw) {
    const s = JSON.parse(raw);
    if (s?.state) s.state.theme = "dark";
    localStorage.setItem("founderflow-storage", JSON.stringify(s));
  }
});
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await shoot("03-login");

await page.goto(`${BASE}/signup`, { waitUntil: "networkidle2" });
await shoot("04-signup");

// --- 4. trigger demo session via the store, then visit inner pages ---
await page.goto(BASE, { waitUntil: "networkidle2" });
await page.waitForSelector("button");
// click the demo button text-wise — fall back to the page.evaluate hammer if it's not findable
const clicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const demo = btns.find((b) => /try the live demo|live demo/i.test(b.textContent ?? ""));
  if (demo) {
    demo.click();
    return true;
  }
  return false;
});
if (!clicked) console.error("Could not find demo button");
await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
await shoot("05-dashboard");

const inner = [
  ["06-expenses", "/expenses"],
  ["07-investments", "/investments"],
  ["08-tasks", "/tasks"],
  ["09-activities", "/activities"],
  ["10-team", "/team"],
  ["11-reports", "/reports"],
  ["12-notifications", "/notifications"],
  ["13-settings", "/settings"],
];

for (const [name, path] of inner) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 800));
  await shoot(name);
}

await browser.close();
console.log("done");
