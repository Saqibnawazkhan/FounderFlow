// Smoke-test Phase 6 (recurring slice): create a rule via the action, hit
// the cron endpoint TWICE with a backdated lastMaterializedAt so the
// second instance fires, verify a new Transaction lands with the rule id.
//
// The materializer is gated on (a) today matches the rule's day AND (b)
// lastMaterializedAt isn't already today. To exercise it without sleeping
// for days, we manually backdate lastMaterializedAt in the DB to simulate
// "next day arrived", then call /api/cron/materialize-recurring.

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";
const CRON_SECRET = process.env.CRON_SECRET; // pull from process env

if (!CRON_SECRET) {
  console.error("Set CRON_SECRET in env before running this smoke.");
  process.exit(1);
}

const db = new PrismaClient();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

const stamp = Date.now();

const beforeRules = await db.recurringRule.count();
const beforeTxns = await db.transaction.count({ where: { companyId: "demo-nimbus" } });
console.log(`DB before: rules=${beforeRules} txns(demo-nimbus)=${beforeTxns}`);

/* ── Sign in as admin ─────────────────────────────────────────────────── */
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("input[name=email]", { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 500));
await page.type("input[name=email]", "demo@founderflow.app");
await page.type("input[name=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
await page
  .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15_000 })
  .catch(() => {});
console.log(`signed in -> ${page.url()}`);

/* ── Visit /recurring + open the New rule modal ───────────────────────── */
await page.goto(`${BASE}/recurring`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));

await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /new rule|add first rule/i.test(b.textContent ?? "")
  );
  btn?.click();
});
await page.waitForSelector('[role="dialog"] input', { timeout: 10_000 });

const todayDom = new Date().getUTCDate();

// Fill the form via prototype-descriptor injection (same trick the other smokes use)
await page.evaluate(
  ({ desc, dayOfMonth }) => {
    const dialog = document.querySelector('[role="dialog"]');
    const amountEl = dialog?.querySelector('input[type="number"]'); // first number input is amount
    const numberInputs = dialog?.querySelectorAll('input[type="number"]');
    const dayEl = numberInputs?.[numberInputs.length - 1]; // last number input = day of month
    const descEl = dialog?.querySelector('input[name="description"]');
    const setInput = (el, v) => {
      if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
        el,
        String(v)
      );
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setInput(amountEl, "9999");
    setInput(dayEl, String(dayOfMonth));
    setInput(descEl, desc);
  },
  { desc: `Smoke rule ${stamp}`, dayOfMonth: todayDom }
);
await new Promise((r) => setTimeout(r, 200));

await page.evaluate(() => {
  document.querySelector('[role="dialog"] form')?.requestSubmit();
});
await page
  .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 })
  .catch(() => {});

const ruleRow = await db.recurringRule.findFirst({
  where: { description: `Smoke rule ${stamp}` },
});
console.log(
  ruleRow
    ? `✅ rule created: id=${ruleRow.id.slice(0, 8)} dayOfMonth=${ruleRow.dayOfMonth} lastMat=${ruleRow.lastMaterializedAt?.toISOString().slice(0, 10) ?? "null"}`
    : "❌ rule row NOT found"
);
if (!ruleRow) {
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

// Seed transaction should also exist (createRecurringRuleAction emits one
// immediately so the user sees instant feedback).
const seedTxn = await db.transaction.findFirst({
  where: { ruleId: ruleRow.id },
  orderBy: { createdAt: "desc" },
});
console.log(
  seedTxn
    ? `✅ seed transaction created at rule-creation time: id=${seedTxn.id.slice(0, 8)} amount=${seedTxn.amount}`
    : "❌ seed transaction missing"
);

/* ── Backdate lastMaterializedAt + hit cron to simulate next day ──────── */
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
await db.recurringRule.update({
  where: { id: ruleRow.id },
  data: { lastMaterializedAt: twoDaysAgo },
});
console.log(`backdated lastMaterializedAt to ${twoDaysAgo.toISOString().slice(0, 10)}`);

const cronRes = await fetch(`${BASE}/api/cron/materialize-recurring`, {
  headers: { Authorization: `Bearer ${CRON_SECRET}` },
});
const cronJson = await cronRes.json();
console.log(
  `cron response: status=${cronRes.status} created=${cronJson.transactionsCreated} checked=${cronJson.rulesChecked}`
);

const cronTxns = await db.transaction.findMany({
  where: { ruleId: ruleRow.id },
  orderBy: { createdAt: "desc" },
});
console.log(
  cronTxns.length >= 2
    ? `✅ cron created a second transaction (total: ${cronTxns.length})`
    : `❌ cron didn't materialize (total: ${cronTxns.length})`
);

/* ── Hit cron AGAIN — should be idempotent ────────────────────────────── */
const cronRes2 = await fetch(`${BASE}/api/cron/materialize-recurring`, {
  headers: { Authorization: `Bearer ${CRON_SECRET}` },
});
const cronJson2 = await cronRes2.json();
console.log(
  cronJson2.transactionsCreated === 0
    ? `✅ second cron run was idempotent (created=0)`
    : `❌ second run double-fired (created=${cronJson2.transactionsCreated})`
);

/* ── Unauthorized request rejected ────────────────────────────────────── */
const cronUnauth = await fetch(`${BASE}/api/cron/materialize-recurring`);
console.log(
  cronUnauth.status === 401
    ? "✅ unauthenticated cron request rejected with 401"
    : `❌ unauthenticated request returned ${cronUnauth.status}`
);

/* ── Cleanup ──────────────────────────────────────────────────────────── */
await db.transaction.deleteMany({ where: { ruleId: ruleRow.id } });
await db.recurringRule.delete({ where: { id: ruleRow.id } });

const ok =
  !!ruleRow &&
  !!seedTxn &&
  cronTxns.length >= 2 &&
  cronJson2.transactionsCreated === 0 &&
  cronUnauth.status === 401;

console.log("");
console.log(ok ? "✅ recurring flow round-trip succeeded" : "❌ recurring flow has failures");

await browser.close();
await db.$disconnect();
process.exit(ok ? 0 : 1);
