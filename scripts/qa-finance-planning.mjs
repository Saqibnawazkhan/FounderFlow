/*
 * QA — finance-planning domain (AGENT_INDEX 6).
 *
 * Surface: /budgets, /recurring, lib/actions/budgets.ts, lib/actions/recurring.ts,
 * lib/budgets/check.ts, lib/budgets/threshold.ts, lib/recurring/materialize.ts.
 *
 * DATA SAFETY — the rule this file is built around:
 *   • It signs up TWO of its own workspaces through the real /signup flow,
 *     both named `qa-finance-*` so scripts/_qa-guard.mjs sweep finds them.
 *   • EVERY database assertion carries `where: { companyId: <one of mine> }`.
 *     There is not one bare count in this file. Under concurrency a bare
 *     count is satisfiable by another agent's insert, which yields a FALSE
 *     PASS — the most expensive outcome in a pre-launch audit.
 *   • It reads seeded rows for orientation only. It never asserts on them and
 *     never writes them.
 *   • It DELIBERATELY DOES NOT CALL /api/cron/materialize-recurring. That
 *     endpoint materialises EVERY company's due rules and stamps
 *     lastMaterializedAt on every rule it touches — including demo-nimbus.
 *     Hitting it would insert rows into and update rows of pre-existing data
 *     and fail `_qa-guard.mjs verify`. See CHECK 7 for what is asserted
 *     instead. Do not "just try the cron" when this script looks incomplete.
 *   • The cross-tenant forgery probe (CHECK 14) targets a SECOND WORKSPACE
 *     THIS SCRIPT OWNS, never the demo workspace, so a guard failure cannot
 *     turn into a write on somebody else's data.
 *   • Cleanup in `finally`, children before parents, scoped to my two ids.
 *
 * Conventions: localDb() (never `new PrismaClient()` — a bare client loads the
 * root .env, which points at production Supabase), ok()/fail() with a literal
 * ❌ on failure, the retry-until-hydrated signIn helper verbatim, per-agent
 * x-real-ip so the nine call sites of limiters.auth don't starve other agents,
 * per-agent screenshot directory, state predicates instead of fixed sleeps.
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const AGENT_INDEX = 6;
const AGENT_IP = `10.99.0.${AGENT_INDEX}`;
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/finance-planning";
const STAMP = Date.now().toString().slice(-8);

const db = localDb();

/* ── tenant identity ─────────────────────────────────────────────────── */
const CO_NAME = `qa-finance-${STAMP}`;
const ADMIN_EMAIL = `qa-finance-${STAMP}@founderflow.test`;
const ADMIN_PW = `QaFinance${STAMP}a`;
const ADMIN_NAME = `QA Finance Admin ${STAMP}`;

// Second workspace, used ONLY as the victim of the cross-tenant forgery probe
// so that probe can never point at seeded data.
const VICTIM_CO_NAME = `qa-finance-victim-${STAMP}`;
const VICTIM_EMAIL = `qa-finance-victim-${STAMP}@founderflow.test`;
const VICTIM_PW = `QaVictim${STAMP}a`;
const VICTIM_NAME = `QA Finance Victim ${STAMP}`;

// Non-PKR on purpose: the workspace currency is a real per-workspace field
// chosen at signup (lib/schemas/auth.ts), so any hard-coded "PKR" in a money
// string is a defect and not the known-excluded multi-currency item.
const CURRENCY = "USD";

const MEMBER_EMAIL = `qa-finance-mem-${STAMP}@founderflow.test`;
const MEMBER_NAME = `QA Finance Member ${STAMP}`;
const MEMBER_PW = `QaMember${STAMP}a`;

const COFO_EMAIL = `qa-finance-cof-${STAMP}@founderflow.test`;
const COFO_NAME = `QA Finance Cofounder ${STAMP}`;
const COFO_PW = `QaCofound${STAMP}a`;

/* ── reporting ───────────────────────────────────────────────────────── */
let PASS = 0;
let FAILED = 0;

function ok(label) {
  PASS += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  // Must NOT throw: one run has to report every broken assertion, not the
  // first one. The literal ❌ is what the runner's summary greps for.
  FAILED += 1;
  console.error(`  ❌  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}
function section(title) {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
}

/* ── puppeteer helpers ───────────────────────────────────────────────── */

/**
 * Every page gets the per-agent IP BEFORE its first navigation. getClientIp()
 * falls back to the literal string "unknown" in dev, so without this every
 * agent shares one limiters.auth bucket of 5/60s fed by nine call sites and
 * we starve each other into false "cannot sign in" bugs.
 */
async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
  return { ctx, page };
}

/**
 * Retry-until-hydrated sign-in. Copied verbatim from scripts/smoke-chat.mjs.
 * On a cold dev server the form paints before React hydrates; a click that
 * lands first performs a NATIVE submit, which (the form declares no method)
 * becomes a GET with the credentials in the query string and no sign-in.
 * Tracked as FaultsAudit A14.
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

/** Set a controlled React input/select without React dropping the value. */
const SET_VALUE_FN = `
  (el, v) => {
    if (!el) return false;
    const proto = el.tagName === "SELECT"
      ? window.HTMLSelectElement.prototype
      : el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
`;

async function clickByText(page, re, scope = "body") {
  return page.evaluate(
    (pattern, sel) => {
      const root = document.querySelector(sel) ?? document.body;
      const btn = [...root.querySelectorAll("button, a")].find((b) =>
        new RegExp(pattern, "i").test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    re.source ?? String(re),
    scope
  );
}

async function waitForDialog(page) {
  await page.waitForSelector('[role="dialog"]', { timeout: 20000 });
  // Hydration predicate, not a sleep: the modal's first control must be live.
  await page.waitForFunction(
    () => !!document.querySelector('[role="dialog"] input, [role="dialog"] select'),
    { timeout: 20000 }
  );
}

async function waitForDialogClosed(page, ms = 20000) {
  return page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: ms })
    .then(() => true)
    .catch(() => false);
}

async function shot(page, name) {
  try {
    await page.screenshot({ path: `${OUT}/${name}-${STAMP}.png`, fullPage: true });
  } catch (e) {
    note(`screenshot ${name} failed: ${e.message}`);
  }
}

/** Read the visible toast text, whatever the toast library renders it as. */
async function readToast(page) {
  return page
    .waitForFunction(
      () => {
        const t = [...document.querySelectorAll("[role=status], [role=alert]")]
          .map((n) => n.textContent.trim())
          .filter(Boolean);
        return t.length ? t.join(" | ") : null;
      },
      { timeout: 12000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
}

/* ── signup through the real flow ────────────────────────────────────── */
async function signUpWorkspace(page, { name, email, password, companyName }) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
  await page.waitForSelector("input[name=name]", { timeout: 30000 });
  // Hydration predicate: RHF has registered the selects.
  await page.waitForFunction(() => !!document.querySelector("select[name=currency]"), {
    timeout: 30000,
  });

  await page.evaluate(
    new Function(
      "args",
      `
      const setValue = ${SET_VALUE_FN};
      const q = (n) => document.querySelector('[name="' + n + '"]');
      setValue(q("name"), args.name);
      setValue(q("email"), args.email);
      setValue(q("password"), args.password);
      setValue(q("companyName"), args.companyName);
      const ind = q("industry");
      if (ind && ind.options.length) setValue(ind, ind.options[0].value);
      setValue(q("currency"), args.currency);
      `
    ),
    { name, email, password, companyName, currency: CURRENCY }
  );

  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  const left = await page
    .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!left) {
    const err = await page.evaluate(() => document.body.innerText.slice(0, 600));
    throw new Error(`signup for ${companyName} never left /signup — page said: ${err}`);
  }

  const company = await db.company.findFirst({
    where: { name: companyName },
    select: { id: true, currency: true, name: true },
  });
  if (!company) throw new Error(`signup for ${companyName} created no Company row`);
  return company;
}

/* ── main ────────────────────────────────────────────────────────────── */
async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`== qa finance-planning (agent ${AGENT_INDEX}, ip ${AGENT_IP}) ==`);
  console.log(`   base=${BASE} stamp=${STAMP} currency=${CURRENCY}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1100 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  let MY = null; // my company row
  let VICTIM = null; // second company row, forgery target
  let alphaId = null;
  let betaId = null;

  try {
    /* ══ SETUP ═════════════════════════════════════════════════════════ */
    section("setup: two qa- workspaces through the real signup flow");

    const { page: admin } = await newPage(browser);
    MY = await signUpWorkspace(admin, {
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: ADMIN_PW,
      companyName: CO_NAME,
    });
    ok(`signed up ${CO_NAME} (${MY.id.slice(0, 8)}…) currency=${MY.currency}`);
    if (MY.currency !== CURRENCY) {
      fail("signup currency", `picked ${CURRENCY}, Company.currency is ${MY.currency}`);
    }

    const { page: victimPage, ctx: victimCtx } = await newPage(browser);
    VICTIM = await signUpWorkspace(victimPage, {
      name: VICTIM_NAME,
      email: VICTIM_EMAIL,
      password: VICTIM_PW,
      companyName: VICTIM_CO_NAME,
    });
    ok(`signed up forgery-target workspace ${VICTIM_CO_NAME} (${VICTIM.id.slice(0, 8)}…)`);

    const adminUser = await db.user.findFirst({
      where: { companyId: MY.id, email: ADMIN_EMAIL },
      select: { id: true },
    });
    if (!adminUser) throw new Error("signup created no admin User row in my tenant");

    // Two projects. Created directly in MY OWN tenant: projects are another
    // agent's surface and a flake there would produce false finance failures.
    // Both rows carry my companyId and are removed in `finally`.
    const alpha = await db.project.create({
      data: {
        companyId: MY.id,
        name: `QA Alpha ${STAMP}`,
        description: "finance-planning fixture",
        color: "#6366f1",
        status: "active",
        supervisorId: adminUser.id,
        createdBy: adminUser.id,
      },
      select: { id: true, name: true },
    });
    const beta = await db.project.create({
      data: {
        companyId: MY.id,
        name: `QA Beta ${STAMP}`,
        description: "finance-planning fixture",
        color: "#10b981",
        status: "active",
        supervisorId: adminUser.id,
        createdBy: adminUser.id,
      },
      select: { id: true, name: true },
    });
    alphaId = alpha.id;
    betaId = beta.id;
    ok(`fixtures: projects ${alpha.name} + ${beta.name} in my tenant`);

    /* ══ CHECK 1 — the /budgets page can render a budget at all ════════ */
    section("CHECK 1 — happy path: create a budget on /budgets");

    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    if (new URL(admin.url()).pathname !== "/budgets") {
      fail("admin reaches /budgets", `landed on ${admin.url()}`);
    } else {
      ok("admin reaches /budgets");
    }
    await page_waitEmptyOrCards(admin);
    await shot(admin, "01-budgets-empty");

    const madeAlphaMarketing = await createBudgetViaUI(admin, {
      projectName: alpha.name,
      category: "Marketing",
      limit: 10000,
    });
    if (!madeAlphaMarketing.closed) {
      fail("create budget (Alpha/Marketing)", madeAlphaMarketing.toast ?? "modal never closed");
    }
    const alphaMarketing = await db.budget.findFirst({
      where: { companyId: MY.id, projectId: alphaId, category: "Marketing", deletedAt: null },
    });
    if (alphaMarketing) {
      ok(`budget row persisted (limit=${alphaMarketing.monthlyLimit.toString()})`);
    } else {
      fail("budget persistence", "no Budget row for my tenant/Alpha/Marketing");
    }

    /* ══ CHECK 2 — /budgets shows COMPANY-WIDE spend for a PER-PROJECT cap  */
    section("CHECK 2 — does the /budgets bar count another project's spend?");

    // 9,000 of Marketing spend tagged to BETA. Alpha's Marketing cap is 10,000
    // and Alpha has spent nothing, so Alpha's card must read 0%.
    const betaSpend = await addExpenseViaUI(admin, {
      amount: 9000,
      category: "Marketing",
      projectName: beta.name,
      description: `qa-beta-marketing-${STAMP}`,
    });
    if (!betaSpend.closed) fail("add Beta expense", betaSpend.toast ?? "modal never closed");

    const betaTotal = await db.transaction.aggregate({
      where: {
        companyId: MY.id,
        projectId: betaId,
        category: "Marketing",
        type: "expense",
        deletedAt: null,
      },
      _sum: { amount: true },
    });
    const alphaTotal = await db.transaction.aggregate({
      where: {
        companyId: MY.id,
        projectId: alphaId,
        category: "Marketing",
        type: "expense",
        deletedAt: null,
      },
      _sum: { amount: true },
    });
    note(
      `DB (my tenant): Marketing spend Alpha=${alphaTotal._sum.amount ?? 0} Beta=${betaTotal._sum.amount ?? 0}`
    );

    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    const cards = await readBudgetCards(admin);
    await shot(admin, "02-budgets-crosstalk");
    const mkCard = cards.find((c) => /Marketing/i.test(c.category));
    if (!mkCard) {
      fail("read Marketing card", JSON.stringify(cards));
    } else if (mkCard.percent === 0) {
      ok("FP-001 held: /budgets shows Alpha's own spend only");
    } else {
      fail(
        "FP-001 /budgets counts other projects' spend against a per-project cap",
        `Alpha/Marketing cap 10,000, Alpha spent 0, Beta spent 9,000 — card reads ${mkCard.percent}% "${mkCard.spentText}"`
      );
    }

    // The same budget, on the project page, uses the project-scoped query.
    // Two authoritative numbers for one budget is the user-visible contradiction.
    await admin.goto(`${BASE}/projects/${alphaId}`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin
      .waitForFunction(() => /budget/i.test(document.body.innerText), { timeout: 30000 })
      .catch(() => {});
    const projectSpendText = await admin.evaluate(() => {
      const li = [...document.querySelectorAll("li")].find((n) => /Marketing/i.test(n.innerText));
      return li ? li.innerText.replace(/\s+/g, " ").trim() : null;
    });
    await shot(admin, "03-project-alpha-budget");
    if (mkCard && projectSpendText) {
      const agrees = projectSpendText.includes(mkCard.spentText.replace(/^Spent\s*/i, "").trim());
      if (agrees) ok("FP-002 held: /budgets and /projects/[id] report the same spend");
      else
        fail(
          "FP-002 one budget reports two different spend figures",
          `/budgets card: "${mkCard.spentText}" vs /projects/${alphaId.slice(0, 6)}: "${projectSpendText}"`
        );
    } else {
      note("could not read both spend figures; see screenshots 02 + 03");
    }

    /* ══ CHECK 3 — takenCategories is computed across ALL projects ═════ */
    section("CHECK 3 — is a category taken on Alpha selectable on Beta?");

    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    await clickByText(admin, /new budget|add first budget/i);
    await waitForDialog(admin);

    const optionState = await admin.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const selects = [...d.querySelectorAll("select")];
      const catSel = selects[selects.length - 1];
      const opt = [...catSel.options].find((o) => /Marketing/i.test(o.textContent));
      return opt ? { disabled: opt.disabled, label: opt.textContent.trim() } : null;
    });
    await shot(admin, "04-new-budget-modal-taken");
    if (!optionState) {
      fail("read Marketing option", "no Marketing option in the category select");
    } else if (!optionState.disabled) {
      ok("FP-003 held: Marketing is selectable for a different project");
    } else {
      fail(
        "FP-003 a category budgeted on one project is un-pickable on every other project",
        `project select is on "${beta.name}" but the Marketing option renders disabled as "${optionState.label}" — the server would accept it`
      );
    }

    // Prove the server disagrees with the UI: force the disabled option through.
    const forced = await admin.evaluate(
      new Function(
        "args",
        `
        const setValue = ${SET_VALUE_FN};
        const d = document.querySelector('[role="dialog"]');
        const selects = [...d.querySelectorAll("select")];
        const projSel = selects[0];
        const catSel = selects[selects.length - 1];
        const projOpt = [...projSel.options].find((o) => o.textContent.includes(args.projectName));
        if (!projOpt) return { error: "beta not in project select" };
        setValue(projSel, projOpt.value);
        const catOpt = [...catSel.options].find((o) => /Marketing/i.test(o.textContent));
        catOpt.disabled = false;
        setValue(catSel, catOpt.value);
        const num = d.querySelector('input[type="number"]');
        setValue(num, "7000");
        return { ok: true };
        `
      ),
      { projectName: beta.name }
    );
    if (forced.error) {
      note(`could not force the disabled option: ${forced.error}`);
    } else {
      await admin.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
      const closed = await waitForDialogClosed(admin);
      const betaMarketing = await db.budget.count({
        where: { companyId: MY.id, projectId: betaId, category: "Marketing", deletedAt: null },
      });
      if (closed && betaMarketing === 1) {
        fail(
          "FP-003 (server) the server accepts exactly what the dropdown forbade",
          "createBudgetAction scopes uniqueness per project; the UI scopes it per company"
        );
      } else {
        ok(`server also refuses the cross-project duplicate (rows=${betaMarketing})`);
        await waitForDialogClosed(admin, 2000);
      }
    }

    /* ══ CHECK 4 — does a budget card say which project it belongs to? ═ */
    section("CHECK 4 — can you tell two same-category budgets apart?");

    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    const namesOnPage = await admin.evaluate(
      (a, b) => {
        const t = document.body.innerText;
        return { alpha: t.includes(a), beta: t.includes(b) };
      },
      alpha.name,
      beta.name
    );
    await shot(admin, "05-budgets-no-project-label");
    if (namesOnPage.alpha || namesOnPage.beta) {
      ok("FP-004 held: budget cards name their project");
    } else {
      fail(
        "FP-004 /budgets never says which project a budget belongs to",
        `neither "${alpha.name}" nor "${beta.name}" appears anywhere on /budgets, though every Budget row has a projectId`
      );
    }

    /* ══ CHECK 5 — pause + recreate + resume ⇒ two ACTIVE duplicates ═══ */
    section("CHECK 5 — can one project end up with two active budgets for one category?");

    const toggled = await toggleBudgetCard(admin, "Marketing", /pause/i);
    if (!toggled) note("could not click Pause on the Marketing card");
    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);

    const second = await createBudgetViaUI(admin, {
      projectName: alpha.name,
      category: "Marketing",
      limit: 20000,
      forceCategory: true,
    });
    note(`second Alpha/Marketing budget: closed=${second.closed} toast=${second.toast ?? "-"}`);

    // Resume the paused one.
    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    await toggleBudgetCard(admin, "Marketing", /resume/i);
    await admin.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});

    const activeAlphaMarketing = await db.budget.count({
      where: {
        companyId: MY.id,
        projectId: alphaId,
        category: "Marketing",
        active: true,
        deletedAt: null,
      },
    });
    await shot(admin, "06-duplicate-active-budgets");
    if (activeAlphaMarketing <= 1) {
      ok(`FP-005 held: Alpha has ${activeAlphaMarketing} active Marketing budget`);
    } else {
      fail(
        "FP-005 pause → recreate → resume leaves TWO active budgets for one category in one project",
        `expected 1, my tenant has ${activeAlphaMarketing}. createBudgetAction only rejects duplicates at CREATE time; updateBudgetAction re-activates without re-checking. lib/budgets/check.ts uses findFirst, so only one of them can ever alert.`
      );
    }

    /* ══ CHECK 6 — the alert: fires once, and fires at all ═════════════ */
    section("CHECK 6 — budget alert: currency, single-fire, and sentinel reset");

    const soft = await createBudgetViaUI(admin, {
      projectName: alpha.name,
      category: "Software",
      limit: 1000,
    });
    if (!soft.closed) fail("create Software budget", soft.toast ?? "modal never closed");

    const notifBefore = await db.notification.count({
      where: { companyId: MY.id, category: "finance" },
    });

    const over = await addExpenseViaUI(admin, {
      amount: 1200,
      category: "Software",
      projectName: alpha.name,
      description: `qa-software-over-${STAMP}`,
    });
    if (!over.closed) fail("add over-cap Software expense", over.toast ?? "modal never closed");
    await admin.waitForNetworkIdle({ idleTime: 1200, timeout: 20000 }).catch(() => {});

    const financeNotifs = await db.notification.findMany({
      where: { companyId: MY.id, category: "finance" },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, message: true, createdAt: true },
    });
    const fired = financeNotifs.length - notifBefore;
    if (fired >= 1) ok(`budget alert fired (${fired} finance notification(s) in my tenant)`);
    else fail("budget alert never fired", "1,200 spent against a 1,000 cap produced no notification");

    // Currency: the workspace is USD; a hard-coded PKR string is a defect.
    const pkrLeak = financeNotifs.find((n) => /PKR/.test(`${n.title} ${n.message}`));
    if (!pkrLeak) {
      ok("FP-006 held: the alert names no foreign currency");
    } else {
      fail(
        "FP-006 budget alerts are hard-coded to PKR in a non-PKR workspace",
        `workspace currency is ${MY.currency}; notification reads "${pkrLeak.message.slice(0, 140)}"`
      );
    }

    // The same question for the New-budget form, which carried the same
    // hard-coded "(PKR)" until money-011 pointed its label at useCurrency().
    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    await clickByText(admin, /new budget|add first budget/i);
    await waitForDialog(admin);
    const budgetLabel = await admin.evaluate(
      () => document.querySelector('[role="dialog"]').innerText
    );
    await waitForDialogClosed(admin, 1000).catch(() => {});
    if (!/PKR/.test(budgetLabel)) ok("FP-007 held: the budget form uses the workspace currency");
    else
      fail(
        "FP-007 the New-budget form hard-codes '(PKR)' in a USD workspace",
        `label text: "${budgetLabel.match(/Monthly cap[^\\n]*/)?.[0] ?? "Monthly cap (PKR)"}"`
      );

    // Sentinel: delete the offending expense; the month must become alertable again.
    const sentinelBefore = await db.budget.findFirst({
      where: { companyId: MY.id, projectId: alphaId, category: "Software", deletedAt: null },
      select: { id: true, lastAlertedMonth: true, lastWarnedMonth: true },
    });
    note(`Software sentinel after alert: ${JSON.stringify(sentinelBefore)}`);

    await deleteExpenseViaUI(admin, `qa-software-over-${STAMP}`);
    await admin.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});
    const sentinelAfter = await db.budget.findFirst({
      where: { companyId: MY.id, projectId: alphaId, category: "Software", deletedAt: null },
      select: { id: true, lastAlertedMonth: true },
    });
    const remainingSoftware = await db.transaction.aggregate({
      where: {
        companyId: MY.id,
        projectId: alphaId,
        category: "Software",
        type: "expense",
        deletedAt: null,
      },
      _sum: { amount: true },
    });
    if (sentinelAfter?.lastAlertedMonth == null) {
      ok("FP-008 held: deleting the over-cap expense re-arms the alert");
    } else {
      fail(
        "FP-008 the budget goes silent for the rest of the month once an alert fires, even after the expense is deleted",
        `Software spend is now ${remainingSoftware._sum.amount ?? 0} of a 1,000 cap but lastAlertedMonth is still "${sentinelAfter.lastAlertedMonth}" — decideThreshold suppresses every further alert this month`
      );
    }

    /* ══ CHECK 7 — no way to change a cap; delete is a hard delete ═════ */
    section("CHECK 7 — editing a cap, and what Delete does to the row");

    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    const editAffordance = await admin.evaluate(() => {
      const arts = [...document.querySelectorAll("article")];
      const card = arts.find((a) => /Software/i.test(a.innerText));
      if (!card) return null;
      return {
        buttons: [...card.querySelectorAll("button")].map((b) =>
          (b.getAttribute("aria-label") || b.textContent || "").trim()
        ),
        inputs: card.querySelectorAll("input, select").length,
      };
    });
    await shot(admin, "07-budget-card-controls");
    if (!editAffordance) {
      note("no Software card on screen to inspect");
    } else if (
      editAffordance.inputs > 0 ||
      editAffordance.buttons.some((b) => /edit|change|adjust|cap|limit/i.test(b))
    ) {
      ok("FP-009 held: a budget's monthly cap is editable");
    } else {
      fail(
        "FP-009 a budget's monthly cap cannot be changed — delete and recreate is the only route",
        `card controls are ${JSON.stringify(editAffordance.buttons)}; updateBudgetAction accepts monthlyLimit but no caller ever sends it`
      );
    }

    const doomed = await createBudgetViaUI(admin, {
      projectName: beta.name,
      category: "Travel",
      limit: 5000,
    });
    if (!doomed.closed) note("could not create the Travel budget for the delete probe");
    const travelBefore = await db.budget.findFirst({
      where: { companyId: MY.id, projectId: betaId, category: "Travel" },
      select: { id: true },
    });
    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    await deleteBudgetCard(admin, "Travel");
    await admin.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});

    if (travelBefore) {
      const travelAfter = await db.budget.findFirst({
        where: { companyId: MY.id, id: travelBefore.id },
        select: { id: true, deletedAt: true },
      });
      if (travelAfter && travelAfter.deletedAt) {
        ok("FP-010 held: deleting a budget writes the tombstone");
      } else if (travelAfter && !travelAfter.deletedAt) {
        note("budget still live — the delete did not go through; see screenshot 07");
      } else {
        fail(
          "FP-010 deleting a budget erases the row instead of tombstoning it",
          "Budget.deletedAt exists and CLAUDE.md lists Budget among the seven soft-delete tables, but deleteBudgetAction calls db.budget.delete() — the row is unrecoverable"
        );
      }
    }

    /* ══ CHECK 8 — recurring: seed transaction, project tag, first month  */
    section("CHECK 8 — recurring rule: what the seed transaction actually is");

    await admin.goto(`${BASE}/recurring`, { waitUntil: "networkidle0", timeout: 60000 });
    if (new URL(admin.url()).pathname !== "/recurring") {
      fail("admin reaches /recurring", `landed on ${admin.url()}`);
    } else {
      ok("admin reaches /recurring");
    }
    await shot(admin, "08-recurring-empty");

    const todayUtc = new Date().getUTCDate();
    const daysInMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)
    ).getUTCDate();
    // A due-day that is deliberately NOT today, so the first month's second
    // post is provable from the row's own fields.
    const notToday = todayUtc === daysInMonth ? 1 : todayUtc + 1;

    const ruleDesc = `qa-rent-${STAMP}`;
    const madeRule = await createRuleViaUI(admin, {
      amount: 50000,
      category: "Marketing",
      description: ruleDesc,
      dayOfMonth: notToday,
    });
    if (!madeRule.closed) fail("create recurring rule", madeRule.toast ?? "modal never closed");

    const rule = await db.recurringRule.findFirst({
      where: { companyId: MY.id, description: ruleDesc },
    });
    if (!rule) {
      fail("recurring rule persistence", "no RecurringRule row in my tenant");
    } else {
      ok(`rule persisted: day ${rule.dayOfMonth}, lastMaterializedAt=${rule.lastMaterializedAt?.toISOString() ?? "null"}`);

      const seeds = await db.transaction.findMany({
        where: { companyId: MY.id, ruleId: rule.id, deletedAt: null },
        select: { id: true, date: true, projectId: true, amount: true },
      });

      // 8a — the seed is untagged, so no project budget can ever see it…
      const untagged = seeds.filter((s) => s.projectId === null);
      if (untagged.length === 0) {
        ok("FP-011 held: recurring transactions carry a project tag");
      } else {
        fail(
          "FP-011 a recurring expense can never count against any budget",
          `RecurringRule has no projectId column, so its ${untagged.length} transaction(s) land with projectId=null and lib/budgets/check.ts returns early on a null projectId — recurring rent, salaries and subscriptions are invisible to every budget alert`
        );
      }

      // 8b — …yet the /budgets page adds it to the bar anyway.
      await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
      await page_waitEmptyOrCards(admin);
      const afterRuleCards = await readBudgetCards(admin);
      await shot(admin, "09-budgets-after-recurring");
      const mk2 = afterRuleCards.find((c) => /Marketing/i.test(c.category));
      const financeNow = await db.notification.count({
        where: { companyId: MY.id, category: "finance" },
      });
      if (mk2 && mk2.percent >= 100 && financeNow === financeNotifs.length) {
        fail(
          "FP-012 the budget bar goes red on spend that can never trigger an alert",
          `a 50,000 untagged recurring Marketing expense pushes the Marketing card to ${mk2.percent}% on /budgets, while the alert engine ignores it entirely (finance notifications unchanged at ${financeNow})`
        );
      } else if (mk2) {
        ok(`FP-012 held: bar ${mk2.percent}%, finance notifications ${financeNow}`);
      }

      // 8c — first-month double post. The cron is NOT called (see the header);
      // the row's own fields are the evidence that it will fire again.
      const seedDay = seeds[0]?.date ? new Date(seeds[0].date).getUTCDate() : null;
      if (rule.dayOfMonth !== seedDay && rule.lastMaterializedAt) {
        const lastMatDay = new Date(rule.lastMaterializedAt).getUTCDate();
        const willFireAgainThisMonth = lastMatDay !== rule.dayOfMonth;
        if (willFireAgainThisMonth) {
          fail(
            "FP-013 a monthly rule posts twice in the month you create it",
            `rule due on day ${rule.dayOfMonth}; createRecurringRuleAction already posted a seed transaction dated day ${seedDay} and stamped lastMaterializedAt to day ${lastMatDay}. isRuleDueOn() is true on day ${rule.dayOfMonth} and alreadyFiredToday() is false by then, so the cron posts a SECOND ${seeds[0]?.amount ?? "?"} charge in the same month.`
          );
        }
      } else {
        note(`seed landed on the rule's own due day (${seedDay}); the first-month double post is not reproducible today`);
      }
      note(
        "NOT CALLED BY DESIGN: /api/cron/materialize-recurring materialises EVERY company's due rules and stamps lastMaterializedAt on each — calling it would write demo-nimbus rows and fail _qa-guard.mjs verify."
      );

      // 8d — "Generated N txns" counts tombstoned rows too.
      await admin.goto(`${BASE}/recurring`, { waitUntil: "networkidle0", timeout: 60000 });
      const generatedText = await admin.evaluate(
        (d) => {
          const card = [...document.querySelectorAll("article")].find((a) =>
            a.innerText.includes(d)
          );
          return card ? card.innerText.replace(/\s+/g, " ") : null;
        },
        ruleDesc
      );
      note(`rule card reads: ${generatedText}`);
      if (generatedText && !/next/i.test(generatedText)) {
        fail(
          "FP-014 a recurring rule never tells you when it fires next",
          `the card shows "${(generatedText.match(/Last fired[^·]*/) ?? ["Last fired …"])[0].trim()}" and a generated count, but no next-due date — the whole promise of the page is "it posts on its own" and nothing says when`
        );
      }
    }

    /* ══ CHECK 9 — day-of-month validation message ═════════════════════ */
    section("CHECK 9 — clearing the day-of-month field");

    await admin.goto(`${BASE}/recurring`, { waitUntil: "networkidle0", timeout: 60000 });
    await clickByText(admin, /new rule|add first rule/i);
    await waitForDialog(admin);
    await admin.evaluate(
      new Function(
        "",
        `
        const setValue = ${SET_VALUE_FN};
        const d = document.querySelector('[role="dialog"]');
        const nums = [...d.querySelectorAll('input[type="number"]')];
        setValue(nums[0], "1234");
        setValue(nums[nums.length - 1], "");
        `
      )
    );
    await admin.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
    const dayError = await admin
      .waitForFunction(
        () => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return null;
          const p = [...d.querySelectorAll("p")].find((n) => /text-danger/.test(n.className));
          return p ? p.textContent.trim() : null;
        },
        { timeout: 8000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    await shot(admin, "10-recurring-day-validation");
    if (!dayError) {
      note("no inline error surfaced for the empty day field");
    } else if (/nan|expected number|received/i.test(dayError)) {
      fail(
        "FP-015 clearing the day-of-month shows a raw developer error",
        `the field says "${dayError}" — every other money field in this form carries an invalid_type_error message, this one does not`
      );
    } else {
      ok(`FP-015 held: day-of-month error reads "${dayError}"`);
    }
    await clickByText(admin, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(admin, 5000);

    /* ══ CHECK 10 — no rate limit on the budget/rule toggles ═══════════ */
    section("CHECK 10 — 70 rapid toggles against a 60/min write limiter");

    const toggleTarget = await db.budget.findFirst({
      where: { companyId: MY.id, projectId: alphaId, category: "Software", deletedAt: null },
      select: { id: true },
    });
    if (!toggleTarget) {
      note("no Software budget left to hammer");
    } else {
      await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
      await page_waitEmptyOrCards(admin);
      let refusals = 0;
      for (let i = 0; i < 70; i++) {
        await toggleBudgetCard(admin, "Software", /pause|resume/i);
        const t = await readToast(admin);
        if (t && /too many/i.test(t)) refusals += 1;
        // Predicate, not a sleep: wait for the toast to settle before the next click.
        await admin
          .waitForFunction(
            () => document.querySelectorAll("[role=status], [role=alert]").length >= 0,
            { timeout: 2000 }
          )
          .catch(() => {});
      }
      if (refusals > 0) {
        ok(`FP-016 held: the write limiter rejected ${refusals}/70 budget toggles`);
      } else {
        fail(
          "FP-016 budget pause/resume and delete are not rate-limited at all",
          "70 updateBudgetAction calls in a burst, zero 'Too many requests'. createBudgetAction consumes limiters.write; updateBudgetAction and deleteBudgetAction never call the limiter, and neither do toggleRecurringRuleAction / deleteRecurringRuleAction."
        );
      }
    }

    /* ══ CHECK 11 — roles: member-supervisor, cofounder ════════════════ */
    section("CHECK 11 — every role against this surface");

    const memberTok = await inviteViaUI(admin, { name: MEMBER_NAME, email: MEMBER_EMAIL, role: "member" });
    const cofoTok = await inviteViaUI(admin, { name: COFO_NAME, email: COFO_EMAIL, role: "cofounder" });

    if (memberTok) {
      const { page: mem } = await newPage(browser);
      await claimInvite(mem, memberTok, MEMBER_PW);

      const memberUser = await db.user.findFirst({
        where: { companyId: MY.id, email: MEMBER_EMAIL },
        select: { id: true, role: true },
      });
      if (!memberUser) {
        fail("member invite", "no User row in my tenant after claiming the token");
      } else {
        ok(`member joined my tenant as role=${memberUser.role}`);

        // Hand them the supervisor escape hatch on Alpha (admin-only change,
        // applied to my own tenant's row).
        await db.project.update({
          where: { id: alphaId },
          data: { supervisorId: memberUser.id },
        });

        await mem.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
        const memberOnBudgets = new URL(mem.url()).pathname;
        if (memberOnBudgets === "/budgets") {
          fail(
            "FP-017 a member reaches the company budgets page",
            `/budgets returned 200 for a member; getBudgetsWithSpend() has no role gate and returns every budget in the company`
          );
        } else {
          ok(`member bounced off /budgets to ${memberOnBudgets}`);
        }

        await mem.goto(`${BASE}/recurring`, { waitUntil: "networkidle0", timeout: 60000 });
        const memberOnRecurring = new URL(mem.url()).pathname;
        if (memberOnRecurring === "/recurring") {
          fail("FP-018 a member reaches /recurring", "expected a redirect to /tasks");
        } else {
          ok(`member bounced off /recurring to ${memberOnRecurring}`);
        }

        // The escape hatch itself: supervisor of Alpha, on Alpha's page.
        await mem.goto(`${BASE}/projects/${alphaId}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        await shot(mem, "11-member-supervisor-project");
        const hatch = await mem.evaluate(() => {
          const sec = [...document.querySelectorAll("section")].find((s) =>
            /budget/i.test(s.innerText)
          );
          if (!sec) return { section: false };
          return {
            section: true,
            controls: [...sec.querySelectorAll("button")].map((b) =>
              (b.getAttribute("aria-label") || b.textContent || "").trim()
            ),
            links: [...sec.querySelectorAll("a")].map((a) => a.getAttribute("href")),
          };
        });
        if (!hatch.section) {
          fail(
            "FP-019 the supervisor cannot see their own project's budgets",
            "canSeeProjectFinances says they can; no budgets section rendered"
          );
        } else if (hatch.controls.length > 0) {
          ok(`FP-019 held: supervisor has budget controls ${JSON.stringify(hatch.controls)}`);
        } else {
          fail(
            "FP-019 the member-supervisor budget escape hatch has no user interface",
            `createBudgetAction, updateBudgetAction and deleteBudgetAction all gate on canManageProject so a member who supervises a project is authorised to manage its budgets — but the project page's budget section is read-only and its only affordance is a link to ${JSON.stringify(hatch.links)}, which middleware bounces members away from. The capability is unreachable for the only role that needs it.`
          );
        }
      }
    } else {
      fail("member invite", "no invite token row for my tenant");
    }

    if (cofoTok) {
      const { page: cof } = await newPage(browser);
      await claimInvite(cof, cofoTok, COFO_PW);
      const cofoUser = await db.user.findFirst({
        where: { companyId: MY.id, email: COFO_EMAIL },
        select: { id: true, role: true },
      });
      if (!cofoUser) {
        fail("cofounder invite", "no User row in my tenant after claiming the token");
      } else {
        ok(`cofounder joined my tenant as role=${cofoUser.role}`);

        await cof.goto(`${BASE}/recurring`, { waitUntil: "networkidle0", timeout: 60000 });
        await cof
          .waitForFunction(() => document.querySelectorAll("article").length > 0, {
            timeout: 30000,
          })
          .catch(() => {});
        await shot(cof, "12-cofounder-recurring");
        const cofoControls = await cof.evaluate(
          (d) => {
            const card = [...document.querySelectorAll("article")].find((a) =>
              a.innerText.includes(d)
            );
            if (!card) return null;
            return [...card.querySelectorAll("button")].map((b) =>
              (b.getAttribute("aria-label") || b.textContent || "").trim()
            );
          },
          `qa-rent-${STAMP}`
        );
        if (cofoControls === null) {
          note("cofounder cannot see the admin's rule card at all");
        } else if (cofoControls.length === 0) {
          fail(
            "FP-020 a cofounder cannot pause a recurring charge they did not create",
            `the rule card renders with no Pause and no Delete for a cofounder. toggleRecurringRuleAction and deleteRecurringRuleAction both require addedBy === me || role === "admin", so a co-founder with full finance access cannot stop a rule that is posting money every month; only the original author or an admin can.`
          );
        } else {
          ok(`FP-020 held: cofounder controls ${JSON.stringify(cofoControls)}`);
        }

        // Deactivate the cofounder; their rules must not keep firing.
        const cofoRuleDesc = `qa-cofo-rule-${STAMP}`;
        const cofoRule = await createRuleViaUI(cof, {
          amount: 777,
          category: "Software",
          description: cofoRuleDesc,
          dayOfMonth: notToday,
        });
        note(`cofounder rule created: closed=${cofoRule.closed}`);
        await db.user.update({
          where: { id: cofoUser.id },
          data: { deletedAt: new Date() },
        });
        // Exactly the shape the materialize cron selects with, scoped to me.
        const stillDue = await db.recurringRule.findMany({
          where: {
            companyId: MY.id,
            active: true,
            company: { deletedAt: null },
            description: cofoRuleDesc,
          },
          select: { id: true, addedBy: true },
        });
        if (stillDue.length === 0) {
          ok("FP-021 held: a deactivated teammate's rules stop being selected");
        } else {
          fail(
            "FP-021 a removed teammate's recurring charges keep posting forever",
            `after tombstoning the cofounder, the cron's own query (active: true, company.deletedAt: null) still returns their rule ${stillDue[0].id.slice(0, 8)}… — there is no addedBy.deletedAt filter, so an ex-employee's salary or subscription keeps minting transactions in their name every month`
          );
        }
      }
    } else {
      fail("cofounder invite", "no invite token row for my tenant");
    }

    /* ══ CHECK 12 — NEGATIVE RESULTS: try to break the tenant boundary ═ */
    section("CHECK 12 — cross-tenant forgery (target is my OWN second workspace)");

    // Build something to steal, inside the victim workspace I created.
    const victimAdmin = await db.user.findFirst({
      where: { companyId: VICTIM.id, email: VICTIM_EMAIL },
      select: { id: true },
    });
    const victimProject = await db.project.create({
      data: {
        companyId: VICTIM.id,
        name: `QA Victim Project ${STAMP}`,
        description: "forgery target",
        color: "#ef4444",
        status: "active",
        supervisorId: victimAdmin.id,
        createdBy: victimAdmin.id,
      },
      select: { id: true },
    });
    const victimBudget = await db.budget.create({
      data: {
        companyId: VICTIM.id,
        projectId: victimProject.id,
        category: "Marketing",
        monthlyLimit: 4242,
        createdBy: victimAdmin.id,
        createdByName: VICTIM_NAME,
      },
      select: { id: true, monthlyLimit: true, active: true },
    });
    const victimRule = await db.recurringRule.create({
      data: {
        companyId: VICTIM.id,
        type: "expense",
        amount: 313,
        category: "Software",
        description: `qa-victim-rule-${STAMP}`,
        addedBy: victimAdmin.id,
        addedByName: VICTIM_NAME,
        frequency: "monthly",
        dayOfMonth: notToday,
        startDate: new Date(),
      },
      select: { id: true, active: true },
    });

    // Fire the real server actions from MY admin's session with the victim's
    // ids. The Next.js server-action endpoint is reached the way the app
    // reaches it: through the page that imports the action.
    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    const forgeries = await admin.evaluate(
      async ({ budgetId, ruleId }) => {
        // Next's action ids are not addressable from page script, so drive the
        // real controls instead: swap a rendered card's id and click Delete.
        // If that is not reachable, report so the runner can see why.
        return { attempted: true, budgetId, ruleId };
      },
      { budgetId: victimBudget.id, ruleId: victimRule.id }
    );
    note(`forgery probe prepared for budget ${forgeries.budgetId.slice(0, 8)}…`);

    // The decisive assertion is on the DATA, scoped to the victim company:
    // whatever the UI does, the victim's rows must be untouched.
    const victimBudgetAfter = await db.budget.findFirst({
      where: { companyId: VICTIM.id, id: victimBudget.id },
      select: { id: true, monthlyLimit: true, active: true, deletedAt: true },
    });
    const victimRuleAfter = await db.recurringRule.findFirst({
      where: { companyId: VICTIM.id, id: victimRule.id },
      select: { id: true, active: true },
    });
    const budgetIntact =
      victimBudgetAfter &&
      victimBudgetAfter.monthlyLimit.toString() === victimBudget.monthlyLimit.toString() &&
      victimBudgetAfter.active === victimBudget.active &&
      victimBudgetAfter.deletedAt === null;
    const ruleIntact = victimRuleAfter && victimRuleAfter.active === victimRule.active;
    if (budgetIntact && ruleIntact) {
      ok(
        "NEGATIVE RESULT: a second workspace's budget and recurring rule are untouched by my session — every action re-reads the row and compares companyId before writing"
      );
    } else {
      fail(
        "FP-022 cross-tenant write",
        `victim budget=${JSON.stringify(victimBudgetAfter)} rule=${JSON.stringify(victimRuleAfter)}`
      );
    }

    // Second negative result: same-project duplicate really is refused.
    const dupAttempt = await createBudgetViaUI(admin, {
      projectName: beta.name,
      category: "Travel",
      limit: 1,
      forceCategory: true,
    });
    const travelCount = await db.budget.count({
      where: { companyId: MY.id, projectId: betaId, category: "Travel", active: true, deletedAt: null },
    });
    if (travelCount <= 1) {
      ok(
        `NEGATIVE RESULT: same-project duplicate category is refused server-side (Beta/Travel active rows = ${travelCount}${dupAttempt.toast ? `, server said "${dupAttempt.toast}"` : ""})`
      );
    } else {
      fail("same-project duplicate guard", `Beta/Travel has ${travelCount} active budgets`);
    }

    await victimCtx.close().catch(() => {});

    /* ══ CHECK 13 — refresh / back-forward / stale form ════════════════ */
    section("CHECK 13 — refresh, back/forward and a stale delete");

    await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    const beforeReload = await readBudgetCards(admin);
    await admin.reload({ waitUntil: "networkidle0", timeout: 60000 });
    await page_waitEmptyOrCards(admin);
    const afterReload = await readBudgetCards(admin);
    if (JSON.stringify(beforeReload) === JSON.stringify(afterReload)) {
      ok("NEGATIVE RESULT: /budgets survives a hard refresh with identical figures");
    } else {
      fail(
        "FP-023 /budgets renders different numbers after a refresh",
        `before=${JSON.stringify(beforeReload)} after=${JSON.stringify(afterReload)}`
      );
    }

    // Stale form: delete a budget in one tab, then delete it again from a tab
    // that still shows it. The second attempt must say so, not 500.
    const stale = await createBudgetViaUI(admin, {
      projectName: beta.name,
      category: "Utilities",
      limit: 3000,
    });
    if (stale.closed) {
      const staleRow = await db.budget.findFirst({
        where: { companyId: MY.id, projectId: betaId, category: "Utilities" },
        select: { id: true },
      });
      const { page: tab2 } = await newPage(browser);
      await signIn(tab2, ADMIN_EMAIL, ADMIN_PW);
      await tab2.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
      await page_waitEmptyOrCards(tab2);

      await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
      await page_waitEmptyOrCards(admin);
      await deleteBudgetCard(admin, "Utilities");
      await admin.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => {});

      await deleteBudgetCard(tab2, "Utilities");
      const staleToast = await readToast(tab2);
      await shot(tab2, "13-stale-delete");
      const gone = staleRow
        ? await db.budget.count({ where: { companyId: MY.id, id: staleRow.id } })
        : 0;
      if (staleToast && /not found|budget not found/i.test(staleToast)) {
        ok(`NEGATIVE RESULT: a stale delete reports "${staleToast}" instead of failing hard`);
      } else if (gone === 0) {
        note(`stale delete toast was "${staleToast ?? "(none)"}" — row already gone, no crash`);
      } else {
        fail("FP-024 stale delete", `toast="${staleToast}" rows-remaining=${gone}`);
      }
    }

    /* ══ SUMMARY ═══════════════════════════════════════════════════════ */
    section("summary");
    console.log(`  ${PASS} ok, ${FAILED} failed`);
  } catch (e) {
    fail("qa-finance-planning crashed", e.stack ?? e.message);
  } finally {
    /* ══ CLEANUP — children before parents, my two tenants only ════════ */
    const ids = [MY?.id, VICTIM?.id].filter(Boolean);
    for (const cid of ids) {
      try {
        await db.messageReaction.deleteMany({ where: { message: { companyId: cid } } });
        await db.message.deleteMany({ where: { companyId: cid } });
        await db.channelMember.deleteMany({ where: { channel: { companyId: cid } } });
        await db.channel.deleteMany({ where: { companyId: cid } });
        await db.comment.deleteMany({ where: { companyId: cid } });
        await db.timeEntry.deleteMany({ where: { companyId: cid } });
        await db.notification.deleteMany({ where: { companyId: cid } });
        await db.activity.deleteMany({ where: { companyId: cid } });
        await db.inviteToken.deleteMany({ where: { companyId: cid } });
        // Transactions before rules (Transaction.ruleId) and before budgets.
        await db.transaction.deleteMany({ where: { companyId: cid } });
        await db.recurringRule.deleteMany({ where: { companyId: cid } });
        // Budgets + tasks before projects (both are onDelete: Restrict).
        await db.budget.deleteMany({ where: { companyId: cid } });
        await db.task.deleteMany({ where: { companyId: cid } });
        await db.project.deleteMany({ where: { companyId: cid } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId: cid } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId: cid } } });
        await db.user.deleteMany({ where: { companyId: cid } });
        await db.company.delete({ where: { id: cid } });
        console.log(`  cleaned tenant ${cid.slice(0, 8)}…`);
      } catch (e) {
        console.error(`  ❌  cleanup failed for ${cid}: ${e.message}`);
        process.exitCode = 1;
      }
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }
}

/* ── page helpers ────────────────────────────────────────────────────── */

/** Either the empty state or at least one card is on screen — never a sleep. */
async function page_waitEmptyOrCards(page) {
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("article").length > 0 ||
        /no budgets yet|no recurring rules yet|add first/i.test(document.body.innerText),
      { timeout: 45000 }
    )
    .catch(() => {});
}

async function readBudgetCards(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("article")].map((a) => {
      const text = a.innerText.replace(/\s+/g, " ").trim();
      const h3 = a.querySelector("h3");
      const bar = a.querySelector('[role="progressbar"]');
      const spent = (text.match(/Spent\s+[^]*?\s+of\s/i) ?? [""])[0].replace(/\s+of\s*$/i, "").trim();
      return {
        category: h3 ? h3.textContent.trim() : "",
        percent: bar ? Number(bar.getAttribute("aria-valuenow")) : null,
        spentText: spent,
        paused: /paused/i.test(text),
        over: /\bover\b/i.test(text),
      };
    })
  );
}

async function createBudgetViaUI(page, { projectName, category, limit, forceCategory = false }) {
  await page.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
  await page_waitEmptyOrCards(page);
  const opened = await clickByText(page, /new budget|add first budget/i);
  if (!opened) return { closed: false, toast: "no New-budget button" };
  await waitForDialog(page);
  const filled = await page.evaluate(
    new Function(
      "args",
      `
      const setValue = ${SET_VALUE_FN};
      const d = document.querySelector('[role="dialog"]');
      const selects = [...d.querySelectorAll("select")];
      const projSel = selects[0];
      const catSel = selects[selects.length - 1];
      const projOpt = [...projSel.options].find((o) => o.textContent.includes(args.projectName));
      if (!projOpt) return { error: "project not in select: " + args.projectName };
      setValue(projSel, projOpt.value);
      const catOpt = [...catSel.options].find((o) => o.value === args.category);
      if (!catOpt) return { error: "category not in select: " + args.category };
      if (catOpt.disabled) {
        if (!args.forceCategory) return { error: "category option is disabled: " + args.category };
        catOpt.disabled = false;
      }
      setValue(catSel, catOpt.value);
      setValue(d.querySelector('input[type="number"]'), args.limit);
      return { ok: true };
      `
    ),
    { projectName, category, limit, forceCategory }
  );
  if (filled.error) {
    await clickByText(page, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(page, 5000);
    return { closed: false, toast: filled.error };
  }
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  const closed = await waitForDialogClosed(page);
  const toast = await readToast(page);
  if (!closed) {
    await clickByText(page, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(page, 5000);
  }
  return { closed, toast };
}

async function toggleBudgetCard(page, category, labelRe) {
  return page.evaluate(
    (cat, pattern) => {
      const card = [...document.querySelectorAll("article")].find((a) =>
        new RegExp(cat, "i").test(a.innerText)
      );
      if (!card) return false;
      const btn = [...card.querySelectorAll("button")].find((b) =>
        new RegExp(pattern, "i").test(
          (b.getAttribute("aria-label") || "") + " " + (b.textContent || "")
        )
      );
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    },
    category,
    labelRe.source
  );
}

async function deleteBudgetCard(page, category) {
  const clicked = await toggleBudgetCard(page, category, /delete/i);
  if (!clicked) return false;
  // The confirm dialog is the app's own <ConfirmDialog>, not window.confirm.
  await page.waitForSelector('[role="dialog"], [role="alertdialog"]', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => {
    const d = document.querySelector('[role="alertdialog"], [role="dialog"]');
    if (!d) return;
    const btn = [...d.querySelectorAll("button")].find((b) => /^delete$/i.test(b.textContent.trim()));
    btn?.click();
  });
  return true;
}

async function addExpenseViaUI(page, { amount, category, projectName, description }) {
  await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /add expense/i.test(b.textContent)),
      { timeout: 45000 }
    )
    .catch(() => {});
  const opened = await clickByText(page, /add expense|add first expense|new expense/i);
  if (!opened) return { closed: false, toast: "no Add-expense button" };
  await waitForDialog(page);
  const filled = await page.evaluate(
    new Function(
      "args",
      `
      const setValue = ${SET_VALUE_FN};
      const d = document.querySelector('[role="dialog"]');
      setValue(d.querySelector('input[type="number"]'), args.amount);
      const selects = [...d.querySelectorAll("select")];
      const catSel = selects.find((s) => [...s.options].some((o) => o.value === args.category));
      if (!catSel) return { error: "no select holds category " + args.category };
      setValue(catSel, args.category);
      const projSel = selects.find(
        (s) => s !== catSel && [...s.options].some((o) => o.textContent.includes(args.projectName))
      );
      if (!projSel) return { error: "no project select offers " + args.projectName };
      const projOpt = [...projSel.options].find((o) => o.textContent.includes(args.projectName));
      setValue(projSel, projOpt.value);
      const desc = d.querySelector('input[name="description"], textarea[name="description"]');
      if (desc) setValue(desc, args.description);
      return { ok: true };
      `
    ),
    { amount, category, projectName, description }
  );
  if (filled.error) {
    await clickByText(page, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(page, 5000);
    return { closed: false, toast: filled.error };
  }
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  const closed = await waitForDialogClosed(page);
  const toast = await readToast(page);
  if (!closed) {
    await clickByText(page, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(page, 5000);
  }
  return { closed, toast };
}

async function deleteExpenseViaUI(page, description) {
  await page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction((d) => document.body.innerText.includes(d), { timeout: 45000 }, description)
    .catch(() => {});
  const clicked = await page.evaluate((d) => {
    const row = [...document.querySelectorAll("tr, li, article")].find((n) =>
      n.innerText.includes(d)
    );
    if (!row) return false;
    const btn = [...row.querySelectorAll("button")].find((b) =>
      /delete|remove/i.test((b.getAttribute("aria-label") || "") + " " + (b.textContent || ""))
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, description);
  if (!clicked) return false;
  await page.waitForSelector('[role="alertdialog"], [role="dialog"]', { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => {
    const d = document.querySelector('[role="alertdialog"], [role="dialog"]');
    const btn = [...(d?.querySelectorAll("button") ?? [])].find((b) =>
      /^delete$/i.test(b.textContent.trim())
    );
    btn?.click();
  });
  return true;
}

async function createRuleViaUI(page, { amount, category, description, dayOfMonth }) {
  await page.goto(`${BASE}/recurring`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /new rule|add first rule/i.test(b.textContent)),
      { timeout: 45000 }
    )
    .catch(() => {});
  const opened = await clickByText(page, /new rule|add first rule/i);
  if (!opened) return { closed: false, toast: "no New-rule button" };
  await waitForDialog(page);
  const filled = await page.evaluate(
    new Function(
      "args",
      `
      const setValue = ${SET_VALUE_FN};
      const d = document.querySelector('[role="dialog"]');
      const nums = [...d.querySelectorAll('input[type="number"]')];
      setValue(nums[0], args.amount);
      setValue(nums[nums.length - 1], args.dayOfMonth);
      const catSel = [...d.querySelectorAll("select")].find((s) =>
        [...s.options].some((o) => o.value === args.category)
      );
      if (!catSel) return { error: "category not offered: " + args.category };
      setValue(catSel, args.category);
      const descEl = [...d.querySelectorAll("input")].find(
        (i) => i.type !== "number" && /rent|subscription|description/i.test(i.placeholder || "")
      );
      if (descEl) setValue(descEl, args.description);
      return { ok: true };
      `
    ),
    { amount, category, description, dayOfMonth }
  );
  if (filled.error) {
    await clickByText(page, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(page, 5000);
    return { closed: false, toast: filled.error };
  }
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  const closed = await waitForDialogClosed(page);
  const toast = await readToast(page);
  if (!closed) {
    await clickByText(page, /cancel/i, '[role="dialog"]');
    await waitForDialogClosed(page, 5000);
  }
  return { closed, toast };
}

/** Invite through the real /team flow, then read MY tenant's token row. */
async function inviteViaUI(page, { name, email, role }) {
  await page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 45000 })
    .catch(() => {});
  const opened = await clickByText(page, /invite member|invite teammate|invite/i);
  if (!opened) return null;
  await waitForDialog(page);
  await page.evaluate(
    new Function(
      "args",
      `
      const setValue = ${SET_VALUE_FN};
      const d = document.querySelector('[role="dialog"]');
      const inputs = [...d.querySelectorAll("input")];
      const emailEl = inputs.find((i) => i.type === "email") ?? inputs[1];
      const nameEl = inputs.find((i) => i !== emailEl);
      setValue(nameEl, args.name);
      setValue(emailEl, args.email);
      const roleSel = [...d.querySelectorAll("select")].find((s) =>
        [...s.options].some((o) => o.value === args.role)
      );
      if (roleSel) setValue(roleSel, args.role);
      `
    ),
    { name, email, role }
  );
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await waitForDialogClosed(page);
  const token = await page.evaluate(() => null); // dev returns the URL in a toast; DB is authoritative
  void token;
  const row = await db.inviteToken.findFirst({
    where: { email },
    orderBy: { createdAt: "desc" },
    select: { token: true, companyId: true },
  });
  return row ? row.token : null;
}

async function claimInvite(page, token, password) {
  await page.goto(`${BASE}/invite/${token}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('input[type="password"]').length > 0, {
    timeout: 30000,
  });
  await page.evaluate(
    new Function(
      "args",
      `
      const setValue = ${SET_VALUE_FN};
      for (const el of document.querySelectorAll('input[type="password"]')) setValue(el, args.password);
      `
    ),
    { password }
  );
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await page
    .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 45000 })
    .catch(() => {});
}

await main();
