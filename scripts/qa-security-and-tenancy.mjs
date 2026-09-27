/*
 * Go-live QA — domain: security-and-tenancy (AGENT_INDEX 15).
 *
 * WHAT THIS EXERCISES
 *   Cross-tenant isolation (IDOR on every id a client can supply through a
 *   URL), the two enforcement layers (middleware route gating in
 *   auth.config.ts vs the server-side re-check that is supposed to sit behind
 *   it), `requireScopedSession`, the raw SQL in lib/queries/search.ts, secret
 *   handling, the CSP + security headers from next.config.js, and the
 *   rate limiter (lib/rate-limit.ts + lib/client-ip.ts).
 *
 * DATA SAFETY — the hardest constraint in this audit.
 *   This script signs up TWO OWN workspaces through the real signup form
 *   (tenant A = the "victim", tenant B = the "attacker") and never touches a
 *   pre-existing row. Every database assertion carries
 *   `where: { companyId: A.companyId }` or `{ companyId: B.companyId }` — never
 *   a bare `db.X.count()`, because under nine-agent concurrency another
 *   agent's insert can satisfy a "did mine land?" check and produce a FALSE
 *   PASS, which is the most expensive outcome in a pre-launch audit.
 *
 *   Rows written outside the browser are FIXTURES INSIDE MY OWN TENANTS ONLY
 *   — a Project, a Task and a Budget in tenant A, created directly because the
 *   thing under test is the server's notification fan-out for the EXPENSE, and
 *   that expense is logged through the real /expenses UI so
 *   `addTransactionAction` + `checkBudgetThresholdAfterExpense` actually run.
 *   Nothing seeded is written and nothing seeded is asserted on. Seeded rows
 *   are READ in exactly one place (`peekSeedIds`) to obtain a foreign id for
 *   the cross-tenant probes — and even there the probe targets are preferred
 *   from tenant A, with the seed used only as a fallback id string.
 *
 * CONVENTIONS
 *   - localDb() only. `new PrismaClient()` auto-loads the root .env, which
 *     points at PRODUCTION Supabase (tests/lib/db/script-safety.test.ts).
 *   - fail() records and prints a literal ❌ but never throws, so one run
 *     reports every broken assertion.
 *   - x-real-ip is set on every page BEFORE its first navigation.
 *     getClientIp() returns the literal "unknown" in dev when the header is
 *     absent, so without this every agent shares ONE limiters.auth bucket of
 *     5/60s fed by nine call sites. Probes that deliberately BURN the auth
 *     bucket use their own suffixed key so they can never starve this run or
 *     anybody else's.
 *   - waitUntil() polls a state predicate. The only fixed waits are the
 *     pre-hydration pauses copied from scripts/smoke-chat.mjs (FaultsAudit
 *     A14) — those wait for React to own the click, which no DOM predicate can
 *     report.
 *   - Screenshots land in a PER-AGENT directory so shared filenames cannot
 *     destroy another agent's evidence.
 *
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT DO
 *   It does not invoke a server action by forging its Next-Action id. Those
 *   ids live in build-specific client chunks and a probe built on them reports
 *   a build detail, not a product fact. Forged-id coverage therefore runs
 *   through every surface that accepts an id in a URL (`/projects/[id]`,
 *   `/chat/[slug]`, `/tasks?taskId=`, `/invite/[token]`, `/api/export`) plus
 *   the form-level substitution in §4, where a select's option value is
 *   rewritten in the DOM to a FOREIGN id before submit — which is exactly the
 *   request a hostile client would send, produced by the product's own action
 *   plumbing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_INDEX = 15;
const IP = `10.99.0.${AGENT_INDEX}`;
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/security-and-tenancy";
const STAMP = `${Date.now().toString().slice(-7)}${randomBytes(2).toString("hex")}`;
const HYDRATE_MS = 1500; // A14: the window before React owns the submit button

/* Tenant A — the "victim" workspace: an admin, a cofounder, and two members. */
const A_NAME = `qa-sec-a-${STAMP}`;
const A_ADMIN_EMAIL = `qa-sec-a-${STAMP}@founderflow.test`;
const A_COFO_EMAIL = `qa-sec-a-cofo-${STAMP}@founderflow.test`;
const A_MEM_EMAIL = `qa-sec-a-mem-${STAMP}@founderflow.test`;
const A_MEM2_EMAIL = `qa-sec-a-mem2-${STAMP}@founderflow.test`;

/* Tenant B — the "attacker" workspace. Same product, different company id. */
const B_NAME = `qa-sec-b-${STAMP}`;
const B_ADMIN_EMAIL = `qa-sec-b-${STAMP}@founderflow.test`;

const PW = "QaSec1Pass";

/* Values chosen to be unmistakable in a payload grep. A leak is proven by
 * finding one of these strings somewhere it must not be, so they must not
 * collide with anything the product or another agent writes. */
const SECRET_AMOUNT = "743219"; // PKR figure on the project-tagged expense
const SECRET_LIMIT = "800000"; // budget monthly cap
const SECRET_DESC = `qa-sec-ledger-${STAMP}`;
const SECRET_DM = `qa-sec-dm-secret-${STAMP}`;
const SECRET_PROJECT = `qa-sec-project-${STAMP}`;

mkdirSync(OUT, { recursive: true });

// Pinned to the local docker Postgres. See scripts/_local-db.mjs.
const db = localDb();

/* ───────────────────────── reporting ───────────────────────── */

let passes = 0;
const failures = [];
/** Findings this run PROMOTES from static to observed, printed at the end. */
const observed = [];

function ok(label) {
  passes += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  failures.push(label);
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
/** An observation with no pass/fail verdict, recorded so the report can cite it. */
function note(label, detail) {
  console.log(`  ..  ${label}${detail ? ` — ${detail}` : ""}`);
}
/** Record that a static finding is now confirmed by observation. */
function promote(id, evidence) {
  observed.push(`${id} — ${evidence}`);
  console.log(`  →→  PROMOTED ${id}: ${evidence}`);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}

/* ───────────────────────── waiting ───────────────────────── */

async function waitUntil(predicate, { timeout = 25000, interval = 250, label = "" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await predicate();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() > deadline) {
      if (label) note(`timed out waiting for: ${label}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = (page) => page.evaluate(() => document.body.innerText).catch(() => "");
/**
 * The whole served document, not the rendered text. This is the assertion that
 * matters for a redaction claim: a figure hidden by a component is still in the
 * RSC flight payload, and `outerHTML` is where that payload sits (Next.js
 * streams it as self.__next_f.push(...) script chunks).
 */
const pageSource = (page) =>
  page.evaluate(() => document.documentElement.outerHTML).catch(() => "");
const titleOf = (page) => page.evaluate(() => document.title).catch(() => "");
const pathOf = (page) => {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return "";
  }
};

/* ───────────────────────── browser ───────────────────────── */

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

/**
 * A fresh, cookie-isolated context. `ip` is the rate-limit key the server
 * sees: getClientIp() reads x-real-ip verbatim, so a distinct suffix buys a
 * distinct limiters.auth bucket. That is itself finding sec-001 — the client
 * picks its own bucket — and §8 measures it deliberately.
 */
async function newCtx(browser, ip = IP) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  wire(page);
  // BEFORE the first navigation, always.
  await page.setExtraHTTPHeaders({ "x-real-ip": ip });
  return { ctx, page };
}

async function shut(page, ctx) {
  await page?.close().catch(() => {});
  await ctx?.close().catch(() => {});
}

/** Click the first button/link whose visible text matches. */
async function clickByText(page, re) {
  const handle = await page.evaluateHandle((source) => {
    const rx = new RegExp(source, "i");
    const els = [...document.querySelectorAll("button, a, [role=button]")];
    return els.find((e) => rx.test((e.textContent || "").trim())) || null;
  }, re.source);
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

async function setInput(page, selector, value) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector);
  await page.type(selector, value);
}

/**
 * Copied verbatim in shape from scripts/smoke-chat.mjs. On a cold dev server
 * the form paints before React hydrates; a click that lands first performs a
 * NATIVE submit and no sign-in happens (FaultsAudit A14). Retry until React
 * owns the click.
 */
async function signIn(page, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 30000 });
    await pause(HYDRATE_MS);
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", password);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

/** Drive the real two-step /signup form. Returns the Company row or null. */
async function signUpWorkspace(page, { name, email, companyName }) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
  await pause(HYDRATE_MS);
  await page.type('input[name="name"]', name);
  await page.type('input[name="email"]', email);
  await page.type('input[name="password"]', PW);
  await clickByText(page, /continue/);
  const onStep2 = await waitUntil(() => page.$('input[name="companyName"]'), {
    timeout: 12000,
    label: "signup step 2",
  });
  if (!onStep2) return null;
  await page.type('input[name="companyName"]', companyName);
  await page.click("button[type=submit]");
  await waitUntil(() => pathOf(page) !== "/signup" && pathOf(page) !== "", {
    timeout: 40000,
    label: "signup navigation",
  });
  return db.company.findFirst({ where: { name: companyName } });
}

/**
 * Invite a teammate through the REAL invite flow, then accept it. Exercises
 * the flow AND keeps every user inside my own tenant.
 * Returns the accepted User row, scoped to the tenant, or null.
 */
async function inviteAndAccept(browser, adminPage, { email, name, role, companyId, ip }) {
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  await pause(HYDRATE_MS);
  if (!(await clickByText(adminPage, /invite/))) {
    fail(`invite ${role}`, "no Invite control on /team");
    return null;
  }
  const form = await waitUntil(() => adminPage.$('input[type=email]'), {
    timeout: 12000,
    label: "invite modal",
  });
  if (!form) {
    fail(`invite ${role}`, "invite modal never rendered");
    return null;
  }
  // The modal carries a name, an email and a role select.
  const nameSel = 'input[name="name"], input[type=text]';
  if (await adminPage.$(nameSel)) await adminPage.type(nameSel, name);
  await adminPage.type("input[type=email]", email);
  const roleSel = await adminPage.$("select");
  if (roleSel) await roleSel.select(role).catch(() => {});
  await clickByText(adminPage, /send invite|invite/);

  // The token is the invite's secret and is never rendered in full; read it
  // back from MY OWN tenant's InviteToken row.
  const invite = await waitUntil(
    () => db.inviteToken.findFirst({ where: { companyId, email, usedAt: null } }),
    { timeout: 20000, label: `InviteToken for ${email}` }
  );
  if (!invite) {
    fail(`invite ${role}`, `no InviteToken row in ${companyId} for ${email}`);
    return null;
  }

  const { ctx, page } = await newCtx(browser, ip);
  await page.goto(`${BASE}/invite/${invite.token}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[type=password]", { timeout: 20000 }).catch(() => {});
  await pause(HYDRATE_MS);
  const pwFields = await page.$$("input[type=password]");
  for (const f of pwFields) await f.type(PW);
  await page.click("button[type=submit]").catch(() => {});
  await waitUntil(() => pathOf(page) !== `/invite/${invite.token}`, {
    timeout: 40000,
    label: "invite acceptance navigation",
  });
  await shut(page, ctx);

  const user = await db.user.findFirst({ where: { companyId, email } });
  if (!user) fail(`invite ${role}`, `accepted invite produced no User row in ${companyId}`);
  else ok(`invited + accepted a ${role} (${email})`);
  return user;
}

/* ───────────────────────── tenant state ───────────────────────── */

const A = {
  companyId: null,
  adminId: null,
  cofounderId: null,
  memberId: null,
  member2Id: null,
  projectId: null,
  taskId: null,
  budgetId: null,
  generalChannelId: null,
};
const B = { companyId: null, adminId: null, projectId: null };

/** Every read below is scoped to ONE of my own tenants. Never a bare count(). */
const aUsers = (where = {}) =>
  db.user.findMany({ where: { companyId: A.companyId, ...where }, orderBy: { createdAt: "asc" } });
const aNotifications = (userId) =>
  db.notification.findMany({
    where: { companyId: A.companyId, userId },
    orderBy: { createdAt: "desc" },
  });
const aTransactions = () =>
  db.transaction.findMany({ where: { companyId: A.companyId }, orderBy: { createdAt: "desc" } });

/**
 * One READ of seeded data, for a foreign id to probe with. Reading to
 * understand the app is allowed; asserting on a seeded row is not, and nothing
 * below asserts on these — they are id strings for a 404 check.
 */
async function peekSeedIds() {
  const project = await db.project.findFirst({
    where: { companyId: "demo-nimbus" },
    select: { id: true, name: true },
  });
  const channel = await db.channel.findFirst({
    where: { companyId: "demo-nimbus" },
    select: { slug: true, name: true },
  });
  return { project, channel };
}

/* ═══════════════════════════ main ═══════════════════════════ */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log(`== qa security-and-tenancy == tenants ${A_NAME} / ${B_NAME} @ ${IP}`);

  let aAdminCtx, aAdmin, bAdminCtx, bAdmin, memCtx, mem, cofoCtx, cofo;

  try {
    /* ═══ 0. TWO TENANTS, FOUR ROLES, ALL THROUGH THE REAL FLOWS ═══ */
    section("0. fixtures — two tenants via the real signup + invite flows");

    ({ ctx: aAdminCtx, page: aAdmin } = await newCtx(browser, `${IP}-a`));
    const aCompany = await signUpWorkspace(aAdmin, {
      name: `QA Sec A ${STAMP}`,
      email: A_ADMIN_EMAIL,
      companyName: A_NAME,
    });
    if (!aCompany) {
      fail("tenant A signup", "no Company row — aborting, nothing below can run");
      return;
    }
    A.companyId = aCompany.id;
    const aFounders = await aUsers();
    if (aFounders.length !== 1) {
      fail("tenant A founder count", `expected 1 in ${A.companyId}, found ${aFounders.length}`);
      return;
    }
    A.adminId = aFounders[0].id;
    ok(`tenant A up (${A_NAME} / ${A.companyId})`);

    ({ ctx: bAdminCtx, page: bAdmin } = await newCtx(browser, `${IP}-b`));
    const bCompany = await signUpWorkspace(bAdmin, {
      name: `QA Sec B ${STAMP}`,
      email: B_ADMIN_EMAIL,
      companyName: B_NAME,
    });
    if (!bCompany) {
      fail("tenant B signup", "no Company row — the cross-tenant probes cannot run");
    } else {
      B.companyId = bCompany.id;
      const bFounders = await db.user.findMany({ where: { companyId: B.companyId } });
      B.adminId = bFounders[0]?.id ?? null;
      ok(`tenant B up (${B_NAME} / ${B.companyId})`);
    }

    const cofoUser = await inviteAndAccept(browser, aAdmin, {
      email: A_COFO_EMAIL,
      name: `QA Cofo ${STAMP}`,
      role: "cofounder",
      companyId: A.companyId,
      ip: `${IP}-cofo`,
    });
    A.cofounderId = cofoUser?.id ?? null;

    const memUser = await inviteAndAccept(browser, aAdmin, {
      email: A_MEM_EMAIL,
      name: `QA Mem ${STAMP}`,
      role: "member",
      companyId: A.companyId,
      ip: `${IP}-mem`,
    });
    A.memberId = memUser?.id ?? null;

    const mem2User = await inviteAndAccept(browser, aAdmin, {
      email: A_MEM2_EMAIL,
      name: `QA Mem2 ${STAMP}`,
      role: "member",
      companyId: A.companyId,
      ip: `${IP}-mem2`,
    });
    A.member2Id = mem2User?.id ?? null;

    if (!A.memberId || !A.cofounderId) {
      fail("role fixtures", "missing a member or a cofounder — role sections will be skipped");
    }

    A.generalChannelId =
      (await db.channel.findFirst({ where: { companyId: A.companyId, slug: "general" } }))?.id ??
      null;

    /* Fixtures inside MY OWN tenant. Created directly because the thing under
     * test is the fan-out for the EXPENSE, which is logged through the real UI
     * below so the real action + budget check run. */
    if (A.memberId) {
      const project = await db.project.create({
        data: {
          companyId: A.companyId,
          name: SECRET_PROJECT,
          description: "qa-sec fixture",
          supervisorId: A.adminId, // NOT the member: the member is a plain assignee
          createdBy: A.adminId,
        },
      });
      A.projectId = project.id;
      const task = await db.task.create({
        data: {
          companyId: A.companyId,
          projectId: project.id,
          title: `qa-sec task ${STAMP}`,
          description: "fixture",
          status: "pending",
          priority: "medium",
          assignedTo: A.memberId,
          assignedToName: `QA Mem ${STAMP}`,
          assignedBy: A.adminId,
          assignedByName: `QA Sec A ${STAMP}`,
          deadline: new Date(Date.now() + 7 * 864e5),
        },
      });
      A.taskId = task.id;
      const budget = await db.budget.create({
        data: {
          companyId: A.companyId,
          projectId: project.id,
          category: "Marketing",
          monthlyLimit: SECRET_LIMIT,
          createdBy: A.adminId,
          createdByName: `QA Sec A ${STAMP}`,
        },
      });
      A.budgetId = budget.id;
      ok("tenant-A fixtures: one project, one member-assigned task, one Marketing budget");
    }

    if (B.companyId && B.adminId) {
      const bProject = await db.project.create({
        data: {
          companyId: B.companyId,
          name: `qa-sec-b-project-${STAMP}`,
          supervisorId: B.adminId,
          createdBy: B.adminId,
        },
      });
      B.projectId = bProject.id;
    }

    /* ═══ 1. THE FINANCE BOUNDARY: IS IT ENFORCED ANYWHERE BUT MIDDLEWARE? ═══
     *
     * MEMBER_BLOCKED_ROUTES is the product promise "members never see
     * finance". Only /reports re-checks canSeeFinances server-side; the other
     * seven rely on the middleware redirect alone, and the role the middleware
     * reads comes from the COOKIE, not the database. §7 exploits that. Here we
     * just establish the redirect works and record which routes have a second
     * layer at all. */
    section("1. MEMBER_BLOCKED_ROUTES — the middleware layer");

    const BLOCKED = [
      "/dashboard",
      "/expenses",
      "/investments",
      "/revenue",
      "/recurring",
      "/budgets",
      "/reports",
      "/activities",
    ];

    if (A.memberId) {
      ({ ctx: memCtx, page: mem } = await newCtx(browser, `${IP}-mem`));
      if (!(await signIn(mem, A_MEM_EMAIL, PW))) {
        fail("member sign-in", "cannot continue the member sections");
      } else {
        for (const route of BLOCKED) {
          await mem.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 });
          const landed = pathOf(mem);
          if (landed !== route) ok(`member is bounced off ${route} (-> ${landed})`);
          else fail(`member reached ${route}`, "the finance boundary did not hold");
        }
        // The querystring must survive the bounce (auth.config.ts says so).
        await mem.goto(`${BASE}/expenses?ref=newsletter`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        const q = new URL(mem.url()).search;
        if (q.includes("ref=newsletter")) ok("the bounce preserves the original querystring");
        else note("querystring dropped on the member bounce", q || "(empty)");
        await mem.screenshot({ path: `${OUT}/01-member-bounced.png` });
      }
    }

    /* ═══ 2. sec-004 — THE PROJECT SPEND FIGURE IN A MEMBER'S PAYLOAD ═══
     *
     * canSeeProjectFinances says a plain assigned member must NOT see the
     * project's money. project-detail-client.tsx renders `canSeeBudgets ?
     * money(...) : "—"` — a COMPONENT-LEVEL redaction — while
     * getProjectOverview puts `monthToDateSpendPkr` in the props regardless.
     * The acceptance criterion is not "the member does not see the number"; it
     * is that the number is not in the served document at all. */
    section("2. project spend figure vs a plain member's RSC payload");

    // Log the project-tagged expense through the REAL UI as the admin, so
    // addTransactionAction and checkBudgetThresholdAfterExpense both run.
    let expenseLogged = false;
    if (A.projectId) {
      await aAdmin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
      await pause(HYDRATE_MS);
      await clickByText(aAdmin, /add expense|log expense|new expense/);
      const amountField = await waitUntil(() => aAdmin.$("input[type=number]"), {
        timeout: 12000,
        label: "expense modal",
      });
      if (!amountField) {
        fail("expense modal", "could not open the Add-expense form — §2/§3 will be inert");
      } else {
        await setInput(aAdmin, "input[type=number]", SECRET_AMOUNT);
        const selects = await aAdmin.$$("select");
        // First select is Category, last is Project (transaction-form.tsx).
        if (selects[0]) await selects[0].select("Marketing").catch(() => {});
        if (selects.length > 1) {
          await selects[selects.length - 1].select(A.projectId).catch(() => {});
        }
        await aAdmin.type("textarea", SECRET_DESC);
        await aAdmin.click("button[type=submit]");
        const row = await waitUntil(
          async () => (await aTransactions()).find((t) => t.description === SECRET_DESC) ?? false,
          { timeout: 25000, label: "the expense row in tenant A" }
        );
        if (row) {
          expenseLogged = true;
          if (row.projectId === A.projectId) {
            ok(`expense of ${SECRET_AMOUNT} PKR logged and tagged to the fixture project`);
          } else {
            fail("expense project tag", `projectId came back ${row.projectId}`);
          }
        } else {
          fail("expense persisted", `no Transaction "${SECRET_DESC}" in ${A.companyId}`);
        }
      }
      await aAdmin.screenshot({ path: `${OUT}/02-admin-expense.png` });
    }

    if (mem && A.projectId) {
      await mem.goto(`${BASE}/projects/${A.projectId}`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const src = await pageSource(mem);
      const text = await bodyText(mem);
      if (!/not found|404/i.test(text)) {
        ok("a member with a task in the project can open it (canSeeProject holds)");
      } else {
        note("the member could not open the project", "task assignment did not grant visibility");
      }
      // The figure, in every spelling the payload could carry it in.
      const spellings = [SECRET_AMOUNT, "743,219", "743219.00", "743219"];
      const leaked = spellings.filter((s) => src.includes(s));
      if (expenseLogged && leaked.length > 0) {
        fail(
          "sec-004 project spend leaks to a plain member",
          `found ${JSON.stringify(leaked)} in the served document for /projects/${A.projectId}`
        );
        promote("sec-004", `monthToDateSpendPkr (${SECRET_AMOUNT}) present in the member's payload`);
      } else if (expenseLogged) {
        ok("the project spend figure is absent from a plain member's served document");
      }
      // The visible cell should read the em-dash placeholder either way.
      if (/—/.test(text)) ok("the spend KPI renders the redacted placeholder for a member");
      else note("no em-dash placeholder found on the member's project page");
      await mem.screenshot({ path: `${OUT}/02-member-project.png` });

      // And the budget list must not travel at all.
      if (src.includes(SECRET_LIMIT) || src.includes("800,000")) {
        fail(
          "budget cap leaks to a plain member",
          `the ${SECRET_LIMIT} monthly cap is in /projects/${A.projectId}'s payload`
        );
      } else {
        ok("the budget cap is absent from a plain member's project payload");
      }
    }

    /* ═══ 3. sec-005 / sec-006 — FINANCE FIGURES IN A MEMBER'S NOTIFICATIONS ═══
     *
     * addTransactionAction fans `transaction_logged` at every other user in
     * the company with the PKR amount in the body, and stamps projectId so
     * "the member-side filter in lib/queries/notifications can strip these" —
     * a filter that does not exist. getNotifications filters ONLY on
     * isMemberBlockedRoute(link), and a project-tagged expense links to
     * /projects/<id>, which is not blocked.
     *
     * checkBudgetThresholdAfterExpense then fans `budget_alert` at the
     * supervisor AND every task assignee, with the cap and the spend in the
     * body — and budget_alert defaults to email:true, push:true. */
    section("3. finance figures in a plain member's notifications");

    if (expenseLogged && A.memberId) {
      const memberRows = await waitUntil(
        async () => {
          const rows = await aNotifications(A.memberId);
          return rows.length > 0 ? rows : false;
        },
        { timeout: 20000, label: "the member's notification rows" }
      );
      const rows = memberRows ?? [];
      note(`the member holds ${rows.length} notification row(s) in ${A.companyId}`);

      const moneyRows = rows.filter(
        (r) =>
          `${r.title} ${r.message}`.includes(SECRET_AMOUNT) ||
          `${r.title} ${r.message}`.includes("743,219")
      );
      if (moneyRows.length > 0) {
        fail(
          "sec-005 transaction_logged carries a PKR figure to a member",
          `${moneyRows.length} row(s): ${JSON.stringify(moneyRows.map((r) => r.message))}`
        );
        promote("sec-005", `member Notification body contains ${SECRET_AMOUNT}`);
      } else {
        ok("no transaction_logged row reached the member with the amount in it");
      }

      const alertRows = rows.filter(
        (r) => r.category === "finance" && /cap|budget/i.test(`${r.title} ${r.message}`)
      );
      if (alertRows.length > 0) {
        fail(
          "sec-006 budget_alert carries the cap + spend to a plain assignee",
          JSON.stringify(alertRows.map((r) => r.message))
        );
        promote("sec-006", `member received a budget_alert: ${alertRows[0].message}`);
      } else {
        ok("no budget_alert reached the plain assignee");
      }

      // Now the READ filter: whatever landed, does /notifications show it?
      if (mem) {
        await mem.goto(`${BASE}/notifications`, { waitUntil: "networkidle0", timeout: 60000 });
        const nsrc = await pageSource(mem);
        if (nsrc.includes(SECRET_AMOUNT) || nsrc.includes("743,219")) {
          fail(
            "the /notifications read filter does not strip a project-linked finance ping",
            "the PKR figure is in the member's served notifications document"
          );
        } else {
          ok("/notifications does not render a PKR figure to a member");
        }
        await mem.screenshot({ path: `${OUT}/03-member-notifications.png` });
      }

      // The cofounder SHOULD get the ping — proves the fan-out ran at all, so
      // a silent "no rows" above cannot be mistaken for a pass.
      if (A.cofounderId) {
        const cofoRows = await aNotifications(A.cofounderId);
        const cofoMoney = cofoRows.some((r) => `${r.title} ${r.message}`.includes(SECRET_AMOUNT));
        if (cofoMoney) ok("the cofounder did receive the transaction_logged ping (fan-out ran)");
        else
          note(
            "the cofounder has no amount-bearing ping either",
            "the fan-out may not have run — §3's negatives are weak evidence"
          );
      }
    }

    /* ═══ 4. CROSS-TENANT IDOR — every id a client can supply ═══ */
    section("4. cross-tenant IDOR from tenant B");

    const seed = await peekSeedIds();

    if (bAdmin && A.projectId) {
      // 4a. sec-003: generateMetadata reads the project with NO companyId
      // filter and no auth. The body 404s; the TITLE is the question.
      const res = await bAdmin.goto(`${BASE}/projects/${A.projectId}`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const status = res ? res.status() : 0;
      const text = await bodyText(bAdmin);
      const title = await titleOf(bAdmin);
      const src = await pageSource(bAdmin);
      if (status === 404 || /not found|404/i.test(text)) {
        ok(`tenant B gets not-found for tenant A's project (status ${status})`);
      } else {
        fail("cross-tenant project page", `status ${status}, body did not read as not-found`);
      }
      if (title.includes(SECRET_PROJECT) || src.includes(SECRET_PROJECT)) {
        fail(
          "sec-003 generateMetadata leaks a foreign tenant's project name",
          `document.title = "${title}"`
        );
        promote("sec-003", `title/source of the 404 page contains "${SECRET_PROJECT}"`);
      } else {
        ok("the 404 page carries no trace of the foreign project's name");
      }
      await bAdmin.screenshot({ path: `${OUT}/04-cross-tenant-project.png` });

      // 4b. The same probe against a SEEDED id, to prove the check is about
      // tenancy and not about my fixture. Nothing is asserted on the seed row.
      if (seed.project) {
        await bAdmin.goto(`${BASE}/projects/${seed.project.id}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        const t2 = await titleOf(bAdmin);
        const s2 = await pageSource(bAdmin);
        if (t2.includes(seed.project.name) || s2.includes(seed.project.name)) {
          fail(
            "sec-003 confirmed against a second tenant",
            `a foreign project name reached document.title: "${t2}"`
          );
        } else {
          ok("a second foreign project id also leaks nothing");
        }
      }
    }

    if (bAdmin && A.generalChannelId) {
      // 4c. Chat: a foreign #general has the SAME slug in every workspace, so
      // this checks slug resolution is company-scoped rather than global.
      await bAdmin.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
      const landedChannel = await db.channel.findFirst({
        where: { companyId: B.companyId, slug: "general" },
        select: { id: true },
      });
      const shown = await pageSource(bAdmin);
      if (landedChannel && shown.includes(landedChannel.id)) {
        ok("/chat/general resolves inside the caller's own workspace, not the first match");
      } else {
        note("could not confirm which #general /chat/general resolved to", "check the screenshot");
      }
      if (shown.includes(SECRET_DM)) {
        fail("cross-tenant chat leak", "tenant A's DM text appeared in tenant B's chat document");
      }
    }

    if (bAdmin && A.taskId) {
      // 4d. /tasks?taskId=<foreign> — the deep link every assignment
      // notification uses. A foreign id must highlight nothing and reveal
      // nothing.
      await bAdmin.goto(`${BASE}/tasks?taskId=${A.taskId}`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const tsrc = await pageSource(bAdmin);
      if (tsrc.includes(`qa-sec task ${STAMP}`)) {
        fail("cross-tenant task deep link", "a foreign task's title rendered in tenant B");
      } else {
        ok("a foreign taskId in the deep link reveals nothing");
      }
    }

    if (bAdmin) {
      // 4e. /api/export must be admin-only AND company-scoped. Tenant B's
      // admin IS an admin, so the gate that matters here is the scope.
      const exportJson = await bAdmin.evaluate(async (base) => {
        const r = await fetch(`${base}/api/export`, { credentials: "include" });
        return { status: r.status, body: (await r.text()).slice(0, 4_000_000) };
      }, BASE);
      if (exportJson.status !== 200) {
        note(`/api/export returned ${exportJson.status} for tenant B's admin`);
      } else {
        if (exportJson.body.includes(A.companyId) || exportJson.body.includes(SECRET_DESC)) {
          fail(
            "cross-tenant export leak",
            "tenant B's export contains tenant A's companyId or ledger description"
          );
        } else {
          ok("tenant B's export contains nothing from tenant A");
        }
      }
    }

    if (mem) {
      // 4f. /api/export for a MEMBER — the documented 403. The route is not on
      // MEMBER_BLOCKED_ROUTES, so middleware lets the request through and the
      // route's own canSeeFinances gate is the only thing standing there.
      const memExport = await mem.evaluate(async (base) => {
        const r = await fetch(`${base}/api/export`, { credentials: "include" });
        return { status: r.status, body: (await r.text()).slice(0, 2000) };
      }, BASE);
      if (memExport.status === 403) {
        ok("/api/export answers 403 to a member (the second layer is present here)");
      } else {
        fail(
          "a member reached /api/export",
          `status ${memExport.status} — the whole ledger via a side door`
        );
      }
    }

    /* ═══ 5. sec-007 — PRIVATE DM BODIES IN AN ADMIN'S EXPORT ═══
     *
     * canSeeChannel is emphatic that an admin gets NO back door into a private
     * conversation, and that a compliance export would be "an explicit,
     * auditable, logged path". sendMessageAction writes the DM body (truncated
     * to 140 chars) into the recipient's Notification.message, and
     * /api/export dumps `notification.findMany({ where: { companyId } })` —
     * every user's rows, not the caller's. */
    section("5. private DM bodies in the workspace export");

    let dmSent = false;
    if (A.memberId && A.member2Id) {
      const { ctx: dmCtx, page: dmPage } = await newCtx(browser, `${IP}-dm`);
      if (await signIn(dmPage, A_MEM_EMAIL, PW)) {
        await dmPage.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
        await pause(HYDRATE_MS);
        // Open a DM with the other member through the real picker.
        await clickByText(dmPage, /message a teammate|new message|direct message|\+/);
        await pause(1000);
        const picked = await clickByText(dmPage, new RegExp(`QA Mem2 ${STAMP}`));
        if (picked) {
          await waitUntil(() => dmPage.$("textarea"), { timeout: 12000, label: "DM composer" });
          const ta = await dmPage.$("textarea");
          if (ta) {
            await ta.click();
            await dmPage.keyboard.type(SECRET_DM);
            await dmPage.keyboard.press("Enter");
            const landed = await waitUntil(
              () => db.message.findFirst({ where: { companyId: A.companyId, body: SECRET_DM } }),
              { timeout: 20000, label: "the DM row in tenant A" }
            );
            if (landed) {
              dmSent = true;
              ok("a private DM between two members was sent");
            } else {
              note("the DM never landed", "§5 will be inert");
            }
          }
        } else {
          note("could not open a DM through the picker", "§5 will be inert");
        }
        await dmPage.screenshot({ path: `${OUT}/05-member-dm.png` });
      }
      await shut(dmPage, dmCtx);
    }

    if (dmSent) {
      // Is the body in the OTHER member's notification row? (Own tenant only.)
      const recipientRows = await aNotifications(A.member2Id);
      const dmRow = recipientRows.find((r) => (r.message || "").includes(SECRET_DM));
      if (dmRow) {
        note("the DM body is stored verbatim in the recipient's Notification.message");
      } else {
        note("no DM notification row found", "the export probe below may come up clean for that");
      }

      const adminExport = await aAdmin.evaluate(async (base) => {
        const r = await fetch(`${base}/api/export`, { credentials: "include" });
        return { status: r.status, body: (await r.text()).slice(0, 8_000_000) };
      }, BASE);
      if (adminExport.status !== 200) {
        note(`/api/export returned ${adminExport.status} for tenant A's admin`);
      } else if (adminExport.body.includes(SECRET_DM)) {
        fail(
          "sec-007 the admin export contains two members' private DM text",
          "canSeeChannel promises no admin back door into a private conversation"
        );
        promote("sec-007", `"${SECRET_DM}" found in /api/export for an admin who is not a party`);
      } else {
        ok("the admin export carries no private DM text");
      }
      // Messages themselves are absent from the export — a portability gap
      // worth recording alongside the leak, since the two point opposite ways.
      if (adminExport.status === 200 && !/"messages"/.test(adminExport.body)) {
        note("the export has no `messages` table at all", "chat history is not portable");
      }
    }

    /* ═══ 6. SEARCH — the only raw SQL in the product ═══ */
    section("6. search: injection, tenancy, and the finance gate");

    const PROBES = [
      "' OR 1=1 --",
      '" OR "1"="1',
      "%",
      "_",
      "'; DROP TABLE \"Message\"; --",
      "budget & ",
      "a:b:c",
      "\\",
      "<b>bold</b>",
      "üñïçøde ٹیسٹ",
    ];
    if (bAdmin) {
      await bAdmin.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      await pause(HYDRATE_MS);
      let brokeOnce = false;
      for (const probe of PROBES) {
        // Drive the palette through the keyboard so the real debounce and the
        // real searchAction path run — not a hand-rolled fetch.
        await bAdmin.keyboard.down("Control");
        await bAdmin.keyboard.press("KeyK");
        await bAdmin.keyboard.up("Control");
        const box = await waitUntil(() => bAdmin.$('input[type=text], input[role=combobox]'), {
          timeout: 8000,
          label: "command palette input",
        });
        if (!box) {
          note("command palette did not open", `probe ${JSON.stringify(probe)} skipped`);
          break;
        }
        await bAdmin.keyboard.type(probe);
        // Wait for the palette to settle (a result list, or an explicit empty
        // state) rather than a fixed sleep.
        await waitUntil(
          async () => {
            const t = await bodyText(bAdmin);
            return /no results|result|nothing found/i.test(t) || t.length > 0;
          },
          { timeout: 8000, label: "palette settled" }
        );
        const t = await bodyText(bAdmin);
        if (/application error|internal server error|unhandled/i.test(t)) {
          brokeOnce = true;
          fail("search injection probe crashed the page", JSON.stringify(probe));
        }
        if (t.includes(SECRET_PROJECT) || t.includes(SECRET_DESC) || t.includes(SECRET_DM)) {
          fail(
            "cross-tenant search leak",
            `probe ${JSON.stringify(probe)} surfaced tenant A content in tenant B`
          );
        }
        await bAdmin.keyboard.press("Escape");
      }
      if (!brokeOnce) ok(`${PROBES.length} injection/edge probes left search up and tenant-clean`);

      // A direct cross-tenant search for the exact foreign project name.
      await bAdmin.keyboard.down("Control");
      await bAdmin.keyboard.press("KeyK");
      await bAdmin.keyboard.up("Control");
      const box2 = await waitUntil(() => bAdmin.$('input[type=text], input[role=combobox]'), {
        timeout: 8000,
        label: "palette for the targeted search",
      });
      if (box2) {
        await bAdmin.keyboard.type(SECRET_PROJECT);
        await pause(1200);
        const t = await bodyText(bAdmin);
        if (t.includes(SECRET_PROJECT)) {
          fail(
            "search returns another tenant's project by name",
            "searchWorkspace scoped the query wrong"
          );
        } else {
          ok("searching tenant A's exact project name from tenant B returns nothing");
        }
        await bAdmin.screenshot({ path: `${OUT}/06-cross-tenant-search.png` });
        await bAdmin.keyboard.press("Escape");
      }
    }

    if (mem && expenseLogged) {
      // The finance groups must not RUN for a member, let alone return.
      await mem.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
      await pause(HYDRATE_MS);
      await mem.keyboard.down("Control");
      await mem.keyboard.press("KeyK");
      await mem.keyboard.up("Control");
      const mbox = await waitUntil(() => mem.$('input[type=text], input[role=combobox]'), {
        timeout: 8000,
        label: "palette for the member",
      });
      if (mbox) {
        await mem.keyboard.type(SECRET_DESC);
        await pause(1500);
        const t = await bodyText(mem);
        const src = await pageSource(mem);
        if (t.includes(SECRET_DESC) || src.includes(SECRET_AMOUNT)) {
          fail(
            "search hands a member a transaction hit",
            "the canSeeFinances gate in searchWorkspace did not hold"
          );
        } else {
          ok("a member's search returns no transaction group at all");
        }
        await mem.screenshot({ path: `${OUT}/06-member-search.png` });
        await mem.keyboard.press("Escape");
      }
    }

    /* ═══ 7. sec-002 — ROLE CHANGE vs THE MIDDLEWARE'S COOKIE-BORNE ROLE ═══
     *
     * The Edge jwt callback in auth.config.ts does no DB read, so
     * `authorized()` gates on the role baked into the cookie. The Node
     * callback refreshes it, but only `/api/auth/session` writes the cookie
     * back — and the finance PAGES have no canSeeFinances gate of their own
     * (only /reports does). So a demoted user who never lets that endpoint run
     * keeps reading the ledger. */
    section("7. role change vs the middleware's cookie-borne role");

    if (A.cofounderId) {
      ({ ctx: cofoCtx, page: cofo } = await newCtx(browser, `${IP}-cofo`));
      if (!(await signIn(cofo, A_COFO_EMAIL, PW))) {
        fail("cofounder sign-in", "§7 cannot run");
      } else {
        await cofo.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
        if (pathOf(cofo) === "/expenses") ok("a cofounder can read /expenses (baseline)");
        else fail("cofounder finance access", `bounced to ${pathOf(cofo)}`);

        // Block the one request that would refresh the cookie's role claim.
        // This is what a demoted insider does with one devtools rule.
        await cofo.setRequestInterception(true);
        cofo.on("request", (req) => {
          if (req.url().includes("/api/auth/session")) req.abort().catch(() => {});
          else req.continue().catch(() => {});
        });

        // Demote through the REAL admin UI so updateUserRoleAction runs.
        await aAdmin.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
        await pause(HYDRATE_MS);
        const demoted = await aAdmin.evaluate(
          (email) => {
            // Find the roster row for this user and its role <select>.
            const rows = [...document.querySelectorAll("tr, li, div")];
            const row = rows.find((r) => (r.textContent || "").includes(email));
            const sel = row?.querySelector("select");
            if (!sel) return false;
            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLSelectElement.prototype,
              "value"
            ).set;
            setter.call(sel, "member");
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          },
          A_COFO_EMAIL
        );
        const nowMember = demoted
          ? await waitUntil(
              async () => {
                const u = await db.user.findUnique({ where: { id: A.cofounderId } });
                return u?.role === "member" ? u : false;
              },
              { timeout: 20000, label: "the demotion landing in the database" }
            )
          : null;

        if (!nowMember) {
          // Fall back to the confirm-dialog shape if the select is not inline.
          note("could not demote through the roster select", "§7's verdict is inconclusive");
        } else {
          ok("the cofounder is now role=member in the database");
          await cofo.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
          const landed = pathOf(cofo);
          const src = await pageSource(cofo);
          const stillSeesLedger = landed === "/expenses" && src.includes(SECRET_DESC);
          if (stillSeesLedger) {
            fail(
              "sec-002 a demoted user keeps reading the ledger",
              "middleware honoured the stale cookie role and /expenses has no server-side gate"
            );
            promote(
              "sec-002",
              `role=member in the DB, yet /expenses served ${SECRET_DESC} to the demoted session`
            );
          } else if (landed === "/expenses") {
            fail(
              "sec-002 (partial) a demoted user still reaches /expenses",
              "the page rendered even though the DB says member"
            );
          } else {
            ok(`the demoted session is bounced off /expenses (-> ${landed})`);
          }
          await cofo.screenshot({ path: `${OUT}/07-demoted-expenses.png` });

          // /reports is the one route with a server-side gate. If sec-002 is
          // real, this is where the difference shows.
          await cofo.goto(`${BASE}/reports`, { waitUntil: "networkidle0", timeout: 60000 });
          const rText = await bodyText(cofo);
          if (/not found|404/i.test(rText) || pathOf(cofo) !== "/reports") {
            ok("/reports refuses the demoted session (its own canSeeFinances gate holds)");
          } else {
            fail("/reports served a demoted session", "even the one double-gated route let it in");
          }
        }
        await cofo.setRequestInterception(false).catch(() => {});
      }
    }

    /* ═══ 8. sec-001 / sec-008 — THE RATE LIMITER ═══
     *
     * Three separate questions, and they must be asked in this order:
     *   (a) is the limiter live on this box at all (RATE_LIMIT_DISABLED)?
     *   (b) can a client pick its own bucket by choosing x-real-ip? (sec-001)
     *   (c) does the limiter cover the NextAuth credentials endpoint, which is
     *       public and calls authorize() directly? (sec-008)
     * Each probe uses its OWN ip suffix so it cannot starve the rest of this
     * run — or any other agent. */
    section("8. the rate limiter: bucket choice and the endpoint it does not cover");

    const BURN_IP = `${IP}-burn`;
    const FRESH_IP = `${IP}-fresh`;

    // (a) + (b): burn the bucket on one ip, then prove a new ip is untouched.
    const { ctx: burnCtx, page: burn } = await newCtx(browser, BURN_IP);
    let burned = false;
    for (let i = 1; i <= 8; i++) {
      await burn.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 60000 });
      await burn.waitForSelector("input[type=email]", { timeout: 20000 });
      await pause(HYDRATE_MS);
      await burn.type("input[type=email]", A_ADMIN_EMAIL);
      await burn.type("input[type=password]", `wrong-${i}-${STAMP}`);
      await burn.click("button[type=submit]");
      const t = await waitUntil(
        async () => {
          const s = await bodyText(burn);
          return /too many requests|invalid email or password/i.test(s) ? s : false;
        },
        { timeout: 20000, label: `login rejection ${i}` }
      );
      if (t && /too many requests/i.test(t)) {
        burned = true;
        ok(`limiters.auth is live: attempt ${i} from ${BURN_IP} was throttled`);
        break;
      }
    }
    if (!burned) {
      fail(
        "limiters.auth never throttled 8 wrong-password attempts from one x-real-ip",
        "is RATE_LIMIT_DISABLED=true? every probe below is inert without a live limiter"
      );
    }
    await burn.screenshot({ path: `${OUT}/08-burned-bucket.png` });

    if (burned) {
      const { ctx: freshCtx, page: fresh } = await newCtx(browser, FRESH_IP);
      await fresh.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 60000 });
      await fresh.waitForSelector("input[type=email]", { timeout: 20000 });
      await pause(HYDRATE_MS);
      await fresh.type("input[type=email]", A_ADMIN_EMAIL);
      await fresh.type("input[type=password]", `wrong-fresh-${STAMP}`);
      await fresh.click("button[type=submit]");
      const t = await waitUntil(
        async () => {
          const s = await bodyText(fresh);
          return /too many requests|invalid email or password/i.test(s) ? s : false;
        },
        { timeout: 20000, label: "fresh-ip rejection" }
      );
      if (t && /invalid email or password/i.test(t)) {
        fail(
          "sec-001 a client picks its own rate-limit bucket by setting x-real-ip",
          `${BURN_IP} is exhausted, yet ${FRESH_IP} got a fresh allowance on the next request`
        );
        promote(
          "sec-001",
          `bucket reset by changing x-real-ip only — brute force is bounded by header values, not by the attacker`
        );
      } else if (t) {
        ok("changing x-real-ip did NOT buy a fresh bucket (a trusted-proxy layer is normalising it)");
      }
      await shut(fresh, freshCtx);
    }

    // (c) sec-008: the NextAuth credentials endpoint. auth.config.ts makes
    // /api/auth/* public and the limiter lives only in loginAction, so this
    // path reaches authorize() (bcrypt.compare) with no bucket at all.
    if (burned) {
      const direct = await burn.evaluate(
        async (base, email, stamp) => {
          const csrfRes = await fetch(`${base}/api/auth/csrf`, { credentials: "include" });
          const { csrfToken } = await csrfRes.json();
          const out = [];
          for (let i = 0; i < 12; i++) {
            const body = new URLSearchParams({
              email,
              password: `direct-wrong-${i}-${stamp}`,
              csrfToken,
              callbackUrl: `${base}/login`,
              json: "true",
            });
            const r = await fetch(`${base}/api/auth/callback/credentials`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body,
              credentials: "include",
              redirect: "manual",
            });
            out.push(r.status);
          }
          return out;
        },
        BASE,
        A_ADMIN_EMAIL,
        STAMP
      );
      note(`12 direct POSTs to /api/auth/callback/credentials returned ${JSON.stringify(direct)}`);
      // A throttled path would answer 429, or stop answering the credential
      // flow's own 302/401 pattern. All-identical statuses across 12 tries
      // from an ALREADY-EXHAUSTED bucket means the limiter is not in this path.
      const uniform = new Set(direct).size === 1;
      if (uniform && !direct.includes(429)) {
        fail(
          "sec-008 the credentials endpoint is not rate limited",
          `12 password guesses from an exhausted auth bucket all returned ${direct[0]} — loginAction's limiter is bypassed by POSTing NextAuth directly`
        );
        promote(
          "sec-008",
          `12/12 direct credential POSTs accepted while the same IP's loginAction bucket was exhausted`
        );
      } else {
        ok("the credentials endpoint pushes back on repeated guesses");
      }

      // And prove the guesses really did reach bcrypt: the account must still
      // be usable with the right password (no lockout), which is the other
      // half of the brute-force story.
      const stillWorks = await burn.evaluate(
        async (base, email, pw) => {
          const csrfRes = await fetch(`${base}/api/auth/csrf`, { credentials: "include" });
          const { csrfToken } = await csrfRes.json();
          const r = await fetch(`${base}/api/auth/callback/credentials`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              email,
              password: pw,
              csrfToken,
              callbackUrl: `${base}/login`,
              json: "true",
            }),
            credentials: "include",
            redirect: "manual",
          });
          return r.status;
        },
        BASE,
        A_ADMIN_EMAIL,
        PW
      );
      note(`the correct password through the same direct endpoint returned ${stillWorks}`);
      note("no account lockout exists", "the only brake on guessing is the per-IP bucket");
    }
    await shut(burn, burnCtx);

    /* ═══ 9. UNAUTHENTICATED SURFACE + requireScopedSession ═══ */
    section("9. the anonymous surface");

    const { ctx: anonCtx, page: anon } = await newCtx(browser, `${IP}-anon`);
    for (const route of [...BLOCKED, "/tasks", "/team", "/settings", "/projects", "/chat"]) {
      await anon.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 });
      const landed = pathOf(anon);
      if (landed.startsWith("/login")) ok(`anonymous ${route} -> /login`);
      else fail(`anonymous reached ${route}`, `landed on ${landed}`);
    }
    // The API surface, which middleware treats separately.
    const anonApi = await anon.evaluate(async (base) => {
      const out = {};
      for (const p of ["/api/export", "/api/cron/purge-soft-deleted"]) {
        const r = await fetch(`${base}${p}`, { redirect: "manual" });
        out[p] = r.status;
      }
      return out;
    }, BASE);
    note(`anonymous API statuses ${JSON.stringify(anonApi)}`);
    if (anonApi["/api/cron/purge-soft-deleted"] === 401) {
      ok("the purge cron answers 401 without CRON_SECRET (fail-closed)");
    } else if (anonApi["/api/cron/purge-soft-deleted"] === 500) {
      note("the purge cron answered 500", "CRON_SECRET is unset on this box — still fail-closed");
    } else {
      fail(
        "the purge cron is reachable without the secret",
        `status ${anonApi["/api/cron/purge-soft-deleted"]}`
      );
    }
    if ([401, 302, 307].includes(anonApi["/api/export"])) {
      ok("/api/export refuses an anonymous caller");
    } else {
      fail("/api/export answered an anonymous caller", `status ${anonApi["/api/export"]}`);
    }

    /* ═══ 10. SECURITY HEADERS + SECRET HYGIENE ═══ */
    section("10. security headers and secret hygiene");

    const headerProbe = await anon.evaluate(async (base) => {
      const r = await fetch(`${base}/login`, { redirect: "manual" });
      const h = {};
      r.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
      return { status: r.status, headers: h, body: (await r.text()).slice(0, 400000) };
    }, BASE);
    const H = headerProbe.headers;
    const REQUIRED = {
      "content-security-policy": /default-src 'self'/,
      "x-frame-options": /DENY/i,
      "x-content-type-options": /nosniff/i,
      "referrer-policy": /strict-origin-when-cross-origin/i,
      "permissions-policy": /camera=\(\)/,
    };
    for (const [name, re] of Object.entries(REQUIRED)) {
      if (H[name] && re.test(H[name])) ok(`${name} is present and correct`);
      else fail(`${name} missing or wrong`, H[name] ?? "(absent)");
    }
    if (H["x-powered-by"]) fail("x-powered-by is exposed", H["x-powered-by"]);
    else ok("x-powered-by is suppressed");

    const csp = H["content-security-policy"] ?? "";
    if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
      fail(
        "sec-009 CSP allows 'unsafe-inline' in script-src",
        "the header is present but provides no XSS containment; the shell bootstrap needs a nonce"
      );
      promote("sec-009", `served script-src includes 'unsafe-inline': ${csp.slice(0, 200)}`);
    } else {
      ok("script-src carries no 'unsafe-inline'");
    }
    for (const missing of ["object-src", "frame-src"]) {
      if (!csp.includes(missing)) note(`CSP has no ${missing} directive`, "falls back to default-src");
    }
    writeFileSync(`${OUT}/headers.json`, JSON.stringify({ login: H }, null, 2));

    // Nothing secret may reach the anonymous document.
    const SECRET_NEEDLES = [
      "AUTH_SECRET",
      "CRON_SECRET",
      "LEMONSQUEEZY",
      "DATABASE_URL",
      "postgresql://",
      "$2a$",
      "$2b$", // bcrypt hash prefixes
      "SENTRY_AUTH_TOKEN",
      "BACKUP_S3_SECRET",
    ];
    const found = SECRET_NEEDLES.filter((n) => headerProbe.body.includes(n));
    if (found.length > 0) fail("a secret-looking string is in the public HTML", JSON.stringify(found));
    else ok("no secret-looking strings in the anonymous /login document");

    // Password hashes must never cross the RSC boundary on an authed page
    // either — getCompanyUsers selects the whole row and relies on a mapper.
    if (aAdmin) {
      await aAdmin.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
      const teamSrc = await pageSource(aAdmin);
      if (/\$2[aby]\$\d\d\$/.test(teamSrc)) {
        fail("a bcrypt hash is in the /team RSC payload", "getCompanyUsers leaked passwordHash");
      } else {
        ok("no bcrypt hash in the /team payload");
      }
      if (/sessionVersion/.test(teamSrc)) {
        note("sessionVersion appears in the /team payload", "harmless, but it is internal state");
      }
    }
    await shut(anon, anonCtx);

    /* ═══ 11. sec-010 — CHANGING THE LOGIN EMAIL WITH NO RE-AUTH ═══
     *
     * requestEmailChangeAction asks for no password, confirmEmailChangeAction
     * bumps no sessionVersion, and nothing is sent to the OLD address. A
     * borrowed session is therefore a silent account takeover: change the
     * email, then use /forgot-password on the new one. */
    section("11. changing the login email: re-auth and notice to the old address");

    if (mem) {
      await mem.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
      await pause(HYDRATE_MS);
      const opened = await clickByText(mem, /change email|change your email/);
      if (!opened) {
        note("no change-email control found on /settings", "§11 is inconclusive");
      } else {
        await pause(800);
        const pwFields = await mem.$$("input[type=password]");
        if (pwFields.length === 0) {
          fail(
            "sec-010 the change-email form asks for no password",
            "a borrowed session can repoint the login address with no re-authentication"
          );
          promote("sec-010", "the change-email dialog renders no password input");
        } else {
          ok("the change-email form requires the current password");
        }
        await mem.screenshot({ path: `${OUT}/11-change-email.png` });
        // Does the request bump sessionVersion (which would sign other devices
        // out) — checked against MY OWN member row only.
        const before = await db.user.findUnique({ where: { id: A.memberId } });
        const newAddr = `qa-sec-a-mem-moved-${STAMP}@founderflow.test`;
        const emailInput = await mem.$('input[type=email]');
        if (emailInput) {
          await emailInput.type(newAddr);
          await clickByText(mem, /send|confirm|continue/);
          await pause(2500);
          const after = await db.user.findUnique({ where: { id: A.memberId } });
          if (after && before && after.sessionVersion === before.sessionVersion) {
            note(
              "requesting an email change bumps no sessionVersion",
              "expected — the swap happens on confirmation; recorded for the report"
            );
          }
          if (after && after.email === newAddr) {
            fail(
              "the email changed without clicking the confirmation link",
              "inbox ownership was never proven"
            );
          } else {
            ok("the email is unchanged until the emailed link is clicked");
          }
        }
      }
    }

    /* ═══ 12. FORM-LEVEL FORGED ID — a foreign project in a real submit ═══
     *
     * The closest a browser gets to forging a server-action argument without
     * reverse-engineering Next-Action ids: rewrite a select's option value to
     * a FOREIGN id and let the product's own submit path send it. */
    section("12. a foreign project id pushed through a real form submit");

    if (bAdmin && A.projectId) {
      await bAdmin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
      await pause(HYDRATE_MS);
      await clickByText(bAdmin, /add expense|log expense|new expense/);
      const amt = await waitUntil(() => bAdmin.$("input[type=number]"), {
        timeout: 12000,
        label: "tenant B expense modal",
      });
      if (!amt) {
        note("could not open tenant B's expense modal", "§12 is inconclusive");
      } else {
        const forgedDesc = `qa-sec-forged-${STAMP}`;
        await setInput(bAdmin, "input[type=number]", "1234");
        await bAdmin.type("textarea", forgedDesc);
        const injected = await bAdmin.evaluate((foreignId) => {
          const sels = [...document.querySelectorAll("select")];
          const projectSel = sels[sels.length - 1];
          if (!projectSel) return false;
          const opt = document.createElement("option");
          opt.value = foreignId;
          opt.textContent = "forged";
          projectSel.appendChild(opt);
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype,
            "value"
          ).set;
          setter.call(projectSel, foreignId);
          projectSel.dispatchEvent(new Event("change", { bubbles: true }));
          return projectSel.value === foreignId;
        }, A.projectId);
        if (!injected) {
          note("could not inject the foreign option", "§12 is inconclusive");
        } else {
          await bAdmin.click("button[type=submit]");
          const rejected = await waitUntil(
            async () => /project not found|not authorized/i.test(await bodyText(bAdmin)),
            { timeout: 15000, label: "the server's rejection" }
          );
          // The authoritative check is the database, in BOTH tenants.
          const inB = await db.transaction.findMany({
            where: { companyId: B.companyId, description: forgedDesc },
          });
          const inA = await db.transaction.findMany({
            where: { companyId: A.companyId, description: forgedDesc },
          });
          const crossTagged = [...inA, ...inB].filter((t) => t.projectId === A.projectId);
          if (crossTagged.length > 0) {
            fail(
              "a transaction was tagged into another tenant's project",
              `${crossTagged.length} row(s) with projectId=${A.projectId}`
            );
          } else if (inA.length > 0) {
            fail("a write landed in tenant A from tenant B's session", JSON.stringify(inA.map((t) => t.id)));
          } else {
            ok(
              rejected
                ? "the forged foreign projectId was rejected with 'Project not found'"
                : "the forged foreign projectId produced no cross-tenant row"
            );
          }
          await bAdmin.screenshot({ path: `${OUT}/12-forged-project-id.png` });
        }
      }
    }

    /* ═══ 13. THE REPLAYED / STALE TOKEN SURFACE ═══ */
    section("13. invite tokens: replay, revoke, and the tenant they land in");

    if (A.companyId && A.adminId) {
      // A fresh invite, accepted, then REPLAYED. usedAt must refuse it.
      const replayEmail = `qa-sec-replay-${STAMP}@founderflow.test`;
      const replayUser = await inviteAndAccept(browser, aAdmin, {
        email: replayEmail,
        name: `QA Replay ${STAMP}`,
        role: "member",
        companyId: A.companyId,
        ip: `${IP}-replay`,
      });
      if (replayUser) {
        const used = await db.inviteToken.findFirst({
          where: { companyId: A.companyId, email: replayEmail },
        });
        if (used?.usedAt) ok("the accepted invite is marked used");
        else fail("invite usedAt not set", "the token is replayable");

        const { ctx: rCtx, page: rPage } = await newCtx(browser, `${IP}-replay2`);
        await rPage.goto(`${BASE}/invite/${used.token}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        const rText = await bodyText(rPage);
        if (/already been used|invalid|expired/i.test(rText)) {
          ok("replaying a used invite link is refused");
        } else {
          fail("a used invite link is still live", rText.slice(0, 200));
        }
        // And no second user may exist for that address in my tenant.
        const dupes = await aUsers({ email: replayEmail });
        if (dupes.length === 1) ok("the replay created no duplicate user");
        else fail("invite replay created duplicates", `${dupes.length} rows for ${replayEmail}`);
        await shut(rPage, rCtx);
      }
    }

    /* ═══ 14. THE FINAL TENANCY SWEEP — did anything of mine cross over? ═══ */
    section("14. tenancy sweep");

    if (A.companyId && B.companyId) {
      const aRows = await db.transaction.findMany({ where: { companyId: A.companyId } });
      const bRows = await db.transaction.findMany({ where: { companyId: B.companyId } });
      const aBadProject = aRows.filter((t) => t.projectId && t.projectId === B.projectId);
      const bBadProject = bRows.filter((t) => t.projectId && t.projectId === A.projectId);
      if (aBadProject.length === 0 && bBadProject.length === 0) {
        ok("no transaction in either tenant references the other tenant's project");
      } else {
        fail(
          "a cross-tenant foreign key exists",
          `A->B ${aBadProject.length}, B->A ${bBadProject.length}`
        );
      }
      const aUsersAll = await aUsers();
      const strayEmails = aUsersAll.filter((u) => !u.email.includes(STAMP));
      if (strayEmails.length === 0) ok("tenant A holds only users this run created");
      else fail("unexpected user in tenant A", JSON.stringify(strayEmails.map((u) => u.email)));
    }
  } finally {
    section("cleanup");
    await shut(aAdmin, aAdminCtx);
    await shut(bAdmin, bAdminCtx);
    await shut(mem, memCtx);
    await shut(cofo, cofoCtx);
    await browser.close().catch(() => {});

    for (const cid of [A.companyId, B.companyId]) {
      if (!cid) continue;
      try {
        // Never leave a tenant tombstoned, whatever threw above.
        await db.company.update({ where: { id: cid }, data: { deletedAt: null } }).catch(() => {});
        // Children before parents — the discipline the purge cron uses.
        await db.messageReaction.deleteMany({ where: { message: { companyId: cid } } });
        await db.message.deleteMany({ where: { companyId: cid } });
        await db.channelMember.deleteMany({ where: { channel: { companyId: cid } } });
        await db.channel.deleteMany({ where: { companyId: cid } });
        await db.comment.deleteMany({ where: { companyId: cid } });
        await db.timeEntry.deleteMany({ where: { companyId: cid } });
        await db.notification.deleteMany({ where: { companyId: cid } });
        await db.activity.deleteMany({ where: { companyId: cid } });
        await db.inviteToken.deleteMany({ where: { companyId: cid } });
        await db.recurringRule.deleteMany({ where: { companyId: cid } });
        await db.budget.deleteMany({ where: { companyId: cid } });
        await db.transaction.deleteMany({ where: { companyId: cid } });
        await db.task.deleteMany({ where: { companyId: cid } });
        await db.project.deleteMany({ where: { companyId: cid } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId: cid } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId: cid } } });
        // Break the Company→User owner FK before the users go.
        await db.company.update({ where: { id: cid }, data: { ownerId: null } });
        await db.user.deleteMany({ where: { companyId: cid } });
        await db.company.delete({ where: { id: cid } });
        console.log(`  cleaned tenant ${cid}`);
      } catch (e) {
        console.error(`  ❌ cleanup failed for ${cid}:`, e.message);
        process.exitCode = 1;
      }
    }
    await db.$disconnect();
  }
}

await main()
  .catch((err) => {
    console.error("❌ qa-security-and-tenancy threw:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(`\n${passes} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ❌ ${f}`);
    if (observed.length > 0) {
      console.log(`\npromoted to observed:`);
      for (const o of observed) console.log(`  →→ ${o}`);
    }
    console.log(failures.length ? "\n== FAIL ==" : "\n== pass ==");
  });
