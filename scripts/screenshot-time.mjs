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
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", "demo@founderflow.app");
  await page.type("input[type=password]", "demo123");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click("button[type=submit]"),
  ]);

  await page.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: "artifacts/time-page.png", fullPage: true });
  console.log("wrote artifacts/time-page.png");

  await page.goto(`${BASE}/time?scope=team`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: "artifacts/time-team.png", fullPage: true });
  console.log("wrote artifacts/time-team.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
