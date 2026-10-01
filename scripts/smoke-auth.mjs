/*
 * Auth.js sign-in, end to end, with assertions.
 *
 * WHAT IT ASSERTS:
 *   1. an unauthenticated /dashboard lands on /login (the middleware gate)
 *   2. submitting the seeded credentials leaves /login
 *   3. an `authjs.session-token` cookie exists and is httpOnly
 *   4. /dashboard then renders /dashboard rather than bouncing again
 *   5. the dashboard greets the signed-in user by name
 *
 * WHY IT WAS REWRITTEN (audit harness-001). This file contained zero failure
 * markers, zero `process.exitCode` assignments and no non-zero exit. It printed
 * five console.log lines and stopped. One of them was literally
 * `(3) session cookie: NONE` on a broken sign-in, and it still exited 0 — and
 * scripts/run-all-smoke.sh classifies a script by grepping its log for a failure
 * marker, so the summary read `OK smoke-auth`. Sign-in could have been
 * completely broken, with no session cookie set at all, and the only end-to-end
 * check of the only way into this product would have reported success.
 *
 * Nothing about the flow it drives was wrong. It just could not fail, which is
 * the same thing as not being a test. tests/ops/smoke-hygiene.test.ts now refuses
 * a smoke script with no reachable failure path, so this cannot recur silently.
 */

import puppeteer from "puppeteer-core";

/**
 * This script's own rate-limit bucket (audit harness-009). Every puppeteer
 * request in dev arrives with no forwarding header, so lib/client-ip.ts finds no
 * trusted address and lib/rate-limit.ts falls back to per-ACCOUNT limits — which
 * means two scripts signing in as the same seeded user share one 5-per-minute
 * budget, and whichever runs second reports "cannot sign in". A distinct address
 * per script is what lib/client-ip.ts already documents the harness as relying
 * on, and what every scripts/qa-*.mjs already does on 10.99.0.x.
 *
 * tests/ops/smoke-hygiene.test.ts asserts these are unique across the directory
 * and that every page created here is given one.
 */
const SMOKE_IP = "10.98.0.1";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

const EMAIL = "demo@founderflow.app";
const PASSWORD = "demo123";
/** prisma/seed.ts gives demo@founderflow.app the name "Saqib Nawaz". */
const EXPECTED_FIRST_NAME = "Saqib";

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE ERR:", m.text());
});

console.log("== auth smoke ==");

try {
  // ── 1. middleware bounce ──────────────────────────────────────────────
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
  const bounced = new URL(page.url()).pathname;
  if (bounced === "/login") ok("an unauthenticated /dashboard lands on /login");
  else fail("middleware bounce", `/dashboard -> ${bounced}, expected /login`);
  await page.screenshot({ path: `${OUT}/auth-01-bounce.png` });

  // ── 2. submit the seeded credentials ──────────────────────────────────
  // On a cold dev server the form paints before React hydrates, and a click
  // that lands first performs a NATIVE submit — a GET with the credentials in
  // the query string and no sign-in at all (FaultsAudit A14). So: retry until
  // React owns the submit, and treat "still on /login" as a real failure rather
  // than waiting a fixed 2.5s and hoping.
  let left = false;
  for (let attempt = 1; attempt <= 3 && !left; attempt += 1) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("input[type=email]", { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.type("input[type=email]", EMAIL);
    await page.type("input[type=password]", PASSWORD);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (left) ok(`submitting the seeded credentials left /login (-> ${page.url()})`);
  else fail("sign-in", `still on ${page.url()} after 3 attempts`);

  // ── 3. the session cookie ─────────────────────────────────────────────
  const cookies = await browser.cookies();
  const session = cookies.find((c) => c.name === "authjs.session-token");
  if (!session) {
    // THE assertion this file existed to make and did not. A missing cookie
    // means nobody can sign in.
    fail("session cookie", "authjs.session-token was not set");
  } else if (!session.httpOnly) {
    // A readable session cookie is an XSS-to-account-takeover primitive.
    fail("session cookie httpOnly", "authjs.session-token is readable from JS");
  } else {
    ok(`authjs.session-token is set and httpOnly (secure=${session.secure})`);
  }

  // ── 4. the authenticated dashboard ────────────────────────────────────
  const res = await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
  const landed = new URL(page.url()).pathname;
  const status = res ? res.status() : 0;
  if (landed === "/dashboard" && status < 400) {
    ok(`/dashboard renders for the signed-in user [${status}]`);
  } else {
    fail("authenticated dashboard", `-> ${landed} [${status}]`);
  }
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${OUT}/auth-02-dashboard.png` });

  // ── 5. it is the RIGHT user ───────────────────────────────────────────
  // A dashboard that renders is not the same as a dashboard that knows who is
  // looking at it: the session-name-freshness bugs all rendered fine.
  const headline = await page.evaluate(() => document.querySelector("h1")?.textContent ?? null);
  if (headline && headline.includes(EXPECTED_FIRST_NAME)) {
    ok(`the dashboard greets the signed-in user (${JSON.stringify(headline.trim())})`);
  } else {
    fail(
      "dashboard identity",
      `h1 was ${JSON.stringify(headline)}, expected it to name ${EXPECTED_FIRST_NAME} ` +
        `(prisma/seed.ts — if the seed's demo user was renamed, update EXPECTED_FIRST_NAME)`
    );
  }
} catch (err) {
  fail("auth smoke threw", err.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
process.exit(process.exitCode ? 1 : 0);
