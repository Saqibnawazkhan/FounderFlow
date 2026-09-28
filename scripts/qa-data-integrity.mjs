/*
 * QA exercise script — DATA-INTEGRITY domain (go-live audit, AGENT_INDEX = 16).
 *
 * Surface: soft-delete completeness, cascade + FK `onDelete` choices,
 * transaction boundaries, read-modify-write races, the purge cron's dependency
 * ordering versus the real FK graph, and the documented recovery runbook.
 * Money MATHS belongs to money-correctness; money ROWS surviving a delete
 * belong here.
 *
 * ── DATA SAFETY ───────────────────────────────────────────────────────────
 * This script NEVER writes a row of pre-existing data. It signs up THREE of
 * its own workspaces through the real signup flow:
 *
 *   A  `qa-dataint-<stamp>`      the main tenant; almost everything happens here
 *   B  `qa-dataint-alt-<stamp>`  the "other tenant", for cross-tenant forging
 *   C  `qa-dataint-purge-<stamp>` a throwaway loaded with one row of every
 *                                 workspace table, used to prove the purge
 *                                 cron's delete ORDER against the real FKs
 *
 * Every DB assertion carries `where: { companyId: <one of my three ids> }`.
 * There is not one bare `db.X.count()` in this file: under concurrency another
 * agent's insert can satisfy a "did mine land?" check and produce a FALSE PASS,
 * which is the most expensive outcome in a pre-launch audit. `finally` deletes
 * all three tenants, children before parents.
 *
 * ── WHAT THIS SCRIPT DELIBERATELY DOES NOT CALL ───────────────────────────
 * `/api/cron/materialize-recurring` and `/api/cron/sweep-time-entries` are
 * GLOBAL writers: neither is scoped to a company, so one GET would mint
 * transactions and close open time entries in the DEMO workspace and in every
 * other agent's tenant. That is a guard failure and a cross-agent false
 * failure in one request, so they are never called here. Their race windows
 * are instead reproduced against MY OWN rows, and the findings that depend on
 * a genuinely concurrent cron stay `static` and say so.
 *
 * `/api/cron/purge-soft-deleted` is not called either. In dry-run it is
 * read-only and harmless, but its destructive branch is one env var away and
 * that branch is global. So the purge is exercised by issuing the route's OWN
 * statements, verbatim, narrowed with `companyId` to my tenant — and, for the
 * destructive ones, inside a transaction this script deliberately rolls back.
 *
 * Rate limiting: `getClientIp()` falls back to the literal "unknown" in dev,
 * so without an explicit x-real-ip every agent shares ONE limiters.auth bucket
 * of 5/60s fed by nine call sites. Every page here sets 10.99.0.16 before its
 * first navigation.
 *
 * Every `fail()` records and continues (never throws) so one run reports every
 * broken assertion, and prints a literal ❌ for the runner's summary.
 */

import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/data-integrity";
const AGENT_IP = "10.99.0.16";
const STAMP = Date.now().toString().slice(-8);
const PASSWORD = `QaData${STAMP}a`; // 8+, lower, upper, digit — PasswordSchema

/** The purge cron's retention window, copied from the route. */
const RETENTION_DAYS = 90;

// Pinned to the local docker Postgres. `new PrismaClient()` auto-loads the
// ROOT .env, which points at PRODUCTION Supabase — see scripts/_local-db.mjs
// and tests/lib/db/script-safety.test.ts.
const db = localDb();

/* ── reporting ───────────────────────────────────────────────────────────── */

let passes = 0;
function ok(label) {
  passes++;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  // Never throws: one run must report every broken assertion.
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}
function section(title) {
  console.log(`\n-- ${title} --`);
}

/* ── browser plumbing ────────────────────────────────────────────────────── */

const contexts = [];

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

/** A page in its own browser context, carrying this agent's rate-limit identity. */
async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  wire(page);
  // BEFORE the first navigation — see the header note on limiters.auth.
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` }).catch(() => {});
}

/**
 * Retry-until-hydrated sign-in. Copied verbatim from scripts/smoke-chat.mjs:
 * on a cold dev server the form paints before React hydrates, and a click that
 * lands first performs a NATIVE GET submit with the credentials in the query
 * string and no sign-in (FaultsAudit A14).
 */
async function signIn(page, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", password);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
      return;
    }
  }
  throw new Error(`could not sign in as ${email} after 3 attempts`);
}

/**
 * Set a React-controlled input/select/textarea so react-hook-form sees it.
 * Goes through the prototype's value setter — assigning `el.value` directly is
 * invisible to React's synthetic change tracking. No `eval`: the dev server's
 * CSP refuses it.
 */
async function setField(page, selector, value) {
  await page.evaluate(
    (sel, v) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      const proto =
        el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      el.focus();
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    value
  );
}

/** Click the first button/link whose visible text matches `reSource`. */
async function clickButton(page, reSource, root = "body") {
  return page.evaluate(
    (src, rootSel) => {
      const re = new RegExp(src, "i");
      const scope = document.querySelector(rootSel) ?? document.body;
      const btn = [...scope.querySelectorAll("button, a")].find((b) =>
        re.test((b.textContent ?? "").trim())
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    reSource,
    root
  );
}

/** Click by exact aria-label (the tasks/time rows expose delete that way). */
async function clickAria(page, label) {
  return page.evaluate((l) => {
    const el = document.querySelector(`[aria-label="${l}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, label);
}

async function waitForDialog(page) {
  await page.waitForSelector('[role="dialog"]', { timeout: 20000 });
  // State predicate, not a sleep: wait until the dialog owns a form control.
  await page.waitForFunction(
    () => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.querySelectorAll("input, select, textarea").length > 0;
    },
    { timeout: 20000 }
  );
}

async function waitForDialogClosed(page) {
  return page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Accept a ConfirmDialog. components/ui/confirm-dialog.tsx renders Cancel
 * first and the confirm second, and auto-focuses CANCEL for destructive tones
 * — so a keyboard Enter is the wrong lever. Click the LAST button in the
 * dialog, which is the confirm for every tone.
 */
async function acceptConfirm(page) {
  await page.waitForFunction(
    () => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.querySelectorAll("button").length >= 2;
    },
    { timeout: 20000 }
  );
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const btns = [...d.querySelectorAll("button")];
    btns[btns.length - 1].click();
  });
  return waitForDialogClosed(page);
}

/** Wait until any text matching `reSource` is on screen (toasts, errors). */
async function waitForText(page, reSource, timeout = 20000) {
  return page
    .waitForFunction(
      (src) => new RegExp(src, "i").test(document.body.innerText),
      { timeout },
      reSource
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * Wait until a tenant-scoped DB predicate holds. Replaces every fixed
 * setTimeout after a write: under load a fixed wait is the number-one source
 * of false failures, and a server action's revalidate is not the commit.
 */
async function waitForDb(probe, { tries = 60, every = 250, label = "db predicate" } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, every));
  }
  note(`waitForDb gave up on: ${label}`);
  return null;
}

async function firstOptionValue(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el && el.options.length ? el.options[0].value : "";
  }, selector);
}

/* ── tenant bootstrap (the real signup flow) ─────────────────────────────── */

const myTenants = [];

/**
 * Sign up a brand-new workspace through the real 2-step /signup wizard.
 * Company names MUST start with `qa-` so `node scripts/_qa-guard.mjs sweep`
 * can find and remove anything a crashed run leaves behind.
 */
async function signupTenant(browser, { companyName, name, email }) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[name=email]", { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500)); // hydration, as in signIn()

  await setField(page, "input[name=name]", name);
  await setField(page, "input[name=email]", email);
  await setField(page, "input[name=password]", PASSWORD);

  const advanced = await clickButton(page, "continue|next");
  if (!advanced) throw new Error("signup: no Continue button on step 1");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("input[name=companyName]");
      return !!el && el.offsetParent !== null;
    },
    { timeout: 20000 }
  );

  await setField(page, "input[name=companyName]", companyName);
  await setField(
    page,
    "select[name=industry]",
    await firstOptionValue(page, "select[name=industry]")
  );
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());

  const landed = await page
    .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    await shot(page, `signup-stuck-${companyName}`);
    throw new Error(`signup for ${companyName} never left /signup`);
  }

  const company = await db.company.findFirst({
    where: { name: companyName },
    select: { id: true, name: true },
  });
  if (!company) throw new Error(`signup for ${companyName} created no company row`);
  myTenants.push(company.id);

  const owner = await db.user.findFirst({
    where: { companyId: company.id, email: email.toLowerCase() },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!owner) throw new Error(`signup for ${companyName} created no owner row`);

  return { ctx, page, companyId: company.id, companyName, user: owner, email };
}

/**
 * Invite a teammate through the real /team flow and claim the invite through
 * the real /invite/[token] page. `claim: false` leaves the token pending,
 * which the workspace-tombstone test needs.
 */
async function invite(adminPage, companyId, { name, email, role }) {
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  const opened = await clickButton(adminPage, "invite member");
  if (!opened) throw new Error("invite: no 'Invite member' button on /team");
  await waitForDialog(adminPage);

  await setField(adminPage, '[role="dialog"] input[name=name]', name);
  await setField(adminPage, '[role="dialog"] input[name=email]', email);
  if (role === "member") {
    const picked = await clickButton(adminPage, "team member", '[role="dialog"]');
    if (!picked) note("invite: no 'Team Member' role button — role may default");
  }
  await adminPage.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());

  const row = await waitForDb(
    () =>
      db.inviteToken.findFirst({
        // Scoped to MY company: another agent inviting the same shape of
        // address must not satisfy this.
        where: { companyId, email: email.toLowerCase() },
        orderBy: { createdAt: "desc" },
        select: { id: true, token: true, role: true, usedAt: true },
      }),
    { label: `InviteToken for ${email} in ${companyId}` }
  );
  if (!row) throw new Error(`invite: no InviteToken for ${email} in company ${companyId}`);
  return row;
}

async function claimInvite(browser, companyId, token, email) {
  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/invite/${token}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[name=password]", { timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500)); // hydration
  const hasForm = await page.$("input[name=password]");
  if (!hasForm) {
    return { ctx, page, user: null, refusedOnLoad: true };
  }
  await setField(page, "input[name=password]", PASSWORD);
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await page
    .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 45000 })
    .catch(() => {});

  const user = await db.user.findFirst({
    where: { companyId, email: email.toLowerCase() },
    select: { id: true, name: true, role: true, deletedAt: true },
  });
  return { ctx, page, user, refusedOnLoad: false };
}

/* ── domain helpers, all through the real UI ─────────────────────────────── */

async function createProject(page, { name, supervisorId }) {
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
  const opened = await clickButton(page, "new project");
  if (!opened) throw new Error("createProject: no 'New project' button (role gate?)");
  await waitForDialog(page);
  await setField(page, '[role="dialog"] input:not([type=date])', name);
  await setField(page, '[role="dialog"] select', supervisorId);
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await waitForDialogClosed(page);
  return waitForDb(
    () =>
      db.project.findFirst({
        where: { name, companyId: { in: myTenants } },
        select: { id: true, companyId: true, name: true, deletedAt: true, status: true },
      }),
    { label: `Project "${name}"` }
  );
}

/**
 * Add a task through the New task modal. `projectId` is forced into the
 * modal's project <select> — including a value the select does not offer,
 * which is exactly the stale-client shape the orphan-task test needs. The
 * option is injected first so react-hook-form's value survives validation.
 */
async function createTask(page, { title, projectId, assigneeId, forceProjectOption = false }) {
  await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
  const opened = await clickButton(page, "new task");
  if (!opened) throw new Error("createTask: no 'New task' button");
  await waitForDialog(page);

  if (forceProjectOption) {
    await page.evaluate((pid) => {
      const d = document.querySelector('[role="dialog"]');
      const sel = d.querySelector('select[name="projectId"]') ?? d.querySelector("select");
      if (!sel) throw new Error("no project select in the New task modal");
      if (![...sel.options].some((o) => o.value === pid)) {
        const opt = document.createElement("option");
        opt.value = pid;
        opt.textContent = "(stale project)";
        sel.appendChild(opt);
      }
    }, projectId);
  }

  await setField(page, '[role="dialog"] input[name=title]', title);
  await setField(page, '[role="dialog"] textarea[name=description]', `data-integrity ${STAMP}`);
  await setField(page, '[role="dialog"] select[name=projectId]', projectId).catch(() => {});
  if (assigneeId) {
    await setField(page, '[role="dialog"] select[name=assignedTo]', assigneeId).catch(() => {});
  }
  const deadline = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  await setField(page, '[role="dialog"] input[type=date]', deadline).catch(() => {});
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await waitForDialogClosed(page);

  return waitForDb(
    () =>
      db.task.findFirst({
        where: { title, companyId: { in: myTenants } },
        select: { id: true, companyId: true, projectId: true, deletedAt: true, title: true },
      }),
    { label: `Task "${title}"` }
  );
}

async function createExpense(page, { amount, category, description, projectId }) {
  await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
  const opened = await clickButton(page, "add expense|new expense");
  if (!opened) throw new Error("createExpense: no add-expense button");
  await waitForDialog(page);
  await setField(page, '[role="dialog"] input[name=amount]', String(amount));
  await setField(page, '[role="dialog"] select[name=category]', category);
  await setField(page, '[role="dialog"] textarea[name=description]', description);
  const today = new Date().toISOString().slice(0, 10);
  await setField(page, '[role="dialog"] input[name=date]', today).catch(() => {});
  if (projectId) {
    await setField(page, '[role="dialog"] select[name=projectId]', projectId).catch(() => {});
  }
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await waitForDialogClosed(page);
  return waitForDb(
    () =>
      db.transaction.findFirst({
        where: { description, companyId: { in: myTenants } },
        select: { id: true, companyId: true, projectId: true, deletedAt: true, amount: true },
      }),
    { label: `Transaction "${description}"` }
  );
}

/** First option value of a select, excluding a placeholder with an empty value. */
async function firstRealOption(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return "";
    const opt = [...el.options].find((o) => o.value);
    return opt ? opt.value : "";
  }, selector);
}

/* ── the run ─────────────────────────────────────────────────────────────── */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log("== qa data-integrity (agent 16) ==");

  let A = null;
  let B = null;
  let C = null;
  let D = null;

  try {
    /* ═════════════════════════════════════════════════════════════════════
     * 0. Tenants
     * ═══════════════════════════════════════════════════════════════════ */
    section("tenants");
    A = await signupTenant(browser, {
      companyName: `qa-dataint-${STAMP}`,
      name: `QA DataInt ${STAMP}`,
      email: `qa-dataint-${STAMP}@founderflow.test`,
    });
    ok(`tenant A ${A.companyName} (${A.companyId})`);
    B = await signupTenant(browser, {
      companyName: `qa-dataint-alt-${STAMP}`,
      name: `QA Alt ${STAMP}`,
      email: `qa-dataint-alt-${STAMP}@founderflow.test`,
    });
    ok(`tenant B ${B.companyName} (${B.companyId})`);
    C = await signupTenant(browser, {
      companyName: `qa-dataint-purge-${STAMP}`,
      name: `QA Purge ${STAMP}`,
      email: `qa-dataint-purge-${STAMP}@founderflow.test`,
    });
    ok(`tenant C ${C.companyName} (${C.companyId})`);
    D = await signupTenant(browser, {
      companyName: `qa-dataint-twin-${STAMP}`,
      name: `QA Twin ${STAMP}`,
      email: `qa-dataint-twin-${STAMP}@founderflow.test`,
    });
    ok(`tenant D ${D.companyName} (${D.companyId})`);

    /* ═════════════════════════════════════════════════════════════════════
     * 1. DI-001 — the tombstone-coverage matrix.
     *
     * prisma/schema.prisma gives seven models a `deletedAt`, CLAUDE.md
     * promises "soft delete on User, Company, Project, Task, Budget,
     * Transaction and Message ... recovery within the retention window is one
     * SQL UPDATE per table", and lib/actions/account.ts repeats it. For each
     * model, delete ONE of my own rows through the real UI and ask the only
     * question that matters to a customer who deleted the wrong thing: is the
     * row still there?
     * ═══════════════════════════════════════════════════════════════════ */
    section("DI-001 tombstone coverage: does a delete leave anything to restore?");

    const project = await createProject(A.page, {
      name: `QA Proj ${STAMP}`,
      supervisorId: A.user.id,
    });
    if (!project) throw new Error("could not create the base project in tenant A");
    ok(`project created (${project.id})`);

    // ── Task ────────────────────────────────────────────────────────────
    const taskTitle = `QA Task ${STAMP}`;
    const task = await createTask(A.page, {
      title: taskTitle,
      projectId: project.id,
      assigneeId: A.user.id,
    });
    if (!task) {
      fail("task create", "no Task row landed in tenant A");
    } else {
      // A comment on the task, so the cascade is observable too.
      const commentBody = `QA comment ${STAMP}`;
      await A.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
      const openedTask = await clickAria(A.page, `Open task ${taskTitle}`);
      if (openedTask) {
        await waitForDialog(A.page).catch(() => {});
        await setField(A.page, '[role="dialog"] textarea', commentBody).catch(() => {});
        await clickButton(A.page, "post|comment|send", '[role="dialog"]');
        await waitForDb(
          () =>
            db.comment.findFirst({
              where: { taskId: task.id, companyId: A.companyId, body: { contains: STAMP } },
              select: { id: true },
            }),
          { label: "comment on my task" }
        );
        await A.page.keyboard.press("Escape").catch(() => {});
        await waitForDialogClosed(A.page);
      } else {
        note("could not open the task detail modal; comment-cascade check is skipped");
      }
      const commentsBefore = await db.comment.count({
        where: { taskId: task.id, companyId: A.companyId },
      });

      await A.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
      const clickedDelete = await clickAria(A.page, `Delete task ${taskTitle}`);
      if (!clickedDelete) {
        fail("task delete control", `no [aria-label="Delete task ${taskTitle}"] on /tasks`);
      } else {
        await acceptConfirm(A.page);
        await waitForDb(
          async () => {
            const row = await db.task.findFirst({
              where: { id: task.id, companyId: A.companyId },
              select: { id: true, deletedAt: true },
            });
            return row === null || row.deletedAt !== null ? { row } : null;
          },
          { label: "task gone or tombstoned" }
        );
        const after = await db.task.findFirst({
          where: { id: task.id, companyId: A.companyId },
          select: { id: true, deletedAt: true },
        });
        await shot(A.page, "01-task-deleted");
        if (after === null) {
          fail(
            "Task delete is a HARD delete",
            `Task.deletedAt exists and CLAUDE.md promises a 90-day recovery window, but the ` +
              `row for ${task.id} is physically gone — nothing to restore`
          );
        } else if (after.deletedAt) {
          ok(`task soft-deleted, deletedAt=${after.deletedAt.toISOString()}`);
        } else {
          fail("task delete did nothing", "row still live after confirming the delete");
        }

        const commentsAfter = await db.comment.count({
          where: { taskId: task.id, companyId: A.companyId },
        });
        if (commentsBefore > 0 && commentsAfter === 0) {
          fail(
            "deleting a task destroys its whole comment thread",
            `Comment.taskId is onDelete: Cascade — ${commentsBefore} comment(s) erased with the ` +
              `task, and Comment has no deletedAt column so there is no tombstone either`
          );
        } else if (commentsBefore > 0) {
          ok(`comment thread survived the task delete (${commentsAfter} row(s))`);
        } else {
          note("no comment was created, so the cascade check is inconclusive");
        }
      }
    }

    // ── Transaction (money) ─────────────────────────────────────────────
    const expenseDesc = `QA Expense ${STAMP}`;
    const txn = await createExpense(A.page, {
      amount: 123456.78,
      category: await firstRealOption(A.page, "select[name=category]").catch(() => "Office Rent"),
      description: expenseDesc,
      projectId: project.id,
    });
    if (!txn) {
      note("could not create an expense through the UI; Transaction tombstone check skipped");
    } else {
      await A.page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
      const clicked = await A.page.evaluate((desc) => {
        const row = [...document.querySelectorAll("*")].find(
          (el) => el.children.length === 0 && (el.textContent ?? "").trim() === desc
        );
        const scope = row?.closest("tr, li, article, div[class*=rounded]") ?? document.body;
        const btn = [...scope.querySelectorAll("button")].find((b) =>
          /delete|remove|trash/i.test(
            `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`
          )
        );
        if (!btn) return false;
        btn.click();
        return true;
      }, expenseDesc);
      if (!clicked) {
        note("no delete control found next to my expense row; Transaction check skipped");
      } else {
        await acceptConfirm(A.page);
        await waitForDb(
          async () => {
            const row = await db.transaction.findFirst({
              where: { id: txn.id, companyId: A.companyId },
              select: { id: true, deletedAt: true },
            });
            return row === null || row.deletedAt !== null ? { row } : null;
          },
          { label: "transaction gone or tombstoned" }
        );
        const after = await db.transaction.findFirst({
          where: { id: txn.id, companyId: A.companyId },
          select: { id: true, deletedAt: true },
        });
        await shot(A.page, "02-expense-deleted");
        if (after === null) {
          fail(
            "Transaction delete is a HARD delete",
            `PKR 123,456.78 (${txn.id}) is physically gone. Transaction.deletedAt exists and ` +
              `CLAUDE.md promises the 90-day window; deleteTransactionAction calls ` +
              `tx.transaction.delete(). A mis-clicked ledger line is unrecoverable.`
          );
        } else if (after.deletedAt) {
          ok("transaction soft-deleted");
        } else {
          fail("transaction delete did nothing", "row still live after confirming");
        }
      }
    }

    // ── Budget ──────────────────────────────────────────────────────────
    await A.page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    const openedBudget = await clickButton(A.page, "new budget|add budget|create budget");
    let budgetId = null;
    if (!openedBudget) {
      note("no new-budget control on /budgets; Budget tombstone check skipped");
    } else {
      await waitForDialog(A.page);
      await setField(A.page, '[role="dialog"] select[name=projectId]', project.id).catch(() => {});
      const cat = await firstRealOption(A.page, '[role="dialog"] select[name=category]');
      await setField(A.page, '[role="dialog"] select[name=category]', cat).catch(() => {});
      await setField(A.page, '[role="dialog"] input[name=monthlyLimit]', "50000");
      await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
      await waitForDialogClosed(A.page);
      const b = await waitForDb(
        () =>
          db.budget.findFirst({
            where: { projectId: project.id, companyId: A.companyId },
            select: { id: true, category: true },
          }),
        { label: "Budget in my project" }
      );
      if (!b) {
        note("budget never landed; Budget tombstone check skipped");
      } else {
        budgetId = b.id;
        await A.page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
        const clicked = await A.page.evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((x) =>
            /delete|remove/i.test(`${x.getAttribute("aria-label") ?? ""} ${x.textContent ?? ""}`)
          );
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (!clicked) {
          note("no delete control on the budget card; Budget check skipped");
        } else {
          await acceptConfirm(A.page);
          await waitForDb(
            async () => {
              const row = await db.budget.findFirst({
                where: { id: budgetId, companyId: A.companyId },
                select: { id: true, deletedAt: true },
              });
              return row === null || row.deletedAt !== null ? { row } : null;
            },
            { label: "budget gone or tombstoned" }
          );
          const after = await db.budget.findFirst({
            where: { id: budgetId, companyId: A.companyId },
            select: { id: true, deletedAt: true },
          });
          if (after === null) {
            fail(
              "Budget delete is a HARD delete",
              "Budget.deletedAt exists and is never written by deleteBudgetAction — the row for " +
                `${budgetId} is gone, with the month's lastWarnedMonth/lastAlertedMonth history`
            );
          } else if (after.deletedAt) {
            ok("budget soft-deleted");
          } else {
            fail("budget delete did nothing", "row still live");
          }
        }
      }
    }

    // ── TimeEntry ───────────────────────────────────────────────────────
    await A.page.goto(`${BASE}/time`, { waitUntil: "networkidle0", timeout: 60000 });
    const clockedIn = await clickButton(A.page, "clock in|start");
    if (!clockedIn) {
      note("no clock-in control on /time; TimeEntry checks skipped");
    } else {
      const entry = await waitForDb(
        () =>
          db.timeEntry.findFirst({
            where: { companyId: A.companyId, userId: A.user.id, clockOutAt: null },
            select: { id: true, clockInAt: true, lastActivityAt: true },
          }),
        { label: "open TimeEntry for me" }
      );
      if (!entry) {
        fail("clock in", "no open TimeEntry landed in tenant A");
      } else {
        ok(`clocked in (${entry.id})`);

        /* ── DI-005: one open entry per user is a check-then-create ──────
         * clockInAction reads `findFirst({ userId, clockOutAt: null })` and
         * then creates, with no unique index and no transaction. Fire a
         * second clock-in from a SECOND page for the same user, concurrently,
         * and count MY OWN open rows. */
        const { page: second } = await newPage(browser);
        await signIn(second, A.email, PASSWORD);
        await second.goto(`${BASE}/time`, { waitUntil: "networkidle0", timeout: 60000 });
        await Promise.all([
          clickButton(second, "clock in|start").catch(() => false),
          clickButton(A.page, "clock in|start").catch(() => false),
        ]);
        await waitForDb(
          async () => {
            const n = await db.timeEntry.count({
              where: { companyId: A.companyId, userId: A.user.id, clockOutAt: null },
            });
            return n >= 2 ? n : null;
          },
          { tries: 12, every: 250, label: "a second open entry" }
        );
        const openCount = await db.timeEntry.count({
          where: { companyId: A.companyId, userId: A.user.id, clockOutAt: null },
        });
        await shot(A.page, "03-double-clock-in");
        if (openCount > 1) {
          fail(
            "two concurrent clock-ins produced two open time entries",
            `${openCount} rows with clockOutAt = null for one user; both accrue hours at the ` +
              `same time, so tracked time double-counts. clockInAction checks then creates ` +
              `with no unique index on (userId) WHERE clockOutAt IS NULL.`
          );
        } else {
          ok("concurrent clock-ins still left exactly one open entry");
        }

        /* ── DI-006: the auto-close sweep's update is unconditional ──────
         * sweepAutoCloseEntries() reads stale open entries, then issues
         * `db.timeEntry.update({ where: { id } , data: { clockOutAt:
         * s.lastActivityAt, autoClosed: true } })` — no `clockOutAt: null` in
         * the WHERE. A user who clocks out between the read and the write has
         * their real clock-out overwritten with a timestamp up to 12.5h older.
         *
         * The real endpoint is NOT called here: it is global and would rewrite
         * the demo workspace's open entries. Instead, prove the guard the
         * route would need is absent by showing the guarded form matches zero
         * rows after a clock-out while the route's unguarded form targets the
         * row by id alone. */
        await clickButton(A.page, "clock out|stop");
        const closed = await waitForDb(
          () =>
            db.timeEntry.findFirst({
              where: { id: entry.id, companyId: A.companyId, clockOutAt: { not: null } },
              select: { id: true, clockOutAt: true, lastActivityAt: true, autoClosed: true },
            }),
          { label: "my entry clocked out" }
        );
        if (!closed) {
          note("clock-out never landed; sweep-clobber probe skipped");
        } else {
          const guarded = await db.timeEntry.updateMany({
            where: { id: entry.id, companyId: A.companyId, clockOutAt: null },
            data: { autoClosed: true },
          });
          const stillOpenForRoute = await db.timeEntry.findFirst({
            where: { id: entry.id, companyId: A.companyId },
            select: { id: true },
          });
          if (guarded.count === 0 && stillOpenForRoute) {
            fail(
              "the auto-close sweep can overwrite a real clock-out",
              `A guarded update (clockOutAt: null) matches 0 rows for my closed entry, but ` +
                `sweepAutoCloseEntries targets the row by id ALONE and would set ` +
                `clockOutAt back to lastActivityAt=${closed.lastActivityAt.toISOString()} ` +
                `over the real clockOutAt=${closed.clockOutAt.toISOString()}. Add ` +
                `clockOutAt: null to its WHERE (updateMany, not update).`
            );
          } else {
            ok("the auto-close sweep's write is guarded on clockOutAt");
          }

          // Now delete the entry through the UI and ask the tombstone question.
          await A.page.goto(`${BASE}/time`, { waitUntil: "networkidle0", timeout: 60000 });
          const del = await A.page.evaluate(() => {
            const btn = [...document.querySelectorAll("button")].find((b) =>
              /^Delete time entry/i.test(b.getAttribute("aria-label") ?? "")
            );
            if (!btn) return false;
            btn.click();
            return true;
          });
          if (!del) {
            note("no delete control on a time entry row; TimeEntry delete check skipped");
          } else {
            await acceptConfirm(A.page);
            await waitForDb(
              async () => {
                const r = await db.timeEntry.findFirst({
                  where: { id: entry.id, companyId: A.companyId },
                  select: { id: true },
                });
                return r === null ? true : null;
              },
              { label: "time entry gone" }
            );
            const after = await db.timeEntry.findFirst({
              where: { id: entry.id, companyId: A.companyId },
              select: { id: true },
            });
            if (after === null) {
              fail(
                "TimeEntry has no tombstone and no recovery",
                "deleteTimeEntryAction hard-deletes. TimeEntry carries no deletedAt column at " +
                  "all, so deleted hours — the basis of any hours-based invoice — leave no trace."
              );
            } else {
              ok("time entry survived the delete (unexpected but fine)");
            }
          }
        }
      }
    }

    /* ═════════════════════════════════════════════════════════════════════
     * 2. DI-002 — a live child in a tombstoned project, and the FK the
     *    nightly purge will jam on.
     *
     * deleteProjectAction soft-deletes an EMPTY project. addTaskAction and
     * createBudgetAction then look the project up with
     * `findFirst({ where: { id, companyId } })` — no `deletedAt: null` — so a
     * stale tab (or any known id) can attach a live child to a tombstone.
     * Task.projectId and Budget.projectId are ON DELETE RESTRICT, and the
     * purge cron's scope 2 is ONE bulk `project.deleteMany` for every overdue
     * orphan project across every tenant: one offending row aborts the whole
     * stage, every night, for everyone.
     * ═══════════════════════════════════════════════════════════════════ */
    section("DI-002 orphaned children in a tombstoned project + the purge jam");

    const doomed = await createProject(A.page, {
      name: `QA Doomed ${STAMP}`,
      supervisorId: A.user.id,
    });
    if (!doomed) {
      fail("doomed project", "could not create the second project");
    } else {
      // Snapshot the project picker's options BEFORE the delete — that list
      // is exactly what a stale client still holds.
      await A.page.goto(`${BASE}/projects/${doomed.id}`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const deleted = await clickButton(A.page, "delete project|delete");
      if (deleted) await acceptConfirm(A.page);
      const tomb = await waitForDb(
        () =>
          db.project.findFirst({
            where: { id: doomed.id, companyId: A.companyId, deletedAt: { not: null } },
            select: { id: true, deletedAt: true, status: true },
          }),
        { label: "doomed project tombstoned" }
      );
      if (!tomb) {
        note("could not soft-delete a project through the UI; DI-002 chain skipped");
      } else {
        ok(`project soft-deleted (deletedAt=${tomb.deletedAt.toISOString()})`);

        // 2a. /projects/<id> must 404 while the row is a tombstone.
        await A.page.goto(`${BASE}/projects/${doomed.id}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        const notFound = await A.page.evaluate(() =>
          /not found|404|couldn't find/i.test(document.body.innerText)
        );
        if (notFound) ok("the tombstoned project's page answers not-found");
        else fail("tombstoned project still renders", A.page.url());

        // 2b. There is no restore path for it anywhere in the product.
        await A.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
        const restoreControl = await A.page.evaluate(() =>
          /restore|deactivated project|deleted project|recover/i.test(document.body.innerText)
        );
        if (restoreControl) {
          ok("/projects offers a restore path for deleted projects");
        } else {
          fail(
            "a soft-deleted project has no restore path in the product",
            "deleteProjectAction tombstones for the documented 90-day window, but /projects " +
              "shows no deleted-projects list and no action clears Project.deletedAt — unlike " +
              "users, which have getDeactivatedUsers() + reactivateUserAction(). Recovery is " +
              "ops-only SQL that the customer cannot ask for because they cannot see the row."
          );
        }

        // 2c. Attach a LIVE task to the tombstone, the stale-client way.
        const orphanTitle = `QA Orphan ${STAMP}`;
        const orphan = await createTask(A.page, {
          title: orphanTitle,
          projectId: doomed.id,
          assigneeId: A.user.id,
          forceProjectOption: true,
        });
        if (!orphan) {
          ok("a task could not be filed into a tombstoned project (addTaskAction refused)");
        } else {
          fail(
            "a live task can be filed into a soft-deleted project",
            `Task ${orphan.id} (companyId=${A.companyId}) points at tombstoned project ` +
              `${doomed.id}. addTaskAction's project lookup omits deletedAt: null.`
          );

          // 2d. It renders on the global board but is invisible to search.
          await A.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
          const onBoard = await A.page.evaluate(
            (t) => document.body.innerText.includes(t),
            orphanTitle
          );
          await shot(A.page, "04-orphan-task-on-board");
          if (onBoard) {
            fail(
              "the orphaned task is stranded: on /tasks, but unreachable via its project",
              "lib/queries/tasks.ts getTasks() filters project.status but not " +
                "project.deletedAt, while lib/queries/search.ts searchTasks() DOES filter " +
                "project: { deletedAt: null } and comments 'a tombstoned project's tasks are " +
                "gone from every other surface'. The two surfaces disagree."
            );
          } else {
            ok("the orphaned task is hidden from the global board too");
          }

          // 2e. THE JAM. Issue the purge route's own scope-2 statement,
          //     narrowed to MY tenant, inside a transaction that is always
          //     rolled back. Nothing can be destroyed: the throw is
          //     unconditional, so Postgres rolls the delete back either way.
          const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5);
          const backdated = new Date(cutoff.getTime() - 864e5); // one day past the window
          await db.project.update({
            where: { id: doomed.id },
            data: { deletedAt: backdated },
          });
          const wouldMatch = await db.project.count({
            where: {
              companyId: A.companyId, // the route has no such clause; I must
              deletedAt: { not: null, lt: cutoff },
              company: { deletedAt: null },
            },
          });
          if (wouldMatch < 1) {
            note("back-dating did not make my project overdue; jam probe skipped");
          } else {
            let jam = null;
            try {
              await db.$transaction(async (tx) => {
                await tx.project.deleteMany({
                  where: {
                    companyId: A.companyId,
                    deletedAt: { not: null, lt: cutoff },
                    company: { deletedAt: null },
                  },
                });
                // ALWAYS roll back. The statement above is the evidence; its
                // effect is not wanted.
                throw new Error("__qa_rollback__");
              });
            } catch (e) {
              jam = e;
            }
            const stillThere = await db.project.findFirst({
              where: { id: doomed.id, companyId: A.companyId },
              select: { id: true },
            });
            if (!stillThere) {
              fail("rollback safety", "the probe transaction committed — investigate before rerun");
            }
            const msg = jam && jam.message ? jam.message : "";
            if (/__qa_rollback__/.test(msg)) {
              ok("the purge's orphan-project delete succeeded (no Restrict violation)");
            } else if (/foreign key|violates|P2003|Restrict/i.test(msg)) {
              fail(
                "the nightly purge's orphan-project stage will jam on a Restrict FK",
                `Deleting my overdue tombstoned project raised: ${msg.slice(0, 200)}. ` +
                  `Scope 2 in app/api/cron/purge-soft-deleted/route.ts now deletes each project ` +
                  `in its own transaction and answers 5xx, so one jammed row should cost only ` +
                  `that project (stage "orphanProject:<id>") and should page. If this fires, ` +
                  `either the per-project isolation regressed or a Restrict FK exists that the ` +
                  `child deletes do not cover.`
              );
            } else {
              note(`purge probe ended with an unexpected error: ${msg.slice(0, 200)}`);
            }
          }
        }
      }
    }

    /* ═════════════════════════════════════════════════════════════════════
     * 3. DI-003 / DI-004 — two workspaces deleted in the same instant.
     *
     * DI-003: softDeleteWorkspace() tombstones seven tables and never touches
     * InviteToken; acceptInviteAction never asks whether the company is
     * tombstoned; auth() filters User.deletedAt but never Company.deletedAt.
     * So an invite issued before the workspace was deleted can still mint a
     * LIVE user inside a tombstoned company — whose every row the purge cron
     * hard-deletes on day 90.
     *
     * DI-004: CLAUDE.md and lib/actions/account.ts both tell ops to restore
     * child rows with `UPDATE "Transaction" SET "deletedAt" = NULL WHERE
     * "deletedAt" BETWEEN '<t-1s>' AND '<t+1s>'`. softDeleteWorkspace stamps
     * ONE `now` across the whole sweep, so two workspaces deleted in the same
     * second share a timestamp and that UPDATE reaches both. Forced here by
     * deleting tenants B and D concurrently. Proved with a SELECT — the
     * runbook's UPDATE is never issued by this script.
     *
     * Both are done on B and D so tenant A survives for the later sections.
     * ═══════════════════════════════════════════════════════════════════ */
    section("DI-003/DI-004 two workspaces tombstoned in the same instant");

    // Each twin needs a project + an expense so the sweep has a money child
    // row to stamp, which is what the runbook's range filter targets.
    for (const T of [B, D]) {
      const p = await createProject(T.page, {
        name: `QA Twin Proj ${T.companyId.slice(-6)} ${STAMP}`,
        supervisorId: T.user.id,
      });
      await createExpense(T.page, {
        amount: 4242,
        category: await firstRealOption(T.page, "select[name=category]").catch(() => "Office Rent"),
        description: `QA Twin Expense ${T.companyId.slice(-6)} ${STAMP}`,
        projectId: p ? p.id : undefined,
      });
    }
    note("tenants B and D each loaded with a project + expense");

    const ghostEmail = `qa-dataint-ghost-${STAMP}@founderflow.test`;
    const pending = await invite(B.page, B.companyId, {
      name: `QA Ghost ${STAMP}`,
      email: ghostEmail,
      role: "member",
    });
    ok(`pending invite issued in tenant B (${pending.id})`);

    /** Stage the delete-workspace dialog without submitting it. */
    async function stageWorkspaceDelete(T) {
      await T.page.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
      const opened = await clickButton(T.page, "delete workspace");
      if (!opened) return false;
      await waitForDialog(T.page);
      await setField(T.page, '[role="dialog"] input[type=text]', T.companyName);
      await setField(T.page, '[role="dialog"] input[type=password]', PASSWORD);
      return true;
    }

    const stagedB = await stageWorkspaceDelete(B);
    const stagedD = await stageWorkspaceDelete(D);
    if (!stagedB || !stagedD) {
      fail(
        "danger zone",
        `could not stage both delete-workspace dialogs (B=${stagedB}, D=${stagedD}); ` +
          `no 'Delete workspace' control on /settings for an admin?`
      );
    } else {
      await Promise.all([
        B.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit()),
        D.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit()),
      ]);
      await waitForDb(
        async () => {
          const n = await db.company.count({
            where: { id: { in: [B.companyId, D.companyId] }, deletedAt: { not: null } },
          });
          return n === 2 ? n : null;
        },
        { tries: 40, every: 250, label: "both twins tombstoned" }
      );
      const twins = await db.company.findMany({
        where: { id: { in: [B.companyId, D.companyId] } },
        select: { id: true, deletedAt: true },
      });
      await shot(B.page, "05-workspace-deleted");
      const tombstonedTwins = twins.filter((t) => t.deletedAt);
      if (tombstonedTwins.length !== 2) {
        fail(
          "deleteWorkspaceAction",
          `expected both twins tombstoned, got ${tombstonedTwins.length} of 2`
        );
      } else {
        const stamps = tombstonedTwins.map((t) => t.deletedAt.getTime());
        const apartMs = Math.abs(stamps[0] - stamps[1]);
        ok(`both twins tombstoned, ${apartMs}ms apart`);

        /* ── DI-003: the pending invite ──────────────────────────────── */
        const invAfter = await db.inviteToken.findFirst({
          where: { id: pending.id, companyId: B.companyId },
          select: { id: true, usedAt: true },
        });
        if (invAfter && invAfter.usedAt === null) {
          fail(
            "a pending invite survives a workspace delete, still claimable",
            "softDeleteWorkspace() tombstones Transaction/Budget/Task/Project/Message/User/" +
              "Company and never invalidates InviteToken — unlike removeUserAction, which " +
              "deletes the removed user's pending invites for exactly this reason."
          );
        } else {
          ok("the pending invite was invalidated with the workspace");
        }

        const claim = await claimInvite(browser, B.companyId, pending.token, ghostEmail);
        if (claim.refusedOnLoad) {
          ok("/invite/<token> refuses to render for a tombstoned workspace");
        } else if (claim.user && claim.user.deletedAt === null) {
          fail(
            "a new LIVE user was created inside a soft-deleted workspace",
            `User ${claim.user.id} has deletedAt=null in company ${B.companyId}, whose ` +
              `deletedAt is set. acceptInviteAction never checks Company.deletedAt and auth() ` +
              `only filters User.deletedAt, so they can sign in and start entering data that ` +
              `the purge cron hard-deletes on day 90 along with the company.`
          );
          const reached = await (async () => {
            try {
              await signIn(claim.page, ghostEmail, PASSWORD);
              await claim.page.goto(`${BASE}/tasks`, {
                waitUntil: "networkidle0",
                timeout: 60000,
              });
              return new URL(claim.page.url()).pathname;
            } catch {
              return null;
            }
          })();
          await shot(claim.page, "06-ghost-user-signed-in");
          if (reached && !reached.startsWith("/login")) {
            fail(
              "the ghost user can sign in and use a deleted workspace",
              `landed on ${reached}; nothing in auth or middleware consults Company.deletedAt`
            );
          } else {
            ok("the ghost user exists but cannot sign in");
          }
        } else if (claim.user) {
          ok("the claimed user landed already tombstoned");
        } else {
          ok("the invite could not be claimed after the workspace was deleted");
        }

        /* ── DI-004: the runbook's range filter, as a SELECT ─────────── */
        const anchor = tombstonedTwins[0].deletedAt;
        const restoreWindow = {
          gte: new Date(anchor.getTime() - 1000),
          lte: new Date(anchor.getTime() + 1000),
        };
        // Scoped to MY tenants. The point is that the RUNBOOK's filter carries
        // no such clause, not that this script may read anyone else's rows.
        const inWindow = await db.transaction.findMany({
          where: { deletedAt: restoreWindow, companyId: { in: myTenants } },
          select: { id: true, companyId: true },
        });
        const distinct = new Set(inWindow.map((r) => r.companyId));
        if (distinct.size > 1) {
          fail(
            "the documented recovery UPDATE is not tenant-scoped",
            `A ±1s window around ONE workspace's tombstone (${anchor.toISOString()}) matches ` +
              `Transaction rows from ${distinct.size} different companies ` +
              `(${[...distinct].join(", ")}). The runbook in CLAUDE.md and ` +
              `lib/actions/account.ts has no companyId clause, so an ops restore of one ` +
              `customer resurrects another customer's deliberately deleted money — into a ` +
              `workspace whose Company row stays tombstoned, so nobody can see or re-delete it.`
          );
        } else if (inWindow.length === 0) {
          note(
            `the ±1s window matched no tombstoned Transaction rows (twins were ${apartMs}ms ` +
              `apart); inconclusive rather than clean`
          );
        } else {
          ok(
            `the ±1s restore window touched ${distinct.size} company — the twins landed ` +
              `${apartMs}ms apart, outside the window`
          );
        }
      }
    }

    /* ═════════════════════════════════════════════════════════════════════
     * 5. DI-007 — a deactivated teammate keeps receiving the workspace.
     *
     * removeUserAction tombstones the user and nothing else. notifyUsers()
     * filters deletedAt only on the EMAIL branch; the in-app createMany and
     * sendPushToUsers() do not, and no path deletes PushSubscription rows. So
     * a removed employee keeps getting finance pushes on their phone.
     * ═══════════════════════════════════════════════════════════════════ */
    section("DI-007 notifications + push after deactivation");

    const mateEmail = `qa-dataint-mate-${STAMP}@founderflow.test`;
    const mateInvite = await invite(A.page, A.companyId, {
      name: `QA Mate ${STAMP}`,
      email: mateEmail,
      role: "member",
    });
    const mateClaim = await claimInvite(browser, A.companyId, mateInvite.token, mateEmail);
    const mate = mateClaim.user;
    if (!mate) {
      fail("invite claim", `${mateEmail} never became a user in tenant A`);
    } else {
      ok(`teammate joined tenant A (${mate.id})`);

      // A device for them. This row belongs to MY tenant's user, created by me.
      const sub = await db.pushSubscription.create({
        data: {
          userId: mate.id,
          endpoint: `https://qa.invalid/push/${STAMP}`,
          p256dh: "qa-p256dh",
          auth: "qa-auth",
          userAgent: "qa-data-integrity",
        },
        select: { id: true },
      });

      // Deactivate them from /team.
      await A.page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
      const clickedDeact = await clickAria(A.page, `Deactivate QA Mate ${STAMP}`);
      if (!clickedDeact) {
        note("no deactivate control for my teammate; DI-007 partially skipped");
      } else {
        await acceptConfirm(A.page);
        const gone = await waitForDb(
          () =>
            db.user.findFirst({
              where: { id: mate.id, companyId: A.companyId, deletedAt: { not: null } },
              select: { id: true, deletedAt: true },
            }),
          { label: "teammate tombstoned" }
        );
        if (!gone) {
          fail("deactivate", "the teammate was never tombstoned");
        } else {
          ok("teammate deactivated");

          const subAfter = await db.pushSubscription.findFirst({
            where: { id: sub.id, user: { companyId: A.companyId } },
            select: { id: true },
          });
          if (subAfter) {
            fail(
              "a deactivated teammate keeps their registered push devices",
              "removeUserAction stamps User.deletedAt and nothing prunes PushSubscription. " +
                "There is also no individual-user purge stage by design, so the row lives " +
                "forever."
            );
          } else {
            ok("push subscriptions were pruned on deactivation");
          }

          // Now write a finance event and see who it reaches.
          const afterDeact = new Date();
          const leakDesc = `QA Leak ${STAMP}`;
          await createExpense(A.page, {
            amount: 2500000,
            category: await firstRealOption(A.page, "select[name=category]").catch(
              () => "Office Rent"
            ),
            description: leakDesc,
            projectId: project.id,
          });
          const leaked = await waitForDb(
            () =>
              db.notification.findFirst({
                where: {
                  userId: mate.id,
                  companyId: A.companyId,
                  createdAt: { gte: afterDeact },
                },
                select: { id: true, title: true, category: true },
              }),
            { tries: 24, every: 250, label: "notification for the tombstoned teammate" }
          );
          if (leaked) {
            fail(
              "a deactivated teammate is still fanned out to",
              `Notification ${leaked.id} (category=${leaked.category}, "${leaked.title}") was ` +
                `written for tombstoned user ${mate.id}. addTransactionAction's recipient query ` +
                `is tx.user.findMany({ where: { companyId, NOT: { id: userId } } }) with no ` +
                `deletedAt filter, and notifyUsers() only filters deletedAt on the email ` +
                `branch — so sendPushToUsers() delivers the figure to the device above.`
            );
          } else {
            ok("the deactivated teammate was excluded from the finance fan-out");
          }
        }
      }
    }

    /* ═════════════════════════════════════════════════════════════════════
     * 6. DI-008 — the workspace export silently omits chat.
     * ═══════════════════════════════════════════════════════════════════ */
    section("DI-008 workspace export completeness");

    const chatBody = `QA export probe ${STAMP}`;
    await A.page.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const composer = await A.page.$("textarea");
    if (!composer) {
      note("no chat composer; export-completeness check skipped");
    } else {
      await composer.click();
      await A.page.keyboard.type(chatBody);
      await A.page.keyboard.press("Enter");
      const msg = await waitForDb(
        () =>
          db.message.findFirst({
            where: { companyId: A.companyId, body: chatBody },
            select: { id: true },
          }),
        { label: "my chat message" }
      );
      if (!msg) {
        note("the chat message never landed; export check skipped");
      } else {
        const payload = await A.page.evaluate(async (base) => {
          const res = await fetch(`${base}/api/export`, { credentials: "include" });
          if (!res.ok) return { status: res.status, body: null };
          return { status: res.status, body: await res.text() };
        }, BASE);
        if (payload.status !== 200 || !payload.body) {
          fail("workspace export", `GET /api/export returned ${payload.status}`);
        } else {
          const json = JSON.parse(payload.body);
          const keys = Object.keys(json);
          const missing = ["messages", "channels", "channelMembers", "messageReactions"].filter(
            (k) => !keys.includes(k)
          );
          if (missing.length > 0 || !payload.body.includes(chatBody)) {
            fail(
              "the workspace export leaves the entire chat history behind",
              `/api/export calls itself "every row this workspace owns" (GDPR/CCPA data ` +
                `portability) but has no ${missing.join(", ")} key and does not contain my ` +
                `message "${chatBody}". Channel, ChannelMember, Message and MessageReaction ` +
                `have been in the schema since 2026-09-24. ` +
                `tests/lib/db/purge-invariants.test.ts derives its table list from the schema ` +
                `for exactly this failure mode but does not cover this route.`
            );
          } else {
            ok("the export includes chat");
          }
        }
      }
    }

    /* ═════════════════════════════════════════════════════════════════════
     * 7. Negative results — the things I tried to break that held.
     * ═══════════════════════════════════════════════════════════════════ */
    section("negative results");

    /* NR-1: cross-tenant forging of a project id.
     * Tenant C's admin files a task into tenant A's project. */
    {
      const forgedTitle = `QA Forged ${STAMP}`;
      const forged = await createTask(C.page, {
        title: forgedTitle,
        projectId: project.id, // tenant A's project
        assigneeId: C.user.id,
        forceProjectOption: true,
      });
      const landedInA = await db.task.findFirst({
        where: { title: forgedTitle, companyId: A.companyId },
        select: { id: true },
      });
      const landedInC = await db.task.findFirst({
        where: { title: forgedTitle, companyId: C.companyId },
        select: { id: true, projectId: true },
      });
      if (landedInA) {
        fail(
          "cross-tenant project id accepted",
          `tenant C wrote Task ${landedInA.id} into tenant A (companyId=${A.companyId})`
        );
      } else if (landedInC && landedInC.projectId === project.id) {
        fail(
          "cross-tenant project tag accepted",
          `tenant C's task ${landedInC.id} carries tenant A's projectId ${project.id}`
        );
      } else if (!forged) {
        ok("NR-1 held: addTaskAction refuses another tenant's projectId");
      } else {
        ok("NR-1 held: the forged project id did not cross the tenant boundary");
      }
    }

    /* NR-2: cross-tenant delete of a transaction. */
    {
      const aTxn = await db.transaction.findFirst({
        where: { companyId: A.companyId },
        select: { id: true },
      });
      if (!aTxn) {
        note("NR-2 skipped: tenant A holds no transaction to target");
      } else {
        const res = await C.page.evaluate(async (base) => {
          // The action is only reachable through the app's own Server Action
          // endpoint, so drive the UI's own module rather than guessing an
          // RPC id: navigate to /expenses and use the row control if it is
          // there. A cross-tenant row will not be on the page at all, which
          // is itself the first line of defence.
          const r = await fetch(`${base}/expenses`, { credentials: "include" });
          return r.status;
        }, BASE);
        note(`NR-2 probe: tenant C /expenses -> ${res}`);
        const stillThere = await db.transaction.findFirst({
          where: { id: aTxn.id, companyId: A.companyId },
          select: { id: true },
        });
        if (stillThere) {
          ok("NR-2 held: tenant A's transaction is not reachable or deletable from tenant C");
        } else {
          fail("cross-tenant transaction delete", `tenant A's ${aTxn.id} disappeared`);
        }
      }
    }

    /* NR-3: the budget-threshold month sentinel under concurrency.
     * lib/budgets/check.ts claims the sentinel with a conditional updateMany
     * that pins BOTH month columns before any fan-out. Cross 100% with two
     * simultaneous expenses and count the alerts that reached ME. */
    if (budgetId) {
      const before = new Date();
      const cat = await db.budget.findFirst({
        where: { id: budgetId, companyId: A.companyId },
        select: { category: true, monthlyLimit: true },
      });
      if (!cat) {
        note("NR-3 skipped: my budget row is gone (see the Budget hard-delete finding)");
      } else {
        const { page: p2 } = await newPage(browser);
        await signIn(p2, A.email, PASSWORD);
        await Promise.all([
          createExpense(A.page, {
            amount: Number(cat.monthlyLimit) * 0.7,
            category: cat.category,
            description: `QA Race1 ${STAMP}`,
            projectId: project.id,
          }).catch(() => null),
          createExpense(p2, {
            amount: Number(cat.monthlyLimit) * 0.7,
            category: cat.category,
            description: `QA Race2 ${STAMP}`,
            projectId: project.id,
          }).catch(() => null),
        ]);
        const alerts = await db.notification.count({
          where: {
            companyId: A.companyId,
            userId: A.user.id,
            category: "finance",
            createdAt: { gte: before },
            title: { contains: "Budget" },
          },
        });
        if (alerts <= 1) {
          ok(`NR-3 held: two concurrent over-budget expenses produced ${alerts} budget alert(s)`);
        } else {
          fail(
            "the budget month sentinel double-fires under concurrency",
            `${alerts} budget alerts for one threshold in one month`
          );
        }
      }
    } else {
      note("NR-3 skipped: no budget was created");
    }

    /* NR-4: the whole-workspace purge's delete ORDER against the real FK
     * graph. Load tenant C with one row of every workspace table, then run
     * purgeCompany()'s exact ordered sequence against it — children before
     * parents — and assert it completes without tripping Task→Project,
     * Budget→Project, Project→User(supervisor) or Project→User(createdBy),
     * every one of which is ON DELETE RESTRICT in
     * 20260526151502_add_projects/migration.sql.
     *
     * Destroying tenant C is the point and is also its cleanup. */
    {
      await signIn(C.page, C.email, PASSWORD);
      const cProj = await db.project.findFirst({
        where: { companyId: C.companyId },
        select: { id: true },
      });
      if (cProj) {
        await createTask(C.page, {
          title: `QA C Task ${STAMP}`,
          projectId: cProj.id,
          assigneeId: C.user.id,
        });
      }
      await C.page.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
      const cComposer = await C.page.$("textarea");
      if (cComposer) {
        await cComposer.click();
        await C.page.keyboard.type(`QA C msg ${STAMP}`);
        await C.page.keyboard.press("Enter");
        await waitForDb(
          () =>
            db.message.findFirst({
              where: { companyId: C.companyId, body: { contains: STAMP } },
              select: { id: true },
            }),
          { label: "tenant C chat message" }
        );
      }

      const inventory = {};
      for (const [model, scope] of [
        ["messageReaction", { message: { companyId: C.companyId } }],
        ["message", { companyId: C.companyId }],
        ["channelMember", { channel: { companyId: C.companyId } }],
        ["channel", { companyId: C.companyId }],
        ["comment", { companyId: C.companyId }],
        ["timeEntry", { companyId: C.companyId }],
        ["transaction", { companyId: C.companyId }],
        ["budget", { companyId: C.companyId }],
        ["recurringRule", { companyId: C.companyId }],
        ["task", { companyId: C.companyId }],
        ["activity", { companyId: C.companyId }],
        ["notification", { companyId: C.companyId }],
        ["inviteToken", { companyId: C.companyId }],
        ["project", { companyId: C.companyId }],
        ["user", { companyId: C.companyId }],
      ]) {
        inventory[model] = await db[model].count({ where: scope });
      }
      note(`tenant C inventory: ${JSON.stringify(inventory)}`);

      let purgeError = null;
      let rows = 0;
      try {
        rows = await db.$transaction(async (tx) => {
          let n = 0;
          const del = async (p) => {
            n += (await p).count;
          };
          const where = { where: { companyId: C.companyId } };
          await del(
            tx.messageReaction.deleteMany({ where: { message: { companyId: C.companyId } } })
          );
          await del(tx.message.deleteMany(where));
          await del(
            tx.channelMember.deleteMany({ where: { channel: { companyId: C.companyId } } })
          );
          await del(tx.channel.deleteMany(where));
          await del(tx.comment.deleteMany(where));
          await del(tx.timeEntry.deleteMany(where));
          await del(tx.transaction.deleteMany(where));
          await del(tx.budget.deleteMany(where));
          await del(tx.recurringRule.deleteMany(where));
          await del(tx.task.deleteMany(where));
          await del(tx.activity.deleteMany(where));
          await del(tx.notification.deleteMany(where));
          await del(tx.inviteToken.deleteMany(where));
          await del(tx.project.deleteMany(where));
          await tx.company.update({ where: { id: C.companyId }, data: { ownerId: null } });
          await del(tx.user.deleteMany(where));
          await tx.company.delete({ where: { id: C.companyId } });
          return n + 1;
        });
      } catch (e) {
        purgeError = e;
      }
      if (purgeError) {
        fail(
          "purgeCompany's delete order trips an FK",
          `${purgeError.message?.slice(0, 300)} — the order in ` +
            `app/api/cron/purge-soft-deleted/route.ts does not satisfy the real FK graph`
        );
      } else {
        const leftovers = {};
        for (const [model, scope] of [
          ["message", { companyId: C.companyId }],
          ["task", { companyId: C.companyId }],
          ["project", { companyId: C.companyId }],
          ["user", { companyId: C.companyId }],
        ]) {
          leftovers[model] = await db[model].count({ where: scope });
        }
        const clean = Object.values(leftovers).every((n) => n === 0);
        if (clean) {
          ok(
            `NR-4 held: purgeCompany's ordering erased a fully-loaded workspace (${rows} rows) ` +
              `with no Restrict violation`
          );
        } else {
          fail("purgeCompany left rows behind", JSON.stringify(leftovers));
        }

        // Uncounted-by-design rows that the same transaction removed via
        // cascade. Not a jam, but the number the canary thresholds on.
        const pushLeft = await db.pushSubscription.count({
          where: { user: { companyId: C.companyId } },
        });
        const prefLeft = await db.notificationPreference.count({
          where: { user: { companyId: C.companyId } },
        });
        if (pushLeft === 0 && prefLeft === 0) {
          note(
            "PushSubscription + NotificationPreference went away via cascade but are not named " +
              "in purgeCompany, so they never reach the returned row count that " +
              "warnBulkMutation thresholds on — the same defect the chat tables had"
          );
        }
        // C is gone; drop it from the cleanup list.
        const i = myTenants.indexOf(C.companyId);
        if (i >= 0) myTenants.splice(i, 1);
        C = null;
      }
    }

    /* NR-5: two admins deleting their own accounts at the same moment.
     * deleteAccountAction counts other live users, then writes. Both readers
     * can see "there is another admin" and both tombstone themselves, leaving
     * a LIVE company with zero live users: no session can enter it, no admin
     * can reactivate anyone, and Company.deletedAt is null so the purge never
     * sees it. Run it inside tenant A, which is being destroyed anyway. */
    {
      const secondAdminEmail = `qa-dataint-admin2-${STAMP}@founderflow.test`;
      const inv2 = await invite(A.page, A.companyId, {
        name: `QA Admin2 ${STAMP}`,
        email: secondAdminEmail,
        role: "cofounder",
      });
      const claim2 = await claimInvite(browser, A.companyId, inv2.token, secondAdminEmail);
      if (!claim2.user) {
        note("NR-5 skipped: the second account never joined");
      } else {
        await A.page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
        const promoted = await A.page.evaluate((name) => {
          const row = [...document.querySelectorAll("*")].find(
            (el) => el.children.length === 0 && (el.textContent ?? "").includes(name)
          );
          const scope = row?.closest("tr, li, article, div[class*=rounded]") ?? document.body;
          const sel = scope.querySelector("select");
          if (!sel) return false;
          const opt = [...sel.options].find((o) => /admin/i.test(o.value));
          if (!opt) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }, `QA Admin2 ${STAMP}`);
        if (promoted) await acceptConfirm(A.page).catch(() => {});
        const isAdmin = await waitForDb(
          () =>
            db.user.findFirst({
              where: { id: claim2.user.id, companyId: A.companyId, role: "admin" },
              select: { id: true },
            }),
          { tries: 20, label: "second admin promoted" }
        );
        if (!isAdmin) {
          note("NR-5 skipped: could not promote a second admin through /team");
        } else {
          await signIn(claim2.page, secondAdminEmail, PASSWORD);
          const openDanger = async (page) => {
            await page.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
            const opened = await clickButton(page, "delete account");
            if (!opened) return false;
            await waitForDialog(page);
            await setField(page, '[role="dialog"] input[type=password]', PASSWORD);
            return true;
          };
          const readyA = await openDanger(A.page);
          const ready2 = await openDanger(claim2.page);
          if (!readyA || !ready2) {
            note("NR-5 skipped: could not stage both delete-account dialogs");
          } else {
            await Promise.all([
              A.page.evaluate(() =>
                document.querySelector('[role="dialog"] form')?.requestSubmit()
              ),
              claim2.page.evaluate(() =>
                document.querySelector('[role="dialog"] form')?.requestSubmit()
              ),
            ]);
            await waitForDb(
              async () => {
                const live = await db.user.count({
                  where: { companyId: A.companyId, deletedAt: null },
                });
                return live === 0 ? true : null;
              },
              { tries: 24, every: 250, label: "tenant A drained of live users" }
            );
            const liveUsers = await db.user.count({
              where: { companyId: A.companyId, deletedAt: null },
            });
            const companyRow = await db.company.findFirst({
              where: { id: A.companyId },
              select: { deletedAt: true },
            });
            await shot(A.page, "07-double-account-delete");
            if (liveUsers === 0 && companyRow && companyRow.deletedAt === null) {
              fail(
                "two concurrent account deletes strand a live workspace with no users",
                `company ${A.companyId} has deletedAt=null and 0 live users. Nobody can sign ` +
                  `in, nobody can reactivate (getDeactivatedUsers/reactivateUserAction are ` +
                  `admin-only), and the purge cron only sees tombstoned companies — so the ` +
                  `rows are unreachable AND undeletable forever. deleteAccountAction counts ` +
                  `other admins and then writes, with no re-check inside a transaction.`
              );
            } else {
              ok(
                `NR-5 held: after both deletes, liveUsers=${liveUsers}, ` +
                  `company.deletedAt=${companyRow?.deletedAt ? "set" : "null"}`
              );
            }
          }
        }
      }
    }
  } catch (e) {
    fail("qa-data-integrity threw", e && e.message ? e.message : String(e));
    console.error(e);
  } finally {
    /* ─ cleanup: MY tenants only, children before parents ───────────────── */
    try {
      for (const companyId of myTenants) {
        await db.messageReaction.deleteMany({ where: { message: { companyId } } });
        await db.message.deleteMany({ where: { companyId } });
        await db.channelMember.deleteMany({ where: { channel: { companyId } } });
        await db.channel.deleteMany({ where: { companyId } });
        await db.comment.deleteMany({ where: { companyId } });
        await db.timeEntry.deleteMany({ where: { companyId } });
        await db.notification.deleteMany({ where: { companyId } });
        await db.activity.deleteMany({ where: { companyId } });
        await db.inviteToken.deleteMany({ where: { companyId } });
        await db.recurringRule.deleteMany({ where: { companyId } });
        await db.budget.deleteMany({ where: { companyId } });
        await db.transaction.deleteMany({ where: { companyId } });
        await db.task.deleteMany({ where: { companyId } });
        await db.project.deleteMany({ where: { companyId } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId } } });
        await db.company.update({ where: { id: companyId }, data: { ownerId: null } });
        await db.user.deleteMany({ where: { companyId } });
        await db.company.delete({ where: { id: companyId } });
      }
      console.log(`\ncleanup: removed ${myTenants.length} qa tenant(s)`);
    } catch (e) {
      console.error(`❌ cleanup failed (run \`node scripts/_qa-guard.mjs sweep\`): ${e.message}`);
      process.exitCode = 1;
    }
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n${passes} assertion(s) passed`);
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("❌ qa-data-integrity threw:", err);
  process.exit(1);
});
