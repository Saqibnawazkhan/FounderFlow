/*
 * QA audit — TIME TRACKING surface.   AGENT_INDEX = 8
 *
 * Phase 2 runner for the static findings in the time-tracking domain:
 *   /time, the topbar clock widget, manual entries, the edit-entry modal,
 *   the weekly timesheet, lib/actions/time.ts, lib/time/thresholds.ts.
 *
 * DATA SAFETY — read before changing anything in here.
 *   This script NEVER touches pre-existing data. It signs up its OWN
 *   workspace through the real signup flow (company name `qa-time-<stamp>`,
 *   which is what scripts/_qa-guard.mjs's sweeper keys on) and invites its
 *   own member through the real invite flow. EVERY database assertion and
 *   EVERY database write carries `companyId: TENANT.companyId`. A bare
 *   `db.timeEntry.count()` would be satisfied by another agent's concurrent
 *   insert and produce a FALSE PASS, which is the single most expensive
 *   outcome in a pre-launch audit — so there are none.
 *
 *   The tenant is torn down in `finally`, children before parents, on
 *   success AND on failure.
 *
 * CONVENTIONS
 *   • localDb() only — a bare `new PrismaClient()` auto-loads the root .env,
 *     which points at PRODUCTION Supabase.
 *   • fail() records and keeps going, so one run reports every broken
 *     assertion instead of stopping at the first.
 *   • x-real-ip: 10.99.0.8 on every page before its first navigation.
 *     getClientIp() falls back to the literal "unknown" in dev, so without
 *     this every agent shares one limiters.auth bucket of 5/60s.
 *   • Waits are state predicates (waitForFunction), never fixed sleeps —
 *     the only exception is the hydration pause inside signIn(), which is
 *     copied verbatim from scripts/smoke-chat.mjs (FaultsAudit A14).
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_IP = "10.99.0.8";
const SHOTS = "C:/Users/USER/AppData/Local/Temp/ff-qa/time-tracking";
const STAMP = Date.now().toString().slice(-8);

// A timezone deliberately far from the dev server's, to expose SSR-vs-client
// date rendering. UTC+14 — no entry can land on the same calendar day in both.
const FAR_TZ = "Pacific/Kiritimati";

const db = localDb();

/** Everything this run created. Filled as we go, torn down in finally. */
const TENANT = {
  companyId: null,
  companyName: `qa-time-${STAMP}`,
  adminEmail: `qa-time-${STAMP}@founderflow.test`,
  adminPassword: `qa-Time-${STAMP}!`,
  memberEmail: `qa-time-m-${STAMP}@founderflow.test`,
  memberPassword: `qa-Time-m-${STAMP}!`,
  adminUserId: null,
  memberUserId: null,
};

let passes = 0;
let failures = 0;

function ok(label) {
  passes++;
  console.log(`  ok  ${label}`);
}

/** Records a failure and RETURNS — never throws, so the run keeps auditing. */
function fail(label, detail) {
  failures++;
  process.exitCode = 1;
  console.error(`  FAIL  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
}

function note(label, detail) {
  console.log(`  ..  ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
  } catch (e) {
    note(`screenshot ${name} failed`, e.message);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Page setup + auth helpers
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Every page gets the agent's own client IP before its first navigation,
 * and a console/pageerror wire so hydration errors are visible.
 */
async function newPage(browser, { timezone } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  await page.setViewport({ width: 1440, height: 1000 });
  if (timezone) await page.emulateTimezone(timezone);
  page.__consoleErrors = [];
  page.on("pageerror", (e) => page.__consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") page.__consoleErrors.push(`console: ${m.text()}`);
  });
  return { ctx, page };
}

// COPIED VERBATIM from scripts/smoke-chat.mjs. On a cold dev server the form
// paints before React hydrates; a click that lands first performs a NATIVE
// submit, which (the form declares no method) becomes a GET with the
// credentials in the query string and no sign-in. Retry until React owns the
// click. Tracked as FaultsAudit A14.
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

/** React-controlled inputs ignore .value = x; go through the native setter. */
async function setNative(page, selector, value, index = 0) {
  await page.evaluate(
    ({ selector, value, index }) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) throw new Error(`no element for ${selector}[${index}]`);
      el.focus();
      const proto =
        el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector, value, index }
  );
}

function toLocalInput(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Tenant creation — the REAL signup flow, then the REAL invite flow
 * ──────────────────────────────────────────────────────────────────────── */

async function signUpTenant(page) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
  await page.waitForSelector("input[name=email]", { timeout: 30000 });
  // Hydration pause — same reason as signIn(); the Continue button is a
  // type="button" that does nothing until React owns it.
  await new Promise((r) => setTimeout(r, 1500));

  await page.type("input[name=name]", `QA Time Admin ${STAMP}`);
  await page.type("input[name=email]", TENANT.adminEmail);
  await page.type("input[name=password]", TENANT.adminPassword);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /continue/i.test(b.textContent || "")
    );
    btn?.click();
  });
  await page.waitForFunction(
    () => {
      const el = document.querySelector("input[name=companyName]");
      return el && el.offsetParent !== null;
    },
    { timeout: 15000 }
  );

  await page.type("input[name=companyName]", TENANT.companyName);
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());

  const landed = await page
    .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 40000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) throw new Error("signup never left /signup");

  const company = await db.company.findFirst({
    where: { name: TENANT.companyName },
    select: { id: true },
  });
  if (!company) throw new Error(`signup did not create company ${TENANT.companyName}`);
  TENANT.companyId = company.id;

  const admin = await db.user.findFirst({
    where: { companyId: TENANT.companyId, email: TENANT.adminEmail },
    select: { id: true, role: true },
  });
  if (!admin) throw new Error("signup did not create the admin user in my tenant");
  TENANT.adminUserId = admin.id;

  ok(`tenant created via real signup — ${TENANT.companyName} (${TENANT.companyId})`);
  if (admin.role === "admin") ok("signup owner has the admin role");
  else fail("signup owner role", `expected "admin", got "${admin.role}"`);
}

async function inviteMember(adminPage) {
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0" });
  await adminPage.waitForFunction(() => document.querySelectorAll("article").length > 0, {
    timeout: 30000,
  });
  await adminPage.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /invite member/i.test(b.textContent || "")
    );
    btn?.click();
  });
  await adminPage.waitForSelector('[role="dialog"] input', { timeout: 15000 });

  await adminPage.evaluate(
    ({ name, email }) => {
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = [...dialog.querySelectorAll("input")];
      const set = (el, v) => {
        el.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(inputs[0], name);
      set(inputs[1], email);
      // Role select — force "member" so the role matrix is exercised.
      const sel = dialog.querySelector("select");
      if (sel) {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(
          sel,
          "member"
        );
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { name: `QA Time Member ${STAMP}`, email: TENANT.memberEmail }
  );
  await adminPage.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await adminPage
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 20000 })
    .catch(() => {});

  const token = await db.inviteToken.findFirst({
    where: { companyId: TENANT.companyId, email: TENANT.memberEmail },
    orderBy: { createdAt: "desc" },
  });
  if (!token) throw new Error("invite token not created inside my tenant");

  const { ctx, page } = await newPage(globalThis.__browser);
  await page.goto(`${BASE}/invite/${token.token}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("input[type=password]", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  await setNative(page, "input[type=password]", TENANT.memberPassword);
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await page
    .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 30000 })
    .catch(() => {});
  await ctx.close();

  const member = await db.user.findFirst({
    where: { companyId: TENANT.companyId, email: TENANT.memberEmail },
    select: { id: true, role: true },
  });
  if (!member) throw new Error("invite accept did not create the member in my tenant");
  TENANT.memberUserId = member.id;
  if (member.role === "member") ok("member joined via the real invite flow, role=member");
  else fail("invited user role", `expected "member", got "${member.role}"`);
}

/* ────────────────────────────────────────────────────────────────────────
 * Fixtures inside MY tenant only
 * ──────────────────────────────────────────────────────────────────────── */

async function seedTenantFixtures() {
  const project = await db.project.findFirst({
    where: { companyId: TENANT.companyId },
    select: { id: true, name: true },
  });
  if (!project) throw new Error("signup did not create a default project in my tenant");

  const mk = (title, assignee, assigneeName) =>
    db.task.create({
      data: {
        companyId: TENANT.companyId,
        projectId: project.id,
        title,
        description: "qa fixture",
        status: "pending",
        priority: "medium",
        assignedTo: assignee,
        assignedToName: assigneeName,
        assignedBy: TENANT.adminUserId,
        assignedByName: `QA Time Admin ${STAMP}`,
        deadline: new Date(Date.now() + 7 * 864e5),
        order: -Date.now(),
      },
    });

  const adminTask = await mk(
    `qa-ADMIN-SECRET-${STAMP}`,
    TENANT.adminUserId,
    `QA Time Admin ${STAMP}`
  );
  const memberTask = await mk(
    `qa-MEMBER-OWN-${STAMP}`,
    TENANT.memberUserId,
    `QA Time Member ${STAMP}`
  );
  const doomedTask = await mk(
    `qa-DELETED-${STAMP}`,
    TENANT.adminUserId,
    `QA Time Admin ${STAMP}`
  );

  return { project, adminTask, memberTask, doomedTask };
}

/** Rows this run owns, scoped to my tenant. Used by every DB assertion. */
function mine(extra = {}) {
  return { companyId: TENANT.companyId, ...extra };
}

/* ────────────────────────────────────────────────────────────────────────
 * Clock-widget helpers
 * ──────────────────────────────────────────────────────────────────────── */

async function openStartModal(page) {
  await page.waitForSelector("button[aria-label='Clock in']", { timeout: 20000 });
  await page.click("button[aria-label='Clock in']");
  await page.waitForSelector('[role="dialog"] select', { timeout: 10000 });
}

async function startModalOptions(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] select option')].map((o) => o.textContent.trim())
  );
}

async function closeDialog(page) {
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 })
    .catch(() => {});
}

async function clockIn(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button[type=submit]')][0];
    btn?.click();
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button[aria-label]")].some((b) =>
        (b.getAttribute("aria-label") || "").startsWith("Clocked in,")
      ),
    { timeout: 20000 }
  );
}

async function clockOut(page) {
  await page.click("button[aria-label^='Clocked in']");
  await page.waitForSelector('[role="dialog"] button[type=submit]', { timeout: 10000 });
  await page.evaluate(() =>
    document.querySelector('[role="dialog"] button[type=submit]')?.click()
  );
  await page.waitForFunction(() => !!document.querySelector("button[aria-label='Clock in']"), {
    timeout: 20000,
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Checks
 * ──────────────────────────────────────────────────────────────────────── */

/** time-001 — the clock-in picker hands a member every task in the company. */
async function checkTaskTitleLeak(memberPage, fx) {
  section("time-001 · member reads every company task title via the clock widget");
  await memberPage.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
  const onBoard = await memberPage.evaluate(() => document.body.innerText);
  if (onBoard.includes(fx.adminTask.title)) {
    fail("/tasks member filter", "the admin-only task is on the member's board — premise broken");
  } else {
    ok("/tasks correctly hides the admin-only task from the member");
  }

  await openStartModal(memberPage);
  const options = await startModalOptions(memberPage);
  await shot(memberPage, "001-member-clockin-picker");
  await closeDialog(memberPage);

  if (options.includes(fx.adminTask.title)) {
    fail(
      "clock-in picker task scope",
      `expected the member to see ONLY their own task; the picker listed "${fx.adminTask.title}" (options: ${JSON.stringify(options)})`
    );
  } else {
    ok("clock-in picker did not leak the admin-only task title");
  }
}

/** time-002 — /time's manual-entry picker is empty for members. */
async function checkManualPickerEmptyForMember(memberPage, fx) {
  section("time-002 · /time manual-entry picker is empty for a member");
  await memberPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  await memberPage.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /log time/i.test(b.textContent)),
    { timeout: 20000 }
  );
  await memberPage.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /log time/i.test(b.textContent)
    );
    btn?.click();
  });
  await memberPage.waitForSelector('[role="dialog"] select', { timeout: 10000 });
  const options = await startModalOptions(memberPage);
  await shot(memberPage, "002-member-manual-entry-picker");

  if (options.length <= 1) {
    fail(
      "manual-entry task picker for a member",
      `expected the member's own task "${fx.memberTask.title}" to be selectable; picker held only ${JSON.stringify(options)} (page.tsx passes tasks=[] to members while createManualEntryAction has no role gate)`
    );
  } else if (!options.includes(fx.memberTask.title)) {
    fail("manual-entry picker content", `member's own task missing; got ${JSON.stringify(options)}`);
  } else {
    ok("member can tag a manual entry with their own task");
  }
  await closeDialog(memberPage);
}

/** time-003 — a soft-deleted task is still offered by the clock widget. */
async function checkDeletedTaskStillOffered(adminPage, fx) {
  section("time-003 · soft-deleted task still offered by the clock-in picker");
  // Delete through the real UI so the soft-delete path is the one under test.
  await adminPage.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
  const deletedViaUi = await adminPage
    .evaluate((title) => {
      const card = [...document.querySelectorAll("*")].find(
        (el) => el.children.length === 0 && el.textContent.trim() === title
      );
      if (!card) return false;
      let node = card;
      for (let i = 0; i < 8 && node; i++) {
        const btn = [...node.querySelectorAll("button")].find((b) =>
          /delete/i.test(b.getAttribute("aria-label") || "")
        );
        if (btn) {
          btn.click();
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }, fx.doomedTask.title)
    .catch(() => false);

  if (deletedViaUi) {
    await adminPage
      .waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some((b) => /^delete$/i.test(b.textContent.trim())),
        { timeout: 8000 }
      )
      .then(() =>
        adminPage.evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((b) =>
            /^delete$/i.test(b.textContent.trim())
          );
          btn?.click();
        })
      )
      .catch(() => {});
  }

  await adminPage
    .waitForFunction(
      async () => true,
      { timeout: 1000 }
    )
    .catch(() => {});

  let row = await db.task.findFirst({
    where: mine({ id: fx.doomedTask.id }),
    select: { deletedAt: true },
  });
  if (!row?.deletedAt) {
    note("UI delete did not land; tombstoning the fixture directly (my tenant only)");
    await db.task.updateMany({
      where: mine({ id: fx.doomedTask.id }),
      data: { deletedAt: new Date() },
    });
    row = await db.task.findFirst({
      where: mine({ id: fx.doomedTask.id }),
      select: { deletedAt: true },
    });
  }
  if (!row?.deletedAt) {
    fail("time-003 setup", "could not tombstone the fixture task");
    return;
  }

  await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await openStartModal(adminPage);
  const options = await startModalOptions(adminPage);
  await shot(adminPage, "003-admin-picker-after-task-delete");
  await closeDialog(adminPage);

  if (options.includes(fx.doomedTask.title)) {
    fail(
      "clock-in picker hides deleted tasks",
      `expected "${fx.doomedTask.title}" to be gone after deletion; it is still selectable (getOpenEntryAction omits deletedAt: null)`
    );
  } else {
    ok("clock-in picker drops a deleted task");
  }
}

/** time-004 — time entries never carry projectId, so project hours are 0. */
async function checkProjectRollupAlwaysZero(adminPage, fx) {
  section("time-004 · project 'Hours tracked' can never leave 0");
  await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await openStartModal(adminPage);
  await setNative(adminPage, '[role="dialog"] select', fx.adminTask.id);
  await clockIn(adminPage);
  await clockOut(adminPage);

  const entry = await db.timeEntry.findFirst({
    where: mine({ userId: TENANT.adminUserId, taskId: fx.adminTask.id }),
    orderBy: { clockInAt: "desc" },
    select: { id: true, projectId: true, projectName: true, taskId: true, clockOutAt: true },
  });
  if (!entry) {
    fail("time-004 setup", "the clock-in/out round trip left no entry in my tenant");
    return null;
  }
  ok("clock in → clock out persisted a closed entry in my tenant");

  if (entry.projectId === null) {
    fail(
      "time entry carries its task's project",
      `entry ${entry.id} is tagged with task ${entry.taskId} (project ${fx.project.id}) but TimeEntry.projectId is NULL — lib/actions/time.ts never writes projectId/projectName, so getProjects()/getProjectOverview() roll up 0 forever`
    );
  } else {
    ok(`time entry inherited projectId ${entry.projectId}`);
  }

  await adminPage.goto(`${BASE}/projects`, { waitUntil: "networkidle0" });
  const cardText = await adminPage.evaluate(() => document.body.innerText);
  await shot(adminPage, "004-projects-hours-tracked");
  if (/0m/.test(cardText)) {
    note("/projects still renders a 0m hours figure after a tracked session");
  }
  return entry;
}

/** time-005 — manual entries have no maximum length and no overlap check. */
async function checkManualEntryBounds(adminPage, fx) {
  section("time-005 · manual entry accepts an absurd duration and overlaps");
  const before = await db.timeEntry.count({ where: mine({ userId: TENANT.adminUserId }) });

  async function logManual(startDate, endDate, label) {
    await adminPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
    await adminPage.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /log time/i.test(b.textContent)),
      { timeout: 20000 }
    );
    await adminPage.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /log time/i.test(b.textContent)
      );
      btn?.click();
    });
    await adminPage.waitForSelector('[role="dialog"] input[type=datetime-local]', {
      timeout: 10000,
    });
    await setNative(adminPage, '[role="dialog"] input[type=datetime-local]', startDate, 0);
    await setNative(adminPage, '[role="dialog"] input[type=datetime-local]', endDate, 1);
    await adminPage.evaluate(() => {
      const btn = [...document.querySelectorAll('[role="dialog"] button[type=submit]')][0];
      btn?.click();
    });
    const closed = await adminPage
      .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    note(`manual entry ${label}: dialog ${closed ? "closed (accepted)" : "stayed open (rejected)"}`);
    if (!closed) await closeDialog(adminPage);
    return closed;
  }

  // (a) a 3-year session
  const longStart = new Date(Date.now() - 3 * 365 * 864e5);
  const longEnd = new Date(Date.now() - 60_000);
  const acceptedLong = await logManual(
    toLocalInput(longStart),
    toLocalInput(longEnd),
    "3 years"
  );
  const longRow = await db.timeEntry.findFirst({
    where: mine({ userId: TENANT.adminUserId, clockInAt: { lt: new Date(Date.now() - 300 * 864e5) } }),
    select: { id: true, clockInAt: true, clockOutAt: true },
  });
  if (acceptedLong && longRow) {
    const hours = Math.round(
      (longRow.clockOutAt.getTime() - longRow.clockInAt.getTime()) / 3_600_000
    );
    fail(
      "manual entry duration ceiling",
      `expected a plausibility cap (e.g. <= 24h per entry); a single ${hours}h session was stored as ${longRow.id}. CreateManualEntrySchema only checks end>start and end<=now, so any member can inflate their own tracked hours without limit`
    );
  } else {
    ok("a 3-year manual entry was rejected");
  }

  // (b) two overlapping sessions on the same day
  const base = new Date();
  base.setHours(9, 0, 0, 0);
  const a1 = new Date(base);
  const a2 = new Date(base.getTime() + 3 * 3600_000);
  const b1 = new Date(base.getTime() + 1 * 3600_000);
  const b2 = new Date(base.getTime() + 4 * 3600_000);
  const nowMs = Date.now();
  if (a2.getTime() > nowMs || b2.getTime() > nowMs) {
    note("skipping the overlap probe — the fixed 09:00–13:00 window is in the future right now");
  } else {
    await logManual(toLocalInput(a1), toLocalInput(a2), "09:00-12:00");
    await logManual(toLocalInput(b1), toLocalInput(b2), "10:00-13:00");
    const overlapping = await db.timeEntry.count({
      where: mine({
        userId: TENANT.adminUserId,
        clockInAt: { gte: a1, lte: b1 },
        clockOutAt: { not: null },
      }),
    });
    if (overlapping >= 2) {
      fail(
        "overlapping manual entries rejected",
        `expected the second entry to be refused (it double-counts 10:00–12:00); ${overlapping} overlapping rows exist for this user in my tenant`
      );
    } else {
      ok("overlapping manual entries were refused");
    }
  }

  const after = await db.timeEntry.count({ where: mine({ userId: TENANT.adminUserId }) });
  note(`entries for my admin: ${before} → ${after}`);
}

/** time-006/007/008/009 — what the admin edit modal can do to an entry. */
async function checkEditModal(adminPage, entry) {
  section("time-006..009 · admin edit modal: reopen, autoClosed, future dates");
  if (!entry) {
    fail("edit-modal checks", "no closed entry to edit");
    return;
  }

  // Give the row an autoClosed marker so we can see whether a corrective
  // edit clears it. My tenant, my row.
  await db.timeEntry.updateMany({
    where: mine({ id: entry.id }),
    data: { autoClosed: true },
  });

  // Also start a SECOND, live entry so a reopen produces two open rows.
  await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await openStartModal(adminPage);
  await clockIn(adminPage);
  ok("a live entry is running while we edit the older one");

  await adminPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  const opened = await adminPage
    .waitForSelector("button[aria-label^='Edit time entry']", { timeout: 20000 })
    .then((h) => h.click())
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    fail("edit modal", "no edit button on /time for an admin");
    return;
  }
  await adminPage.waitForSelector('[role="dialog"] input[type=datetime-local]', { timeout: 10000 });

  // Move clock-in FORWARD past lastActivityAt, and blank clock-out.
  const future = new Date(Date.now() + 2 * 365 * 864e5);
  await setNative(adminPage, '[role="dialog"] input[type=datetime-local]', toLocalInput(new Date()), 0);
  await setNative(adminPage, '[role="dialog"] input[type=datetime-local]', "", 1);
  await adminPage.evaluate(() =>
    document.querySelector('[role="dialog"] button[type=submit]')?.click()
  );
  await adminPage
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 15000 })
    .catch(() => {});
  await shot(adminPage, "006-after-reopen-edit");

  const openRows = await db.timeEntry.findMany({
    where: mine({ userId: TENANT.adminUserId, clockOutAt: null }),
    select: { id: true, clockInAt: true, lastActivityAt: true, autoClosed: true },
  });
  if (openRows.length > 1) {
    fail(
      "one open entry per user",
      `expected at most 1 open entry; my tenant's admin has ${openRows.length} (${openRows
        .map((r) => r.id)
        .join(", ")}). updateTimeEntryAction writes clockOutAt: null with no open-entry check, so the invariant clockInAction defends is reachable from the edit modal`
    );
  } else {
    ok("the edit modal could not create a second open entry");
  }

  const reopened = openRows.find((r) => r.id === entry.id);
  if (reopened) {
    if (reopened.lastActivityAt.getTime() < reopened.clockInAt.getTime()) {
      fail(
        "reopened entry survives the nightly sweep",
        `entry ${reopened.id} is open with lastActivityAt ${reopened.lastActivityAt.toISOString()} BEFORE clockInAt ${reopened.clockInAt.toISOString()}. sweepAutoCloseEntries writes clockOutAt = lastActivityAt, so the next 00:10 UTC cron closes it before it started and durationMs() clamps the session to 0m — the admin's correction silently becomes data loss`
      );
    } else {
      ok("reopened entry has lastActivityAt at/after clockInAt");
    }
    if (reopened.autoClosed) {
      fail(
        "corrective edit clears the auto-closed marker",
        `entry ${reopened.id} still has autoClosed=true after an admin edit, so /time keeps showing the ⏱ badge and counting it in the "Auto-closed" KPI`
      );
    } else {
      ok("corrective edit cleared autoClosed");
    }
  }

  // Now push clock-out two years into the future.
  await adminPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  const opened2 = await adminPage
    .waitForSelector("button[aria-label^='Edit time entry']", { timeout: 20000 })
    .then((h) => h.click())
    .then(() => true)
    .catch(() => false);
  if (opened2) {
    await adminPage.waitForSelector('[role="dialog"] input[type=datetime-local]', {
      timeout: 10000,
    });
    await setNative(
      adminPage,
      '[role="dialog"] input[type=datetime-local]',
      toLocalInput(future),
      1
    );
    await adminPage.evaluate(() =>
      document.querySelector('[role="dialog"] button[type=submit]')?.click()
    );
    const accepted = await adminPage
      .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!accepted) await closeDialog(adminPage);

    const futureRow = await db.timeEntry.findFirst({
      where: mine({ userId: TENANT.adminUserId, clockOutAt: { gt: new Date(Date.now() + 864e5) } }),
      select: { id: true, clockOutAt: true },
    });
    if (futureRow) {
      fail(
        "clock-out cannot be set in the future",
        `entry ${futureRow.id} has clockOutAt ${futureRow.clockOutAt.toISOString()}. UpdateTimeEntrySchema only checks out>=in — CreateManualEntrySchema's "no future time" refine is missing here, so /settings "Total tracked" and every project rollup can be inflated by years`
      );
    } else {
      ok("a future clock-out was refused");
    }
  }
}

/** time-010 — /time totals disagree with /settings once past the 500 cap. */
async function checkFiveHundredCap(adminPage) {
  section("time-010 · the take:500 cap vs the week pager and /settings total");
  const rows = [];
  const dayMs = 864e5;
  for (let i = 0; i < 520; i++) {
    const start = new Date(Date.now() - (i + 2) * dayMs);
    start.setHours(9, 0, 0, 0);
    rows.push({
      companyId: TENANT.companyId,
      userId: TENANT.adminUserId,
      userName: `QA Time Admin ${STAMP}`,
      note: `qa-bulk-${i}`,
      clockInAt: start,
      clockOutAt: new Date(start.getTime() + 3600_000),
      lastActivityAt: new Date(start.getTime() + 3600_000),
    });
  }
  await db.timeEntry.createMany({ data: rows });
  const total = await db.timeEntry.count({ where: mine({ userId: TENANT.adminUserId }) });
  note(`my tenant's admin now owns ${total} entries`);

  await adminPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  await adminPage.waitForFunction(() => /Total tracked/.test(document.body.innerText), {
    timeout: 40000,
  });
  const timeTotal = await adminPage.evaluate(() => {
    const m = document.body.innerText.match(/Total tracked\s*([\s\S]{0,40}?)(\d[\d,]*h[^\n]*)/);
    return m ? m[2].trim() : null;
  });
  const sessionsLabel = await adminPage.evaluate(() => {
    const m = document.body.innerText.match(/([\d,]+)\s+sessions/);
    return m ? m[1] : null;
  });
  await shot(adminPage, "010-time-total-after-520");

  await adminPage.goto(`${BASE}/settings`, { waitUntil: "networkidle0" });
  await adminPage
    .waitForFunction(() => /tracked/i.test(document.body.innerText), { timeout: 30000 })
    .catch(() => {});
  const settingsText = await adminPage.evaluate(() => document.body.innerText);
  await shot(adminPage, "010-settings-total");

  note(`/time "Total tracked" = ${timeTotal}, sessions label = ${sessionsLabel}`);
  if (sessionsLabel && Number(sessionsLabel.replace(/,/g, "")) < total) {
    fail(
      "/time shows every session",
      `expected ${total} sessions; /time reports ${sessionsLabel}. getEntries() takes only the 500 newest, so the KPI, the "Total tracked" figure and the week pager all silently truncate — and /settings (which sums ALL entries: ${settingsText.slice(0, 0)}unbounded) disagrees with /time for the same user`
    );
  } else {
    ok("/time accounts for every session");
  }

  // Page the weekly timesheet back past the cap: those weeks exist in the DB
  // but the client only has the newest 500 rows.
  await adminPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  await adminPage
    .waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /^Week$/i.test(b.textContent.trim())),
      { timeout: 30000 }
    )
    .catch(() => {});
  await adminPage.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /^Week$/i.test(b.textContent.trim())
    );
    btn?.click();
  });
  await adminPage
    .waitForFunction(() => /Week total/.test(document.body.innerText), { timeout: 20000 })
    .catch(() => {});
  for (let i = 0; i < 74; i++) {
    await adminPage.evaluate(() => {
      document.querySelector("button[aria-label='Previous week']")?.click();
    });
  }
  await adminPage
    .waitForFunction(() => /Week total/.test(document.body.innerText), { timeout: 20000 })
    .catch(() => {});
  const weekText = await adminPage.evaluate(() => document.body.innerText);
  await shot(adminPage, "010-week-pager-past-cap");
  const weekTotalMatch = weekText.match(/Week total\s*([^\n]+)/);
  note(`week ~74 weeks back reports: ${weekTotalMatch ? weekTotalMatch[1].trim() : "?"}`);

  // The DB definitely has an entry in that window.
  const farBack = await db.timeEntry.count({
    where: mine({
      userId: TENANT.adminUserId,
      clockInAt: { gte: new Date(Date.now() - 525 * dayMs), lte: new Date(Date.now() - 505 * dayMs) },
    }),
  });
  if (farBack > 0 && /Week total\s*0m/.test(weekText)) {
    fail(
      "week pager reaches entries older than the 500-row cap",
      `my tenant has ${farBack} entries in that window but the timesheet renders an empty week — the user sees "no work logged" for weeks they actually worked`
    );
  } else if (farBack > 0) {
    ok("week pager still found entries beyond the 500th row");
  }
}

/** time-011 — SSR renders timestamps in the SERVER's timezone. */
async function checkTimezoneHydration(browser) {
  section("time-011 · /time timestamps are rendered in the server's timezone on first paint");
  const { ctx, page } = await newPage(browser, { timezone: FAR_TZ });
  try {
    await signIn(page, TENANT.adminEmail, TENANT.adminPassword);
    await page.emulateTimezone(FAR_TZ);
    page.__consoleErrors.length = 0;
    await page.goto(`${BASE}/time`, { waitUntil: "domcontentloaded" });
    const preHydration = await page.evaluate(() => {
      const m = document.body.innerText.match(/[A-Z][a-z]{2} \d{2} · \d{2}:\d{2}/);
      return m ? m[0] : null;
    });
    await page.waitForFunction(() => !!window.next || document.readyState === "complete", {
      timeout: 20000,
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /log time/i.test(b.textContent)),
      { timeout: 20000 }
    );
    const postHydration = await page.evaluate(() => {
      const m = document.body.innerText.match(/[A-Z][a-z]{2} \d{2} · \d{2}:\d{2}/);
      return m ? m[0] : null;
    });
    await shot(page, "011-timezone-hydration");

    note(`first cell before hydration: ${preHydration} · after: ${postHydration}`);
    const hydrationErrors = page.__consoleErrors.filter((e) =>
      /hydrat|did not match|Text content|#418|#419|#423|#425/i.test(e)
    );
    if (preHydration && postHydration && preHydration !== postHydration) {
      fail(
        "/time renders timestamps in the viewer's timezone",
        `server-rendered "${preHydration}" then swapped to "${postHydration}" after hydration (viewer TZ ${FAR_TZ}). date-fns format() runs with the SERVER's zone during SSR, so on Vercel (UTC) a PKT customer sees every session 5 hours early until JS lands — and the weekly timesheet buckets by the wrong day in that window`
      );
    } else if (hydrationErrors.length) {
      fail(
        "/time hydrates without a mismatch",
        `React logged: ${hydrationErrors.slice(0, 2).join(" | ")}`
      );
    } else {
      ok("/time timestamps agree before and after hydration");
    }
  } finally {
    await ctx.close();
  }
}

/** time-012 — there is no way to stop the clock from /time itself. */
async function checkNoClockOutOnTimePage(adminPage) {
  section("time-012 · /time has no clock-out control of its own");
  const running = await db.timeEntry.count({
    where: mine({ userId: TENANT.adminUserId, clockOutAt: null }),
  });
  if (running === 0) {
    await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
    await openStartModal(adminPage);
    await clockIn(adminPage);
  }
  await adminPage.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  await adminPage
    .waitForFunction(() => /Live session/.test(document.body.innerText), { timeout: 20000 })
    .catch(() => {});
  const stopButtons = await adminPage.evaluate(() => {
    const banner = [...document.querySelectorAll("section")].find((s) =>
      /Live session/.test(s.innerText || "")
    );
    return banner ? [...banner.querySelectorAll("button")].map((b) => b.textContent.trim()) : null;
  });
  await shot(adminPage, "012-running-banner");
  if (!stopButtons) {
    note("no running banner rendered");
  } else if (stopButtons.length === 0) {
    fail(
      "running-session banner offers a clock-out",
      `the banner tells the user to "clock out from the topbar widget" but carries no control of its own; buttons found: ${JSON.stringify(stopButtons)}`
    );
  } else {
    ok("running banner has its own control");
  }
}

/** time-013 — the clock-in picker silently truncates at 100 tasks. */
async function checkHundredTaskCap(adminPage, fx) {
  section("time-013 · clock-in picker truncates at 100 tasks with no search");
  const rows = [];
  for (let i = 0; i < 110; i++) {
    rows.push({
      companyId: TENANT.companyId,
      projectId: fx.project.id,
      title: `qa-bulk-task-${STAMP}-${String(i).padStart(3, "0")}`,
      description: "qa fixture",
      status: "pending",
      priority: "low",
      assignedTo: TENANT.adminUserId,
      assignedToName: `QA Time Admin ${STAMP}`,
      assignedBy: TENANT.adminUserId,
      assignedByName: `QA Time Admin ${STAMP}`,
      deadline: new Date(Date.now() + 30 * 864e5),
      order: -Date.now() - i,
    });
  }
  await db.task.createMany({ data: rows });
  const open = await db.task.count({
    where: mine({ deletedAt: null, status: { not: "completed" } }),
  });
  note(`my tenant now holds ${open} open tasks`);

  await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await openStartModal(adminPage);
  const options = await startModalOptions(adminPage);
  const hasSearch = await adminPage.evaluate(
    () => !!document.querySelector('[role="dialog"] input[type=search], [role="dialog"] [role="combobox"]')
  );
  await shot(adminPage, "013-picker-110-tasks");
  await closeDialog(adminPage);

  const listed = options.length - 1; // minus "Untagged work"
  if (listed < open) {
    fail(
      "clock-in picker offers every open task",
      `my tenant has ${open} open tasks; the picker listed ${listed} (take: 100 in getOpenEntryAction) and offers ${hasSearch ? "a search box" : "NO search box"}, so the missing tasks are unreachable — a user cannot tag time to them at all`
    );
  } else {
    ok("clock-in picker listed every open task");
  }
}

/** NEGATIVE RESULT — forged scope + cross-tenant reads. */
async function checkScopeForgeryHolds(memberPage, browser) {
  section("negative · forged ?scope=team and cross-tenant reads");
  await memberPage.goto(`${BASE}/time?scope=team`, { waitUntil: "networkidle0" });
  await memberPage
    .waitForFunction(() => /Time/.test(document.body.innerText), { timeout: 20000 })
    .catch(() => {});
  const memberView = await memberPage.evaluate(() => document.body.innerText);
  await shot(memberPage, "neg-member-scope-team");
  if (memberView.includes(`QA Time Admin ${STAMP}`)) {
    fail(
      "member forging ?scope=team",
      "the member's /time page listed the admin's name — getEntries() honoured a scope the role does not permit"
    );
  } else {
    ok("member forging ?scope=team saw only their own entries (Person column absent)");
  }

  // A second tenant must not see tenant one's hours anywhere.
  const other = {
    company: `qa-time-b-${STAMP}`,
    email: `qa-time-b-${STAMP}@founderflow.test`,
    password: `qa-TimeB-${STAMP}!`,
  };
  const { ctx, page } = await newPage(browser);
  try {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[name=email]", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.type("input[name=name]", `QA Time Other ${STAMP}`);
    await page.type("input[name=email]", other.email);
    await page.type("input[name=password]", other.password);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /continue/i.test(b.textContent || "")
      );
      btn?.click();
    });
    await page.waitForFunction(
      () => {
        const el = document.querySelector("input[name=companyName]");
        return el && el.offsetParent !== null;
      },
      { timeout: 15000 }
    );
    await page.type("input[name=companyName]", other.company);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    await page
      .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 40000 })
      .catch(() => {});

    const otherCompany = await db.company.findFirst({
      where: { name: other.company },
      select: { id: true },
    });
    if (!otherCompany) {
      note("second tenant signup failed; cross-tenant probe skipped");
    } else {
      TENANT.otherCompanyId = otherCompany.id;
      await page.goto(`${BASE}/time?scope=team`, { waitUntil: "networkidle0" });
      await page
        .waitForFunction(() => /Time/.test(document.body.innerText), { timeout: 20000 })
        .catch(() => {});
      const text = await page.evaluate(() => document.body.innerText);
      await shot(page, "neg-other-tenant-time");
      if (text.includes(`QA Time Admin ${STAMP}`) || text.includes(`qa-bulk-`)) {
        fail(
          "cross-tenant leak on /time",
          "tenant B's team view rendered tenant A's entries"
        );
      } else {
        ok("tenant B's /time?scope=team shows none of tenant A's hours");
      }

      const leaked = await db.timeEntry.count({
        where: { companyId: otherCompany.id, userName: `QA Time Admin ${STAMP}` },
      });
      if (leaked > 0) fail("cross-tenant rows", `${leaked} of tenant A's rows are filed under B`);
      else ok("no tenant-A time rows exist under tenant B in the database");
    }
  } finally {
    await ctx.close();
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Teardown — children before parents, scoped to the tenants I created
 * ──────────────────────────────────────────────────────────────────────── */

async function destroyTenant(companyId) {
  if (!companyId) return;
  const byCompany = { where: { companyId } };
  await db.messageReaction.deleteMany({ where: { message: { companyId } } }).catch(() => {});
  await db.message.deleteMany(byCompany).catch(() => {});
  await db.channelMember.deleteMany({ where: { channel: { companyId } } }).catch(() => {});
  await db.channel.deleteMany(byCompany).catch(() => {});
  await db.comment.deleteMany(byCompany).catch(() => {});
  await db.timeEntry.deleteMany(byCompany).catch(() => {});
  await db.notification.deleteMany(byCompany).catch(() => {});
  await db.activity.deleteMany(byCompany).catch(() => {});
  await db.inviteToken.deleteMany(byCompany).catch(() => {});
  await db.recurringRule.deleteMany(byCompany).catch(() => {});
  await db.budget.deleteMany(byCompany).catch(() => {});
  await db.transaction.deleteMany(byCompany).catch(() => {});
  await db.task.deleteMany(byCompany).catch(() => {});
  await db.project.deleteMany(byCompany).catch(() => {});
  await db.notificationPreference.deleteMany({ where: { user: { companyId } } }).catch(() => {});
  await db.pushSubscription.deleteMany({ where: { user: { companyId } } }).catch(() => {});
  await db.user.deleteMany(byCompany).catch(() => {});
  await db.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  console.log(`  cleanup  removed tenant ${companyId}`);
}

/* ────────────────────────────────────────────────────────────────────────
 * Main
 * ──────────────────────────────────────────────────────────────────────── */

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  globalThis.__browser = browser;
  console.log(`== qa: time-tracking (agent 8, ip ${AGENT_IP}) ==`);

  let adminCtx = null;
  let memberCtx = null;
  try {
    const admin = await newPage(browser);
    adminCtx = admin.ctx;
    await signUpTenant(admin.page);
    await inviteMember(admin.page);
    const fx = await seedTenantFixtures();

    const member = await newPage(browser);
    memberCtx = member.ctx;
    await signIn(member.page, TENANT.memberEmail, TENANT.memberPassword);

    await checkTaskTitleLeak(member.page, fx);
    await checkManualPickerEmptyForMember(member.page, fx);
    await checkScopeForgeryHolds(member.page, browser);

    await checkDeletedTaskStillOffered(admin.page, fx);
    const entry = await checkProjectRollupAlwaysZero(admin.page, fx);
    await checkManualEntryBounds(admin.page, fx);
    await checkEditModal(admin.page, entry);
    await checkNoClockOutOnTimePage(admin.page);
    await checkHundredTaskCap(admin.page, fx);
    await checkFiveHundredCap(admin.page);
  } catch (e) {
    fail("run aborted", e.message);
    console.error(e.stack);
  } finally {
    await adminCtx?.close().catch(() => {});
    await memberCtx?.close().catch(() => {});
    await browser.close().catch(() => {});
    await destroyTenant(TENANT.companyId);
    await destroyTenant(TENANT.otherCompanyId);
    await db.$disconnect();
  }

  console.log(`\n== time-tracking: ${passes} ok, ${failures} failed ==`);
  if (failures > 0) console.log("❌ time-tracking has failures");
}

main().catch(async (err) => {
  console.error("❌ qa-time-tracking threw:", err);
  process.exitCode = 1;
  await db.$disconnect().catch(() => {});
});
