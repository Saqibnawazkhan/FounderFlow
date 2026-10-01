// Smoke-test the Phase 1.B transaction flow end-to-end:
//   1. sign in with the seeded demo user
//   2. visit /expenses, count rows in the table
//   3. open the "Log expense" modal, fill the form, submit
//   4. verify a new row appeared
//   5. verify the row also exists in Supabase via a direct DB count

import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

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
const SMOKE_IP = "10.98.0.26";

/**
 * THE TENANT THIS SCRIPT OWNS, and every count below is scoped to it
 * (audit harness-012).
 *
 * The reads used to be bare `db.<model>.count()` -- every tenant in the database
 * at once -- and the pass criterion was `after === before + 1`. Sequentially that
 * is merely fragile; run two scripts against one server, which the QA harness
 * does, and another tenant's insert satisfies the arithmetic while the write
 * under test silently failed. A false pass is the most expensive thing a
 * pre-launch harness can produce, because it ends the investigation.
 */
const COMPANY_ID = "demo-nimbus";

/**
 * A description only this run could have written, so the row can be looked up
 * rather than guessed at. It used to be a fixed literal plus `findFirst({
 * orderBy: { createdAt: "desc" } })`, which returns whoever wrote last -- so the
 * log printed another tenant's transaction as corroboration for a false pass.
 */
const STAMP = Date.now().toString().slice(-6);
const TXN_DESCRIPTION = `Smoke-test expense from puppeteer ${STAMP}`;

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3008";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

// Pinned to the local docker Postgres. A bare `new PrismaClient()` here
// auto-loads the ROOT .env, which points at production Supabase — see
// scripts/_local-db.mjs. This script mutates data; it must never be able
// to reach a hosted database.
const db = localDb();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// --- baseline DB count, scoped to this script's tenant ---
const scope = { where: { companyId: COMPANY_ID } };
const beforeDb = await db.transaction.count(scope);
console.log(`DB rows before: ${beforeDb}`);

// --- 1. sign in ---
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.type("input[type=email]", "demo@founderflow.app");
await page.type("input[type=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
// Wait for the server action + cookie set + redirect to fully settle. The
// bcrypt + Supabase round-trip can take 1.5–2s on cold connections.
await new Promise((r) => setTimeout(r, 5000));
const afterLoginUrl = page.url();
console.log(`after login URL: ${afterLoginUrl}`);

// --- 2. visit /expenses ---
await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle2" });
await page
  .waitForFunction(() => document.querySelectorAll("tbody tr").length > 0, {
    timeout: 8000,
  })
  .catch(() => {});
const rowsBefore = await page.evaluate(() => document.querySelectorAll("tbody tr").length);
console.log(`/expenses rows before: ${rowsBefore}`);
await page.screenshot({ path: `${OUT}/txn-01-expenses-before.png` });

// --- 3. open the modal + fill + submit ---
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  btns.find((b) => /log expense/i.test(b.textContent ?? ""))?.click();
});
// Modal mount + Framer Motion enter takes ~300-1500ms on cold dev. Wait for
// the form's number input to exist rather than racing on a fixed timeout.
await page.waitForSelector('[role="dialog"] input[type="number"]', { timeout: 5000 });
// Fill via the prototype-descriptor trick — page.type silently no-ops on
// some Chromium / RHF combinations for number inputs even after focus().
// Setting via the descriptor + dispatching `input` is the canonical way to
// drive a controlled/registered field.
await page.evaluate((txnDescription) => {
  const dialog = document.querySelector('[role="dialog"]');
  const amount = dialog?.querySelector('input[type="number"]');
  const desc = dialog?.querySelector("textarea");
  const setInput = (el, v) => {
    if (!el) return;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const setTextarea = (el, v) => {
    if (!el) return;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
      el,
      v
    );
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  setInput(amount, "12345");
  setTextarea(desc, txnDescription);
}, TXN_DESCRIPTION);
await page.screenshot({ path: `${OUT}/txn-02-modal.png` });

await page.evaluate(() => {
  // The modal renders its own form — submit only that one.
  const dialog = document.querySelector('[role="dialog"]');
  dialog?.querySelector("form")?.requestSubmit();
});
await new Promise((r) => setTimeout(r, 3000));

// --- 4. verify in the UI: count after in-place refresh ---
const rowsAfterInPlace = await page.evaluate(() => document.querySelectorAll("tbody tr").length);
console.log(`/expenses rows (in-place refresh): ${rowsAfterInPlace}`);
await page.screenshot({ path: `${OUT}/txn-03-after-in-place.png` });

// --- 4b. force a hard nav to re-fetch from scratch ---
// networkidle2 fires before the useEffect-triggered server action returns,
// so explicitly wait for the table to populate (or 8s ceiling).
await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle2" });
await page
  .waitForFunction(() => document.querySelectorAll("tbody tr").length > 0, {
    timeout: 8000,
  })
  .catch(() => {});
const rowsAfterReload = await page.evaluate(() => document.querySelectorAll("tbody tr").length);
console.log(`/expenses rows (hard reload):     ${rowsAfterReload}`);
await page.screenshot({ path: `${OUT}/txn-04-after-reload.png` });
const rowsAfter = rowsAfterReload;

// --- 5. verify in the database ---
const afterDb = await db.transaction.count(scope);
console.log(`DB rows after:  ${afterDb}`);
// The row this run wrote, found by the description this run generated.
const created = await db.transaction.findFirst({
  where: { companyId: COMPANY_ID, description: TXN_DESCRIPTION },
});
console.log(
  `created DB row: ${created ? `${created.type} ${created.amount} "${created.description}"` : "NONE"}`
);

// `created !== null` is the assertion no other writer can satisfy on this
// script's behalf; the deltas are corroboration, not the proof.
const ok = created !== null && rowsAfter === rowsBefore + 1 && afterDb === beforeDb + 1;
console.log(
  ok
    ? "✅ transaction round-trip succeeded"
    : "❌ transaction round-trip failed — check the screenshots"
);
if (!ok) process.exitCode = 1;

await browser.close();
await db.$disconnect();
