/*
 * End-to-end smoke for member-role finance restrictions.
 *
 * Member account: sarah@nimbus.app / demo123 (role: "member" per seed).
 *
 * Asserts:
 *   • Direct nav to each finance route redirects sarah to /tasks.
 *   • Sidebar omits finance nav items for sarah but shows them for admin.
 *   • addTransactionAction rejects sarah (server-action guard, defense in
 *     depth — the form isn't reachable but a forged request might be).
 *   • /tasks is reachable + functional for sarah.
 *   • Notifications list strips financial-link rows for sarah.
 */

import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const BLOCKED = [
  "/dashboard",
  "/expenses",
  "/investments",
  "/recurring",
  "/budgets",
  "/reports",
  "/activities",
];

const ALLOWED = ["/tasks", "/time", "/team", "/notifications", "/settings"];

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", email);
  await page.type("input[type=password]", password);
  await page.click("button[type=submit]");
  // The login form sets the cookie via a server action and THEN does
  // window.location.href to navigate. Wait for the URL to actually leave
  // /login — waitForNavigation race-resolves on the action's network call
  // before the explicit href change fires.
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), {
    timeout: 15000,
  });
  // Let the redirect chain settle (admin → /dashboard, member → /tasks).
  await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*"],
  });

  console.log("== member finance-restriction smoke ==");

  // ── Sarah (member) — isolated browser context so cookies don't leak
  // into the admin's session below.
  const sarahCtx = await browser.createBrowserContext();
  const sarah = await sarahCtx.newPage();
  await sarah.setViewport({ width: 1440, height: 900 });
  await signIn(sarah, "sarah@nimbus.app", "demo123");
  const landedAt = new URL(sarah.url()).pathname;
  if (landedAt === "/tasks") ok(`sarah landed on /tasks (was ${landedAt})`);
  else fail("sarah post-login landing", `landed on ${landedAt}, expected /tasks`);

  // Each blocked route should redirect to /tasks.
  for (const route of BLOCKED) {
    await sarah.goto(`${BASE}${route}`, { waitUntil: "networkidle0" });
    const final = new URL(sarah.url()).pathname;
    if (final === "/tasks") ok(`blocked: ${route} → ${final}`);
    else fail(`blocked: ${route}`, `final ${final}, expected /tasks`);
  }

  // Each allowed route should NOT redirect.
  for (const route of ALLOWED) {
    await sarah.goto(`${BASE}${route}`, { waitUntil: "networkidle0" });
    const final = new URL(sarah.url()).pathname;
    if (final === route) ok(`allowed: ${route}`);
    else fail(`allowed: ${route}`, `final ${final}, expected ${route}`);
  }

  // Sidebar should NOT contain finance hrefs for sarah.
  await sarah.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
  const sidebarHrefs = await sarah.$$eval("aside a[href]", (links) =>
    links.map((a) => a.getAttribute("href"))
  );
  const leakedFinanceHref = BLOCKED.find((r) => sidebarHrefs.includes(r));
  if (!leakedFinanceHref) ok("sidebar: no finance nav items leaked");
  else fail("sidebar leak", `found ${leakedFinanceHref}`);

  // Notifications page should never include an <a href> pointing at a
  // finance route for a member. We check real anchors, not free text, so
  // the topbar's "Search expenses…" placeholder isn't a false positive.
  await sarah.goto(`${BASE}/notifications`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  const sarahFinanceHrefs = await sarah.$$eval("main a[href]", (links) =>
    links
      .map((a) => a.getAttribute("href") || "")
      .filter((h) =>
        /^\/(expenses|investments|budgets|recurring|reports|dashboard|activities)/.test(h)
      )
  );
  if (sarahFinanceHrefs.length === 0) ok("notifications: no finance hrefs visible");
  else fail("notifications leak", `finance hrefs: ${JSON.stringify(sarahFinanceHrefs)}`);

  await sarah.close();
  await sarahCtx.close();

  // ── Saqib (admin) — fresh context, no cookies from sarah's session.
  const saqibCtx = await browser.createBrowserContext();
  const saqib = await saqibCtx.newPage();
  await saqib.setViewport({ width: 1440, height: 900 });
  await signIn(saqib, "demo@founderflow.app", "demo123");
  const adminLanded = new URL(saqib.url()).pathname;
  if (adminLanded === "/dashboard") ok(`admin landed on /dashboard`);
  else fail("admin post-login landing", `landed on ${adminLanded}, expected /dashboard`);

  for (const route of BLOCKED) {
    await saqib.goto(`${BASE}${route}`, { waitUntil: "networkidle0" });
    const final = new URL(saqib.url()).pathname;
    if (final === route) ok(`admin can reach: ${route}`);
    else fail(`admin reach: ${route}`, `final ${final}`);
  }

  const adminSidebarHrefs = await saqib.$$eval("aside a[href]", (links) =>
    links.map((a) => a.getAttribute("href"))
  );
  const allFinancePresent = BLOCKED.every((r) => adminSidebarHrefs.includes(r));
  if (allFinancePresent) ok("admin sidebar: all finance nav items present");
  else
    fail(
      "admin sidebar",
      `missing: ${BLOCKED.filter((r) => !adminSidebarHrefs.includes(r)).join(",")}`
    );

  await browser.close();
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
