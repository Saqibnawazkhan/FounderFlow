// Smoke-test the Phase 1.B transaction flow end-to-end:
//   1. sign in with the seeded demo user
//   2. visit /expenses, count rows in the table
//   3. open the "Log expense" modal, fill the form, submit
//   4. verify a new row appeared
//   5. verify the row also exists in Supabase via a direct DB count

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3008";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

const db = new PrismaClient();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// --- baseline DB count ---
const beforeDb = await db.transaction.count();
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
await new Promise((r) => setTimeout(r, 500));
await page.type('input[type="number"]', "12345");
await page.type("textarea", "Smoke-test expense from puppeteer");
await page.screenshot({ path: `${OUT}/txn-02-modal.png` });

await page.evaluate(() => {
  // The modal renders its own form — submit only that one.
  const dialog = document.querySelector('[role="dialog"]');
  dialog?.querySelector("form")?.requestSubmit();
});
await new Promise((r) => setTimeout(r, 3000));

// --- 4. verify in the UI: count after in-place refresh ---
const rowsAfterInPlace = await page.evaluate(
  () => document.querySelectorAll("tbody tr").length
);
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
const rowsAfterReload = await page.evaluate(
  () => document.querySelectorAll("tbody tr").length
);
console.log(`/expenses rows (hard reload):     ${rowsAfterReload}`);
await page.screenshot({ path: `${OUT}/txn-04-after-reload.png` });
const rowsAfter = rowsAfterReload;

// --- 5. verify in Supabase ---
const afterDb = await db.transaction.count();
console.log(`DB rows after:  ${afterDb}`);
const latest = await db.transaction.findFirst({ orderBy: { createdAt: "desc" } });
console.log(`latest DB row: ${latest ? `${latest.type} ${latest.amount} "${latest.description}"` : "none"}`);

console.log(
  rowsAfter === rowsBefore + 1 && afterDb === beforeDb + 1
    ? "✅ transaction round-trip succeeded"
    : "❌ counts don't line up — check the screenshots"
);

await browser.close();
await db.$disconnect();
