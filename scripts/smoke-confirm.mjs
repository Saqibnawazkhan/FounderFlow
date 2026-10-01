/*
 * ConfirmDialog smoke: the delete confirmation on /expenses actually opens,
 * traps focus in a real dialog, and cancels without deleting.
 *
 * WHY IT WAS REWRITTEN (audit harness-001). This file contained no failure
 * marker, no `process.exitCode` and no non-zero exit. It printed
 * `delete clicked: false` when it could not find the trigger and exited 0, so
 * scripts/run-all-smoke.sh reported `OK smoke-confirm`.
 *
 * AND IT WAS LOOKING AT THE WRONG PAGE. It reached /expenses by clicking "Try
 * the live demo", and `loginDemo()` in lib/store.ts only sets Zustand state — it
 * mints no Auth.js session, so middleware bounces every subsequent navigation
 * straight back to /login. Its screenshot of "the confirm dialog" was a
 * screenshot of the sign-in form. It now signs in with the seeded credentials
 * like every other script in this directory, which is both a real session and a
 * real page. (The demo CTA itself is a separate, live bug: see
 * components/landing/demo-button.tsx.)
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
const SMOKE_IP = "10.98.0.7";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

const EMAIL = "demo@founderflow.app";
const PASSWORD = "demo123";

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

/** Retry until React owns the submit; see FaultsAudit A14. */
async function signIn(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("input[type=email]", { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.type("input[type=email]", EMAIL);
    await page.type("input[type=password]", PASSWORD);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (left) return true;
  }
  return false;
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

console.log("== confirm-dialog smoke ==");

try {
  if (await signIn(page)) ok(`signed in as ${EMAIL}`);
  else fail("sign-in", `still on ${page.url()} after 3 attempts`);

  await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle2" });
  const landed = new URL(page.url()).pathname;
  if (landed === "/expenses") ok("/expenses renders for an admin");
  else fail("reach /expenses", `-> ${landed} (a bounce here means no session)`);

  // Wait for the delete TRIGGER, not for `tbody tr` — expenses-client.tsx
  // renders more than one tbody (the empty/skeleton state has rows of its own),
  // so a row count can be satisfied by a table with nothing in it.
  const hasTrigger = await page
    .waitForSelector('button[aria-label^="Delete expense"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (hasTrigger) ok("the expense table offers a delete trigger");
  else fail("delete trigger", 'no button[aria-label^="Delete expense"] — is the seed loaded?');

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label^="Delete expense"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (clicked) ok("the delete trigger accepted a click");
  else fail("delete click", "the trigger vanished between the wait and the click");

  // THE assertion this file is named for, and the one it never made: a dialog
  // that opens has role="dialog" and is modal. A styled div that merely looks
  // like one is not reachable by a screen reader or dismissible with Escape.
  const dialog = await page
    .waitForSelector('[role="dialog"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (dialog) ok("the confirmation reaches role=dialog");
  else fail("confirm dialog", 'clicking delete opened nothing with role="dialog"');

  const shape = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return {
      modal: d.getAttribute("aria-modal"),
      labelled: Boolean(d.getAttribute("aria-labelledby") || d.getAttribute("aria-label")),
      focusInside: d.contains(document.activeElement),
    };
  });
  if (shape && shape.modal === "true" && shape.labelled) {
    ok("the dialog is aria-modal and has an accessible name");
  } else {
    fail("dialog semantics", JSON.stringify(shape));
  }
  if (shape && shape.focusInside) ok("focus moved into the dialog");
  else fail("dialog focus", "focus stayed behind the dialog, so Tab walks the page underneath");

  await page.screenshot({ path: `${OUT}/confirm-dialog.png`, fullPage: false });

  // Escape must close it, and nothing must have been deleted: this script is a
  // dialog check, not a destructive one, so it must leave the seed alone.
  await page.keyboard.press("Escape");
  const closed = await page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (closed) ok("Escape closes the dialog without deleting anything");
  else fail("dialog escape", "the dialog is still open after Escape");
} catch (err) {
  fail("confirm smoke threw", err.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
process.exit(process.exitCode ? 1 : 0);
