// Smoke the new Auth.js sign-in flow end-to-end:
//   1. unauthenticated /dashboard → bounces to /login (middleware)
//   2. fill the form with the seeded demo creds → POST → session cookie set
//   3. /dashboard renders the real user

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3006";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE ERR:", m.text());
});

// 1. middleware bounce
const r1 = await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
console.log(`(1) /dashboard unauth -> ${page.url()} [${r1?.status()}]`);
await page.screenshot({ path: `${OUT}/auth-01-bounce.png` });

// 2. fill + submit login (don't race with waitForNavigation; just submit and wait)
await page.type("input[type=email]", "demo@founderflow.app");
await page.type("input[type=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
// Give the server action + bcrypt verify + cookie set + client redirect time.
await new Promise((r) => setTimeout(r, 2500));
console.log(`(2) after submit -> ${page.url()}`);

const cookies = await browser.cookies();
const session = cookies.find((c) => c.name === "authjs.session-token");
console.log(
  `(3) session cookie: ${
    session ? `present (httpOnly=${session.httpOnly}, secure=${session.secure})` : "NONE"
  }`
);

// 3. explicit dashboard visit with the saved cookie
const r3 = await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
console.log(`(4) /dashboard auth   -> ${page.url()} [${r3?.status()}]`);
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${OUT}/auth-02-dashboard.png` });

// 4. read the page to confirm the right user is showing
const headline = await page.evaluate(() => {
  const h = document.querySelector("h1");
  return h?.textContent ?? null;
});
console.log(`(5) dashboard headline: ${JSON.stringify(headline)}`);

await browser.close();
