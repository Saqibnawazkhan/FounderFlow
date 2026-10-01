// Smoke-test Phase 1.C: tasks page reads tasks + users from Supabase, the
// modal creates a new task via the server action, and an activity row gets
// written as a side effect (proves the $transaction wraps everything).

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
const SMOKE_IP = "10.98.0.23";

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
 * A title only this run could have written, so the assertion below is a lookup
 * that can only match this script's row. It used to be the fixed literal "Smoke
 * task from puppeteer" plus `findFirst({ orderBy: { createdAt: "desc" } })`,
 * which returns whoever wrote last -- so the log corroborated a false pass with
 * another tenant's task.
 */
const STAMP = Date.now().toString().slice(-6);
const TASK_TITLE = `Smoke task from puppeteer ${STAMP}`;

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";
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
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE.error:", m.text());
});

const scope = { where: { companyId: COMPANY_ID } };
const beforeTasks = await db.task.count(scope);
const beforeActs = await db.activity.count(scope);
const beforeNotifs = await db.notification.count(scope);
console.log(`DB before: tasks=${beforeTasks} activities=${beforeActs} notifs=${beforeNotifs}`);

// sign in — wait for the URL to leave /login rather than guess a timeout.
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.type("input[type=email]", "demo@founderflow.app");
await page.type("input[type=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
await page
  .waitForFunction(() => !location.pathname.startsWith("/login"), {
    timeout: 15_000,
  })
  .catch(() => {});
console.log(`signed in -> ${page.url()}`);

// /tasks. Give the post-login state a beat so cookies settle.
await new Promise((r) => setTimeout(r, 1000));
await page.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded" });
// Wait for at least one task card to render (kanban view default). Bumped to
// 20s — dev-mode RSC + Supabase cold start can run long.
await page
  .waitForFunction(() => document.querySelectorAll("h4, tbody tr").length > 0, { timeout: 20_000 })
  .catch(() => {});
const cardsBefore = await page.evaluate(() => document.querySelectorAll("h4").length);
console.log(`/tasks visible card titles before: ${cardsBefore}`);
await page.screenshot({ path: `${OUT}/task-01-board-before.png` });

// open "New task" modal
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /new task/i.test(b.textContent ?? "")
  );
  btn?.click();
});
await new Promise((r) => setTimeout(r, 500));

// Fill the form. Title is the first non-typed input inside the dialog;
// description is the textarea. Assignee defaults to current user.
await page.evaluate((taskTitle) => {
  const dialog = document.querySelector('[role="dialog"]');
  const title = dialog?.querySelector("input:not([type=date]):not([type=number])");
  const desc = dialog?.querySelector("textarea");
  if (title) {
    title.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      title,
      taskTitle
    );
    title.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (desc) {
    desc.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set?.call(
      desc,
      "Verifying server actions wire up correctly"
    );
    desc.dispatchEvent(new Event("input", { bubbles: true }));
  }
}, TASK_TITLE);
await page.screenshot({ path: `${OUT}/task-02-modal.png` });

// submit
await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  dialog?.querySelector("form")?.requestSubmit();
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/task-03-after.png` });

const cardsAfter = await page.evaluate(() => document.querySelectorAll("h4").length);
console.log(`/tasks visible card titles after:  ${cardsAfter}`);

const afterTasks = await db.task.count(scope);
const afterActs = await db.activity.count(scope);
const afterNotifs = await db.notification.count(scope);
console.log(`DB after:  tasks=${afterTasks} activities=${afterActs} notifs=${afterNotifs}`);

// The row this run created, found by the title this run generated -- not by
// whoever wrote last.
const created = await db.task.findFirst({
  where: { companyId: COMPANY_ID, title: TASK_TITLE },
});
const createdAct = await db.activity.findFirst({
  where: { companyId: COMPANY_ID, message: { contains: TASK_TITLE } },
});
console.log(`created task: "${created?.title}" (${created?.status}, ${created?.priority})`);
console.log(`matching activity: ${createdAct?.type} — ${createdAct?.message}`);

const ok =
  // The row itself, first: this is the only assertion no other writer can
  // satisfy on this script's behalf.
  created !== null &&
  createdAct !== null &&
  afterTasks === beforeTasks + 1 &&
  // ONE activity row, and it is task_created. The comment here used to say
  // task_assigned, which lib/actions/tasks.ts writes only when the assignee is
  // someone other than the actor -- and this script assigns to itself, so that
  // row is never written. The count was right and the reason was wrong.
  afterActs === beforeActs + 1 &&
  // Assignee == actor (Saqib), so no notification fan-out (skip-self rule).
  afterNotifs === beforeNotifs;

console.log(ok ? "✅ task round-trip succeeded" : "❌ task round-trip failed");
if (!ok) process.exitCode = 1;

await browser.close();
await db.$disconnect();
