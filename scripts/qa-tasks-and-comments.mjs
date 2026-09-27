/*
 * ─────────────────────────────────────────────────────────────────────────────
 * QA AGENT 3 — domain: tasks-and-comments   (go-live audit, PHASE 2 runner)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Surface: /tasks (board · list · calendar · filters · bulk ops · drag),
 * components/tasks/**, the task detail modal, comments (lib/actions/comments.ts,
 * components/comments/**) and @mentions (lib/comments/mentions.ts,
 * components/mentions/**).
 *
 * DATA SAFETY — the hardest rule in this audit, and how this file honours it:
 *
 *   • It never touches a pre-existing row. It signs up TWO of its own
 *     workspaces through the real /signup flow (`qa-tasks-<stamp>` and
 *     `qa-tasks-<stamp>-b`) and does everything inside them.
 *   • EVERY database read used as an assertion carries
 *     `where: { companyId: <my tenant> }`. There is not one bare `db.X.count()`
 *     in this file: under concurrency another agent's insert would satisfy a
 *     "did mine land?" check and produce a FALSE PASS, which is the single most
 *     expensive outcome in a pre-launch audit.
 *   • The only non-signup write to a Company row is `plan: "team"` on a tenant
 *     THIS SCRIPT created seconds earlier, and `assertMine()` re-reads the row
 *     and refuses unless its name starts with `qa-`. It is needed because the
 *     free plan caps a workspace at 2 members (lib/actions/team.ts:149) and the
 *     audit asks for admin + cofounder + member + member-as-supervisor.
 *   • Cleanup in `finally` deletes children before parents, scoped to the two
 *     tenant ids. scripts/_qa-guard.mjs sweep is the backstop.
 *   • `localDb()` — never `new PrismaClient()`, which would auto-load the root
 *     .env and point at PRODUCTION Supabase.
 *
 * CONVENTIONS
 *   • `ok()` / `fail()`; `fail` never throws, so one run reports every broken
 *     assertion, prints a literal ❌, and sets process.exitCode = 1.
 *   • `x-real-ip: 10.99.0.3` on every page before its first navigation.
 *     getClientIp() falls back to the literal "unknown" in dev, so without this
 *     all nine agents share ONE limiters.auth bucket of 5/60s and starve each
 *     other into false "cannot sign in" bugs.
 *   • Screenshots to a PER-AGENT directory so evidence is never overwritten.
 *   • State predicates via waitForFunction — never a fixed setTimeout, except
 *     the one pre-hydration settle inside `signIn`, copied verbatim from
 *     scripts/smoke-chat.mjs (FaultsAudit A14).
 *
 * WHAT IT IS TRYING TO PROVE — each block is keyed to a Phase-1 finding id so
 * a failure here promotes that finding from `static`/`derived` to `observed`.
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const DOMAIN = "tasks-and-comments";
const AGENT_IP = "10.99.0.3";
const OUT = `C:/Users/USER/AppData/Local/Temp/ff-qa/${DOMAIN}`;
const STAMP = Date.now().toString().slice(-8);

const PASSWORD = "qa-pass-12345";
const TENANT_A = `qa-tasks-${STAMP}`;
const TENANT_B = `qa-tasks-${STAMP}-b`;

const db = localDb();

let shots = 0;

/* ───────────────────────────── reporting ────────────────────────────────── */

const RESULTS = [];
function ok(label) {
  RESULTS.push(["ok", label]);
  console.log(`  ok  ${label}`);
}
/** Never throws — one run must report EVERY broken assertion. */
function fail(label, detail) {
  RESULTS.push(["FAIL", label]);
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}
function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

async function shot(page, name) {
  shots += 1;
  const file = `${OUT}/${String(shots).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

/* ─────────────────────────── browser plumbing ───────────────────────────── */

function wire(page) {
  page.on("pageerror", (e) => console.error("  PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  CONSOLE.error:", m.text());
  });
}

/**
 * A fresh, isolated browser context + page with the agent IP header set BEFORE
 * its first navigation. Returns { ctx, page } so the caller can close both.
 */
async function newActor(browser, { timezone } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  wire(page);
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  if (timezone) await page.emulateTimezone(timezone).catch(() => {});
  return { ctx, page };
}

/**
 * Retry-until-hydrated sign-in, copied verbatim from scripts/smoke-chat.mjs.
 * On a cold dev server the form paints before React hydrates; a click that
 * lands first performs a NATIVE submit, which (the login form declares no
 * method) becomes a GET with the credentials in the query string and no
 * sign-in at all. FaultsAudit A14.
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

/** React-controlled inputs ignore `.value =`; go through the native setter. */
const SET_VALUE = `(el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  el.focus();
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}`;

/**
 * Sign up a brand-new workspace through the REAL two-step /signup flow.
 * Step 1 = name/email/password behind a type="button" Continue; step 2 =
 * company name + industry + currency behind the real submit. The submit button
 * is disabled until `useHydrated()` flips, so we wait on that rather than on a
 * timer.
 */
async function signUpWorkspace(page, { name, email, companyName }) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
  await page.waitForSelector('input[autocomplete="name"]', { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const btns = [...document.querySelectorAll("button")];
      return btns.some((b) => /continue/i.test(b.textContent ?? ""));
    },
    { timeout: 30000 }
  );

  await page.evaluate(
    (vals, setterSrc) => {
      const setValue = eval(setterSrc);
      setValue(document.querySelector('input[autocomplete="name"]'), vals.name);
      setValue(document.querySelector('input[autocomplete="email"]'), vals.email);
      setValue(document.querySelector('input[autocomplete="new-password"]'), vals.password);
    },
    { name, email, password: PASSWORD },
    SET_VALUE
  );

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /continue/i.test(b.textContent ?? "")
    );
    btn?.click();
  });

  // Step 2 is revealed by un-hiding a wrapper; wait for the submit button to
  // exist AND be enabled (the hydration gate) rather than for a fixed delay.
  await page.waitForFunction(
    () => {
      const b = document.querySelector("button[type=submit]");
      return !!b && !b.disabled;
    },
    { timeout: 30000 }
  );

  await page.evaluate(
    (vals, setterSrc) => {
      const setValue = eval(setterSrc);
      // The company-name field is the only text input inside the step-2 block.
      const inputs = [...document.querySelectorAll("input")];
      const company = inputs.find(
        (i) => i.getAttribute("autocomplete") === null && i.type === "text"
      );
      if (company) setValue(company, vals.companyName);
    },
    { companyName },
    SET_VALUE
  );

  await page.evaluate(() => document.querySelector("form")?.requestSubmit());

  const landed = await page
    .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
    throw new Error(`signup for ${companyName} never reached /dashboard — page said: ${body}`);
  }
}

/* ───────────────────── server-action capture + replay ───────────────────── */
/*
 * A Next.js App Router server action is a POST to the CURRENT path carrying a
 * `Next-Action: <id>` header and a JSON array body. Capturing a real
 * invocation gives us the id; replaying it with a DIFFERENT body is how this
 * script forges input the UI can never produce — omitted fields, wrong types,
 * ids belonging to another tenant. That is the only honest way to test the
 * server's own validation rather than the form's.
 */

function watchActions(page) {
  const seen = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const h = req.headers();
    const id = h["next-action"] || h["Next-Action"];
    if (!id) return;
    seen.push({ id, url: req.url(), body: req.postData() ?? "" });
  });
  return seen;
}

/** The most recent captured action whose serialised body matches `probe`. */
function findAction(seen, probe) {
  for (let i = seen.length - 1; i >= 0; i--) {
    if (seen[i].body.includes(probe)) return seen[i];
  }
  return null;
}

/** Replay a captured action id with arbitrary arguments, from the page's own
 *  origin so the session cookie rides along. */
async function replayAction(page, action, args) {
  return page.evaluate(
    async (url, id, payload) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8" },
          body: payload,
        });
        return { status: res.status, text: (await res.text()).slice(0, 20000) };
      } catch (e) {
        return { status: 0, text: `fetch threw: ${e.message}` };
      }
    },
    action.url,
    action.id,
    JSON.stringify(args)
  );
}

/* ────────────────────────── tenant-scoped helpers ───────────────────────── */

/**
 * The guard rail. Every write this script makes outside the signup flow goes
 * through an id that has passed here first: re-read the Company row and refuse
 * unless it is one of the two `qa-` tenants this run created.
 */
const MINE = new Set();
async function assertMine(companyId) {
  const c = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
  if (!c || !c.name.startsWith("qa-") || !MINE.has(companyId)) {
    throw new Error(
      `REFUSING to touch company ${companyId} ("${c?.name}") — not a tenant this run created`
    );
  }
  return companyId;
}

async function companyIdByName(name) {
  const c = await db.company.findFirst({ where: { name }, select: { id: true } });
  if (!c) throw new Error(`no company named ${name} — did signup fail?`);
  return c.id;
}

/**
 * Invite a teammate through the REAL /team invite flow, then accept the invite
 * through the REAL /invite/[token] page. The token is read back scoped to my
 * own companyId. Returns the new user's row (scoped read).
 */
async function inviteAndAccept(browser, adminPage, companyId, { name, email, role }) {
  await assertMine(companyId);
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  await adminPage.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /invite/i.test(b.textContent ?? "")),
    { timeout: 30000 }
  );
  await adminPage.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /invite (member|teammate|someone)/i.test(b.textContent ?? "")
    );
    btn?.click();
  });
  await adminPage.waitForSelector('[role="dialog"] input', { timeout: 20000 });
  await adminPage.evaluate(
    (vals, setterSrc) => {
      const setValue = eval(setterSrc);
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = [...dialog.querySelectorAll("input")];
      if (inputs[0]) setValue(inputs[0], vals.name);
      if (inputs[1]) setValue(inputs[1], vals.email);
      const sel = dialog.querySelector("select");
      if (sel) setValue(sel, vals.role);
    },
    { name, email, role },
    SET_VALUE
  );
  await adminPage.evaluate(() =>
    document.querySelector('[role="dialog"] form')?.requestSubmit()
  );

  // Wait for the token to land, scoped to MY company.
  const token = await waitFor(
    async () => {
      const row = await db.inviteToken.findFirst({
        where: { companyId, email, usedAt: null },
        orderBy: { createdAt: "desc" },
        select: { token: true },
      });
      return row?.token ?? null;
    },
    20000,
    `invite token for ${email}`
  );

  const { ctx, page } = await newActor(browser);
  await page.goto(`${BASE}/invite/${token}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[type=password]", { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(
    (pw, setterSrc) => {
      const setValue = eval(setterSrc);
      document
        .querySelectorAll("input[type=password]")
        .forEach((el) => setValue(el, pw));
    },
    PASSWORD,
    SET_VALUE
  );
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await page
    .waitForFunction(() => location.pathname.startsWith("/dashboard") || location.pathname.startsWith("/tasks"), {
      timeout: 45000,
    })
    .catch(() => {});
  await page.close();
  await ctx.close();

  const user = await db.user.findFirst({ where: { companyId, email } });
  if (!user) throw new Error(`invite accept for ${email} did not create a user in ${companyId}`);
  return user;
}

/** Poll a predicate until it returns truthy. Never a blind sleep. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Create a project through the real /projects UI. Returns its scoped row. */
async function createProject(page, companyId, name) {
  await assertMine(companyId);
  await page.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) =>
        /new project|create project/i.test(b.textContent ?? "")
      ),
    { timeout: 30000 }
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /new project|create project/i.test(b.textContent ?? "")
    );
    btn?.click();
  });
  await page.waitForSelector('[role="dialog"] input', { timeout: 20000 });
  await page.evaluate(
    (n, setterSrc) => {
      const setValue = eval(setterSrc);
      const dialog = document.querySelector('[role="dialog"]');
      const first = dialog.querySelector("input");
      if (first) setValue(first, n);
    },
    name,
    SET_VALUE
  );
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  return waitFor(
    () => db.project.findFirst({ where: { companyId, name } }),
    25000,
    `project "${name}" in my tenant`
  );
}

/** Create a task through the real /tasks "New task" modal. */
async function createTaskViaUi(page, companyId, { title, projectName, assigneeName, deadline, priority }) {
  await assertMine(companyId);
  await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /new task/i.test(b.textContent ?? "")),
    { timeout: 30000 }
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /new task/i.test(b.textContent ?? "")
    );
    btn?.click();
  });
  await page.waitForSelector('[role="dialog"] input', { timeout: 20000 });
  await page.evaluate(
    (vals, setterSrc) => {
      const setValue = eval(setterSrc);
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = [...dialog.querySelectorAll("input")];
      const title = inputs.find((i) => i.type !== "date");
      if (title) setValue(title, vals.title);
      if (vals.deadline) {
        const d = inputs.find((i) => i.type === "date");
        if (d) setValue(d, vals.deadline);
      }
      const selects = [...dialog.querySelectorAll("select")];
      if (vals.projectName && selects[0]) {
        const opt = [...selects[0].options].find((o) => o.textContent.trim() === vals.projectName);
        if (opt) setValue(selects[0], opt.value);
      }
      if (vals.assigneeName && selects[1]) {
        const opt = [...selects[1].options].find((o) =>
          o.textContent.trim().startsWith(vals.assigneeName)
        );
        if (opt) setValue(selects[1], opt.value);
      }
      if (vals.priority) {
        const btn = [...dialog.querySelectorAll("button")].find(
          (b) => b.textContent.trim().toLowerCase() === vals.priority
        );
        btn?.click();
      }
    },
    { title, projectName, assigneeName, deadline, priority },
    SET_VALUE
  );
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  return waitFor(
    () => db.task.findFirst({ where: { companyId, title } }),
    25000,
    `task "${title}" in my tenant`
  );
}

/** Open a task's comment thread from the board and post `body`. */
async function postComment(page, taskTitle, body) {
  await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout: 30000 },
    taskTitle
  );
  const opened = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
      new RegExp(`^(Open comments|Add a comment).*${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(
        b.getAttribute("aria-label") ?? ""
      )
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, taskTitle);
  if (!opened) return false;
  await page.waitForSelector('[role="dialog"] textarea', { timeout: 20000 });
  const ta = await page.$('[role="dialog"] textarea');
  await ta.click();
  await page.keyboard.type(body);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[role="dialog"] button[type=submit]')].pop();
    btn?.click();
  });
  return page
    .waitForFunction(
      (b) => [...document.querySelectorAll("article")].some((a) => a.innerText.includes(b)),
      { timeout: 20000 },
      body.slice(0, 40)
    )
    .then(() => true)
    .catch(() => false);
}

/* ───────────────────────────────── main ─────────────────────────────────── */

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`== qa: ${DOMAIN} == base=${BASE} ip=${AGENT_IP} out=${OUT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  let companyA = null;
  let companyB = null;

  const emails = {
    adminA: `qa-tasks-${STAMP}-admin@founderflow.test`,
    memberA: `qa-tasks-${STAMP}-member@founderflow.test`,
    cofounderA: `qa-tasks-${STAMP}-cofounder@founderflow.test`,
    supervisorA: `qa-tasks-${STAMP}-super@founderflow.test`,
    adminB: `qa-tasks-${STAMP}-b-admin@founderflow.test`,
  };

  try {
    /* ══ 0. TENANTS ══════════════════════════════════════════════════════ */
    section("0 · own tenants via the real signup flow");

    const admin = await newActor(browser);
    await signUpWorkspace(admin.page, {
      name: "QA Admin",
      email: emails.adminA,
      companyName: TENANT_A,
    });
    companyA = await companyIdByName(TENANT_A);
    MINE.add(companyA);
    ok(`tenant A signed up (${TENANT_A} / ${companyA})`);

    const other = await newActor(browser);
    await signUpWorkspace(other.page, {
      name: "QA Other Admin",
      email: emails.adminB,
      companyName: TENANT_B,
    });
    companyB = await companyIdByName(TENANT_B);
    MINE.add(companyB);
    ok(`tenant B signed up (${TENANT_B} / ${companyB}) — the cross-tenant foil`);

    /* ── TC-009 · FIRST RUN: a brand-new workspace has no project ───────── */
    section("1 · first run (TC-009, TC-010)");
    const projectsAtBirth = await db.project.count({ where: { companyId: companyA } });
    if (projectsAtBirth > 0) {
      ok(`a new workspace is born with ${projectsAtBirth} project(s)`);
    } else {
      fail(
        "TC-009 first-run project",
        "a brand-new workspace has ZERO projects, so the /tasks 'Create task' CTA leads to a form whose project picker reads 'No projects yet' and whose submit fails zod with 'Pick a project'"
      );
    }

    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 30000 });
    await shot(admin.page, "tasks-first-run-empty");
    const firstRun = await admin.page.evaluate(() => {
      const cta = [...document.querySelectorAll("button")].find((b) =>
        /create task|new task/i.test(b.textContent ?? "")
      );
      return { hasCta: !!cta, text: document.body.innerText.slice(0, 500) };
    });
    if (firstRun.hasCta && projectsAtBirth === 0) {
      // Prove the dead end end-to-end: open the modal and read the picker.
      await admin.page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /create task|new task/i.test(b.textContent ?? "")
        );
        btn?.click();
      });
      await admin.page.waitForSelector('[role="dialog"] select', { timeout: 20000 }).catch(() => {});
      const opts = await admin.page.evaluate(() => {
        const sel = document.querySelector('[role="dialog"] select');
        return sel ? [...sel.options].map((o) => o.textContent.trim()) : [];
      });
      await shot(admin.page, "tasks-first-run-no-projects");
      if (opts.length === 0 || opts.some((o) => /no projects yet/i.test(o))) {
        fail(
          "TC-010 first-run CTA dead end",
          `the empty state's 'Create task' button opens a form whose project picker offers ${JSON.stringify(opts)} — the very first thing a paying customer is invited to do cannot succeed`
        );
      } else {
        ok("the first-run Create-task CTA offers a real project");
      }
      await admin.page.keyboard.press("Escape").catch(() => {});
    }

    /* ── plan lift (my tenant only) so the roles the audit asks for fit ── */
    await assertMine(companyA);
    await db.company.update({ where: { id: companyA }, data: { plan: "team" } });
    note("tenant A lifted to plan=team (free caps at 2 members; audit needs 4)");

    /* ── roles, through the real invite flow ───────────────────────────── */
    section("2 · roles via the real invite flow");
    const memberUser = await inviteAndAccept(browser, admin.page, companyA, {
      name: "QA Member",
      email: emails.memberA,
      role: "member",
    });
    ok(`member joined (${memberUser.name}, handle=${memberUser.handle ?? "NULL"})`);

    const cofounderUser = await inviteAndAccept(browser, admin.page, companyA, {
      name: "QA Cofounder",
      email: emails.cofounderA,
      role: "cofounder",
    });
    ok(`cofounder joined (handle=${cofounderUser.handle ?? "NULL"})`);

    const supervisorUser = await inviteAndAccept(browser, admin.page, companyA, {
      name: "QA Supervisor",
      email: emails.supervisorA,
      role: "member",
    });
    ok(`second member joined — will become a project supervisor (escape hatch)`);

    /* ── projects + tasks ──────────────────────────────────────────────── */
    const mainProject = await createProject(admin.page, companyA, `QA Main ${STAMP}`);
    ok(`project created (${mainProject.name})`);
    const superProject = await createProject(admin.page, companyA, `QA Super ${STAMP}`);

    // Make the second member the supervisor of superProject — the documented
    // per-project escape hatch. Scoped to my own project row.
    await assertMine(companyA);
    await db.project.update({
      where: { id: superProject.id },
      data: { supervisorId: supervisorUser.id },
    });
    ok("supervisor escape hatch wired on my own project row");

    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const adminTask = await createTaskViaUi(admin.page, companyA, {
      title: `QA admin task ${STAMP}`,
      projectName: mainProject.name,
      assigneeName: "QA Admin",
      deadline: tomorrow,
      priority: "high",
    });
    ok(`task created and persisted (${adminTask.id})`);

    const memberTask = await createTaskViaUi(admin.page, companyA, {
      title: `QA member task ${STAMP}`,
      projectName: mainProject.name,
      assigneeName: "QA Member",
      deadline: tomorrow,
      priority: "low",
    });
    ok("task assigned to the member");

    // Tenant B gets a task of its own — the forge target.
    const bProject = await createProject(other.page, companyB, `QA B project ${STAMP}`);
    const bTask = await createTaskViaUi(other.page, companyB, {
      title: `QA TENANT-B SECRET ${STAMP}`,
      projectName: bProject.name,
      assigneeName: "QA Other",
      deadline: tomorrow,
    });
    ok("tenant B has a task to forge against");

    /* ══ 3. PERSISTENCE: does the DB agree with the UI? ═══════════════════ */
    section("3 · persistence (TC-012)");
    const dbTasks = await db.task.count({ where: { companyId: companyA, deletedAt: null } });
    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout: 30000 },
      adminTask.title
    );
    // Switch to list view so every row is countable.
    await admin.page.evaluate(() => {
      const tab = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "List"
      );
      tab?.click();
    });
    await admin.page.waitForSelector("tbody tr", { timeout: 20000 }).catch(() => {});
    const rendered = await admin.page.$$eval("tbody tr", (rows) => rows.length);
    if (rendered === dbTasks) ok(`the list renders all ${rendered} of my tenant's live tasks`);
    else fail("TC-012 list/DB agreement", `DB has ${dbTasks} live tasks, list rendered ${rendered}`);
    note(
      `getTasks() has no take: every one of the ${dbTasks} rows crossed the wire. ` +
        "At 2k+ tasks this is the whole table in one RSC payload, three times per session (/tasks, /dashboard, /team)."
    );
    await shot(admin.page, "tasks-list-view");

    /* ══ 4. @MENTIONS — the handle namespace (TC-001, TC-002, TC-003) ════ */
    section("4 · @mentions (TC-001 handle drop, TC-002 composer, TC-003 deep link)");

    const memberHandle = memberUser.handle;
    if (!memberHandle) {
      fail("TC-001 precondition", "the invited member has a NULL handle — mentions cannot be tested");
    } else {
      note(`member handle="${memberHandle}", name="${memberUser.name}" (name slug would be "qa-member")`);

      /* TC-002 — what does the composer OFFER? The hook's own contract says
       * the second line of each row is "a promise about what accepting the row
       * will type", and mentionToken() prefers the handle. */
      await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
      await admin.page.waitForFunction(
        (t) => document.body.innerText.includes(t),
        { timeout: 30000 },
        adminTask.title
      );
      await admin.page.evaluate((t) => {
        const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
          (b.getAttribute("aria-label") ?? "").includes(t)
        );
        btn?.click();
      }, adminTask.title);
      await admin.page.waitForSelector('[role="dialog"] textarea', { timeout: 20000 });
      const composer = await admin.page.$('[role="dialog"] textarea');
      await composer.click();
      await admin.page.keyboard.type("@qa");
      const listbox = await admin.page
        .waitForSelector('[role="listbox"]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const offered = listbox
        ? await admin.page.$$eval('[role="listbox"] [role="option"]', (li) =>
            li.map((x) => x.innerText.replace(/\s+/g, " ").trim())
          )
        : [];
      await shot(admin.page, "mention-autocomplete");
      if (offered.some((row) => row.includes(`@${memberHandle}`))) {
        ok("the mention autocomplete offers the teammate's real handle");
      } else {
        fail(
          "TC-002 composer offers the wrong token",
          `listbox rows are ${JSON.stringify(offered)} — none promises "@${memberHandle}". ` +
            "lib/queries/users.ts toClient() never returns `handle` and every page maps the roster to {id,name}, " +
            "so the composer can only ever offer (and insert) a name slug."
        );
      }

      /* TC-001 — type the HANDLE, as Settings tells users to, and see whether
       * the ping actually fires. */
      await admin.page.evaluate(
        (setterSrc) => {
          const setValue = eval(setterSrc);
          setValue(document.querySelector('[role="dialog"] textarea'), "");
        },
        SET_VALUE
      );
      const mentionBody = `handle ping ${STAMP} @${memberHandle} please look`;
      await composer.click();
      await admin.page.keyboard.type(mentionBody);
      await admin.page.evaluate(() => {
        const btn = [...document.querySelectorAll('[role="dialog"] button[type=submit]')].pop();
        btn?.click();
      });
      const posted = await admin.page
        .waitForFunction(
          (b) => [...document.querySelectorAll("article")].some((a) => a.innerText.includes(b)),
          { timeout: 20000 },
          `handle ping ${STAMP}`
        )
        .then(() => true)
        .catch(() => false);
      if (posted) ok("comment with an @handle posted and rendered");
      else fail("comment post", "the mention comment never rendered in the thread");
      await shot(admin.page, "mention-chip-rendered");

      // (a) does the THREAD claim the mention resolved?
      const chip = await admin.page.evaluate(
        (name) =>
          [...document.querySelectorAll("article span[title]")].some(
            (s) => s.title === `Mentioned ${name}`
          ),
        memberUser.name
      );
      // (b) did a notification actually reach them? — scoped to MY tenant.
      const pings = await db.notification.count({
        where: {
          companyId: companyA,
          userId: memberUser.id,
          title: { contains: "mentioned you" },
        },
      });
      const storedMentions = await db.comment
        .findFirst({
          where: { companyId: companyA, body: { contains: `handle ping ${STAMP}` } },
          select: { mentions: true, id: true },
        })
        .catch(() => null);

      if (chip && pings === 1) {
        ok("@handle resolved consistently: chip rendered AND the teammate was notified");
      } else if (chip && pings === 0) {
        fail(
          "TC-001 SILENT MENTION LOSS",
          `the thread renders a "Mentioned ${memberUser.name}" chip and Comment.mentions is ${storedMentions?.mentions}, ` +
            `but Notification rows for that user in my tenant = ${pings}. ` +
            "lib/actions/comments.ts:91-94 selects the roster as {id,name} with NO `handle`, so extractMentions() " +
            "cannot resolve a handle; lib/queries/comments.ts:46 DOES select handle, so the render path can. " +
            "The writer is told the ping landed. It never does."
        );
      } else {
        fail(
          "TC-001 mention resolution",
          `chip=${chip} notifications=${pings} — write path and render path disagree`
        );
      }

      /* TC-003 — the mention notification's own deep link. */
      const notif = await db.notification.findFirst({
        where: { companyId: companyA, userId: memberUser.id },
        orderBy: { createdAt: "desc" },
        select: { link: true, title: true },
      });
      if (notif?.link) {
        note(`newest member notification link = ${notif.link}`);
        if (notif.link.includes("comment=")) {
          const m = await newActor(browser);
          await signIn(m.page, emails.memberA, PASSWORD);
          await m.page.goto(`${BASE}${notif.link}`, { waitUntil: "networkidle0", timeout: 60000 });
          await m.page.waitForFunction(() => document.body.innerText.length > 50, { timeout: 20000 });
          const openedThread = await m.page.evaluate(
            () => !!document.querySelector('[role="dialog"] article, [role="dialog"] textarea')
          );
          await shot(m.page, "mention-deep-link");
          if (openedThread) ok("the ?comment= deep link opens the thread it names");
          else
            fail(
              "TC-003 dead mention deep link",
              `createCommentAction writes link="${notif.link}", but nothing in the app reads a "comment" search param ` +
                "(tasks-client.tsx:139 reads only ?taskId=). Clicking 'X mentioned you' lands on a bare /tasks board — " +
                "no thread, no scroll, no highlight. For a member the task may not even be on their board."
            );
          await m.page.close();
          await m.ctx.close();
        }
      }
    }

    /* ══ 5. FORGED INPUT — server-side validation (TC-004, TC-005, TC-013) ═ */
    section("5 · forged server-action input (TC-004 target leak, TC-005 XOR, TC-013 cross-tenant)");

    // Capture a real listCommentsAction invocation to learn its action id.
    const seen = watchActions(admin.page);
    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout: 30000 },
      adminTask.title
    );
    await admin.page.evaluate((t) => {
      const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
        (b.getAttribute("aria-label") ?? "").includes(t)
      );
      btn?.click();
    }, adminTask.title);
    await admin.page.waitForSelector('[role="dialog"] textarea', { timeout: 20000 });
    await admin.page.waitForFunction(() => true);
    const listAction = findAction(seen, adminTask.id);

    if (!listAction) {
      note("could not capture listCommentsAction's id — skipping the forged-target probes");
    } else {
      // A distinctive comment on a DIFFERENT target, so a leak is unmistakable.
      const otherBody = `SENTINEL-OTHER-TARGET-${STAMP}`;
      await postComment(admin.page, memberTask.title, otherBody);

      /* TC-004 — omit the discriminator entirely. listCommentsForTarget does
       * `if ("taskId" in target) … else where.transactionId = target.transactionId`.
       * With `{}` that assigns `undefined`, and Prisma DROPS an undefined
       * filter — so the query degrades to `{ companyId }` and returns EVERY
       * comment in the workspace, task and finance alike, uncapped. */
      const leak = await replayAction(admin.page, listAction, [{}]);
      if (leak.text.includes(otherBody) || leak.text.includes(`handle ping ${STAMP}`)) {
        fail(
          "TC-004 unscoped comment read",
          `listCommentsAction({}) returned comments from other targets (found "${otherBody}" in the response). ` +
            "lib/queries/comments.ts:31-32 writes `where.transactionId = undefined`, which Prisma treats as " +
            "'no filter', so the whole company's Comment table comes back — including finance threads a member " +
            "is blocked from ever seeing, and with no `take` cap."
        );
      } else if (leak.status >= 400) {
        ok(`listCommentsAction({}) is rejected (HTTP ${leak.status})`);
      } else {
        ok("listCommentsAction({}) returns nothing it shouldn't");
      }

      /* TC-013 — forge tenant B's task id. */
      const forged = await replayAction(admin.page, listAction, [{ taskId: bTask.id }]);
      if (forged.text.includes("TENANT-B SECRET")) {
        fail(
          "TC-013 CROSS-TENANT COMMENT LEAK",
          `tenant A read a comment target belonging to ${TENANT_B}`
        );
      } else {
        ok("a forged cross-tenant taskId returns nothing (companyId scoping holds)");
      }
    }

    // createCommentAction forging: XOR + cross-tenant write.
    const createSeen = watchActions(admin.page);
    await postComment(admin.page, adminTask.title, `xor probe seed ${STAMP}`);
    const createAction = findAction(createSeen, "xor probe seed");
    if (!createAction) {
      note("could not capture createCommentAction's id — skipping the XOR/forge write probes");
    } else {
      const both = await replayAction(admin.page, createAction, [
        { body: `both targets ${STAMP}`, taskId: adminTask.id, transactionId: "forged" },
      ]);
      const bothLanded = await db.comment.count({
        where: { companyId: companyA, body: { contains: `both targets ${STAMP}` } },
      });
      if (bothLanded === 0) ok("a comment naming BOTH taskId and transactionId is refused (XOR holds)");
      else fail("TC-005 comment XOR", `a both-targets comment persisted (${bothLanded} row)`);

      const neither = await replayAction(admin.page, createAction, [
        { body: `no target ${STAMP}` },
      ]);
      const neitherLanded = await db.comment.count({
        where: { companyId: companyA, body: { contains: `no target ${STAMP}` } },
      });
      if (neitherLanded === 0) ok("a comment naming NEITHER target is refused (XOR holds)");
      else fail("TC-005 comment XOR", `a targetless comment persisted (${neitherLanded} row)`);

      const wrongType = await replayAction(admin.page, createAction, [
        { body: 12345, taskId: adminTask.id },
      ]);
      const wrongLanded = await db.comment.count({
        where: { companyId: companyA, taskId: adminTask.id, body: "12345" },
      });
      if (wrongLanded === 0) ok("a non-string comment body is refused by zod");
      else fail("input typing", "a numeric body was coerced and stored");

      const forgeWrite = await replayAction(admin.page, createAction, [
        { body: `cross tenant write ${STAMP}`, taskId: bTask.id },
      ]);
      const forgeLanded = await db.comment.count({
        where: { companyId: companyB, body: { contains: `cross tenant write ${STAMP}` } },
      });
      if (forgeLanded === 0)
        ok("a comment forged onto another tenant's task is refused ('Target not found')");
      else fail("TC-013 cross-tenant comment write", `${forgeLanded} row landed in ${TENANT_B}`);
      note(`forged-write response head: ${forgeWrite.text.slice(0, 120)}`);
    }

    /* ══ 6. DELETE SEMANTICS (TC-006) ════════════════════════════════════ */
    section("6 · delete semantics (TC-006 hard delete, TC-014 badge)");

    const doomed = await createTaskViaUi(admin.page, companyA, {
      title: `QA doomed task ${STAMP}`,
      projectName: mainProject.name,
      assigneeName: "QA Admin",
      deadline: tomorrow,
    });
    await postComment(admin.page, doomed.title, `doomed comment one ${STAMP}`);
    await postComment(admin.page, doomed.title, `doomed comment two ${STAMP}`);
    const commentsBefore = await db.comment.count({
      where: { companyId: companyA, taskId: doomed.id },
    });
    note(`doomed task carries ${commentsBefore} comment(s) before the delete`);

    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout: 30000 },
      doomed.title
    );
    await admin.page.evaluate((t) => {
      const btn = [...document.querySelectorAll("button[aria-label]")].find(
        (b) => (b.getAttribute("aria-label") ?? "") === `Delete task ${t}`
      );
      btn?.click();
    }, doomed.title);
    // The confirm dialog is a real component, not window.confirm.
    await admin.page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent.trim().toLowerCase() === "delete"
        ),
      { timeout: 20000 }
    );
    await shot(admin.page, "delete-confirm");
    await admin.page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")]
        .reverse()
        .find((b) => b.textContent.trim().toLowerCase() === "delete");
      btn?.click();
    });
    await waitFor(
      async () =>
        (await db.task.count({ where: { companyId: companyA, id: doomed.id, deletedAt: null } })) === 0,
      25000,
      "the doomed task to leave the live set"
    );

    const rowStillThere = await db.task.findFirst({
      where: { companyId: companyA, id: doomed.id },
      select: { deletedAt: true },
    });
    const commentsAfter = await db.comment.count({
      where: { companyId: companyA, taskId: doomed.id },
    });
    if (rowStillThere && rowStillThere.deletedAt) {
      ok("deleting a task writes the Tier-3 tombstone (recoverable, as CLAUDE.md documents)");
    } else {
      fail(
        "TC-006 UNRECOVERABLE TASK DELETE",
        `the Task row is GONE (hard delete via tx.task.delete, lib/actions/tasks.ts:395) although Task.deletedAt exists ` +
          `(schema.prisma:341) and CLAUDE.md publishes a one-UPDATE recovery runbook for it. Its ${commentsBefore} comment(s) ` +
          `cascaded away too (now ${commentsAfter}). Projects and transactions in the same product ARE soft-deleted ` +
          "(lib/actions/projects.ts:666). Nothing can restore this."
      );
    }

    /* TC-014 — the badge count after a comment DELETE. */
    const badgeTask = await createTaskViaUi(admin.page, companyA, {
      title: `QA badge task ${STAMP}`,
      projectName: mainProject.name,
      assigneeName: "QA Admin",
      deadline: tomorrow,
    });
    await postComment(admin.page, badgeTask.title, `badge comment ${STAMP}`);
    const badgeAfterPost = await admin.page.evaluate((t) => {
      const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
        (b.getAttribute("aria-label") ?? "").includes(t)
      );
      return btn ? btn.innerText.replace(/\s+/g, "") : null;
    }, badgeTask.title);
    note(`comment badge after posting one comment: ${badgeAfterPost}`);
    // Delete it from inside the open thread and watch the badge.
    await admin.page.evaluate(() => {
      const btn = [...document.querySelectorAll('[role="dialog"] button[aria-label^="Delete comment"]')][0];
      btn?.click();
    });
    await admin.page
      .waitForFunction(
        () =>
          [...document.querySelectorAll("button")].some(
            (b) => b.textContent.trim().toLowerCase() === "delete"
          ),
        { timeout: 10000 }
      )
      .catch(() => {});
    await admin.page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")]
        .reverse()
        .find((b) => b.textContent.trim().toLowerCase() === "delete");
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 0));
    const badgeBlip = await admin.page
      .waitForFunction(
        (t) => {
          const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
            (b.getAttribute("aria-label") ?? "").includes(t)
          );
          return btn && /\b2\b/.test(btn.getAttribute("aria-label") ?? "");
        },
        { timeout: 3000 },
        badgeTask.title
      )
      .then(() => true)
      .catch(() => false);
    if (badgeBlip) {
      fail(
        "TC-014 comment badge counts up on delete",
        "the /tasks onChanged handler does `commentCount + 1` unconditionally (tasks-client.tsx:1007-1011), " +
          "so DELETING a comment briefly shows one MORE comment than exist before the RSC refresh corrects it"
      );
    } else {
      ok("the comment badge does not count upward when a comment is deleted");
    }

    /* ══ 7. ROLES (TC-007, TC-008, TC-011) ═══════════════════════════════ */
    section("7 · roles: member, cofounder, supervisor");

    const member = await newActor(browser);
    await signIn(member.page, emails.memberA, PASSWORD);

    /* TC-007 — the clock widget's task picker versus the board's member rule. */
    await member.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await member.page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 30000 });
    const memberBoard = await member.page.evaluate(() => document.body.innerText);
    if (memberBoard.includes(adminTask.title)) {
      fail("member board scoping", "a member can see a task assigned to someone else on /tasks");
    } else {
      ok("the board hides another person's task from a member (getTasks assignedTo filter holds)");
    }

    await member.page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Clock in"]');
      btn?.click();
    });
    await member.page.waitForSelector('[role="dialog"] select', { timeout: 20000 }).catch(() => {});
    const clockOptions = await member.page.evaluate(() => {
      const sel = document.querySelector('[role="dialog"] select');
      return sel ? [...sel.options].map((o) => o.textContent.trim()) : [];
    });
    await shot(member.page, "member-clock-widget-tasks");
    if (clockOptions.includes(adminTask.title)) {
      fail(
        "TC-007 MEMBER TASK-TITLE LEAK",
        `the topbar clock-in dialog offers "${adminTask.title}" — a task assigned to someone else, which /tasks ` +
          "deliberately hides from this member. lib/actions/time.ts:51-59 queries `{ companyId, status: { not: 'completed' } }` " +
          "with take:100 and NO `assignedTo` filter and NO `deletedAt: null` filter. Options seen: " +
          JSON.stringify(clockOptions)
      );
    } else {
      ok("the clock-in task picker respects the member's task visibility");
    }
    await member.page.keyboard.press("Escape").catch(() => {});

    /* TC-008 — the member's New-task CTA is offered but the server refuses. */
    await member.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    const memberHasCta = await member.page.evaluate(() =>
      [...document.querySelectorAll("button")].some((b) => /new task/i.test(b.textContent ?? ""))
    );
    if (memberHasCta) {
      const before = await db.task.count({ where: { companyId: companyA } });
      await createTaskViaUi(member.page, companyA, {
        title: `QA member-created ${STAMP}`,
        projectName: mainProject.name,
        assigneeName: "QA Member",
        deadline: tomorrow,
      }).catch(() => null);
      const after = await db.task.count({ where: { companyId: companyA } });
      const toastText = await member.page.evaluate(() => document.body.innerText);
      await shot(member.page, "member-new-task-refused");
      if (after === before) {
        fail(
          "TC-008 member CTA dead end",
          "/tasks shows a plain member the 'New task' button and a full form, but addTaskAction gates on " +
            "canManageProject (lib/actions/tasks.ts:155), so the submit is refused after every field is filled. " +
            (/supervisor or a founder/i.test(toastText) ? "Toast confirms: 'Only the supervisor or a founder can add tasks here'." : "")
        );
      } else {
        ok("a member can create a task in a project they hold work in");
      }
    } else {
      ok("the New-task CTA is hidden from a plain member");
    }

    /* TC-011 — the board hands a cofounder controls the server will refuse. */
    const cofounder = await newActor(browser);
    await signIn(cofounder.page, emails.cofounderA, PASSWORD);
    await cofounder.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await cofounder.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout: 30000 },
      adminTask.title
    );
    const coStatusBefore = (
      await db.task.findFirst({ where: { companyId: companyA, id: adminTask.id }, select: { status: true } })
    )?.status;
    const selDisabled = await cofounder.page.evaluate(
      (id) => {
        const sel = document.querySelector(`#board-status-${CSS.escape(id)}`);
        return sel ? sel.disabled : null;
      },
      adminTask.id
    );
    await cofounder.page.evaluate(
      (id, setterSrc) => {
        const setValue = eval(setterSrc);
        const sel = document.querySelector(`#board-status-${CSS.escape(id)}`);
        if (sel) setValue(sel, "completed");
      },
      adminTask.id,
      SET_VALUE
    );
    await new Promise((r) => setTimeout(r, 0));
    const coApplied = await cofounder.page
      .waitForFunction(
        () => document.body.innerText.toLowerCase().includes("not authorized"),
        { timeout: 6000 }
      )
      .then(() => true)
      .catch(() => false);
    const coStatusAfter = (
      await db.task.findFirst({ where: { companyId: companyA, id: adminTask.id }, select: { status: true } })
    )?.status;
    await shot(cofounder.page, "cofounder-status-refused");
    if (coStatusBefore === coStatusAfter && selDisabled !== true) {
      fail(
        "TC-011 cofounder gets a control the server refuses",
        `the board renders an ENABLED status dropdown (disabled=${selDisabled}) and a drag handle on every card, ` +
          "but updateTaskStatusAction only allows assignee / creator / admin (lib/actions/tasks.ts:269-273) — a " +
          `cofounder is not in that set. Status stayed "${coStatusAfter}"; "Not authorized" toast seen: ${coApplied}. ` +
          "CLAUDE.md: 'Permission gates exist in two layers… Both must agree.'"
      );
    } else if (coStatusBefore !== coStatusAfter) {
      ok("a cofounder can move any task on the board");
    } else {
      ok("the board disables the status control a cofounder cannot use");
    }

    /* ══ 8. FILTERS + DEEP LINK (TC-015, TC-016) ═════════════════════════ */
    section("8 · filters and the ?taskId= deep link");

    /* TC-015 — "No deadline" can never match: Task.deadline is non-nullable. */
    const undated = await db.task.count({
      where: { companyId: companyA, deletedAt: null, deadline: undefined },
    });
    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForSelector("select", { timeout: 20000 });
    const dueOffersNone = await admin.page.evaluate(() =>
      [...document.querySelectorAll("select")].some((s) =>
        [...s.options].some((o) => /no deadline/i.test(o.textContent ?? ""))
      )
    );
    if (dueOffersNone) {
      fail(
        "TC-015 a filter that can never match",
        "the Due filter offers 'No deadline', but Task.deadline is non-nullable in the schema and required by " +
          "NewTaskSchema, so tasks-client.tsx:338 `!t.deadline` is always false. Choosing it always shows " +
          "'No tasks match this filter' — a control that can only ever lie about an empty result."
      );
    } else {
      ok("the Due filter does not offer an option that can never match");
    }

    /* TC-016 — a notification deep link versus a persisted filter. */
    await admin.page.evaluate(() => {
      try {
        localStorage.setItem("ff.tasks.priority", "urgent");
        localStorage.setItem("ff.tasks.view", "board");
      } catch {}
    });
    await admin.page.goto(`${BASE}/tasks?taskId=${memberTask.id}`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    await admin.page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 20000 });
    const deepLinkVisible = await admin.page.evaluate(
      (t) => document.body.innerText.includes(t),
      memberTask.title
    );
    await shot(admin.page, "deeplink-vs-saved-filter");
    if (deepLinkVisible) {
      ok("a ?taskId= deep link shows its task even with a saved filter on");
    } else {
      fail(
        "TC-016 deep link swallowed by a saved filter",
        `the task-assigned notification link /tasks?taskId=${memberTask.id} lands on a board whose localStorage ` +
          "filter (priority=urgent) excludes the task. tasks-client.tsx:169-189 highlights but never clears or " +
          "widens the filter, so the user sees 'No tasks match this filter' and concludes the link is broken."
      );
    }
    await admin.page.evaluate(() => {
      try {
        localStorage.removeItem("ff.tasks.priority");
      } catch {}
    });

    /* ══ 9. DEADLINE TIMEZONE (TC-017) ═══════════════════════════════════ */
    section("9 · deadline day, west of Greenwich (TC-017)");
    const west = await newActor(browser, { timezone: "America/New_York" });
    await signIn(west.page, emails.adminA, PASSWORD);
    await west.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await west.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout: 30000 },
      memberTask.title
    );
    const shownDate = await west.page.evaluate((t) => {
      const h = [...document.querySelectorAll("h4")].find((x) => x.textContent.trim() === t);
      const card = h?.closest("div");
      return card ? card.innerText.replace(/\s+/g, " ") : null;
    }, memberTask.title);
    const storedDay = (
      await db.task.findFirst({
        where: { companyId: companyA, id: memberTask.id },
        select: { deadline: true },
      })
    ).deadline
      .toISOString()
      .slice(0, 10);
    await shot(west.page, "deadline-timezone-card");
    note(`stored deadline (UTC day) = ${storedDay}; card in America/New_York reads: ${shownDate}`);
    const storedDayNum = Number(storedDay.slice(8, 10));
    const cardMatches = shownDate && new RegExp(`\\b0?${storedDayNum}\\b`).test(shownDate);
    if (cardMatches) {
      ok("the card shows the same calendar day the assigner picked");
    } else {
      fail(
        "TC-017 deadline day shifts west of Greenwich",
        `task-form.tsx:103 stores an <input type=date> as UTC midnight, but every client surface formats it in the ` +
          `VIEWER's zone (tasks-client.tsx:1457, task-detail-modal.tsx:183, lib/tasks/calendar.ts:73). The ` +
          `assignment email formats it from UTC parts (lib/actions/tasks.ts:80), so the email and the card disagree ` +
          `by a day for every customer west of UTC. Stored ${storedDay}, card read: ${shownDate}`
      );
    }

    // And the matching validation edge: can a viewer west of UTC file a task
    // due TODAY? NewTaskSchema compares UTC midnight against LOCAL midnight.
    const localToday = await west.page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    const dueTodayTitle = `QA due-today ${STAMP}`;
    await createTaskViaUi(west.page, companyA, {
      title: dueTodayTitle,
      projectName: mainProject.name,
      assigneeName: "QA Admin",
      deadline: localToday,
    }).catch(() => null);
    const dueTodayLanded = await db.task.count({
      where: { companyId: companyA, title: dueTodayTitle },
    });
    if (dueTodayLanded === 1) {
      ok("a task due today can be created from a timezone west of UTC");
    } else {
      fail(
        "TC-018 cannot file a task due today west of UTC",
        "NewTaskSchema (lib/schemas/task.ts:22-26) compares the UTC-midnight deadline against the SERVER's " +
          "local start-of-today. The date input's own `min` allows today, so the form offers a date the " +
          "server then rejects with 'Deadline can't be in the past'."
      );
    }
    await west.page.close();
    await west.ctx.close();

    /* ══ 10. BULK OPS + THE 100-ROW CANARY (TC-019, TC-020) ══════════════ */
    section("10 · bulk operations");

    // A task the admin neither created nor is assigned: created BY the
    // supervisor inside their own project, assigned to the supervisor.
    const superActor = await newActor(browser);
    await signIn(superActor.page, emails.supervisorA, PASSWORD);
    const supTask = await createTaskViaUi(superActor.page, companyA, {
      title: `QA supervisor task ${STAMP}`,
      projectName: superProject.name,
      assigneeName: "QA Supervisor",
      deadline: tomorrow,
    }).catch(() => null);
    if (supTask) ok("the per-project supervisor escape hatch lets a member file a task");
    else
      fail(
        "supervisor escape hatch",
        "a member who supervises a project could not create a task in it — canManageProject should allow this"
      );
    await superActor.page.close();
    await superActor.ctx.close();

    // Admin bulk-deletes a selection that includes a task they did not create.
    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.evaluate(() => {
      const tab = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "List"
      );
      tab?.click();
    });
    await admin.page.waitForSelector("#select-all-tasks", { timeout: 20000 });
    await admin.page.evaluate(() => document.querySelector("#select-all-tasks")?.click());
    const selectedCount = await admin.page.evaluate(() => {
      const m = document.body.innerText.match(/(\d+)\s+selected/);
      return m ? Number(m[1]) : 0;
    });
    await shot(admin.page, "bulk-selection");
    if (selectedCount > 0) ok(`select-all picked ${selectedCount} task(s)`);
    else fail("bulk select-all", "select-all produced no selection");

    const liveBefore = await db.task.count({ where: { companyId: companyA, deletedAt: null } });
    await admin.page.evaluate(
      (setterSrc) => {
        const setValue = eval(setterSrc);
        const sel = document.querySelector("#bulk-status");
        if (sel) setValue(sel, "in_progress");
      },
      SET_VALUE
    );
    const bulkToast = await admin.page
      .waitForFunction(() => /moved \d+ task/i.test(document.body.innerText), { timeout: 15000 })
      .then(() => admin.page.evaluate(() => document.body.innerText.match(/Moved [^\n]*/)?.[0]))
      .catch(() => null);
    const nowInProgress = await db.task.count({
      where: { companyId: companyA, deletedAt: null, status: "in_progress" },
    });
    note(`bulk toast: ${bulkToast}`);
    if (bulkToast && /skipped/.test(bulkToast)) {
      ok(`bulk update reports skipped rows honestly: "${bulkToast}"`);
    } else if (nowInProgress === liveBefore) {
      note("every selected task was the admin's to move — no skip path exercised");
    }
    // Whatever the toast said, the DB must agree with it.
    const claimed = bulkToast ? Number(bulkToast.match(/Moved (\d+)/)?.[1] ?? -1) : -1;
    if (claimed >= 0 && claimed !== nowInProgress) {
      fail(
        "TC-019 bulk count disagrees with the database",
        `toast claimed ${claimed} moved, my tenant now has ${nowInProgress} in_progress tasks`
      );
    } else if (claimed >= 0) {
      ok("the bulk-update count matches the database");
    }

    /* TC-020 — the 200-id cap versus an uncapped board. */
    if (selectedCount > 200) {
      fail(
        "TC-020 select-all can exceed the bulk cap",
        `${selectedCount} tasks were selected, but BulkTaskStatusSchema caps ids at 200 (lib/schemas/task.ts:39), ` +
          "so the action returns zod's raw 'Array must contain at most 200 element(s)'. getTasks() has no `take`, " +
          "so any workspace past 200 tasks hits this on its first select-all."
      );
    } else {
      note(
        `select-all produced ${selectedCount} ids (cap is 200). getTasks() is uncapped, so a real workspace ` +
          "reaches this ceiling; a 201-task select-all surfaces a raw zod message."
      );
    }

    /* ══ 11. DOUBLE SUBMIT / REFRESH / BACK-FORWARD ══════════════════════ */
    section("11 · double submit, refresh, back/forward");

    const dupBody = `double submit ${STAMP}`;
    await admin.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      { timeout: 30000 },
      adminTask.title
    );
    await admin.page.evaluate((t) => {
      const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
        (b.getAttribute("aria-label") ?? "").includes(t)
      );
      btn?.click();
    }, adminTask.title);
    await admin.page.waitForSelector('[role="dialog"] textarea', { timeout: 20000 });
    const ta2 = await admin.page.$('[role="dialog"] textarea');
    await ta2.click();
    await admin.page.keyboard.type(dupBody);
    // Fire the submit twice in the same tick — the composer disables on
    // `submitting`, but only after React commits.
    await admin.page.evaluate(() => {
      const form = document.querySelector('[role="dialog"] form');
      form?.requestSubmit();
      form?.requestSubmit();
    });
    await waitFor(
      async () =>
        (await db.comment.count({
          where: { companyId: companyA, body: { contains: dupBody } },
        })) > 0,
      20000,
      "the double-submitted comment"
    );
    const dupes = await db.comment.count({
      where: { companyId: companyA, body: { contains: dupBody } },
    });
    if (dupes === 1) ok("a double-submitted comment lands exactly once");
    else fail("double submit", `${dupes} identical comments persisted from one double submit`);

    // Refresh mid-flow: the thread must come back.
    await admin.page.reload({ waitUntil: "networkidle0", timeout: 60000 });
    await admin.page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 20000 });
    const afterReload = await admin.page.evaluate(() => location.pathname);
    if (afterReload === "/tasks") ok("a refresh on /tasks stays on /tasks");
    else fail("refresh", `landed on ${afterReload}`);

    /* ══ 12. EXPIRED SESSION ═════════════════════════════════════════════ */
    section("12 · expired session");
    const ghost = await newActor(browser);
    await signIn(ghost.page, emails.memberA, PASSWORD);
    await ghost.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    // Bump the member's own sessionVersion — my tenant, my row.
    await assertMine(companyA);
    await db.user.update({
      where: { id: memberUser.id },
      data: { sessionVersion: { increment: 1 } },
    });
    await ghost.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    const ghostPath = await ghost.page.evaluate(() => location.pathname);
    if (ghostPath.startsWith("/login")) {
      ok("a bumped sessionVersion kills the live tab's session on the next request");
    } else {
      fail(
        "session invalidation",
        `after a sessionVersion bump the member's tab is still on ${ghostPath}`
      );
    }
    await ghost.page.close();
    await ghost.ctx.close();

    await admin.page.close();
    await admin.ctx.close();
    await member.page.close();
    await member.ctx.close();
    await cofounder.page.close();
    await cofounder.ctx.close();
    await other.page.close();
    await other.ctx.close();
  } catch (err) {
    fail("script threw", err.message);
    console.error(err);
  } finally {
    /* ══ CLEANUP — children before parents, scoped to MY tenants only ════ */
    for (const companyId of [companyA, companyB]) {
      if (!companyId) continue;
      try {
        await assertMine(companyId);
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
        await db.company.update({ where: { id: companyId }, data: { ownerId: null } }).catch(() => {});
        await db.user.deleteMany({ where: { companyId } });
        await db.company.delete({ where: { id: companyId } });
        console.log(`  ..  swept tenant ${companyId}`);
      } catch (e) {
        console.error(`  cleanup failed for ${companyId}: ${e.message}`);
      }
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  const failures = RESULTS.filter((r) => r[0] === "FAIL").length;
  console.log(`\n== ${DOMAIN}: ${RESULTS.length - failures} ok, ${failures} failed ==`);
  console.log(process.exitCode ? "== FAIL ==" : "== pass ==");
}

main().catch((err) => {
  console.error("qa script threw:", err);
  process.exit(1);
});
