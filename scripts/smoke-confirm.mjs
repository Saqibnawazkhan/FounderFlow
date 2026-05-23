// One-off: prove the ConfirmDialog actually opens by clicking a delete trigger
// on the expenses page after demo login.

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3004";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// boot demo
await page.goto(BASE, { waitUntil: "networkidle2" });
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const demo = btns.find((b) => /try the live demo|live demo/i.test(b.textContent ?? ""));
  demo?.click();
});
await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});

await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 600));

// click the first delete button in the table
const clicked = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label^="Delete expense"]');
  if (btn) {
    btn.click();
    return true;
  }
  return false;
});
console.log("delete clicked:", clicked);
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: `${OUT}/confirm-dialog.png`, fullPage: false });
console.log("captured confirm-dialog");

await browser.close();
