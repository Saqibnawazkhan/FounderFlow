// Smoke-test Phase 2 (loading slice): verify each protected route renders a
// skeleton (.animate-pulse divs) during navigation transition.
//
// Strategy:
//   1. Sign in.
//   2. Pre-warm /dashboard so we have a stable starting page.
//   3. Throttle the network so the page-chunk fetch takes ~500ms.
//   4. For each route: trigger client-side nav via a sidebar Link, then probe
//      .animate-pulse count within the next ~200ms. Skeleton wins if >0.
//
// Loading.tsx only fires for App-Router client navigation, not for full
// page reloads, so we deliberately use page.click on the sidebar <Link>.

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";

const ROUTES = [
  "/expenses",
  "/investments",
  "/tasks",
  "/activities",
  "/team",
  "/reports",
  "/notifications",
  "/settings",
  "/dashboard",
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// Sign in
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("input[name=email]", { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 500));
await page.type("input[name=email]", "demo@founderflow.app");
await page.type("input[name=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
await page
  .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20_000 })
  .catch(() => {});
console.log(`signed in -> ${page.url()}`);

// Land on /dashboard cleanly so the sidebar is rendered + clickable.
await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
await page.waitForSelector('aside[aria-label="Primary"]', { timeout: 10_000 });

// Throttle so the page-chunk fetch takes long enough to see the skeleton.
const cdp = await page.target().createCDPSession();
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 400,
  downloadThroughput: (200 * 1024) / 8,
  uploadThroughput: (50 * 1024) / 8,
});

let pass = 0;
const fail = [];

for (const path of ROUTES) {
  // Click the sidebar link by exact href so we trigger client-side App Router
  // navigation (Next.js then shows loading.tsx until the chunk + RSC resolve).
  const clicked = await page.evaluate((href) => {
    const link = document.querySelector(`aside[aria-label="Primary"] a[href="${href}"]`);
    if (!link) return false;
    link.click();
    return true;
  }, path);
  if (!clicked) {
    console.log(`❌ ${path.padEnd(16)} sidebar link not found`);
    fail.push(path);
    continue;
  }

  // Sample shortly after click — should still be in the loading state.
  await new Promise((r) => setTimeout(r, 250));
  let skeletonCount = 0;
  try {
    skeletonCount = await page.evaluate(
      () => document.querySelectorAll(".animate-pulse").length
    );
  } catch {
    // Execution context destroyed mid-probe means navigation completed; treat
    // as another sample opportunity.
    await new Promise((r) => setTimeout(r, 200));
    try {
      skeletonCount = await page.evaluate(
        () => document.querySelectorAll(".animate-pulse").length
      );
    } catch {
      /* swallow */
    }
  }
  // Wait for the page to actually finish loading before moving on.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll(".animate-pulse").length === 0 &&
        !!document.querySelector("h1"),
      { timeout: 15_000 }
    )
    .catch(() => {});
  const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent ?? "");

  const ok = skeletonCount > 0;
  console.log(
    `${ok ? "✅" : "❌"} ${path.padEnd(16)} skeletons=${String(skeletonCount).padEnd(3)} settled h1="${h1.slice(0, 40)}"`
  );
  if (ok) pass++;
  else fail.push(path);
}

console.log(`\nresult: ${pass}/${ROUTES.length} routes showed a skeleton`);
await browser.close();
process.exit(fail.length === 0 ? 0 : 1);
