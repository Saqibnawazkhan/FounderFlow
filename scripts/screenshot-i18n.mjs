/*
 * Visual screenshot: settings page in English and Urdu.
 * Not a smoke (no assertions) — just artifacts to eyeball the layout flip.
 */

import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function main() {
  await mkdir("artifacts", { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", "demo@founderflow.app");
  await page.type("input[type=password]", "demo123");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }),
    page.click("button[type=submit]"),
  ]);

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: "artifacts/settings-en.png", fullPage: true });
  console.log("wrote artifacts/settings-en.png");

  await (await page.waitForSelector("button[lang='ur']")).click();
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: "artifacts/settings-ur.png", fullPage: true });
  console.log("wrote artifacts/settings-ur.png");

  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: "artifacts/dashboard-ur.png", fullPage: true });
  console.log("wrote artifacts/dashboard-ur.png (sidebar should be in Urdu, layout RTL)");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
