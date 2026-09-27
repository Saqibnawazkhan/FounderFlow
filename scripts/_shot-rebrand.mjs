/*
 * Visual check of the charcoal/emerald rebrand. Not a smoke (no assertions) —
 * artifacts to eyeball the palette on the surfaces that changed most.
 */
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.SHOT_DIR;

async function signIn(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[type=email]", { timeout: 180000 });
  await page.type("input[type=email]", email);
  await page.type("input[type=password]", "demo123");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 1500));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

  // Marketing surface is light-first, so it exercises the light tokens.
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[type=email]", { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/01-login.png` });
  console.log("wrote 01-login");

  await signIn(page, "demo@founderflow.app");

  for (const [name, path, wait] of [
    ["02-dashboard", "/dashboard", 2500],
    ["03-projects", "/projects", 1800],
    ["04-reports", "/reports", 2500],
    ["05-tasks", "/tasks", 1800],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 180000 });
    await new Promise((r) => setTimeout(r, wait));
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log("wrote", name);
  }

  await browser.close();
}

main().catch((e) => {
  console.error("shot threw:", e);
  process.exit(1);
});
