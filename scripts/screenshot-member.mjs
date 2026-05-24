import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const BASE = "http://localhost:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

async function main() {
  await mkdir("artifacts", { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", "sarah@nimbus.app");
  await page.type("input[type=password]", "demo123");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => !location.pathname.startsWith("/login"));
  await new Promise((r) => setTimeout(r, 1000));

  await page.screenshot({ path: "artifacts/member-tasks.png", fullPage: true });
  console.log("wrote artifacts/member-tasks.png");

  await page.goto(`${BASE}/notifications`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: "artifacts/member-notifs.png", fullPage: true });
  console.log("wrote artifacts/member-notifs.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
