import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
const BASE = "http://localhost:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
await mkdir("artifacts", { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
for (const [name, email] of [
  ["admin", "demo@founderflow.app"],
  ["member", "sarah@nimbus.app"],
]) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", email);
  await page.type("input[type=password]", "demo123");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => !location.pathname.startsWith("/login"));
  await new Promise((r) => setTimeout(r, 500));
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `artifacts/projects-${name}.png`, fullPage: true });
  console.log("wrote artifacts/projects-" + name + ".png");
  await ctx.close();
}
await browser.close();
