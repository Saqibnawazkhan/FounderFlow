/*
 * QA: money-correctness — go-live audit, AGENT_INDEX 17.
 *
 * Scope: every number a customer could dispute. Decimal handling end to end
 * (Prisma Decimal -> DTO -> UI -> XLSX export), rounding, sign conventions,
 * currency labelling, runway + budget maths, and whether /dashboard, /reports,
 * /expenses, /budgets and /projects/[id] agree about the same money.
 *
 * ─── DATA SAFETY ────────────────────────────────────────────────────────────
 * This script NEVER writes a pre-existing row. It signs its own workspace up
 * through the real /signup flow (company name starts with `qa-` so the sweeper
 * finds it), invites its second user through the real invite flow, and every
 * single database assertion carries `where: { companyId: TENANT.id }`. There is
 * no bare `db.X.count()` anywhere below: under concurrency another agent's
 * insert would satisfy a "did mine land?" check and produce a false PASS, which
 * is the most expensive outcome in a pre-launch audit.
 *
 * The workspace currency is deliberately USD, not PKR. Several findings are only
 * visible when the workspace currency is NOT the hardcoded default — the money
 * input labels, the activity-feed strings and the notification bodies all
 * hardcode "PKR", and in a PKR workspace that bug is invisible.
 *
 * ─── HOW TO READ THE OUTPUT ─────────────────────────────────────────────────
 * Each check is a Phase-1 finding. `finding(id, …, reproduced)`:
 *   reproduced === true   -> the defect is REAL: printed as FAIL + ❌, exit 1.
 *   reproduced === false  -> the defect did NOT reproduce (fixed, or Phase 1 was
 *                            wrong): printed as ok.
 * `fail()` never throws, so one run reports every finding it can reach.
 *
 * Run:  node scripts/qa-money-correctness.mjs
 * Env:  BASE (default http://localhost:3000), PUPPETEER_EXECUTABLE_PATH
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** Per-agent screenshot dir. Shared fixed filenames destroy evidence. */
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/money-correctness";
const DOWNLOADS = join(OUT, "downloads");

/**
 * AGENT_INDEX 17. `getClientIp()` falls back to the literal string "unknown" in
 * dev, so without a distinct x-real-ip every agent shares ONE `limiters.auth`
 * bucket of 5/60s fed by nine call sites and we starve each other into false
 * "cannot sign in" bugs. Set on every page before its first navigation.
 */
const AGENT_IP = "10.99.0.17";

const STAMP = Date.now().toString().slice(-8);
const TENANT_NAME = `qa-money-${STAMP}`;
const ADMIN_EMAIL = `qa-money-${STAMP}@founderflow.test`;
const COFO_EMAIL = `qa-money-cofo-${STAMP}@founderflow.test`;
const PASSWORD = `QaMoney${STAMP}x`; // 8+, upper, lower, digit

/** The expense category every money check below uses, so sums stay predictable. */
const CAT = "Salaries";

// Pinned to the local docker Postgres. `new PrismaClient()` would read the root
// .env, which points at PRODUCTION Supabase — see scripts/_local-db.mjs.
const db = localDb();

/** Filled in after signup. Every DB read below is scoped to this id. */
const TENANT = { id: null, adminUserId: null, projectId: null };

/* ─────────────────────────────────────────────────────────────────────────── */
/* Reporting                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

let reproduced = 0;
let cleared = 0;

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  // The literal ❌ is what the runner's summary counts.
  console.error(`  FAIL  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}

/**
 * Report one Phase-1 finding.
 * @param {string} id      e.g. "money-003"
 * @param {string} claim   one sentence in USER terms
 * @param {boolean} repro  true when the defect reproduced
 * @param {string} detail  literal expected-vs-actual
 */
function finding(id, claim, repro, detail) {
  if (repro) {
    reproduced += 1;
    fail(`${id} REPRODUCED — ${claim}`, detail);
  } else {
    cleared += 1;
    ok(`${id} did not reproduce — ${claim} (${detail})`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Browser helpers                                                             */
/* ─────────────────────────────────────────────────────────────────────────── */

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  // BEFORE the first navigation — see AGENT_IP.
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  page.setDefaultTimeout(45000);
  wire(page);
  return { ctx, page };
}

/**
 * Retry-until-hydrated sign-in. Copied verbatim from scripts/smoke-chat.mjs —
 * a pre-hydration click does a native GET submit (FaultsAudit A14).
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
 * Set a form control by its visible <label> text, using the native value setter
 * so React-Hook-Form's onChange actually fires. Typing into `type=number` and
 * `type=date` inputs is unreliable; this is not.
 */
async function setField(page, labelText, value) {
  const result = await page.evaluate(
    (labelText, value) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const label = [...document.querySelectorAll("label")].find((l) =>
        norm(l.textContent).startsWith(norm(labelText))
      );
      if (!label) return "no-label";
      const el = label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector("input,select,textarea");
      if (!el) return "no-control";
      const proto =
        el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    },
    labelText,
    value
  );
  if (result !== "ok") throw new Error(`setField("${labelText}") -> ${result}`);
}

/** setField for an optional field: note and carry on instead of throwing. */
async function trySetField(page, labelText, value) {
  try {
    await setField(page, labelText, value);
  } catch (e) {
    note(`optional field skipped: ${e.message}`);
  }
}

/**
 * Inject an extra <option> into a <select> and select it. Used only to forge a
 * value the UI would never offer — an id from ANOTHER tenant — so the server
 * action's ownership check is what gets tested, not the dropdown's contents.
 */
async function forceSelectOption(page, labelPrefix, value) {
  return page.evaluate(
    (labelPrefix, value) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const label = [...document.querySelectorAll("label")].find((l) =>
        norm(l.textContent).startsWith(norm(labelPrefix))
      );
      if (!label) return "no-label";
      const el = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      if (!el || el.tagName !== "SELECT") return "no-select";
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = "forged";
      el.appendChild(opt);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return el.value === value ? "ok" : "not-selected";
    },
    labelPrefix,
    value
  );
}

/** Read a control's attribute by its label text (for the date `max` check). */
async function fieldAttr(page, labelText, attr) {
  return page.evaluate(
    (labelText, attr) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const label = [...document.querySelectorAll("label")].find((l) =>
        norm(l.textContent).startsWith(norm(labelText))
      );
      if (!label) return null;
      const el = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      return el ? el.getAttribute(attr) : null;
    },
    labelText,
    attr
  );
}

/** The full visible text of the <label> that starts with `labelText`. */
async function labelText(page, prefix) {
  return page.evaluate((prefix) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const label = [...document.querySelectorAll("label")].find((l) =>
      norm(l.textContent).toLowerCase().startsWith(prefix.toLowerCase())
    );
    return label ? norm(label.textContent) : null;
  }, prefix);
}

async function clickByText(page, text, sel = "button") {
  const handles = await page.$$(sel);
  for (const h of handles) {
    const t = await h.evaluate((el) => (el.textContent || "").replace(/\s+/g, " ").trim());
    if (t.toLowerCase().includes(text.toLowerCase())) {
      await h.click();
      return true;
    }
  }
  return false;
}

/** Wait for the Radix dialog to be present / gone. State predicates, not sleeps. */
const dialogOpen = (page) => page.waitForFunction(() => !!document.querySelector('[role="dialog"]'));
const dialogGone = (page) =>
  page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 30000 });

/**
 * Read a <DashboardStat> card by its label. The card has no data attribute, so
 * we find the label <p> and walk to the card root (`div.group`).
 * @returns {Promise<{value: string, delta: string|null}|null>}
 */
async function stat(page, label) {
  return page.evaluate((label) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const labelEl = [...document.querySelectorAll("p")].find(
      (p) => norm(p.textContent).toLowerCase() === label.toLowerCase()
    );
    if (!labelEl) return null;
    const card = labelEl.closest("div.group");
    if (!card) return null;
    const ps = [...card.querySelectorAll("p")].map((p) => norm(p.textContent));
    return { value: ps[1] ?? "", delta: ps[2] ?? null };
  }, label);
}

/** "PKR 1,235" / "-$1,235" / "$0" -> 1235 / -1235 / 0. */
function moneyToNumber(s) {
  if (s === null || s === undefined) return NaN;
  const neg = /-/.test(s);
  const digits = String(s).replace(/[^0-9.]/g, "");
  if (!digits) return NaN;
  const n = Number(digits);
  return neg ? -n : n;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Date helpers — plain JS so the script has no date-fns dependency            */
/* ─────────────────────────────────────────────────────────────────────────── */

/** yyyy-mm-dd in UTC (what the transaction form itself uses as its default). */
function utcDay(d) {
  return d.toISOString().slice(0, 10);
}
/** Local start of this month — the boundary /dashboard and /reports use. */
function localStartOfMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
}
/** UTC start of this month — the boundary /budgets and project spend use. */
function utcStartOfMonth(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Fixture builders (own tenant only)                                          */
/* ─────────────────────────────────────────────────────────────────────────── */

/** Sign up a brand-new `qa-` workspace in USD through the real /signup flow. */
async function signUpTenant(page) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
  await page.waitForSelector('form input[type="email"]');
  // Step 1 renders both steps in the DOM (hidden), so the inputs are all
  // present: [name, email, password, companyName].
  const inputs = await page.$$("form input");
  if (inputs.length < 4) throw new Error(`signup form has ${inputs.length} inputs, expected >= 4`);
  await inputs[0].type(`QA Money ${STAMP}`);
  await inputs[1].type(ADMIN_EMAIL);
  await inputs[2].type(PASSWORD);
  if (!(await clickByText(page, "Continue"))) throw new Error("no Continue button on /signup");
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll('button[type="submit"]')][0];
      return !!btn && !btn.disabled;
    },
    { timeout: 30000 }
  );
  await inputs[3].type(TENANT_NAME);
  const selects = await page.$$("form select");
  // [industry, currency] — USD so the hardcoded-PKR findings become visible.
  await selects[1].select("USD");
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 60000 });

  const company = await db.company.findFirst({
    where: { name: TENANT_NAME },
    select: { id: true, currency: true, ownerId: true },
  });
  if (!company) throw new Error(`signup did not create company "${TENANT_NAME}"`);
  TENANT.id = company.id;
  TENANT.adminUserId = company.ownerId;
  if (company.currency !== "USD") {
    fail("signup currency", `picked USD, company row says ${company.currency}`);
  }
  ok(`tenant ${TENANT_NAME} (${TENANT.id}) created in ${company.currency}`);
}

/**
 * A project to hang budgets off. Signup creates NO project, and /budgets
 * requires one. Written straight into MY OWN tenant: it is a fixture, not part
 * of the money surface, and the UI path for it belongs to the projects agent.
 */
async function createProject() {
  const p = await db.project.create({
    data: {
      companyId: TENANT.id,
      name: `qa-money-project-${STAMP}`,
      supervisorId: TENANT.adminUserId,
      createdBy: TENANT.adminUserId,
      status: "active",
    },
    select: { id: true },
  });
  TENANT.projectId = p.id;
  ok(`fixture project ${p.id}`);
}

/**
 * Log one expense through the REAL transaction form on /expenses.
 * @param {object} o {amount, date?: "yyyy-mm-dd", project?: string|null, desc?}
 */
async function logExpense(page, o) {
  await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
  if (!(await clickByText(page, "Log expense"))) throw new Error("no 'Log expense' button");
  await dialogOpen(page);
  await setField(page, "Amount", o.amount);
  await setField(page, "Category", CAT);
  if (o.date) await setField(page, "Date", o.date);
  if (o.project !== undefined) await setField(page, "Project", o.project ?? "");
  await setField(page, "Description", o.desc ?? `qa-money ${STAMP} ${o.amount}`);
  await clickByText(page, "Add expense");
  await dialogGone(page);
}

/** Every live expense row in MY tenant, amounts as Numbers. */
async function myExpenses() {
  const rows = await db.transaction.findMany({
    where: { companyId: TENANT.id, deletedAt: null, type: "expense" },
    select: { id: true, amount: true, date: true, category: true, projectId: true, ruleId: true },
  });
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* main                                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1100 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log(`== money-correctness qa (${TENANT_NAME}) ==`);

  let adminCtx = null;
  let cofoCtx = null;

  try {
    const admin = await newPage(browser);
    adminCtx = admin.ctx;
    const page = admin.page;

    await signUpTenant(page);
    await createProject();

    /* ───────────────────────────────────────────────────────────────────────
     * money-002 — a sub-cent amount is silently stored as 0.00, and the
     * /reports category percentage then renders "NaN%".
     *
     * Runs FIRST, while it is the only expense in the tenant: that is the
     * state in which totalExpenses === 0 and the 0/0 division is reachable.
     * ─────────────────────────────────────────────────────────────────────── */
    await logExpense(page, { amount: "0.004", desc: `qa-money ${STAMP} subcent` });
    const subcent = (await myExpenses()).find((r) => r.category === CAT);
    finding(
      "money-002a",
      "an amount smaller than one cent is accepted and silently saved as zero",
      !!subcent && subcent.amount === 0,
      subcent
        ? `typed 0.004, Decimal(12,2) stored ${subcent.amount}`
        : "no expense row found — check could not run"
    );

    await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    const zeroRowVisible = await page.evaluate(
      (stamp) =>
        [...document.querySelectorAll("tr,li")].some(
          (el) => el.textContent.includes(`${stamp} subcent`) && /\$\s?0\b/.test(el.textContent)
        ),
      STAMP
    );
    finding(
      "money-002b",
      "the zeroed expense renders as $0 in the ledger with no hint that the typed amount was lost",
      zeroRowVisible,
      zeroRowVisible ? 'row shows "$0"' : "row did not render as $0"
    );

    await page.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
    await page.screenshot({ path: `${OUT}/01-reports-zero-total.png`, fullPage: true });
    const nanPct = await page.evaluate(() => /NaN\s*%/.test(document.body.innerText));
    finding(
      "money-002c",
      "/reports prints NaN% for a category when every expense in the window rounds to zero",
      nanPct,
      nanPct ? 'body contains "NaN%"' : "no NaN% on the page"
    );

    /* ───────────────────────────────────────────────────────────────────────
     * money-001 — no amount anywhere shows cents (formatCurrency pins
     * maximumFractionDigits: 0), so the visible rows and the visible total of
     * the same ledger disagree.
     * ─────────────────────────────────────────────────────────────────────── */
    for (let i = 0; i < 3; i++) {
      await logExpense(page, { amount: "0.50", desc: `qa-money ${STAMP} half-${i}` });
    }
    const halves = await db.transaction.findMany({
      where: { companyId: TENANT.id, deletedAt: null, description: { contains: `${STAMP} half-` } },
      select: { amount: true },
    });
    const halvesExact = halves.every((h) => Number(h.amount) === 0.5);
    finding(
      "money-001a",
      "the database keeps the cents a customer typed",
      !halvesExact,
      `stored ${halves.map((h) => String(h.amount)).join(", ")} (expected three 0.50 rows)`
    );

    await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    const halfRows = await page.evaluate(
      (stamp) =>
        [...document.querySelectorAll("tr,li")]
          .filter((el) => el.textContent.includes(`${stamp} half-`))
          .map((el) => {
            const m = el.textContent.match(/-?\$\s?[\d,]+(?:\.\d+)?/);
            return m ? m[0] : null;
          })
          .filter(Boolean),
      STAMP
    );
    const total = await stat(page, "Total spend");
    const visibleRowSum = halfRows.reduce((s, r) => s + moneyToNumber(r), 0);
    const visibleTotal = moneyToNumber(total?.value);
    const dbSum = (await myExpenses()).reduce((s, r) => s + r.amount, 0);
    finding(
      "money-001b",
      "three 50-cent expenses each render as a whole unit, so the rows add up to more than the ledger total the same page prints",
      halfRows.length === 3 && visibleRowSum !== Math.round(dbSum),
      `rows render [${halfRows.join(", ")}] = ${visibleRowSum}; page total "${total?.value}" = ${visibleTotal}; DB sum = ${dbSum}`
    );
    await page.screenshot({ path: `${OUT}/02-expenses-cents.png`, fullPage: true });

    /* ───────────────────────────────────────────────────────────────────────
     * money-003 — /expenses "This month" compares only getMonth(), so the
     * SAME MONTH OF EVERY PREVIOUS YEAR counts, and the card disagrees with
     * /dashboard's "This month" over the same ledger.
     * ─────────────────────────────────────────────────────────────────────── */
    const now = new Date();
    const lastYearSameMonth = new Date(
      Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), Math.min(15, 28))
    );
    await logExpense(page, {
      amount: "1000",
      date: utcDay(lastYearSameMonth),
      desc: `qa-money ${STAMP} lastyear`,
    });
    await logExpense(page, { amount: "500", desc: `qa-money ${STAMP} thismonth` });

    const rows = await myExpenses();
    const localStart = localStartOfMonth();
    const correctThisMonth = rows
      .filter((r) => r.date >= localStart)
      .reduce((s, r) => s + r.amount, 0);
    const buggyThisMonth = rows
      .filter((r) => r.date.getMonth() === now.getMonth())
      .reduce((s, r) => s + r.amount, 0);

    await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    const expMonth = moneyToNumber((await stat(page, "This month"))?.value);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
    const dashMonth = moneyToNumber((await stat(page, "This month"))?.value);
    finding(
      "money-003",
      "/expenses 'This month' counts the same calendar month of previous years, so it disagrees with /dashboard about this month's spend",
      expMonth !== dashMonth && expMonth === Math.round(buggyThisMonth),
      `/expenses = ${expMonth}, /dashboard = ${dashMonth}; correct month-to-date = ${correctThisMonth}, year-agnostic sum = ${buggyThisMonth}`
    );
    await page.screenshot({ path: `${OUT}/03-dashboard-this-month.png`, fullPage: true });

    /* ───────────────────────────────────────────────────────────────────────
     * money-009 — /dashboard and /reports bucket by the VIEWER'S LOCAL month
     * while /budgets and project spend bucket by the UTC month. A transaction
     * dated the 1st is filed in two different months for any customer west of
     * UTC. Reproduced by emulating a negative-offset timezone.
     * ─────────────────────────────────────────────────────────────────────── */
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (firstOfMonth <= now) {
      await logExpense(page, {
        amount: "7000",
        date: utcDay(firstOfMonth),
        project: TENANT.projectId,
        desc: `qa-money ${STAMP} firstday`,
      });
      const tz = await newPage(browser);
      try {
        await tz.page.emulateTimezone("America/Bogota"); // UTC-5, the repo's own test TZ
        await signIn(tz.page, ADMIN_EMAIL, PASSWORD);
        await tz.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
        const tzDash = moneyToNumber((await stat(tz.page, "This month"))?.value);
        const utcMTD = (await myExpenses())
          .filter((r) => r.date >= utcStartOfMonth())
          .reduce((s, r) => s + r.amount, 0);
        finding(
          "money-009",
          "a transaction dated the 1st of the month is counted in the previous month by /dashboard for any customer west of UTC, while /budgets still counts it in this month",
          tzDash < Math.round(utcMTD),
          `America/Bogota viewer sees this-month spend ${tzDash}; UTC month-to-date in the DB is ${utcMTD}`
        );
        await tz.page.screenshot({ path: `${OUT}/04-tz-month-boundary.png`, fullPage: true });
      } finally {
        await tz.ctx.close().catch(() => {});
      }
    } else {
      note("money-009 skipped — today IS the 1st, no boundary row to place");
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-011 — the date picker's default AND its `max` are the UTC date, so
     * a customer in a timezone ahead of UTC (Pakistan is UTC+5, the product's
     * home market) cannot log today's expense during their early hours.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      const ahead = await newPage(browser);
      try {
        await ahead.page.emulateTimezone("Pacific/Kiritimati"); // UTC+14, no DST
        await signIn(ahead.page, ADMIN_EMAIL, PASSWORD);
        await ahead.page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
        await clickByText(ahead.page, "Log expense");
        await dialogOpen(ahead.page);
        const max = await fieldAttr(ahead.page, "Date", "max");
        const localToday = await ahead.page.evaluate(() => {
          const d = new Date();
          const p = (n) => String(n).padStart(2, "0");
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        });
        finding(
          "money-011",
          "customers east of UTC cannot date an expense today — the picker caps at the UTC date, which is yesterday for them",
          !!max && max < localToday,
          `viewer's local date ${localToday}, date input max="${max}"`
        );
        await ahead.page.screenshot({ path: `${OUT}/05-date-max.png` });
      } finally {
        await ahead.ctx.close().catch(() => {});
      }
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-008 — money inputs hardcode "(PKR)" in a USD workspace.
     * ─────────────────────────────────────────────────────────────────────── */
    await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await clickByText(page, "Log expense");
    await dialogOpen(page);
    const amountLabel = await labelText(page, "Amount");
    const prefixText = await page.evaluate(
      () => document.querySelector('[role="dialog"]')?.innerText ?? ""
    );
    finding(
      "money-008a",
      "the expense form asks for an amount in PKR inside a workspace whose currency is USD",
      /PKR/.test(amountLabel ?? "") || /\bPKR\b/.test(prefixText),
      `label is "${amountLabel}", workspace currency is USD`
    );
    await page.screenshot({ path: `${OUT}/06-form-pkr-label.png` });
    await page.keyboard.press("Escape").catch(() => {});

    await page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0" });
    await clickByText(page, "New budget");
    await dialogOpen(page);
    const capLabel = await labelText(page, "Monthly cap");
    finding(
      "money-008b",
      "the budget form asks for a monthly cap in PKR inside a USD workspace",
      /PKR/.test(capLabel ?? ""),
      `label is "${capLabel}"`
    );

    /* Create the budget we need for the scoping check, limit 1000. */
    await setField(page, "Project", TENANT.projectId);
    await setField(page, "Category", CAT);
    await setField(page, "Monthly cap", "1000");
    await clickByText(page, "Create budget");
    await dialogGone(page);
    const budget = await db.budget.findFirst({
      where: { companyId: TENANT.id, projectId: TENANT.projectId, category: CAT },
      select: { id: true, monthlyLimit: true },
    });
    if (!budget) {
      fail("budget fixture", "budget was not created — the scoping checks below cannot run");
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-005 — /budgets sums EVERY expense in the category company-wide,
     * including untagged spend and other projects', while the project page and
     * the alert threshold sum only that project's. The same cap reads over
     * budget on one page and on track on the other, and nothing alerts.
     * ─────────────────────────────────────────────────────────────────────── */
    if (budget) {
      await logExpense(page, {
        amount: "600",
        project: TENANT.projectId,
        desc: `qa-money ${STAMP} tagged600`,
      });
      await logExpense(page, { amount: "500", project: null, desc: `qa-money ${STAMP} untagged500` });

      const all = await myExpenses();
      const utcStart = utcStartOfMonth();
      const companyWide = all
        .filter((r) => r.category === CAT && r.date >= utcStart)
        .reduce((s, r) => s + r.amount, 0);
      const projectScoped = all
        .filter((r) => r.category === CAT && r.projectId === TENANT.projectId && r.date >= utcStart)
        .reduce((s, r) => s + r.amount, 0);

      await page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0" });
      const budgetsText = await page.evaluate(() => document.body.innerText);
      const budgetsSpent = moneyToNumber((budgetsText.match(/Spent\s+(-?\$\s?[\d,]+)/) || [])[1]);
      const saysOver = /\bOver\b/.test(budgetsText);
      await page.screenshot({ path: `${OUT}/07-budgets-company-wide.png`, fullPage: true });

      await page.goto(`${BASE}/projects/${TENANT.projectId}`, { waitUntil: "networkidle0" });
      const projText = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: `${OUT}/08-project-scoped.png`, fullPage: true });

      finding(
        "money-005a",
        "/budgets charges spend from other projects and untagged spend against a project's cap, so a cap that is 60% used is shown as over budget",
        Math.round(budgetsSpent) === Math.round(companyWide) &&
          Math.round(companyWide) !== Math.round(projectScoped),
        `/budgets shows Spent ${budgetsSpent} (company-wide ${companyWide}); the project's own spend is ${projectScoped} against a cap of ${budget.monthlyLimit}; /budgets over-budget badge: ${saysOver}`
      );
      finding(
        "money-005b",
        "the project page and /budgets print different month-to-date spend for the same budget",
        !projText.includes(String(Math.round(companyWide))),
        `project page text does not contain the company-wide figure ${Math.round(companyWide)}; expected it to show ${projectScoped}`
      );

      const alerts = await db.notification.findMany({
        where: { companyId: TENANT.id, category: "finance" },
        select: { title: true, message: true },
      });
      const overBudgetAlert = alerts.find((a) => /budget/i.test(a.title));
      finding(
        "money-005c",
        "nothing alerts when /budgets says a cap is exceeded, because the alert uses a different (project-scoped) sum",
        saysOver && !overBudgetAlert,
        `/budgets over-budget badge: ${saysOver}; budget notifications in this tenant: ${alerts.length}`
      );
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-006 — recurring expenses never run the budget threshold check and
     * are never project-tagged, so the automated spend a founder most wants
     * capped can never trip a cap.
     * ─────────────────────────────────────────────────────────────────────── */
    await page.goto(`${BASE}/recurring`, { waitUntil: "networkidle0" });
    const openedRule =
      (await clickByText(page, "New rule")) || (await clickByText(page, "Add first rule"));
    if (!openedRule) {
      fail("money-006", "could not open the recurring-rule modal");
    } else {
      await dialogOpen(page);
      const ruleAmountLabel = await labelText(page, "Amount");
      await setField(page, "Amount", "5000");
      await setField(page, "Category", CAT);
      await trySetField(page, "Description", `qa-money ${STAMP} recurring`);
      await clickByText(page, "Create rule");
      await dialogGone(page).catch(() => {});

      const seeded = await db.transaction.findFirst({
        where: { companyId: TENANT.id, description: { contains: `${STAMP} recurring` } },
        select: { id: true, amount: true, projectId: true, ruleId: true },
      });
      finding(
        "money-006a",
        "a recurring expense can never be tagged to a project, so it can never count against any project budget",
        !!seeded && seeded.projectId === null,
        seeded
          ? `seed transaction ${seeded.id} amount ${seeded.amount}, projectId ${seeded.projectId}, ruleId ${seeded.ruleId}`
          : "no seed transaction was created"
      );
      finding(
        "money-008c",
        "the recurring-rule form asks for an amount in PKR inside a USD workspace",
        /PKR/.test(ruleAmountLabel ?? ""),
        `label is "${ruleAmountLabel}"`
      );

      const alertsAfter = await db.notification.findMany({
        where: { companyId: TENANT.id, category: "finance" },
        select: { title: true },
      });
      const budgetAlerts = alertsAfter.filter((a) => /budget/i.test(a.title));
      finding(
        "money-006b",
        "a recurring expense five times the size of the cap fires no budget warning at all",
        budgetAlerts.length === 0,
        `recurring amount 5000 against a cap of 1000; budget notifications in this tenant: ${budgetAlerts.length}`
      );
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-007 — the activity feed and the notification bodies hardcode
     * "PKR". These strings are PERSISTED, read by every teammate, and one of
     * them leaves the app in an email / lock-screen push.
     * Needs a second user, invited through the real invite flow.
     * ─────────────────────────────────────────────────────────────────────── */
    await page.goto(`${BASE}/team`, { waitUntil: "networkidle0" });
    if (!(await clickByText(page, "Invite member"))) {
      fail("money-007", "no 'Invite member' button on /team");
    } else {
      await dialogOpen(page);
      await setField(page, "Full name", `QA Cofounder ${STAMP}`);
      await setField(page, "Email", COFO_EMAIL);
      await clickByText(page, "Co-Founder");
      // Submit label is "Add to team" / "Add <First> to team".
      await clickByText(page, "to team");
      await dialogGone(page).catch(() => {});

      const invite = await db.inviteToken.findFirst({
        where: { companyId: TENANT.id, email: COFO_EMAIL },
        select: { token: true },
      });
      if (!invite) {
        fail("money-007", "invite token was not created for the cofounder");
      } else {
        const cofo = await newPage(browser);
        cofoCtx = cofo.ctx;
        await cofo.page.goto(`${BASE}/invite/${invite.token}`, { waitUntil: "networkidle0" });
        await cofo.page.waitForSelector('input[type="password"]');
        await cofo.page.type('input[type="password"]', PASSWORD);
        await cofo.page.click('button[type="submit"]');
        await cofo.page
          .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 60000 })
          .catch(() => {});
        const cofoUser = await db.user.findFirst({
          where: { companyId: TENANT.id, email: COFO_EMAIL },
          select: { id: true, role: true },
        });
        if (!cofoUser) {
          fail("money-007", "cofounder did not accept the invite");
        } else {
          ok(`cofounder ${cofoUser.id} joined as ${cofoUser.role}`);
          // One more expense, now that somebody else exists to be notified.
          await logExpense(page, { amount: "1234.56", desc: `qa-money ${STAMP} notify` });

          const acts = await db.activity.findMany({
            where: { companyId: TENANT.id, message: { contains: "1,234.56" } },
            select: { message: true },
          });
          finding(
            "money-007a",
            "the activity feed permanently records amounts labelled PKR in a USD workspace",
            acts.some((a) => /PKR/.test(a.message)),
            acts.length ? `stored message: "${acts[0].message}"` : "no matching activity row"
          );

          const notes = await db.notification.findMany({
            where: { companyId: TENANT.id, userId: cofoUser.id },
            select: { title: true, message: true },
          });
          finding(
            "money-007b",
            "the teammate's notification (and its email / push copy) quotes the amount as PKR in a USD workspace",
            notes.some((nn) => /PKR/.test(nn.message)),
            notes.length
              ? `stored message: "${notes.map((nn) => nn.message).join(" | ")}"`
              : "no notification rows for the cofounder"
          );

          // A cofounder sees the same money as the admin — the role check.
          await cofo.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
          const cofoTotal = moneyToNumber((await stat(cofo.page, "Total spend"))?.value);
          await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
          const adminTotal = moneyToNumber((await stat(page, "Total spend"))?.value);
          if (cofoTotal === adminTotal) ok(`admin and cofounder agree on total spend (${adminTotal})`);
          else fail("role agreement", `admin sees ${adminTotal}, cofounder sees ${cofoTotal}`);
        }
      }
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-012 — the CSV importer's amount sanitiser strips every character
     * that is not a digit, dot or minus. A "Rs. 1,000" cell (a PKR-formatted
     * spreadsheet, the product's home market) keeps the dot from "Rs." and
     * imports as 0.10. A European "1.234,56" imports as 1.23. Neither is
     * reported as an error — the row passes validation and lands.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      const csvPath = join(DOWNLOADS, `qa-money-${STAMP}-import.csv`);
      // Every row below is a real amount a spreadsheet exports. The `expect`
      // column is what the sanitiser actually produces, which is the bug.
      const cases = [
        { raw: "Rs. 1,000", meant: 1000, sanitised: 0.1, tag: "rs" },
        { raw: "1.234,56", meant: 1234.56, sanitised: 1.23, tag: "eu" },
        { raw: "1 234,56", meant: 1234.56, sanitised: 123456, tag: "space" },
      ];
      writeFileSync(
        csvPath,
        [
          "date,amount,category,description",
          ...cases.map(
            (c) => `${utcDay(new Date())},"${c.raw}",${CAT},qa-money ${STAMP} csv-${c.tag}`
          ),
        ].join("\n"),
        "utf8"
      );

      await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
      await clickByText(page, "Import CSV");
      await dialogOpen(page);
      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) {
        note("money-012 skipped — no file input in the import modal");
      } else {
        await fileInput.uploadFile(csvPath);
        // Wait for the preview to parse — a state predicate, not a sleep.
        await page
          .waitForFunction(() => /Import\s+\d/.test(document.body.innerText), { timeout: 20000 })
          .catch(() => {});
        await page.screenshot({ path: `${OUT}/12-csv-preview.png`, fullPage: true });
        // Scoped to the dialog: the page header still holds an "Import CSV"
        // button, and Radix portals the modal to the END of <body>, so an
        // unscoped match would re-click the header button instead.
        await clickByText(page, "Import ", '[role="dialog"] button');
        await dialogGone(page).catch(() => {});

        const imported = await db.transaction.findMany({
          where: { companyId: TENANT.id, description: { contains: `${STAMP} csv-` } },
          select: { amount: true, description: true },
        });
        const byTag = new Map(
          imported.map((r) => [r.description.split("csv-")[1], Number(r.amount)])
        );
        const wrong = cases.filter((c) => {
          const got = byTag.get(c.tag);
          return got !== undefined && Math.abs(got - c.meant) > 0.005;
        });
        finding(
          "money-012",
          "the CSV importer silently rewrites amounts it cannot parse — a cell reading 'Rs. 1,000' is imported as 0.10 and no row is reported as invalid",
          wrong.length > 0,
          wrong.length
            ? wrong.map((c) => `"${c.raw}" meant ${c.meant}, imported ${byTag.get(c.tag)}`).join("; ")
            : `all ${imported.length} rows imported at their intended value`
        );
      }
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-004 — the investor-facing XLSX labels a WINDOWED net flow as
     * "Net Balance" and its default window is the last 6 months, so the
     * exported figure is not the balance /dashboard shows.
     * ─────────────────────────────────────────────────────────────────────── */
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: DOWNLOADS,
      });
      await page.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
      await clickByText(page, "Export Excel");
      const file = await waitForDownload(DOWNLOADS, ".xlsx", 30000);
      if (!file) {
        note("money-004 — no .xlsx landed in the download dir; export check skipped");
      } else {
        const XLSX = await import("xlsx");
        const wb = XLSX.readFile(join(DOWNLOADS, file));
        const summary = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
        const findRow = (k) => summary.find((r) => String(r[0] ?? "").trim() === k);
        const netBalance = Number(findRow("Net Balance")?.[1]);
        const dateRange = String(findRow("Date range")?.[1] ?? "");
        const txns = XLSX.utils.sheet_to_json(wb.Sheets.Transactions, { header: 1 }).slice(1);

        const live = await db.transaction.findMany({
          where: { companyId: TENANT.id, deletedAt: null },
          select: { type: true, amount: true },
        });
        const trueBalance = live.reduce(
          (s, r) => s + (r.type === "expense" ? -Number(r.amount) : Number(r.amount)),
          0
        );
        finding(
          "money-004a",
          'the investor-ready export calls a 6-month net flow "Net Balance", so the exported balance is not the balance the app shows',
          Number.isFinite(netBalance) && Math.abs(netBalance - trueBalance) > 0.005,
          `export "Net Balance" = ${netBalance} over ${dateRange}; the workspace's actual balance is ${trueBalance}`
        );
        const hasCents = txns.some((r) => {
          const v = Number(r[5]);
          return Number.isFinite(v) && Math.abs(v % 1) > 0;
        });
        finding(
          "money-004b",
          "the spreadsheet export carries cents that no screen and no PDF row ever shows, so the two disagree row by row",
          hasCents,
          hasCents
            ? "at least one exported amount has a fractional part while the UI renders whole units only"
            : "no fractional amounts in the export"
        );
        await page.screenshot({ path: `${OUT}/09-reports-export.png`, fullPage: true });
      }
    } catch (e) {
      note(`money-004 export check could not run: ${e.message}`);
    }

    /* ───────────────────────────────────────────────────────────────────────
     * NEGATIVE RESULT — soft-deleted money is excluded from every aggregate.
     * Tombstone one of MY OWN rows and assert the dashboard total, the /budgets
     * spend and the project spend all drop by exactly that amount.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      const victim = await db.transaction.findFirst({
        where: { companyId: TENANT.id, description: { contains: `${STAMP} tagged600` } },
        select: { id: true, amount: true },
      });
      if (!victim) {
        note("negative-result soft-delete check skipped — fixture row missing");
      } else {
        await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
        const beforeTotal = moneyToNumber((await stat(page, "Total spend"))?.value);
        await page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0" });
        const beforeSpent = moneyToNumber(
          ((await page.evaluate(() => document.body.innerText)).match(
            /Spent\s+(-?\$\s?[\d,]+)/
          ) || [])[1]
        );

        await db.transaction.update({
          where: { id: victim.id },
          data: { deletedAt: new Date() },
        });

        await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
        const afterTotal = moneyToNumber((await stat(page, "Total spend"))?.value);
        await page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0" });
        const afterSpent = moneyToNumber(
          ((await page.evaluate(() => document.body.innerText)).match(
            /Spent\s+(-?\$\s?[\d,]+)/
          ) || [])[1]
        );
        const amt = Number(victim.amount);
        const totalDropped = Math.abs(beforeTotal - afterTotal - amt) <= 1;
        const spentDropped = Math.abs(beforeSpent - afterSpent - amt) <= 1;
        if (totalDropped && spentDropped) {
          ok(
            `NEGATIVE RESULT: a tombstoned transaction leaves every aggregate — total ${beforeTotal}->${afterTotal}, budget spend ${beforeSpent}->${afterSpent} (row was ${amt})`
          );
        } else {
          fail(
            "soft-deleted money still counted",
            `total ${beforeTotal}->${afterTotal}, budget spend ${beforeSpent}->${afterSpent}, row was ${amt}`
          );
        }
        // Restore MY OWN row so the later ceiling check has a clean sum.
        await db.transaction.update({ where: { id: victim.id }, data: { deletedAt: null } });
      }
    }

    /* ───────────────────────────────────────────────────────────────────────
     * NEGATIVE RESULT — a forged projectId from another tenant is refused and
     * writes nothing. Uses a REAL foreign project id, read only, never written.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      const foreign = await db.project.findFirst({
        where: { companyId: { not: TENANT.id } },
        select: { id: true, companyId: true },
      });
      if (!foreign) {
        note("cross-tenant forge check skipped — no foreign project to borrow an id from");
      } else {
        const before = (await myExpenses()).length;
        await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
        await clickByText(page, "Log expense");
        await dialogOpen(page);
        await setField(page, "Amount", "999");
        await setField(page, "Category", CAT);
        await setField(page, "Description", `qa-money ${STAMP} forged`);
        // The dropdown would never offer another tenant's project, so graft the
        // option in and let addTransactionAction be the thing under test.
        const forged = await forceSelectOption(page, "Project", foreign.id);
        if (forged !== "ok") {
          note(`cross-tenant forge check skipped — could not force the option (${forged})`);
        } else {
          await clickByText(page, "Add expense");
          // The action answers "Project not found"; the modal stays open.
          const refused = await page
            .waitForFunction(() => /project not found/i.test(document.body.innerText), {
              timeout: 15000,
            })
            .then(() => true)
            .catch(() => false);
          const after = (await myExpenses()).length;
          const leaked = await db.transaction.count({
            where: { companyId: TENANT.id, projectId: foreign.id },
          });
          if (refused && after === before && leaked === 0) {
            ok(
              `NEGATIVE RESULT: tagging an expense with another tenant's projectId is refused server-side — "Project not found", ${before} -> ${after} rows, 0 rows pointing at ${foreign.id}`
            );
          } else {
            fail(
              "forged cross-tenant projectId",
              `refused=${refused}, rows ${before} -> ${after}, rows tagged to the foreign project: ${leaked}`
            );
          }
          await page.screenshot({ path: `${OUT}/11-forged-project.png` });
          await page.keyboard.press("Escape").catch(() => {});
        }
      }
    }

    /* ───────────────────────────────────────────────────────────────────────
     * money-010 — getTransactions() caps at the 5,000 most recent rows and
     * every finance page aggregates client-side over that capped array, so a
     * busy workspace's totals silently understate with no indication.
     *
     * LAST, because it floods my own tenant. 5,050 rows of 1.00.
     * ─────────────────────────────────────────────────────────────────────── */
    {
      const FLOOD = 5050;
      const beforeSum = (await myExpenses()).reduce((s, r) => s + r.amount, 0);
      const base = Date.now();
      await db.transaction.createMany({
        data: Array.from({ length: FLOOD }, (_, i) => ({
          companyId: TENANT.id,
          type: "expense",
          amount: 1,
          category: CAT,
          description: `qa-money ${STAMP} flood ${i}`,
          // Spread backwards so the flood rows are the OLDEST and the cap's
          // `orderBy date desc / take 5000` is what drops them.
          date: new Date(base - (i + 1) * 3600_000),
          addedBy: TENANT.adminUserId,
          addedByName: `QA Money ${STAMP}`,
        })),
      });
      const dbSum = (await myExpenses()).reduce((s, r) => s + r.amount, 0);
      await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 120000 });
      const shown = moneyToNumber((await stat(page, "Total spend"))?.value);
      const shownCount = ((await stat(page, "Total spend"))?.delta ?? "").match(/[\d,]+/);
      finding(
        "money-010",
        "a workspace with more than 5,000 transactions sees understated totals everywhere, with nothing on screen saying rows were dropped",
        Number.isFinite(shown) && Math.abs(shown - Math.round(dbSum)) > 1,
        `DB expense sum ${dbSum} across ${(await myExpenses()).length} rows (was ${beforeSum} before the flood); /dashboard shows ${shown}, "${shownCount ? shownCount[0] : "?"} transactions"`
      );
      await page.screenshot({ path: `${OUT}/10-dashboard-5000-cap.png`, fullPage: true });
    }
  } catch (e) {
    fail("script threw", e.message);
    console.error(e);
  } finally {
    /* ── Clean up MY tenant only, children before parents. Mirrors the order
     *    scripts/_qa-guard.mjs uses so no Restrict FK can jam. ────────────── */
    try {
      if (TENANT.id) {
        const id = TENANT.id;
        await db.messageReaction.deleteMany({ where: { message: { companyId: id } } });
        await db.message.deleteMany({ where: { companyId: id } });
        await db.channelMember.deleteMany({ where: { channel: { companyId: id } } });
        await db.channel.deleteMany({ where: { companyId: id } });
        await db.comment.deleteMany({ where: { companyId: id } });
        await db.timeEntry.deleteMany({ where: { companyId: id } });
        await db.notification.deleteMany({ where: { companyId: id } });
        await db.activity.deleteMany({ where: { companyId: id } });
        await db.inviteToken.deleteMany({ where: { companyId: id } });
        await db.transaction.deleteMany({ where: { companyId: id } });
        await db.recurringRule.deleteMany({ where: { companyId: id } });
        await db.budget.deleteMany({ where: { companyId: id } });
        await db.task.deleteMany({ where: { companyId: id } });
        await db.project.deleteMany({ where: { companyId: id } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId: id } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId: id } } });
        await db.company.update({ where: { id }, data: { ownerId: null } }).catch(() => {});
        await db.user.deleteMany({ where: { companyId: id } });
        await db.company.delete({ where: { id } });
        ok(`tenant ${TENANT_NAME} removed`);
      }
    } catch (e) {
      console.error("cleanup failed:", e.message);
      process.exitCode = 1;
    }
    try {
      rmSync(DOWNLOADS, { recursive: true, force: true });
    } catch {
      /* not worth failing the run over */
    }
    await adminCtx?.close().catch(() => {});
    await cofoCtx?.close().catch(() => {});
    await browser.close();
    await db.$disconnect();
  }

  console.log(
    `\n== ${reproduced} finding(s) reproduced, ${cleared} cleared ==\n${
      process.exitCode ? "== FAIL ==" : "== pass =="
    }`
  );
}

/** Poll a directory for a finished download (no .crdownload) — state predicate. */
async function waitForDownload(dir, ext, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(dir);
    const done = files.find((f) => f.endsWith(ext));
    const pending = files.some((f) => f.endsWith(".crdownload"));
    if (done && !pending) return done;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

main().catch((err) => {
  console.error("qa-money-correctness threw:", err);
  process.exit(1);
});
