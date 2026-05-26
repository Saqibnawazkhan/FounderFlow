/*
 * One-shot verification — log in as Sarah (member), navigate to /dashboard
 * and /settings, capture exactly what she sees. If the redirect + new
 * settings layout work, the user is hitting a stale cache (PWA service
 * worker, browser cache, or a stale Vercel deploy).
 */

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
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1440, height: 1200 });

// Sign in as Sarah.
await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
await page.type("input[type=email]", "sarah@nimbus.app");
await page.type("input[type=password]", "demo123");
await page.click("button[type=submit]");
await page.waitForFunction(() => !location.pathname.startsWith("/login"));
await new Promise((r) => setTimeout(r, 800));

console.log("Post-login URL:", page.url());

// /dashboard — should redirect to /tasks.
await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
console.log("After /dashboard nav:", page.url());
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: "artifacts/member-dashboard-attempt.png", fullPage: false });
console.log("wrote artifacts/member-dashboard-attempt.png");

// /settings — should show new layout (stats cards + Edit profile + Change password buttons).
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "artifacts/member-settings-current.png", fullPage: true });
console.log("wrote artifacts/member-settings-current.png");

// Inspect what buttons / sections exist on the settings page.
const settingsInspect = await page.evaluate(() => {
  return {
    h1: document.querySelector("h1")?.textContent?.trim(),
    sectionLabels: Array.from(document.querySelectorAll("section h2")).map((h) =>
      (h.textContent || "").trim()
    ),
    visibleButtons: Array.from(document.querySelectorAll("button"))
      .map((b) => (b.textContent || "").trim())
      .filter((t) => t.length > 0 && t.length < 30),
    sidebarHrefs: Array.from(document.querySelectorAll("aside a[href]")).map((a) =>
      a.getAttribute("href")
    ),
  };
});
console.log("Settings page inspection:");
console.log(JSON.stringify(settingsInspect, null, 2));

await browser.close();
