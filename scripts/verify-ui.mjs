// Focused UI verification for the landing/login/signup polish pass.
// Screenshots at desktop + narrow-mobile widths and asserts no horizontal
// overflow (the landing nav used to bleed past ~360-375px viewports).

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-ui-verify";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE ERR:", m.text());
});

let failures = 0;

async function shoot(name, { width, height }) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

// Assert the document doesn't scroll horizontally at this viewport.
async function assertNoHOverflow(label, width) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      innerW: window.innerWidth,
    };
  });
  // Allow 1px rounding slack.
  const bleeds = overflow.scrollW > overflow.clientW + 1;
  console.log(
    `${bleeds ? "❌" : "✅"} ${label} @${width}px  scrollW=${overflow.scrollW} clientW=${overflow.clientW}`
  );
  if (bleeds) failures++;
}

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 360, height: 780 }; // narrow Android — the tight case

// ---------- Landing ----------
await page.setViewport(DESKTOP);
await page.goto(BASE, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1200)); // SplitText settle
await shoot("landing-desktop-dark", DESKTOP);
await assertNoHOverflow("landing", 1440);

// light theme
const lightToggle = await page.$('button[aria-label="Switch to light theme"]');
if (lightToggle) {
  await lightToggle.click();
  await new Promise((r) => setTimeout(r, 400));
  await shoot("landing-desktop-light", DESKTOP);
}

// mobile — the nav-overflow regression case
await page.setViewport(MOBILE);
await page.goto(BASE, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 800));
await shoot("landing-mobile", MOBILE);
await assertNoHOverflow("landing", 360);

// ---------- Login ----------
await page.setViewport(DESKTOP);
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 500));
await shoot("login-desktop", DESKTOP);
await assertNoHOverflow("login", 1440);
await page.setViewport(MOBILE);
await page.reload({ waitUntil: "networkidle2" });
await shoot("login-mobile", MOBILE);
await assertNoHOverflow("login", 360);

// ---------- Signup (step 1 + step 2 to see the industry <select>) ----------
await page.setViewport(DESKTOP);
await page.goto(`${BASE}/signup`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 500));
await shoot("signup-step1-desktop", DESKTOP);
await assertNoHOverflow("signup", 1440);

// Fill step 1 with valid dummy data and click Continue (client-side only, no DB write).
await page.evaluate(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const proto =
      el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set('input[autocomplete="name"]', "Ayesha Malik");
  set('input[type="email"]', "ayesha@nimbuslabs.co");
  set('input[type="password"]', "verystrongpw");
});
await new Promise((r) => setTimeout(r, 200));
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  btns.find((b) => /continue/i.test(b.textContent ?? ""))?.click();
});
await new Promise((r) => setTimeout(r, 600));
await shoot("signup-step2-desktop", DESKTOP); // industry <select> with chevron visible
await assertNoHOverflow("signup step2", 1440);

console.log(failures === 0 ? "\n✅ UI verify passed — no horizontal overflow" : `\n❌ ${failures} overflow issue(s)`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
