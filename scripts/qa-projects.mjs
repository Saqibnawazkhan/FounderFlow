/*
 * QA exercise script — PROJECTS domain (go-live audit, AGENT_INDEX = 4).
 *
 * Surface: /projects, /projects/[id], new / edit / duplicate project,
 * supervisor reassignment, archive + delete, and lib/auth/project-permissions.ts
 * (including the member-as-supervisor escape hatch).
 *
 * ── DATA SAFETY ───────────────────────────────────────────────────────────
 * This script NEVER touches pre-existing data. It signs up TWO of its own
 * workspaces through the real signup flow — `qa-projects-<stamp>` (tenant A)
 * and `qa-projects-alt-<stamp>` (tenant B, used only as the "other tenant"
 * for cross-tenant forging) — invites its own teammates through the real
 * invite flow, and every single DB assertion carries
 * `where: { companyId: <one of my two tenant ids> }`. A bare `db.X.count()`
 * would let another agent's concurrent insert satisfy a "did mine land?"
 * check and produce a FALSE PASS, so there is not one in this file.
 * `finally` deletes both tenants, children before parents.
 *
 * Rate limiting: `getClientIp()` falls back to the literal "unknown" in dev,
 * so without an explicit x-real-ip every agent shares ONE limiters.auth
 * bucket of 5/60s. Every page here sets 10.99.0.4 before its first nav.
 *
 * Each `fail()` records and continues (never throws) so one run reports every
 * broken assertion, and prints a literal ❌ for the runner's summary.
 */

import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/projects";
const AGENT_IP = "10.99.0.4";
const STAMP = Date.now().toString().slice(-8);
const PASSWORD = `QaProj${STAMP}a`; // 8+, lower, upper, digit — PasswordSchema

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

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

/** A page in its own browser context, with this agent's rate-limit identity. */
async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
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
 * Goes through the prototype's value setter — assigning `el.value` directly
 * is invisible to React's synthetic change tracking. No `eval` anywhere: the
 * dev server's CSP would refuse it.
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

/** Click the first button whose visible text matches `re`. Returns bool. */
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

/** Wait until a toast (react-hot-toast) carrying `re` is on screen. */
async function waitForToast(page, reSource) {
  return page
    .waitForFunction(
      (src) => new RegExp(src, "i").test(document.body.innerText),
      { timeout: 20000 },
      reSource
    )
    .then(() => true)
    .catch(() => false);
}

/* ── tenant bootstrap (the real signup flow) ─────────────────────────────── */

/**
 * Sign up a brand-new workspace through the real 2-step /signup wizard.
 * Company names MUST start with `qa-` so scripts/_qa-guard.mjs sweep finds them.
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
  await setField(page, "select[name=industry]", await firstOptionValue(page, "select[name=industry]"));
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
  const owner = await db.user.findFirst({
    where: { companyId: company.id, email },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!owner) throw new Error(`signup for ${companyName} created no owner row`);

  return { ctx, page, companyId: company.id, companyName, user: owner, email };
}

async function firstOptionValue(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el && el.options.length ? el.options[0].value : "";
  }, selector);
}

/**
 * Invite a teammate through the real /team invite flow, then claim the invite
 * through the real /invite/[token] page. Returns the new user's row.
 */
async function inviteAndClaim(browser, adminPage, companyId, { name, email, role }) {
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  const opened = await clickButton(adminPage, "invite member");
  if (!opened) throw new Error("invite: no 'Invite member' button on /team");
  await waitForDialog(adminPage);

  await setField(adminPage, '[role="dialog"] input[name=name]', name);
  await setField(adminPage, '[role="dialog"] input[name=email]', email);
  if (role === "member") {
    const picked = await clickButton(adminPage, "team member", '[role="dialog"]');
    if (!picked) throw new Error("invite: no 'Team Member' role button");
  }
  await adminPage.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());

  // State predicate: the token row lands in MY company only.
  let token = null;
  for (let i = 0; i < 60 && !token; i++) {
    const row = await db.inviteToken.findFirst({
      where: { companyId, email: email.toLowerCase() },
      orderBy: { createdAt: "desc" },
      select: { token: true, role: true },
    });
    if (row) token = row;
    else await new Promise((r) => setTimeout(r, 500));
  }
  if (!token) throw new Error(`invite: no InviteToken row for ${email} in company ${companyId}`);
  if (token.role !== role) {
    fail("invite role persisted", `asked for ${role}, token says ${token.role}`);
  }

  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/invite/${token.token}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[name=password]", { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500)); // hydration
  await setField(page, "input[name=password]", PASSWORD);
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await page
    .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 45000 })
    .catch(() => {});

  const user = await db.user.findFirst({
    where: { companyId, email: email.toLowerCase(), deletedAt: null },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!user) throw new Error(`invite: ${email} never became a user in company ${companyId}`);
  return { ctx, page, user };
}

/* ── project helpers (through the real UI) ───────────────────────────────── */

/**
 * Create a project through the New project modal. `supervisorId` is picked in
 * the modal's <select>; `color` clicks the swatch with that aria-label.
 */
async function createProject(page, { name, description = "", supervisorId, color = "emerald" }) {
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
  const opened = await clickButton(page, "new project");
  if (!opened) throw new Error("createProject: no 'New project' button (role gate?)");
  await waitForDialog(page);

  const inputs = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return {
      hasText: !!d.querySelector("input:not([type=date])"),
      hasSelect: !!d.querySelector("select"),
    };
  });
  if (!inputs.hasText || !inputs.hasSelect) {
    throw new Error("createProject: modal shape changed");
  }

  await setField(page, '[role="dialog"] input:not([type=date])', name);
  await setField(page, '[role="dialog"] textarea', description);
  await setField(page, '[role="dialog"] select', supervisorId);
  await page.evaluate((c) => {
    const d = document.querySelector('[role="dialog"]');
    const swatch = [...d.querySelectorAll('[role="radio"]')].find(
      (b) => b.getAttribute("aria-label") === c
    );
    if (swatch) swatch.click();
  }, color);

  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  // The modal navigates to /projects/<id> on success.
  const navigated = await page
    .waitForFunction(() => /^\/projects\/[^/]+$/.test(location.pathname), { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!navigated) {
    await shot(page, `create-stuck-${name}`);
    throw new Error(`createProject(${name}): never landed on a detail page`);
  }
  return new URL(page.url()).pathname.split("/").pop();
}

/* ── the run ─────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`== qa-projects (agent 4, stamp ${STAMP}) ==`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  /** Every tenant id this run created — the cleanup scope, and the only
   *  companyId any assertion below is ever allowed to name. */
  const myTenants = [];
  const contexts = [];

  try {
    /* ─ 0. two tenants of my own ─────────────────────────────────────── */
    section("0. tenants");
    const A = await signupTenant(browser, {
      companyName: `qa-projects-${STAMP}`,
      name: `QA Projects Admin ${STAMP}`,
      email: `qa-projects-${STAMP}@founderflow.test`,
    });
    myTenants.push(A.companyId);
    contexts.push(A.ctx);
    ok(`tenant A signed up through the real flow (${A.companyName})`);

    const B = await signupTenant(browser, {
      companyName: `qa-projects-alt-${STAMP}`,
      name: `QA Projects Other ${STAMP}`,
      email: `qa-projects-alt-${STAMP}@founderflow.test`,
    });
    myTenants.push(B.companyId);
    contexts.push(B.ctx);
    ok(`tenant B signed up (cross-tenant foil, ${B.companyName})`);

    /* ─ 0b. FIRST-RUN: a brand-new workspace has no project at all ────── */
    section("0b. first run (projects-001)");
    const seededProjects = await db.project.count({ where: { companyId: A.companyId } });
    if (seededProjects === 0) {
      note("a fresh workspace starts with 0 projects (signup mints #general but no project)");
    }
    await A.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "new task|create your first task");
    const taskModal = await waitForDialog(A.page)
      .then(() => true)
      .catch(() => false);
    if (taskModal) {
      const picker = await A.page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        const sel = [...d.querySelectorAll("select")].find((s) =>
          /project/i.test(s.previousElementSibling?.textContent ?? "") ||
          /project/i.test(d.querySelector(`label[for="${s.id}"]`)?.textContent ?? "")
        );
        if (!sel) return null;
        return {
          options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent.trim() })),
        };
      });
      await shot(A.page, "01-first-run-task-no-project");
      if (picker && picker.options.length === 1 && picker.options[0].value === "") {
        fail(
          "projects-001 first-run dead end",
          `the very first "New task" offers only "${picker.options[0].text}" — Task.projectId is NOT NULL, so the form cannot be submitted and nothing tells the user to create a project first`
        );
      } else if (picker) {
        ok("the first New task form offers a usable project");
      } else {
        note("could not locate the project picker; check the screenshot");
      }
      await A.page.keyboard.press("Escape");
      await waitForDialogClosed(A.page);
    } else {
      note("no task modal opened on an empty workspace");
    }

    /* ─ 1. teammates, through the real invite flow ───────────────────── */
    section("1. teammates");
    const memberSess = await inviteAndClaim(browser, A.page, A.companyId, {
      name: `QA Member ${STAMP}`,
      email: `qa-projects-member-${STAMP}@founderflow.test`,
      role: "member",
    });
    contexts.push(memberSess.ctx);
    ok(`member invited + claimed (${memberSess.user.role})`);

    const cofounderSess = await inviteAndClaim(browser, A.page, A.companyId, {
      name: `QA Cofounder ${STAMP}`,
      email: `qa-projects-cofounder-${STAMP}@founderflow.test`,
      role: "cofounder",
    });
    contexts.push(cofounderSess.ctx);
    ok(`cofounder invited + claimed (${cofounderSess.user.role})`);

    const member = memberSess.user;
    const cofounder = cofounderSess.user;

    /* ─ 2. create: happy path + the escape hatch project ──────────────── */
    section("2. create");
    // P1 is supervised by the MEMBER — this is the escape hatch under test.
    const p1Id = await createProject(A.page, {
      name: `QA Supervised ${STAMP}`,
      description: "member-as-supervisor escape hatch",
      supervisorId: member.id,
      color: "slate", // deliberately NOT the default — see projects-004
    });
    const p1 = await db.project.findFirst({
      where: { id: p1Id, companyId: A.companyId },
      select: { id: true, name: true, supervisorId: true, color: true, status: true, createdBy: true },
    });
    if (p1 && p1.supervisorId === member.id && p1.status === "active") {
      ok("create persisted with the chosen supervisor and status=active");
    } else {
      fail("create persisted", JSON.stringify(p1));
    }
    if (p1 && p1.color === "slate") ok("the chosen colour persisted as 'slate'");
    else fail("colour persisted", `expected slate, got ${p1?.color}`);

    // P2 is supervised by the ADMIN; the member will only hold a task in it.
    const p2Id = await createProject(A.page, {
      name: `QA Assigned ${STAMP}`,
      supervisorId: A.user.id,
      color: "emerald",
    });

    // The supervisor who is not the creator must be told.
    const supervisorNotice = await db.notification.count({
      where: { companyId: A.companyId, userId: member.id, projectId: p1Id },
    });
    if (supervisorNotice >= 1) ok("the new supervisor got a notification");
    else fail("supervisor notification", `0 rows for user ${member.id} on project ${p1Id}`);

    const createActivity = await db.activity.count({
      where: { companyId: A.companyId, projectId: p1Id, type: "project_created" },
    });
    if (createActivity === 1) ok("exactly one project_created activity row");
    else fail("create activity", `expected 1, got ${createActivity}`);

    /* ─ 3. validation + role denial on create ─────────────────────────── */
    section("3. create — error paths");
    await A.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "new project");
    await waitForDialog(A.page);
    await setField(A.page, '[role="dialog"] input:not([type=date])', "   "); // whitespace only
    await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    const nameError = await A.page
      .waitForFunction(() => /project name is required/i.test(document.body.innerText), {
        timeout: 10000,
      })
      .then(() => true)
      .catch(() => false);
    if (nameError) ok("a whitespace-only name is rejected inline, no row written");
    else fail("blank-name validation", "no 'Project name is required' message appeared");
    const blankCount = await db.project.count({
      where: { companyId: A.companyId, name: { in: ["", "   "] } },
    });
    if (blankCount === 0) ok("no blank-named project reached the database");
    else fail("blank name persisted", `${blankCount} row(s)`);

    // Forge a supervisor from the OTHER tenant by injecting an <option>.
    await setField(A.page, '[role="dialog"] input:not([type=date])', `QA Forge ${STAMP}`);
    await A.page.evaluate((foreignId) => {
      const sel = document.querySelector('[role="dialog"] select');
      const opt = document.createElement("option");
      opt.value = foreignId;
      opt.textContent = "forged";
      sel.appendChild(opt);
    }, B.user.id);
    await setField(A.page, '[role="dialog"] select', B.user.id);
    await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    const forgeRejected = await waitForToast(A.page, "supervisor must be a member of this company");
    if (forgeRejected) ok("a supervisorId forged from another tenant is rejected");
    else fail("cross-tenant supervisor forge", "the action did not reject it");
    const forgedRow = await db.project.count({
      where: { companyId: A.companyId, supervisorId: B.user.id },
    });
    if (forgedRow === 0) ok("no project in my tenant points at the other tenant's user");
    else fail("cross-tenant supervisor persisted", `${forgedRow} row(s)`);
    await A.page.keyboard.press("Escape");
    await waitForDialogClosed(A.page);

    // A member must not be able to create at all.
    await memberSess.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
    const memberSeesNew = await memberSess.page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /new project/i.test(b.textContent ?? ""))
    );
    if (!memberSeesNew) ok("a member is not offered 'New project'");
    else fail("member create affordance", "'New project' is rendered for a member");

    /* ─ 4. the "On hold" label (projects-002) ─────────────────────────── */
    section("4. status labels");
    // Computed key is `status` + "O" + "on_hold".slice(1).replace("_","")
    // = "statusOnhold"; lib/i18n/strings.ts defines "statusOnHold".
    await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "status");
    const pickedOnHold = await A.page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
        /on hold|روک/i.test(b.textContent ?? "")
      );
      if (!item) return false;
      item.click();
      return true;
    });
    if (!pickedOnHold) {
      fail("status menu", "no 'On hold' menu item");
    } else {
      await waitForToast(A.page, "project updated");
      await A.page.reload({ waitUntil: "networkidle0" });
      const pill = await A.page.evaluate(() => {
        const h = document.querySelector("header");
        const spans = [...(h?.querySelectorAll("span") ?? [])];
        const cand = spans.filter((s) => /rounded-full border/.test(s.className));
        return cand.map((s) => s.textContent.trim());
      });
      await shot(A.page, "02-on-hold-pill");
      const blank = pill.some((txt) => txt === "");
      if (blank) {
        fail(
          "projects-002 On-hold label is blank",
          `the detail-header status pill rendered "" — t.projects.statusOnhold is undefined (dictionary key is statusOnHold). Pills seen: ${JSON.stringify(pill)}`
        );
      } else if (pill.some((t) => /on hold|روک/i.test(t))) {
        ok("the on-hold status pill renders its label");
      } else {
        fail("on-hold pill", JSON.stringify(pill));
      }

      // Same key bug on the list chips and the card badge.
      await A.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
      const chips = await A.page.evaluate(() =>
        [...document.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent.trim())
      );
      await shot(A.page, "03-filter-chips");
      const numericOnlyChip = chips.find((c) => /^\d+$/.test(c));
      if (numericOnlyChip !== undefined) {
        fail(
          "projects-002b On-hold filter chip is unlabelled",
          `one status chip rendered only its count ("${numericOnlyChip}"). Chips: ${JSON.stringify(chips)}`
        );
      } else {
        ok("every /projects status chip carries a label");
      }

      // And the Edit modal's <option>.
      await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
      await clickButton(A.page, "edit project");
      await waitForDialog(A.page);
      const statusOptions = await A.page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        const sel = [...d.querySelectorAll("select")][0];
        return [...sel.options].map((o) => ({ value: o.value, text: o.textContent.trim() }));
      });
      await shot(A.page, "04-edit-status-options");
      const blankOption = statusOptions.find((o) => o.text === "");
      if (blankOption) {
        fail(
          "projects-002c Edit modal has an unlabelled status option",
          `option value="${blankOption.value}" renders no text: ${JSON.stringify(statusOptions)}`
        );
      } else {
        ok("every status option in the Edit modal is labelled");
      }
      await A.page.keyboard.press("Escape");
      await waitForDialogClosed(A.page);
    }

    /* ─ 5. colour stripe on the detail page (projects-004) ────────────── */
    section("5. colour stripe");
    // COLOR_STRIPE in project-detail-client.tsx is keyed
    // primary|forest|mint|warning|info — PROJECT_COLORS is
    // emerald|forest|mint|slate|warning. "slate" is missing, so the fallback
    // (bg-primary, the brand green) paints where slate belongs.
    await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    const stripeClass = await A.page.evaluate(() => {
      const h = document.querySelector("header");
      const stripe = h?.querySelector('span[aria-hidden="true"]');
      return stripe ? stripe.className : null;
    });
    if (stripeClass && /bg-slate/.test(stripeClass)) {
      ok("a slate project shows the slate stripe on its detail page");
    } else {
      fail(
        "projects-004 detail-page colour stripe ignores the project's colour",
        `project.color = "slate", detail header stripe class = "${stripeClass}" (COLOR_STRIPE has no "slate" key, so the bg-primary fallback paints)`
      );
    }

    /* ─ 6. duplicate: the correctness boundary ────────────────────────── */
    section("6. duplicate");
    // Fixtures live inside MY tenant only. Tasks go through the real form is
    // slow at volume, so the history rows the duplicate MUST NOT copy are
    // written here directly, scoped to my own project.
    const past = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const older = new Date(Date.now() - 44 * 24 * 3600 * 1000);
    await db.task.createMany({
      data: [
        {
          companyId: A.companyId, projectId: p1Id, title: `QA dup early ${STAMP}`,
          description: "d", status: "completed", priority: "high",
          assignedTo: member.id, assignedToName: member.name,
          assignedBy: A.user.id, assignedByName: A.user.name,
          deadline: older, completedAt: past, order: 1,
        },
        {
          companyId: A.companyId, projectId: p1Id, title: `QA dup late ${STAMP}`,
          description: "d", status: "in_progress", priority: "low",
          assignedTo: member.id, assignedToName: member.name,
          assignedBy: A.user.id, assignedByName: A.user.name,
          deadline: past, completedAt: null, order: 2,
        },
      ],
    });
    await db.budget.create({
      data: {
        companyId: A.companyId, projectId: p1Id, category: `QA cat ${STAMP}`,
        monthlyLimit: "1000.00", createdBy: A.user.id, createdByName: A.user.name,
      },
    });
    await db.transaction.create({
      data: {
        companyId: A.companyId, projectId: p1Id, type: "expense", amount: "137.50",
        category: `QA cat ${STAMP}`, description: `QA spend ${STAMP}`, date: new Date(),
        addedBy: A.user.id, addedByName: A.user.name,
      },
    });
    const srcTasks = await db.task.findMany({
      where: { companyId: A.companyId, projectId: p1Id, deletedAt: null },
      select: { id: true, deadline: true },
    });
    await db.timeEntry.create({
      data: {
        companyId: A.companyId, projectId: p1Id, projectName: `QA Supervised ${STAMP}`,
        userId: member.id, userName: member.name, taskId: srcTasks[0].id,
        clockInAt: past, clockOutAt: new Date(past.getTime() + 3600_000),
      },
    });
    await db.comment.create({
      data: {
        companyId: A.companyId, body: `QA comment ${STAMP}`, authorId: member.id,
        authorName: member.name, taskId: srcTasks[0].id,
      },
    });

    await A.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
    const dupOpened = await A.page.evaluate((pid) => {
      const link = document.querySelector(`a[href="/projects/${pid}"]`);
      const btn = link?.parentElement?.querySelector("button");
      if (!btn) return false;
      btn.click();
      return true;
    }, p1Id);
    if (!dupOpened) {
      fail("duplicate affordance", "no Duplicate button beside the project card");
    } else {
      await waitForDialog(A.page);
      const copyName = `QA Duplicate ${STAMP}`;
      await setField(A.page, '[role="dialog"] input[type=text], [role="dialog"] input:not([type])', copyName);
      // keepAssignees stays OFF (the default under test); copyTasks +
      // shiftDeadlines stay ON.
      await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
      const landed = await A.page
        .waitForFunction(() => /^\/projects\/[^/]+$/.test(location.pathname), { timeout: 30000 })
        .then(() => true)
        .catch(() => false);
      if (!landed) {
        await shot(A.page, "05-duplicate-stuck");
        fail("duplicate navigation", "never landed on the copy's detail page");
      } else {
        const copyId = new URL(A.page.url()).pathname.split("/").pop();
        await shot(A.page, "06-duplicate-detail");

        const copy = await db.project.findFirst({
          where: { id: copyId, companyId: A.companyId },
          select: { id: true, name: true, status: true, supervisorId: true, targetEndDate: true, color: true },
        });
        if (copy && copy.status === "active") ok("the copy lands active, whatever the source was");
        else fail("copy status", JSON.stringify(copy));
        if (copy && copy.targetEndDate === null) ok("targetEndDate is deliberately not copied");
        else fail("copy targetEndDate", String(copy?.targetEndDate));

        // THE boundary: no money, no history.
        const [copyBudgets, copyTxns, copyTime, copyTasks] = await Promise.all([
          db.budget.count({ where: { companyId: A.companyId, projectId: copyId } }),
          db.transaction.count({ where: { companyId: A.companyId, projectId: copyId } }),
          db.timeEntry.count({ where: { companyId: A.companyId, projectId: copyId } }),
          db.task.findMany({
            where: { companyId: A.companyId, projectId: copyId },
            select: { id: true, status: true, completedAt: true, assignedTo: true, deadline: true, order: true },
          }),
        ]);
        if (copyBudgets === 0 && copyTxns === 0 && copyTime === 0) {
          ok("the duplicate copied NO budget, NO transaction and NO time entry");
        } else {
          fail(
            "duplicate money/history boundary",
            `budgets=${copyBudgets} transactions=${copyTxns} timeEntries=${copyTime} — a duplicate must never restate money or hours`
          );
        }
        const copiedComments = await db.comment.count({
          where: { companyId: A.companyId, taskId: { in: copyTasks.map((t) => t.id) } },
        });
        if (copiedComments === 0) ok("no comment was copied onto the duplicate's tasks");
        else fail("duplicate copied comments", `${copiedComments} row(s)`);

        if (copyTasks.length === srcTasks.length) ok(`all ${srcTasks.length} tasks copied`);
        else fail("copied task count", `source ${srcTasks.length}, copy ${copyTasks.length}`);
        if (copyTasks.every((t) => t.status === "pending" && t.completedAt === null)) {
          ok("every copied task arrives reset to pending with completedAt null");
        } else {
          fail("copied task reset", JSON.stringify(copyTasks.map((t) => [t.status, t.completedAt])));
        }
        if (copyTasks.every((t) => t.assignedTo === A.user.id)) {
          ok("keepAssignees off assigns every copied task to the duplicator");
        } else {
          fail("copied assignees", "a copied task landed on someone who did not press Duplicate");
        }

        // Uniform forward shift: earliest copied deadline == start of today,
        // and the source's internal spacing survives.
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const copyMin = Math.min(...copyTasks.map((t) => t.deadline.getTime()));
        if (Math.abs(copyMin - startOfToday.getTime()) < 24 * 3600 * 1000) {
          ok("the earliest copied deadline moved to the start of today");
        } else {
          fail(
            "deadline shift",
            `earliest copied deadline ${new Date(copyMin).toISOString()} vs start of today ${startOfToday.toISOString()}`
          );
        }
        const srcSpan = Math.max(...srcTasks.map((t) => t.deadline.getTime())) -
          Math.min(...srcTasks.map((t) => t.deadline.getTime()));
        const copySpan = Math.max(...copyTasks.map((t) => t.deadline.getTime())) - copyMin;
        if (Math.abs(srcSpan - copySpan) < 1000) ok("the plan's internal spacing survived the shift");
        else fail("deadline spacing", `source span ${srcSpan}ms, copy span ${copySpan}ms`);

        // projects-005: keepAssignees ON should still tell the assignee.
        await A.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
        await A.page.evaluate((pid) => {
          document.querySelector(`a[href="/projects/${pid}"]`)?.parentElement
            ?.querySelector("button")?.click();
        }, p1Id);
        await waitForDialog(A.page);
        const keepName = `QA Duplicate Keep ${STAMP}`;
        await setField(A.page, '[role="dialog"] input[type=text], [role="dialog"] input:not([type])', keepName);
        await A.page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          const boxes = [...d.querySelectorAll('input[type=checkbox]')];
          if (boxes[1] && !boxes[1].checked) boxes[1].click(); // keepAssignees
        });
        await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
        await A.page
          .waitForFunction(() => /^\/projects\/[^/]+$/.test(location.pathname), { timeout: 30000 })
          .catch(() => {});
        const keepId = new URL(A.page.url()).pathname.split("/").pop();
        const keptTasks = await db.task.findMany({
          where: { companyId: A.companyId, projectId: keepId },
          select: { id: true, assignedTo: true },
        });
        if (keptTasks.length > 0 && keptTasks.every((t) => t.assignedTo === member.id)) {
          ok("keepAssignees on preserved the live assignee");
        } else {
          fail("keepAssignees", JSON.stringify(keptTasks));
        }
        const assigneeNotices = await db.notification.count({
          where: { companyId: A.companyId, userId: member.id, projectId: keepId },
        });
        if (assigneeNotices >= keptTasks.length) {
          ok("every carried-over assignee was notified about their new work");
        } else {
          fail(
            "projects-005 duplicate assigns work silently",
            `${keptTasks.length} task(s) landed on ${member.name} but only ${assigneeNotices} notification(s) exist — addTaskAction always fires task_assigned, duplicateProjectAction never does`
          );
        }
      }
    }

    /* ─ 7. the member-as-supervisor escape hatch ──────────────────────── */
    section("7. escape hatch");
    const mp = memberSess.page;
    await mp.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await shot(mp, "07-member-supervisor-detail");
    const hatch = await mp.evaluate(() => {
      const txt = (el) => (el.textContent ?? "").trim();
      const btns = [...document.querySelectorAll("button")].map(txt);
      const links = [...document.querySelectorAll("a")].map((a) => ({ text: txt(a), href: a.getAttribute("href") }));
      return {
        edit: btns.some((b) => /edit project/i.test(b)),
        archive: btns.some((b) => /archive/i.test(b)),
        del: btns.some((b) => /delete/i.test(b)),
        reassign: btns.some((b) => /change supervisor/i.test(b)),
        budgetsSection: /budgets/i.test(document.body.innerText),
        budgetsLink: links.find((l) => l.href === "/budgets") ?? null,
        spendKpi: [...document.querySelectorAll("p")]
          .map(txt)
          .find((t) => /^[^a-z]*\d/.test(t) && t.includes("13")) ?? null,
      };
    });
    if (hatch.edit && hatch.archive && hatch.del) ok("the member-supervisor can manage their own project");
    else fail("escape hatch manage", JSON.stringify(hatch));
    if (!hatch.reassign) ok("the member-supervisor cannot reassign the supervisor");
    else fail("escape hatch reassign", "'Change supervisor' is offered to a member");
    if (hatch.budgetsLink) {
      // projects-003: the link is rendered, but /budgets is in
      // MEMBER_BLOCKED_ROUTES, so middleware bounces them to /tasks.
      await mp.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
      const landedOn = new URL(mp.url()).pathname;
      await shot(mp, "08-member-supervisor-budgets-bounce");
      if (landedOn === "/budgets") {
        ok("the 'All company budgets' link the supervisor is shown actually works");
      } else {
        fail(
          "projects-003 dead-end 'All company budgets' link",
          `the project page offers a member-supervisor a link to /budgets; following it lands on ${landedOn}`
        );
      }
    } else {
      note("no /budgets link rendered for the member-supervisor");
    }

    // A member-supervisor must be able to do the thing the hatch is for.
    await mp.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    const supervisorAddedTask = await mp.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /new task/i.test(b.textContent ?? ""))
    );
    if (supervisorAddedTask) ok("the member-supervisor is offered 'New task' in their project");
    else fail("escape hatch add task", "no 'New task' button for the supervising member");

    /* ─ 8. a plain assigned member (NOT the supervisor) ───────────────── */
    section("8. assigned member");
    await db.task.create({
      data: {
        companyId: A.companyId, projectId: p2Id, title: `QA member task ${STAMP}`,
        description: "d", status: "pending", priority: "medium",
        assignedTo: member.id, assignedToName: member.name,
        assignedBy: A.user.id, assignedByName: A.user.name,
        deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000), order: 3,
      },
    });
    const p2Spend = "4242.75";
    await db.transaction.create({
      data: {
        companyId: A.companyId, projectId: p2Id, type: "expense", amount: p2Spend,
        category: `QA cat ${STAMP}`, description: `QA p2 spend ${STAMP}`, date: new Date(),
        addedBy: A.user.id, addedByName: A.user.name,
      },
    });

    await mp.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    const p2Status = await mp.evaluate(() => ({
      is404: /not found|404/i.test(document.body.innerText),
      path: location.pathname,
    }));
    if (!p2Status.is404) ok("a member holding a task in the project can open it");
    else fail("assigned-member visibility", "got a 404 on a project they hold a task in");

    // The KPI must not print the figure...
    const shownSpend = await mp.evaluate(() => {
      const kpis = [...document.querySelectorAll("section p")].map((p) => p.textContent.trim());
      return kpis;
    });
    await shot(mp, "09-member-project-detail");
    if (!shownSpend.some((t) => t.includes("4,242") || t.includes("4242"))) {
      ok("the month-to-date spend figure is not rendered for a non-supervisor member");
    } else {
      fail("member sees project spend on screen", JSON.stringify(shownSpend));
    }

    // ...but projects-006: is it in the serialised RSC payload anyway?
    const detailHtml = await mp.content();
    if (/4242\.75|4242,75|4242/.test(detailHtml)) {
      fail(
        "projects-006 project spend leaks into the page payload",
        `/projects/${p2Id} serialises monthToDateSpendPkr = ${p2Spend} into the RSC/Flight payload for a member who must never see finance figures — the UI only masks it with "—". Visible with View Source.`
      );
    } else {
      ok("the spend figure is absent from the raw page payload too");
    }
    await mp.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
    const listHtml = await mp.content();
    if (/4242\.75|4242/.test(listHtml)) {
      fail(
        "projects-006b project spend leaks into the /projects payload",
        `listProjectsForUser returns monthToDateSpendPkr for every visible project and ProjectsClient receives it as a prop; the card only masks it`
      );
    } else {
      ok("the /projects payload carries no spend figure for a member");
    }

    // The New-task affordance a plain member cannot use (projects-007).
    const memberNewTask = await mp.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /new task/i.test(b.textContent ?? ""))
    );
    await mp.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    const memberNewTaskOnDetail = await mp.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /new task/i.test(b.textContent ?? ""))
    );
    if (memberNewTaskOnDetail) {
      // Prove it is a dead end rather than assuming it.
      await clickButton(mp, "new task");
      await waitForDialog(mp).catch(() => {});
      await mp.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        const title = d?.querySelector("input");
        if (title) {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          set.call(title, "QA member dead end");
          title.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await mp.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
      const denied = await waitForToast(mp, "only the supervisor or a founder");
      await shot(mp, "10-member-new-task-denied");
      if (denied) {
        fail(
          "projects-007 dead-end 'New task' button for a non-supervisor member",
          `/projects/${p2Id} renders 'New task' to any viewer (gated only on status !== archived); addTaskAction then refuses with "Only the supervisor or a founder can add tasks here" after the whole form is filled in`
        );
      } else {
        note("the member's New task submit did not surface the expected denial — inspect the shot");
      }
      await mp.keyboard.press("Escape").catch(() => {});
    } else {
      ok("a non-supervisor member is not offered 'New task' on a project page");
    }
    void memberNewTask;

    /* ─ 9. supervisor reassignment ────────────────────────────────────── */
    section("9. supervisor reassignment");
    // Members must be refused; cofounders allowed.
    await cofounderSess.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    const cofounderCanReassign = await cofounderSess.page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /change supervisor/i.test(b.textContent ?? ""))
    );
    if (cofounderCanReassign) ok("a cofounder is offered 'Change supervisor'");
    else fail("cofounder reassign", "the control is missing for a cofounder");

    await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "change supervisor");
    await waitForDialog(A.page);
    await setField(A.page, '[role="dialog"] select', cofounder.id);
    await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    await waitForToast(A.page, "supervisor changed");
    const afterReassign = await db.project.findFirst({
      where: { id: p1Id, companyId: A.companyId },
      select: { supervisorId: true },
    });
    if (afterReassign?.supervisorId === cofounder.id) ok("reassignment persisted");
    else fail("reassignment persisted", JSON.stringify(afterReassign));

    // projects-008: reopening the modal must show the CURRENT supervisor.
    await A.page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 20000 }).catch(() => {});
    await A.page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      { timeout: 20000 },
      cofounder.name
    ).catch(() => {});
    await clickButton(A.page, "change supervisor");
    await waitForDialog(A.page);
    const preselected = await A.page.evaluate(() => {
      const sel = document.querySelector('[role="dialog"] select');
      return { value: sel.value, text: sel.options[sel.selectedIndex]?.textContent.trim() ?? null };
    });
    await shot(A.page, "11-reassign-reopened");
    if (preselected.value === cofounder.id) {
      ok("reopening the reassign modal preselects the current supervisor");
    } else {
      fail(
        "projects-008 reassign modal reopens with a stale supervisor",
        `project.supervisorId is now ${cofounder.id} (${cofounder.name}) but the reopened dropdown preselects ${preselected.value} ("${preselected.text}") — the modal never unmounts, so useForm's defaultValues are frozen at first mount. Pressing Save reverts the change.`
      );
    }

    // Forge a soft-deleted user as the supervisor (projects-009).
    await A.page.keyboard.press("Escape");
    await waitForDialogClosed(A.page);
    // Deactivate my own invited member through the real team flow, then try.
    await A.page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
    const removed = await A.page.evaluate((mid) => {
      const card = [...document.querySelectorAll("article")].find((a) => a.innerHTML.includes(mid));
      const btn = [...(card?.querySelectorAll("button") ?? [])].find((b) =>
        /remove|deactivate/i.test(b.textContent ?? "") || /remove|deactivate/i.test(b.getAttribute("aria-label") ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, member.id);
    if (removed) {
      await clickButton(A.page, "deactivate|remove|confirm", '[role="dialog"]').catch(() => {});
      await A.page
        .waitForFunction(
          (mid) => !document.body.innerHTML.includes(`deactivate-${mid}`),
          { timeout: 15000 },
          member.id
        )
        .catch(() => {});
    }
    const memberRow = await db.user.findFirst({
      where: { id: member.id, companyId: A.companyId },
      select: { deletedAt: true },
    });
    if (!memberRow?.deletedAt) {
      note("could not deactivate the member through the UI; skipping the tombstoned-supervisor probe");
    } else {
      await A.page.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
      await clickButton(A.page, "change supervisor");
      await waitForDialog(A.page);
      const listsDeleted = await A.page.evaluate(
        (mid) => [...document.querySelectorAll('[role="dialog"] select option')].some((o) => o.value === mid),
        member.id
      );
      if (!listsDeleted) ok("a deactivated teammate is not offered as a supervisor");
      else fail("deactivated user in supervisor picker", "the tombstoned user is selectable");

      await A.page.evaluate((mid) => {
        const sel = document.querySelector('[role="dialog"] select');
        const opt = document.createElement("option");
        opt.value = mid;
        opt.textContent = "forged-tombstone";
        sel.appendChild(opt);
      }, member.id);
      await setField(A.page, '[role="dialog"] select', member.id);
      await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
      await waitForToast(A.page, "supervisor changed|must be a member");
      const p2After = await db.project.findFirst({
        where: { id: p2Id, companyId: A.companyId },
        select: { supervisorId: true },
      });
      if (p2After?.supervisorId === member.id) {
        fail(
          "projects-009 a deactivated user can be made project supervisor",
          `changeSupervisorAction looks the supervisor up with { id, companyId } and no deletedAt: null, so project ${p2Id} is now supervised by a tombstoned user who can never sign in. duplicateProjectAction guards this exact case (lib/actions/projects.ts:312) and createProjectAction/changeSupervisorAction do not.`
        );
      } else {
        ok("a forged tombstoned supervisorId is rejected");
      }
      // Restore so later blocks still have a live supervisor on p2.
      await A.page.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
      await clickButton(A.page, "change supervisor");
      await waitForDialog(A.page).catch(() => {});
      await setField(A.page, '[role="dialog"] select', A.user.id).catch(() => {});
      await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
      await waitForDialogClosed(A.page);
    }

    /* ─ 10. concurrent edit — last write wins, silently ───────────────── */
    section("10. concurrent edit");
    const { ctx: raceCtx, page: racePage } = await newPage(browser);
    contexts.push(raceCtx);
    await signIn(racePage, A.email, PASSWORD);
    await racePage.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    // Tab 1 opens Edit and holds a snapshot.
    await clickButton(racePage, "edit project");
    await waitForDialog(racePage);

    // Tab 2 renames the same project.
    const rename = `QA Renamed By Colleague ${STAMP}`;
    await A.page.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "edit project");
    await waitForDialog(A.page);
    await setField(A.page, '[role="dialog"] input:not([type=date])', rename);
    await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    await waitForToast(A.page, "project updated");
    const renamed = await db.project.findFirst({
      where: { id: p2Id, companyId: A.companyId },
      select: { name: true },
    });
    if (renamed?.name !== rename) fail("setup rename", JSON.stringify(renamed));

    // Tab 1 now saves its stale snapshot — only changing the status.
    await racePage.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const sel = [...d.querySelectorAll("select")][0];
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      set.call(sel, "completed");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await racePage.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    await waitForToast(racePage, "project updated");
    const afterRace = await db.project.findFirst({
      where: { id: p2Id, companyId: A.companyId },
      select: { name: true, status: true },
    });
    await shot(racePage, "12-concurrent-edit");
    if (afterRace?.name === rename) {
      ok("a concurrent status change preserved the colleague's rename");
    } else {
      fail(
        "projects-010 a stale form silently reverts a colleague's edit",
        `colleague renamed the project to "${rename}"; a second admin whose Edit modal was opened BEFORE that save then changed only the status, and updateProjectAction rewrote every column from the stale snapshot — name is now "${afterRace?.name}". There is no version check and no "changed since you opened this" warning.`
      );
    }

    /* ─ 11. a task filed into a completed project vanishes ────────────── */
    section("11. completed project + its tasks");
    // p2 is now status=completed from the race above.
    const p2Now = await db.project.findFirst({
      where: { id: p2Id, companyId: A.companyId },
      select: { status: true },
    });
    if (p2Now?.status === "completed") {
      await A.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
      const pickerHasCompleted = await A.page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => /new task/i.test(b.textContent ?? ""));
        if (btn) btn.click();
        return true;
      });
      if (pickerHasCompleted) {
        await waitForDialog(A.page).catch(() => {});
        const options = await A.page.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          const sels = [...d.querySelectorAll("select")];
          return sels.map((s) => [...s.options].map((o) => o.value));
        });
        const offered = options.some((set) => set.includes(p2Id));
        await A.page.keyboard.press("Escape");
        await waitForDialogClosed(A.page);
        const boardShowsIt = await A.page.evaluate(
          (title) => document.body.innerText.includes(title),
          `QA member task ${STAMP}`
        );
        await shot(A.page, "13-completed-project-tasks");
        if (offered && !boardShowsIt) {
          fail(
            "projects-011 tasks in a 'completed' project are invisible on the board",
            `listProjectOptions (lib/queries/projects.ts:251) only excludes "archived", so a completed project stays in the New-task picker; getTasks (lib/queries/tasks.ts:74) excludes BOTH "completed" and "archived", so anything filed there never appears on /tasks for anyone — including the assignee, whose notification deep-links to /tasks?taskId=<id> and highlights nothing.`
          );
        } else if (!offered) {
          ok("a completed project is kept out of the New-task project picker");
        } else {
          ok("tasks in a completed project are still reachable from the board");
        }
      }
    } else {
      note(`p2 status is ${p2Now?.status}; skipping the completed-project probe`);
    }

    /* ─ 12. archive → unarchive, and the staleness of /tasks ──────────── */
    section("12. archive");
    await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "^archive$|archive");
    const confirmed = await waitForDialog(A.page)
      .then(() => clickButton(A.page, "archive", '[role="dialog"]'))
      .catch(() => false);
    if (!confirmed) note("archive confirm dialog not found; the button may archive directly");
    await waitForToast(A.page, "project archived");
    const archived = await db.project.findFirst({
      where: { id: p1Id, companyId: A.companyId },
      select: { status: true },
    });
    if (archived?.status === "archived") ok("archive persisted");
    else fail("archive persisted", JSON.stringify(archived));

    const archiveActivity = await db.activity.count({
      where: { companyId: A.companyId, projectId: p1Id, type: "project_archived" },
    });
    if (archiveActivity === 1) ok("archiving logged exactly one project_archived activity");
    else fail("archive activity", `expected 1, got ${archiveActivity}`);

    await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    const archivedUi = await A.page.evaluate(() => {
      const btns = [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
      return {
        newTask: btns.some((b) => /new task/i.test(b)),
        restore: btns.some((b) => /restore/i.test(b)),
        edit: btns.some((b) => /edit project/i.test(b)),
      };
    });
    await shot(A.page, "14-archived-detail");
    if (!archivedUi.newTask) ok("an archived project stops offering 'New task'");
    else fail("archived project add-task", "'New task' is still offered");
    if (archivedUi.restore) ok("an archived project offers Restore");
    else fail("archived restore affordance", JSON.stringify(archivedUi));

    // Double-submit on Restore: the button has no submitting state.
    const beforeRestoreActivity = await db.activity.count({
      where: { companyId: A.companyId, projectId: p1Id, type: "project_updated" },
    });
    await A.page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /restore/i.test(b.textContent ?? ""));
      if (btn) {
        btn.click();
        btn.click(); // second click lands before the first round trip returns
      }
    });
    await waitForToast(A.page, "project restored");
    // State predicate on the DB, not a sleep: wait until the status actually
    // flipped, then read the activity delta.
    for (let i = 0; i < 40; i++) {
      const row = await db.project.findFirst({
        where: { id: p1Id, companyId: A.companyId },
        select: { status: true },
      });
      if (row?.status === "active") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const afterRestoreActivity = await db.activity.count({
      where: { companyId: A.companyId, projectId: p1Id, type: "project_updated" },
    });
    const delta = afterRestoreActivity - beforeRestoreActivity;
    if (delta <= 1) {
      ok("a double-clicked Restore produced at most one update");
    } else {
      fail(
        "projects-012 project header actions are not double-submit guarded",
        `two clicks on Restore produced ${delta} project_updated activity rows — handleUnarchive/handleArchive/handleStatusChange keep no submitting state and never disable their button, and updateProjectAction takes no rate-limit gate either`
      );
    }

    /* ─ 13. delete: blocked while non-empty, soft when empty ──────────── */
    section("13. delete");
    await A.page.goto(`${BASE}/projects/${p1Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "^delete$|delete project|delete");
    await waitForDialog(A.page).catch(() => {});
    await clickButton(A.page, "delete", '[role="dialog"]').catch(() => {});
    const blocked = await waitForToast(A.page, "still has|archive it instead");
    const stillThere = await db.project.findFirst({
      where: { id: p1Id, companyId: A.companyId },
      select: { deletedAt: true },
    });
    if (blocked && stillThere && stillThere.deletedAt === null) {
      ok("a project holding tasks + budgets refuses to delete and stays untouched");
    } else {
      fail("delete guard", `toast=${blocked} deletedAt=${stillThere?.deletedAt}`);
    }

    // An EMPTY project must soft-delete, not disappear.
    const emptyId = await createProject(A.page, {
      name: `QA Empty ${STAMP}`,
      supervisorId: A.user.id,
    });
    await A.page.goto(`${BASE}/projects/${emptyId}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "^delete$|delete project|delete");
    await waitForDialog(A.page).catch(() => {});
    await clickButton(A.page, "delete", '[role="dialog"]').catch(() => {});
    await A.page
      .waitForFunction(() => location.pathname === "/projects", { timeout: 20000 })
      .catch(() => {});
    const deleted = await db.project.findFirst({
      where: { id: emptyId, companyId: A.companyId },
      select: { deletedAt: true },
    });
    if (deleted && deleted.deletedAt !== null) {
      ok("delete writes the Tier-3 tombstone rather than erasing the row");
    } else {
      fail("soft delete", `row=${JSON.stringify(deleted)} (null deletedAt means a hard delete)`);
    }
    await A.page.goto(`${BASE}/projects/${emptyId}`, { waitUntil: "networkidle0", timeout: 60000 });
    const gone = await A.page.evaluate(() => /not found|404/i.test(document.body.innerText));
    if (gone) ok("a soft-deleted project 404s on direct URL");
    else fail("soft-deleted project still reachable", A.page.url());

    // projects-013: nothing in the product can bring it back.
    await A.page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
    const recoveryUi = await A.page.evaluate(
      (name) => /deleted|trash|restore deleted/i.test(document.body.innerText) &&
        document.body.innerText.includes(name),
      `QA Empty ${STAMP}`
    );
    if (recoveryUi) {
      ok("a soft-deleted project is listed somewhere it can be restored from");
    } else {
      fail(
        "projects-013 no in-product recovery for a deleted project",
        `/team exposes a "Deactivated" panel with reactivateUserAction, but a soft-deleted project has no equivalent — CLAUDE.md's recovery path is a hand-written SQL UPDATE, and the nightly purge hard-deletes empty soft-deleted projects`
      );
    }

    /* ─ 14. cross-tenant: read, title and write ───────────────────────── */
    section("14. cross-tenant");
    const bProjectName = `QA Tenant B Secret ${STAMP}`;
    const bProjectId = await createProject(B.page, {
      name: bProjectName,
      supervisorId: B.user.id,
    });
    const bBefore = await db.project.findFirst({
      where: { id: bProjectId, companyId: B.companyId },
      select: { name: true, status: true, supervisorId: true, deletedAt: true },
    });

    await A.page.goto(`${BASE}/projects/${bProjectId}`, { waitUntil: "networkidle0", timeout: 60000 });
    const crossRead = await A.page.evaluate(() => ({
      notFound: /not found|404/i.test(document.body.innerText),
      title: document.title,
      body: document.body.innerText.slice(0, 400),
    }));
    await shot(A.page, "15-cross-tenant-404");
    if (crossRead.notFound) ok("another tenant's project id 404s — existence is not leaked in the body");
    else fail("cross-tenant read", crossRead.body);

    // projects-014: generateMetadata does the lookup UNSCOPED.
    if (crossRead.title.includes(bProjectName)) {
      fail(
        "projects-014 another tenant's project name leaks in the page title",
        `GET /projects/${bProjectId} as tenant A returns a not-found body but <title> is "${crossRead.title}" — generateMetadata (app/(app)/projects/[id]/page.tsx:20) calls db.project.findUnique({ where: { id } }) with no companyId, no deletedAt and no auth() at all`
      );
    } else {
      ok(`the 404 page title does not carry the other tenant's project name ("${crossRead.title}")`);
    }

    const bAfter = await db.project.findFirst({
      where: { id: bProjectId, companyId: B.companyId },
      select: { name: true, status: true, supervisorId: true, deletedAt: true },
    });
    if (JSON.stringify(bBefore) === JSON.stringify(bAfter)) {
      ok("nothing tenant A did altered tenant B's project row");
    } else {
      fail("cross-tenant write", `${JSON.stringify(bBefore)} -> ${JSON.stringify(bAfter)}`);
    }

    // A member of tenant A who supervises nothing must not see other projects.
    const memberVisible = await db.project.count({
      where: {
        companyId: A.companyId,
        deletedAt: null,
        OR: [{ supervisorId: member.id }, { tasks: { some: { assignedTo: member.id, deletedAt: null } } }],
      },
    });
    const memberCardCount = await memberSess.page
      .goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 })
      .then(() =>
        memberSess.page.evaluate(() => document.querySelectorAll('a[href^="/projects/"]').length)
      )
      .catch(() => -1);
    note(`member sees ${memberCardCount} project card(s); query-visible set is ${memberVisible}`);

    /* ─ 15. session expiry mid-flow ───────────────────────────────────── */
    section("15. expired session");
    await A.page.goto(`${BASE}/projects/${p2Id}`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickButton(A.page, "edit project");
    await waitForDialog(A.page).catch(() => {});
    // Bump sessionVersion on MY OWN admin row — the documented lever.
    await db.user.update({
      where: { id: A.user.id },
      data: { sessionVersion: { increment: 1 } },
    });
    await setField(A.page, '[role="dialog"] input:not([type=date])', `QA After Expiry ${STAMP}`);
    await A.page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    await A.page
      .waitForFunction(
        () => location.pathname.startsWith("/login") || /not authenticated|couldn/i.test(document.body.innerText),
        { timeout: 25000 }
      )
      .catch(() => {});
    const afterExpiry = await db.project.findFirst({
      where: { id: p2Id, companyId: A.companyId },
      select: { name: true },
    });
    await shot(A.page, "16-expired-session-save");
    if (afterExpiry?.name !== `QA After Expiry ${STAMP}`) {
      ok("a write submitted after the session was invalidated did not land");
    } else {
      fail(
        "expired session still writes",
        "the project was renamed by a request whose sessionVersion no longer matches the user row"
      );
    }
  } catch (e) {
    fail("qa-projects threw", e && e.message ? e.message : String(e));
    console.error(e);
  } finally {
    /* ─ cleanup: my tenants only, children before parents ─────────────── */
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
    await db.$disconnect();
  }

  console.log(`\n${passes} assertion(s) passed`);
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("❌ qa-projects threw:", err);
  process.exit(1);
});
