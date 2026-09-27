/*
 * Visual check of the /tasks Calendar view at several widths. Not a smoke
 * (no assertions) — artifacts to see what a real viewport shows.
 */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.SHOT_DIR;

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

  await page.setViewport({ width: 1440, height: 1000 });

  // On a cold dev server the login form paints before React hydrates. Clicking
  // then performs a NATIVE form submit, which (the form has no method) becomes
  // a GET with the credentials in the query string and no sign-in. Retry until
  // the click is handled by React.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 180000 });
    await page.waitForSelector("input[type=email]", { timeout: 180000 });
    await new Promise((r) => setTimeout(r, 4000)); // let hydration finish
    await page.type("input[type=email]", "demo@founderflow.app");
    await page.type("input[type=password]", "demo123");
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      console.log(`signed in (attempt ${attempt})`);
      break;
    }
    const url = page.url();
    console.log(
      `attempt ${attempt} did not sign in (${url.includes("?email=") ? "pre-hydration GET" : "rejected"})`
    );
    if (attempt === 4) throw new Error("could not sign in after 4 attempts");
  }
  await new Promise((r) => setTimeout(r, 1500));

  await page.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.waitForSelector("button", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Switch to Calendar
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => x.textContent.trim() === "Calendar"
    );
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 1200));

  // Page back to a month that has work, so the shot is not an empty grid.
  for (let i = 0; i < 1; i++) {
    await page.click('[aria-label="Previous month"]');
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const [w, h, name] of [
    [1440, 1000, "a-1440"],
    [1280, 900, "b-1280"],
    [1024, 900, "c-1024"],
    [768, 900, "d-768"],
    [390, 844, "e-390"],
  ]) {
    await page.setViewport({ width: w, height: h });
    await new Promise((r) => setTimeout(r, 700));
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    const seen = await page.evaluate(() => ({
      gridVisible: !!document.querySelector('[data-calendar="grid"]')?.getClientRects().length,
      agendaVisible: !!document.querySelector('[data-calendar="agenda"]')?.getClientRects().length,
      toggleVisible: [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Calendar" && b.getClientRects().length
      ),
    }));
    console.log(name, JSON.stringify(seen));
  }

  await browser.close();
}

main().catch((e) => {
  console.error("shot threw:", e);
  process.exit(1);
});
