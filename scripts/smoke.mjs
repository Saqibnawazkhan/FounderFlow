/*
 * The screenshot tour: landing in both themes, the two auth pages, and every
 * page of the signed-in shell. First script in scripts/run-all-smoke.sh, because
 * it creates the shared screenshot directory the others write into.
 *
 * WHY IT WAS REWRITTEN (audit harness-001). Two faults, and the second is what
 * made the first expensive.
 *
 * 1. IT COULD NOT FAIL. No failure marker, no `process.exitCode`, no non-zero
 *    exit — 95 lines of console.log. run-all-smoke.sh classifies a script by
 *    grepping its log for a marker, so this one reported `OK` on every run it
 *    survived, whatever it had captured.
 *
 * 2. IT WAS PHOTOGRAPHING THE LOGIN PAGE. It entered the app by clicking "Try
 *    the live demo", and `loginDemo()` in lib/store.ts only writes Zustand
 *    state; it mints no Auth.js session. Middleware therefore bounced
 *    /dashboard, /expenses, /tasks and the other six straight back to /login. So
 *    nine of its thirteen screenshots were the sign-in form, filed under names
 *    like `08-tasks.png` as evidence that those pages render.
 *
 * Together: a script that reported success while proving nothing, and produced
 * artefacts that actively misled anyone who opened them. It now signs in with
 * the seeded credentials (the same path smoke-auth.mjs and smoke-chat.mjs use)
 * and asserts, for every page, that it landed on the URL it asked for and that
 * the page has a heading. The demo CTA is a real bug and still a bug — it is just
 * not this script's subject; see components/landing/demo-button.tsx.
 */

import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
const SMOKE_IP = "10.98.0.27";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
mkdirSync(OUT, { recursive: true });

const EMAIL = "demo@founderflow.app";
const PASSWORD = "demo123";

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
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  args: [
    "--no-sandbox",
    "--no-proxy-server",
    "--proxy-bypass-list=*",
    "--disable-gpu",
    "--hide-scrollbars",
  ],
});

const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("CONSOLE ERR:", msg.text());
});

async function shoot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`  (captured ${name})`);
}

/**
 * Go to `path`, assert we are actually ON it, and capture it.
 *
 * The URL check is the whole difference between this file and the version that
 * shipped: a bounce to /login is exactly what the old one screenshotted and
 * called done.
 */
async function visit(name, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 800));
  const landed = new URL(page.url()).pathname;
  if (landed !== path) {
    fail(`${path} renders`, `landed on ${landed} — a bounce here means the session is gone`);
  } else {
    const heading = await page.evaluate(() => document.querySelector("h1")?.textContent ?? null);
    if (heading && heading.trim().length > 0) ok(`${path} — h1 ${JSON.stringify(heading.trim())}`);
    else fail(`${path} heading`, "the page rendered with no h1 at all");
  }
  await shoot(name);
}

console.log("== screenshot tour ==");

try {
  // ── 1. landing, dark (the default) ──────────────────────────────────
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1500)); // let the SplitText animation finish
  const landingHeading = await page.evaluate(
    () => document.querySelector("h1")?.textContent ?? null
  );
  if (landingHeading) ok("the landing page renders a headline");
  else fail("landing page", "no h1 on /");
  await shoot("01-landing-dark");

  // ── 2. landing, light ───────────────────────────────────────────────
  const lightToggle = await page.$('button[aria-label="Switch to light theme"]');
  if (lightToggle) {
    await lightToggle.click();
    await new Promise((r) => setTimeout(r, 400));
    await shoot("02-landing-light");
    ok("the theme toggle is present and clickable");
  } else {
    // Not fatal to the tour, but it is a missing control on the marketing page
    // and the old script silently skipped it.
    fail("theme toggle", 'no button[aria-label="Switch to light theme"] on the landing page');
  }

  // Back to dark for the rest of the tour, so the captures are comparable.
  await page.evaluate(() => {
    const raw = localStorage.getItem("founderflow-storage");
    if (raw) {
      const s = JSON.parse(raw);
      if (s?.state) s.state.theme = "dark";
      localStorage.setItem("founderflow-storage", JSON.stringify(s));
    }
  });

  // ── 3. the two pre-auth pages ───────────────────────────────────────
  for (const [name, path] of [
    ["03-login", "/login"],
    ["04-signup", "/signup"],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
    const landed = new URL(page.url()).pathname;
    if (landed === path) ok(`${path} renders`);
    else fail(`${path} renders`, `landed on ${landed}`);
    await shoot(name);
  }

  // ── 4. sign in for real ─────────────────────────────────────────────
  // Retry until React owns the submit; a click that lands before hydration
  // performs a native GET and signs nobody in (FaultsAudit A14).
  let signedIn = false;
  for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("input[type=email]", { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.type("input[type=email]", EMAIL);
    await page.type("input[type=password]", PASSWORD);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    signedIn = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!signedIn) {
    // Every capture below would be the login form. Say so once, loudly, rather
    // than producing nine misleading files.
    fail("sign-in", `still on ${page.url()} after 3 attempts — skipping the shell tour`);
  } else {
    ok(`signed in as ${EMAIL} (-> ${page.url()})`);
    for (const [name, path] of [
      ["05-dashboard", "/dashboard"],
      ["06-expenses", "/expenses"],
      ["07-investments", "/investments"],
      ["08-tasks", "/tasks"],
      ["09-activities", "/activities"],
      ["10-team", "/team"],
      ["11-reports", "/reports"],
      ["12-notifications", "/notifications"],
      ["13-settings", "/settings"],
    ]) {
      await visit(name, path);
    }
  }
} catch (err) {
  fail("screenshot tour threw", err.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
process.exit(process.exitCode ? 1 : 0);
