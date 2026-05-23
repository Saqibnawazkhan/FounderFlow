// Smoke-test Phase 1.C: tasks page reads tasks + users from Supabase, the
// modal creates a new task via the server action, and an activity row gets
// written as a side effect (proves the $transaction wraps everything).

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";
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

const beforeTasks = await db.task.count();
const beforeActs = await db.activity.count();
const beforeNotifs = await db.notification.count();
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

// /tasks
await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle2" });
// Wait for at least one task card to render (kanban view default).
await page
  .waitForFunction(
    () => document.querySelectorAll("h4, tbody tr").length > 0,
    { timeout: 8000 }
  )
  .catch(() => {});
const cardsBefore = await page.evaluate(
  () => document.querySelectorAll("h4").length
);
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
await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  const title = dialog?.querySelector("input:not([type=date]):not([type=number])");
  const desc = dialog?.querySelector("textarea");
  if (title) {
    title.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      title,
      "Smoke task from puppeteer"
    );
    title.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (desc) {
    desc.focus();
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(desc, "Verifying server actions wire up correctly");
    desc.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
await page.screenshot({ path: `${OUT}/task-02-modal.png` });

// submit
await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  dialog?.querySelector("form")?.requestSubmit();
});
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: `${OUT}/task-03-after.png` });

const cardsAfter = await page.evaluate(
  () => document.querySelectorAll("h4").length
);
console.log(`/tasks visible card titles after:  ${cardsAfter}`);

const afterTasks = await db.task.count();
const afterActs = await db.activity.count();
const afterNotifs = await db.notification.count();
console.log(`DB after:  tasks=${afterTasks} activities=${afterActs} notifs=${afterNotifs}`);

const latest = await db.task.findFirst({ orderBy: { createdAt: "desc" } });
const latestAct = await db.activity.findFirst({ orderBy: { createdAt: "desc" } });
console.log(`latest task: "${latest?.title}" (${latest?.status}, ${latest?.priority})`);
console.log(`latest activity: ${latestAct?.type} — ${latestAct?.message}`);

const ok =
  afterTasks === beforeTasks + 1 &&
  afterActs === beforeActs + 1 && // task_assigned
  // Assignee == actor (Saqib), so no notification fan-out (skip-self rule).
  afterNotifs === beforeNotifs;

console.log(ok ? "✅ task round-trip succeeded" : "❌ counts don't line up");

await browser.close();
await db.$disconnect();
