/*
 * QA agent 7 — domain: reporting-and-export.
 *
 * Surface under audit:
 *   • /reports            (client-side jsPDF + xlsx exports, date-window maths)
 *   • GET /api/export     (workspace JSON portability dump)
 *   • /dashboard + /expenses aggregate maths, checked for AGREEMENT with /reports
 *
 * DATA SAFETY — the hard constraint.
 *   This script never touches a row it did not create. It signs up its OWN
 *   workspace through the real /signup form, records that company's id in
 *   `ctx.companyId`, and EVERY database read-assert and write carries
 *   `where: { companyId: ctx.companyId }` (or a relation that narrows to it).
 *   A bare `db.X.count()` would let another agent's concurrent insert satisfy a
 *   "did mine land?" assertion, so there are none. `scripts/_qa-guard.mjs verify`
 *   must be clean after this runs.
 *
 *   The one apparent exception is deliberate and still in-tenant:
 *   `db.company.update({ where: { id: ctx.companyId }, data: { plan: "team" } })`
 *   lifts MY OWN workspace off the free 2-seat cap so the third user the
 *   deactivated-founder and DM-leak checks need can be invited. That row was
 *   created by this script four steps earlier.
 *
 * Conventions (copied from scripts/smoke-chat.mjs):
 *   • localDb() — never `new PrismaClient()`; a bare client auto-loads the root
 *     .env, which points at production Supabase.
 *   • ok()/fail() — fail() records and returns, it never throws, so one run
 *     reports every broken assertion instead of stopping at the first.
 *   • A literal ❌ is printed on failure so the runner's summary counts it.
 *   • x-real-ip: 10.99.0.7 on every page before its first navigation —
 *     getClientIp() falls back to the string "unknown" in dev, so without this
 *     all nine agents share one limiters.auth bucket of 5/60s.
 *   • waitForFunction on state predicates, not fixed sleeps.
 *
 * Run: node scripts/qa-reporting-and-export.mjs      (Phase 2 runs it, not me)
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_INDEX = 7;
const AGENT_IP = `10.99.0.${AGENT_INDEX}`;
const DOMAIN = "reporting-and-export";
const OUT = `C:/Users/USER/AppData/Local/Temp/ff-qa/${DOMAIN}`;
const DL = `${OUT}/downloads`;
const STAMP = Date.now().toString().slice(-8);

const db = localDb();

/* ── result plumbing ──────────────────────────────────────────────────── */

let failures = 0;
const results = [];

function ok(label) {
  results.push({ state: "ok", label });
  console.log(`  ok    ${label}`);
}
/** Records a failure and RETURNS — never throws, so the run keeps going. */
function fail(label, detail) {
  failures += 1;
  results.push({ state: "fail", label, detail });
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function skip(label, why) {
  results.push({ state: "skip", label, detail: why });
  console.log(`  ..    SKIP ${label}${why ? ` — ${why}` : ""}`);
}
function note(msg) {
  console.log(`  ··    ${msg}`);
}

/* ── tenant identity ──────────────────────────────────────────────────── */

const COMPANY = `qa-${DOMAIN}-${STAMP}`;
const ADMIN_EMAIL = `qa-rep-admin-${STAMP}@founderflow.test`;
const CO_EMAIL = `qa-rep-co-${STAMP}@founderflow.test`;
const MEMBER_EMAIL = `qa-rep-member-${STAMP}@founderflow.test`;
const PASSWORD = "QaAudit123";

const ctx = { companyId: null, adminId: null, coId: null, memberId: null };

/* ── browser helpers ──────────────────────────────────────────────────── */

function wire(page, tag) {
  page.on("pageerror", (e) => console.error(`  PAGEERROR[${tag}]:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`  CONSOLE.error[${tag}]:`, m.text().slice(0, 300));
  });
}

/** Every page gets the agent's own IP bucket BEFORE its first navigation. */
async function newPage(context, tag) {
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  wire(page, tag);
  return page;
}

/**
 * React-Hook-Form reads the value off the DOM node, so a plain `page.type`
 * into a controlled input can be dropped. Use the native setter + the event
 * React listens for.
 */
async function setVal(page, selector, value, isSelect = false) {
  await page.evaluate(
    (sel, v, sl) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      const proto = sl ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new Event(sl ? "change" : "input", { bubbles: true }));
    },
    selector,
    value,
    isSelect
  );
}

/**
 * Retry-until-hydrated sign-in. On a cold dev server the login form paints
 * before React hydrates; a click that lands first performs a NATIVE submit,
 * which (the form declares no method) becomes a GET with the credentials in
 * the query string and no sign-in at all. FaultsAudit A14.
 */
async function signIn(page, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 30000 });
    // Hydration predicate, not a sleep: React attaches its own onSubmit, so
    // wait until the submit button is live rather than guessing at 1500ms.
    await page
      .waitForFunction(
        () => {
          const btn = document.querySelector("button[type=submit]");
          if (!btn || btn.disabled) return false;
          return Object.keys(btn).some((k) => k.startsWith("__react"));
        },
        { timeout: 20000 }
      )
      .catch(() => {});
    await setVal(page, "input[type=email]", email);
    await setVal(page, "input[type=password]", password);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 8000 }).catch(() => {});
      return true;
    }
    note(`sign-in attempt ${attempt} for ${email} did not leave /login`);
  }
  return false;
}

/** Read a DashboardStat card's value by its label, inside a labelled section. */
async function statValue(page, sectionAriaLabel, statLabel) {
  return page.evaluate(
    (sec, lbl) => {
      const section = document.querySelector(`section[aria-label="${sec}"]`);
      if (!section) return null;
      for (const card of section.querySelectorAll("div")) {
        const ps = card.querySelectorAll(":scope > p, :scope > div > p");
        const labelEl = [...card.querySelectorAll("p")].find(
          (p) => p.textContent.trim().toLowerCase() === lbl.toLowerCase()
        );
        if (!labelEl) continue;
        const all = [...card.querySelectorAll("p")];
        const i = all.indexOf(labelEl);
        if (i >= 0 && all[i + 1]) return all[i + 1].textContent.trim();
        void ps;
      }
      return null;
    },
    sectionAriaLabel,
    statLabel
  );
}

/** "$1,234" / "PKR 1,234" / "Rs -12" → 1234 / 1234 / -12. */
function moneyToNumber(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** The /reports founder-breakdown table as [{name, invested, expenses, pct}]. */
async function readFounderTable(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("table tbody tr")];
    return rows.map((tr) => {
      const td = [...tr.querySelectorAll("td")].map((c) => c.innerText.trim());
      return { member: td[0] ?? "", role: td[1] ?? "", invested: td[2] ?? "", expenses: td[3] ?? "", pct: td[4] ?? "" };
    });
  });
}

/** Click one of the /reports range presets and wait for the table to settle. */
async function setReportsRange(page, label) {
  const clicked = await page.evaluate((lbl) => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim().toLowerCase() === lbl.toLowerCase()
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  if (!clicked) return false;
  await page
    .waitForFunction(
      (lbl) => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim().toLowerCase() === lbl.toLowerCase()
        );
        return btn?.getAttribute("aria-pressed") === "true";
      },
      { timeout: 10000 },
      label
    )
    .catch(() => {});
  return true;
}

/** Poll the download dir for a new file with the given extension. */
async function waitForDownload(ext, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let names = [];
    try {
      names = readdirSync(DL);
    } catch {
      names = [];
    }
    const hit = names.find((n) => n.toLowerCase().endsWith(ext) && !n.endsWith(".crdownload"));
    if (hit) {
      const full = join(DL, hit);
      // Settled-size predicate: Chrome renames off .crdownload before the last
      // flush on some builds, so require two identical sizes.
      const a = statSync(full).size;
      await new Promise((r) => setImmediate(r));
      const b = statSync(full).size;
      if (a === b && a > 0) return full;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/* ── fixture money ────────────────────────────────────────────────────── */

// Sub-unit cents are the whole point of the currency checks: the workspace is
// created in USD, where the minor unit is real money, and Transaction.amount is
// Decimal(12,2) so 1234.56 round-trips exactly at the database.
const T_EXPENSE_CENTS = 1234.56;
const T_INVEST_CENTS = 1000.01;
const T_REVENUE_CENTS = 2500.49;
const T_OLD_EXPENSE = 777.77; // ~8 months back — outside the default 6m window
const T_LASTYEAR_EXPENSE = 606.06; // same calendar month, previous year
const T_COFOUNDER_INVEST = 4321.12; // added by the co-founder we later deactivate

// 45 characters — longer than the PDF's 30-char slice at reports-client.tsx:251
// and well inside the schema's 500-char ceiling.
const LONG_DESCRIPTION = "Cloud hosting renewal for the analytics ti";
const FORMULA_DESCRIPTION = "=SUM(1+1)+cmd|'/C calc'!A0";
const DM_MARKER = `qa7-private-dm-${STAMP}`;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function firstOfMonthsBack(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  // UTC midnight, exactly how lib/actions/transactions.ts:155 stores a
  // "YYYY-MM-DD" form value (`new Date(date)`).
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  mkdirSync(OUT, { recursive: true });
  try {
    rmSync(DL, { recursive: true, force: true });
  } catch {
    /* first run */
  }
  mkdirSync(DL, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1600, height: 1100 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  console.log(`== qa ${DOMAIN} (agent ${AGENT_INDEX}, ip ${AGENT_IP}) ==`);
  console.log(`   tenant: ${COMPANY}`);

  try {
    /* ── 0. Sign up my own workspace, in USD ───────────────────────────── */
    const adminCtx = await browser.createBrowserContext();
    const admin = await newPage(adminCtx, "admin");

    await admin.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await admin.waitForSelector('input[name="companyName"]', { timeout: 30000 });
    await setVal(admin, 'input[name="name"]', `QA Reporting ${STAMP}`);
    await setVal(admin, 'input[name="email"]', ADMIN_EMAIL);
    await setVal(admin, 'input[name="password"]', PASSWORD);
    await setVal(admin, 'input[name="companyName"]', COMPANY);
    // USD, not the PKR default: PKR has no circulating minor unit, so the
    // cents-rounding question only becomes visible in a currency that has one.
    await setVal(admin, 'select[name="currency"]', "USD", true);
    await admin.evaluate(() => document.querySelector("form")?.requestSubmit());
    const signedUp = await admin
      .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
      .then(() => true)
      .catch(() => false);

    const adminRow = await db.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!adminRow) {
      fail("signup created my workspace", `no User row for ${ADMIN_EMAIL} (landed=${signedUp})`);
      return; // nothing downstream can run without a tenant
    }
    ctx.companyId = adminRow.companyId;
    ctx.adminId = adminRow.id;
    ok(`signed up tenant ${COMPANY} (companyId=${ctx.companyId})`);

    const companyRow = await db.company.findFirst({ where: { id: ctx.companyId } });
    if (companyRow?.currency === "USD") ok("workspace currency stored as USD");
    else fail("workspace currency", `expected USD, got ${companyRow?.currency}`);

    // My own row, created four steps ago: lift the free 2-seat cap so the
    // three-user checks (DM leak, deactivated founder) can run at all.
    await db.company.update({ where: { id: ctx.companyId }, data: { plan: "team" } });
    note("own tenant moved to plan=team to unlock a third seat");

    /* ── 1. Fixtures ───────────────────────────────────────────────────── */

    // The first expense goes through the REAL form so validation, the money
    // input's step=0.01, and the action's Decimal write are all exercised.
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    const openedModal = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /log expense/i.test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    let uiExpenseOk = false;
    if (openedModal) {
      await admin.waitForSelector('input[type="number"]', { timeout: 15000 }).catch(() => {});
      await setVal(admin, 'input[type="number"]', String(T_EXPENSE_CENTS));
      await admin.evaluate((desc) => {
        const el =
          document.querySelector('textarea[name="description"]') ||
          document.querySelector('input[name="description"]');
        if (!el) return;
        const proto =
          el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, desc);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, LONG_DESCRIPTION);
      await admin.evaluate(() => {
        const forms = [...document.querySelectorAll("form")];
        forms[forms.length - 1]?.requestSubmit();
      });
      uiExpenseOk = await admin
        .waitForFunction(
          (amt) => document.body.innerText.includes(amt),
          { timeout: 20000 },
          "1,23"
        )
        .then(() => true)
        .catch(() => false);
    }
    const uiExpense = await db.transaction.findFirst({
      where: { companyId: ctx.companyId, description: LONG_DESCRIPTION },
    });
    if (uiExpense) {
      ok(`expense logged through the real form (id=${uiExpense.id})`);
      if (uiExpense.amount.toString() === T_EXPENSE_CENTS.toFixed(2)) {
        ok(`Decimal(12,2) kept the cents at rest: ${uiExpense.amount.toString()}`);
      } else {
        fail(
          "cents survive the write",
          `expected ${T_EXPENSE_CENTS.toFixed(2)}, DB holds ${uiExpense.amount.toString()}`
        );
      }
    } else {
      fail("log an expense through the UI", `modal opened=${openedModal} rendered=${uiExpenseOk}`);
    }

    // The rest are seeded straight into MY tenant — they are date- and
    // description-shaped edge cases the form cannot produce quickly, and every
    // one carries companyId: ctx.companyId.
    const seeded = [
      {
        type: "investment",
        amount: T_INVEST_CENTS,
        category: "Founder Capital",
        description: "qa7 founder capital",
        date: daysAgo(3),
      },
      {
        type: "income",
        amount: T_REVENUE_CENTS,
        category: "Product Sales",
        description: "qa7 revenue",
        date: daysAgo(4),
      },
      {
        type: "expense",
        amount: T_OLD_EXPENSE,
        category: "Marketing",
        description: "qa7 eight months back",
        date: firstOfMonthsBack(8),
      },
      {
        type: "expense",
        amount: T_LASTYEAR_EXPENSE,
        category: "Marketing",
        description: "qa7 same month last year",
        date: (() => {
          const d = new Date();
          d.setFullYear(d.getFullYear() - 1);
          d.setDate(Math.min(d.getDate(), 28));
          return d;
        })(),
      },
      {
        // The window edge: the 1st of the first month the "6 months" preset
        // covers. startOfMonth() is LOCAL, the stored date is UTC midnight.
        type: "expense",
        amount: 111.11,
        category: "Office Rent",
        description: "qa7 window edge first-of-month",
        date: firstOfMonthsBack(5),
      },
      {
        type: "expense",
        amount: 42.42,
        category: "Software",
        description: FORMULA_DESCRIPTION,
        date: daysAgo(1),
      },
    ];
    for (const s of seeded) {
      await db.transaction.create({
        data: {
          companyId: ctx.companyId,
          type: s.type,
          amount: s.amount,
          category: s.category,
          description: s.description,
          date: s.date,
          addedBy: ctx.adminId,
          addedByName: `QA Reporting ${STAMP}`,
        },
      });
    }
    ok(`seeded ${seeded.length} edge-case transactions inside my tenant`);

    /* ── 2. Invite a co-founder and a member through the real flow ─────── */

    async function inviteAndAccept(email, name, role) {
      await admin.goto(`${BASE}/team`, { waitUntil: "networkidle0" });
      const opened = await admin.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /invite (member|teammate|co-?founder)/i.test(b.textContent ?? "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!opened) return { ok: false, why: "no invite button on /team" };
      await admin.waitForSelector('input[name="email"]', { timeout: 15000 }).catch(() => {});
      await setVal(admin, 'input[name="name"]', name);
      await setVal(admin, 'input[name="email"]', email);
      await admin.evaluate((r) => {
        const sel = [...document.querySelectorAll("select")].find((s) =>
          [...s.options].some((o) => o.value === r)
        );
        if (!sel) return;
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(
          sel,
          r
        );
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, role);
      await admin.evaluate(() => {
        const forms = [...document.querySelectorAll("form")];
        forms[forms.length - 1]?.requestSubmit();
      });
      const tokenRow = await (async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const row = await db.inviteToken.findFirst({
            where: { companyId: ctx.companyId, email, usedAt: null },
          });
          if (row) return row;
          await new Promise((r) => setTimeout(r, 300));
        }
        return null;
      })();
      if (!tokenRow) return { ok: false, why: "invite token never landed" };

      const inviteeCtx = await browser.createBrowserContext();
      const invitee = await newPage(inviteeCtx, role);
      await invitee.goto(`${BASE}/invite/${tokenRow.token}`, { waitUntil: "networkidle0" });
      await invitee.waitForSelector("input[type=password]", { timeout: 20000 }).catch(() => {});
      const pwInputs = await invitee.$$("input[type=password]");
      for (const el of pwInputs) {
        await el.evaluate((node, v) => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
            node,
            v
          );
          node.dispatchEvent(new Event("input", { bubbles: true }));
        }, PASSWORD);
      }
      await invitee.evaluate(() => document.querySelector("form")?.requestSubmit());
      await invitee
        .waitForFunction(() => !location.pathname.startsWith("/invite/"), { timeout: 30000 })
        .catch(() => {});
      const user = await db.user.findFirst({ where: { companyId: ctx.companyId, email } });
      return { ok: !!user, why: user ? "" : "user row never created", user, ctx: inviteeCtx, page: invitee };
    }

    const coRes = await inviteAndAccept(CO_EMAIL, `QA Cofounder ${STAMP}`, "cofounder");
    if (coRes.ok) {
      ctx.coId = coRes.user.id;
      ok(`co-founder joined through the real invite flow (${CO_EMAIL})`);
    } else {
      fail("invite a co-founder", coRes.why);
    }

    const memRes = await inviteAndAccept(MEMBER_EMAIL, `QA Member ${STAMP}`, "member");
    if (memRes.ok) {
      ctx.memberId = memRes.user.id;
      ok(`member joined through the real invite flow (${MEMBER_EMAIL})`);
    } else {
      fail("invite a member", memRes.why);
    }

    // Capital added by the co-founder, so deactivating them later has money to
    // strand. Scoped to my tenant, attributed to my co-founder.
    if (ctx.coId) {
      await db.transaction.create({
        data: {
          companyId: ctx.companyId,
          type: "investment",
          amount: T_COFOUNDER_INVEST,
          category: "Founder Capital",
          description: "qa7 cofounder capital",
          date: daysAgo(2),
          addedBy: ctx.coId,
          addedByName: `QA Cofounder ${STAMP}`,
        },
      });
    }

    /* ── 3. DB truth for my tenant — every query scoped ────────────────── */

    const myTxns = await db.transaction.findMany({
      where: { companyId: ctx.companyId, deletedAt: null },
    });
    const sumBy = (type) =>
      myTxns.filter((t) => t.type === type).reduce((s, t) => s + Number(t.amount), 0);
    const truth = {
      expense: sumBy("expense"),
      investment: sumBy("investment"),
      income: sumBy("income"),
    };
    truth.balance = truth.investment + truth.income - truth.expense;
    note(
      `DB truth (companyId=${ctx.companyId}): expense=${truth.expense.toFixed(2)} ` +
        `investment=${truth.investment.toFixed(2)} income=${truth.income.toFixed(2)} ` +
        `balance=${truth.balance.toFixed(2)}`
    );

    /* ── 4. rep-001 — do the cents reach the screen? ───────────────────── */

    await admin.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
    await admin.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
    await setReportsRange(admin, "All time");
    await admin.screenshot({ path: `${OUT}/01-reports-all-time.png`, fullPage: true });

    const categoryTexts = await admin.evaluate(() =>
      [...document.querySelectorAll("li")].map((li) => li.innerText.replace(/\s+/g, " ").trim())
    );
    const centsShown = categoryTexts.some((t) => /\.\d{2}\b/.test(t));
    if (centsShown) {
      ok("rep-001 negative: /reports renders sub-unit precision");
    } else {
      fail(
        "rep-001 /reports shows whole-unit money in a USD workspace",
        `formatCurrency pins maximumFractionDigits:0 (lib/utils.ts:27) so ` +
          `$${T_EXPENSE_CENTS} renders without its cents. Category list: ` +
          JSON.stringify(categoryTexts.slice(0, 4))
      );
    }

    /* ── 5. rep-002 — /reports "All time" vs /dashboard vs the database ── */

    const founderRows = await readFounderTable(admin);
    const mineRow = founderRows.find((r) => r.member.includes(ADMIN_EMAIL));
    const reportsExpense = moneyToNumber(mineRow?.expenses);
    const shownInvestTotal = founderRows
      .map((r) => moneyToNumber(r.invested) ?? 0)
      .reduce((a, b) => a + b, 0);

    if (reportsExpense == null) {
      fail("rep-002 read the founder-breakdown table", JSON.stringify(founderRows).slice(0, 400));
    } else {
      // My own expenses only: the seeded rows are all attributed to me except
      // the co-founder's capital, which is an investment.
      const myExpenseTruth = myTxns
        .filter((t) => t.type === "expense" && t.addedBy === ctx.adminId)
        .reduce((s, t) => s + Number(t.amount), 0);
      // ±1 unit tolerance absorbs the known whole-unit rounding; anything
      // bigger is a windowing or attribution error, which is what this checks.
      if (Math.abs(reportsExpense - myExpenseTruth) <= 1) {
        ok(
          `rep-002 /reports "All time" expenses agree with the DB ` +
            `(${reportsExpense} vs ${myExpenseTruth.toFixed(2)})`
        );
      } else {
        fail(
          'rep-002 /reports "All time" disagrees with the database',
          `table shows ${reportsExpense}, DB (companyId=${ctx.companyId}) holds ${myExpenseTruth.toFixed(2)}`
        );
      }
    }

    await admin.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
    await admin.waitForSelector('section[aria-label="Key metrics"]', { timeout: 30000 });
    const dashTotalSpend = moneyToNumber(await statValue(admin, "Key metrics", "Total spend"));
    const dashBalance = moneyToNumber(await statValue(admin, "Key metrics", "Balance"));
    const dashThisMonth = moneyToNumber(await statValue(admin, "Key metrics", "This month"));
    await admin.screenshot({ path: `${OUT}/02-dashboard.png`, fullPage: true });
    note(`dashboard: total spend=${dashTotalSpend} balance=${dashBalance} thisMonth=${dashThisMonth}`);

    if (dashTotalSpend != null && Math.abs(dashTotalSpend - truth.expense) <= 1) {
      ok("rep-002b /dashboard all-time spend agrees with the DB");
    } else {
      fail(
        "rep-002b /dashboard all-time spend disagrees with the DB",
        `card=${dashTotalSpend}, DB=${truth.expense.toFixed(2)}`
      );
    }

    /* ── 6. rep-003 — /expenses "This month" ignores the YEAR ──────────── */

    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await admin.waitForSelector('section[aria-label="Expense metrics"]', { timeout: 30000 });
    const expThisMonth = moneyToNumber(await statValue(admin, "Expense metrics", "This month"));
    await admin.screenshot({ path: `${OUT}/03-expenses.png`, fullPage: true });
    note(`/expenses "This month" = ${expThisMonth}; /dashboard "This month" = ${dashThisMonth}`);

    if (expThisMonth != null && dashThisMonth != null) {
      if (Math.abs(expThisMonth - dashThisMonth) <= 1) {
        ok("rep-003 negative: /expenses and /dashboard agree on this-month spend");
      } else {
        fail(
          'rep-003 /expenses and /dashboard disagree on "This month"',
          `/expenses=${expThisMonth} vs /dashboard=${dashThisMonth}. ` +
            `expenses-client.tsx:95 compares getMonth() only, so the ` +
            `$${T_LASTYEAR_EXPENSE} row dated the same month LAST YEAR is counted as this month.`
        );
      }
    } else {
      fail("rep-003 read both this-month cards", `expenses=${expThisMonth} dashboard=${dashThisMonth}`);
    }

    /* ── 7. rep-004 — PDF export: truncation + what the file contains ──── */

    const cdp = await admin.createCDPSession();
    await cdp
      .send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL })
      .catch(async () => {
        await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
      });

    await admin.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
    await admin.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
    await setReportsRange(admin, "All time");
    const clickedPdf = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /export pdf/i.test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clickedPdf) {
      fail("rep-004 find the Export PDF button", "no button matching /export pdf/i on /reports");
    } else {
      const pdfPath = await waitForDownload(".pdf", 90000);
      if (!pdfPath) {
        fail("rep-004 PDF export produced a file", "no .pdf appeared in the download dir in 90s");
      } else {
        // jsPDF writes uncompressed text streams by default, so the literal
        // strings are greppable straight out of the file.
        const pdf = readFileSync(pdfPath, "latin1");
        const head30 = LONG_DESCRIPTION.slice(0, 30);
        const hasFull = pdf.includes(LONG_DESCRIPTION);
        const hasHead = pdf.includes(head30);
        if (hasFull) {
          ok("rep-004 negative: the PDF carries the full transaction description");
        } else if (hasHead) {
          fail(
            "rep-004 the investor PDF silently truncates descriptions at 30 characters",
            `"${head30}…" is in the PDF but the stored ${LONG_DESCRIPTION.length}-char ` +
              `description is not (reports-client.tsx:251). The Excel export of the same ` +
              `click keeps it in full, so the two files disagree.`
          );
        } else {
          fail("rep-004 locate the description in the PDF", "neither the full nor the 30-char form is present");
        }
        // Does the PDF label a windowed net-flow figure as a balance?
        if (pdf.includes("Net Balance")) {
          note('PDF summary uses the label "Net Balance" for a date-windowed net flow');
        }
        note(`PDF size ${(statSync(pdfPath).size / 1024).toFixed(0)} KB at ${pdfPath}`);
      }
    }

    /* ── 8. rep-005 — Excel export: raw values, and formula injection ──── */

    const clickedXlsx = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /export excel/i.test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clickedXlsx) {
      fail("rep-005 find the Export Excel button", "no button matching /export excel/i");
    } else {
      const xlsxPath = await waitForDownload(".xlsx", 90000);
      if (!xlsxPath) {
        fail("rep-005 Excel export produced a file", "no .xlsx appeared in 90s");
      } else {
        let XLSX = null;
        try {
          XLSX = await import("xlsx");
        } catch (e) {
          skip("rep-005 inspect the workbook", `xlsx import failed: ${e.message}`);
        }
        if (XLSX) {
          const wb = XLSX.readFile(xlsxPath);
          const names = wb.SheetNames;
          if (["Summary", "Transactions", "Team", "Monthly"].every((n) => names.includes(n))) {
            ok(`rep-005 workbook carries all four sheets (${names.join(", ")})`);
          } else {
            fail("rep-005 workbook sheets", JSON.stringify(names));
          }

          const txns = XLSX.utils.sheet_to_json(wb.Sheets.Transactions, { header: 1 });
          const longRow = txns.find((r) => r.some((c) => String(c) === LONG_DESCRIPTION));
          if (longRow) {
            ok("rep-005 the Excel export keeps the full description the PDF cut");
          } else {
            note("full description not found in the Transactions sheet");
          }

          const centsRow = txns.find(
            (r) => typeof r[5] === "number" && Math.abs(Math.abs(r[5]) - T_EXPENSE_CENTS) < 0.005
          );
          if (centsRow) {
            ok(`rep-005 negative: Excel carries the exact amount ${centsRow[5]} (cents intact)`);
          } else {
            fail(
              "rep-005 Excel amount column lost the cents",
              `no cell equal to ±${T_EXPENSE_CENTS} in the Transactions sheet`
            );
          }

          // Formula injection: SheetJS types a string cell as "s"; Excel shows
          // it literally. Prove it rather than assume it.
          const sheet = wb.Sheets.Transactions;
          let formulaCell = null;
          for (const addr of Object.keys(sheet)) {
            if (addr.startsWith("!")) continue;
            if (String(sheet[addr].v) === FORMULA_DESCRIPTION) formulaCell = sheet[addr];
          }
          if (!formulaCell) {
            note("formula-shaped description not located in the workbook");
          } else if (formulaCell.t === "s" && formulaCell.f === undefined) {
            ok('rep-005 negative: "=SUM(...)" description exported as a text cell (t="s", no .f)');
          } else {
            fail(
              "rep-005 a transaction description became a live Excel formula",
              `cell type=${formulaCell.t} f=${formulaCell.f}`
            );
          }
        }
      }
    }

    /* ── 9. rep-006 — GET /api/export: content, leaks, Decimal fidelity ── */

    const exportRes = await admin.evaluate(async () => {
      const t0 = performance.now();
      const res = await fetch("/api/export");
      const text = await res.text();
      return {
        status: res.status,
        ms: Math.round(performance.now() - t0),
        bytes: text.length,
        disposition: res.headers.get("content-disposition"),
        text,
      };
    });

    if (exportRes.status !== 200) {
      fail("rep-006 admin can export the workspace", `status ${exportRes.status}`);
    } else {
      ok(`rep-006 admin export returned 200 in ${exportRes.ms}ms (${exportRes.bytes} bytes)`);
      let payload = null;
      try {
        payload = JSON.parse(exportRes.text);
      } catch (e) {
        fail("rep-006 export body is valid JSON", e.message);
      }
      if (payload) {
        // Tenancy: nothing from outside my company may be in here.
        if (payload.companyId === ctx.companyId && payload.company?.id === ctx.companyId) {
          ok("rep-006 export is scoped to my companyId");
        } else {
          fail("rep-006 export scope", `companyId=${payload.companyId}, expected ${ctx.companyId}`);
        }
        const strayCompany = (payload.transactions ?? []).some(
          (t) => t.companyId !== ctx.companyId
        );
        if (strayCompany) fail("rep-006 cross-tenant rows in the export", "a transaction carried another companyId");
        else ok("rep-006 negative: no cross-tenant transaction reached the export");

        // Secrets the route promises to strip.
        if ((payload.users ?? []).every((u) => u.passwordHash === undefined)) {
          ok("rep-006 negative: no passwordHash in any exported user");
        } else {
          fail("rep-006 passwordHash leaked", "a user row carried passwordHash");
        }
        if ((payload.inviteTokens ?? []).every((i) => i.token === undefined)) {
          ok("rep-006 negative: no live invite token in the export");
        } else {
          fail("rep-006 invite token leaked", "an inviteToken row carried its secret");
        }

        // Decimal → number, losslessly?
        const exported = (payload.transactions ?? []).find(
          (t) => t.description === LONG_DESCRIPTION
        );
        if (!exported) {
          fail("rep-006 find my transaction in the export", "description not present");
        } else if (exported.amount === T_EXPENSE_CENTS) {
          ok(`rep-006 negative: Decimal(12,2) → number is exact (${exported.amount})`);
        } else {
          fail(
            "rep-006 Decimal → number lost precision",
            `exported ${exported.amount}, DB holds ${T_EXPENSE_CENTS}`
          );
        }

        // Completeness: the header calls this "every row this workspace owns".
        const expectedCollections = [
          "company",
          "users",
          "projects",
          "tasks",
          "transactions",
          "budgets",
          "recurringRules",
          "timeEntries",
          "comments",
          "activities",
          "notifications",
          "inviteTokens",
          "channels",
          "channelMembers",
          "messages",
          "messageReactions",
        ];
        const missing = expectedCollections.filter((k) => payload[k] === undefined);
        if (missing.length === 0) {
          ok("rep-007 negative: the export covers every workspace-owned table");
        } else {
          fail(
            "rep-007 the workspace export omits tables the workspace owns",
            `missing: ${missing.join(", ")} — chat is customer content and this ` +
              `endpoint is the GDPR/CCPA portability path`
          );
        }

        // An audit trail for pulling the entire workspace?
        const exportActivity = await db.activity.findFirst({
          where: { companyId: ctx.companyId, type: { contains: "export" } },
        });
        if (exportActivity) ok("rep-008 negative: the export writes an activity row");
        else
          fail(
            "rep-008 exporting the whole workspace leaves no audit trail",
            `no Activity row of any export type in companyId=${ctx.companyId} after a 200 export`
          );
      }
    }

    /* ── 10. rep-009 — a private DM must not ride out in the export ────── */

    if (coRes.ok && memRes.ok) {
      const dmSent = await (async () => {
        const p = coRes.page;
        await p.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
        // Open a DM with the member. The rail lists people; click the one
        // whose label carries the member's name.
        const opened = await p.evaluate((needle) => {
          const cand = [...document.querySelectorAll("a, button")].find((el) =>
            (el.textContent ?? "").includes(needle)
          );
          if (!cand) return false;
          cand.click();
          return true;
        }, `QA Member ${STAMP}`);
        if (!opened) return { ok: false, why: "no DM entry point for the member on /chat" };
        const composer = await p
          .waitForSelector("textarea", { timeout: 20000 })
          .catch(() => null);
        if (!composer) return { ok: false, why: "no composer after opening the DM" };
        await composer.click();
        await p.keyboard.type(`${DM_MARKER} salary discussion, confidential`);
        await p.keyboard.press("Enter");
        const landed = await p
          .waitForFunction((m) => document.body.innerText.includes(m), { timeout: 20000 }, DM_MARKER)
          .then(() => true)
          .catch(() => false);
        return { ok: landed, why: landed ? "" : "message never rendered" };
      })();

      if (!dmSent.ok) {
        skip("rep-009 private-DM leak check", dmSent.why);
      } else {
        // Wait for the fan-out row rather than sleeping on it.
        const notif = await (async () => {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const row = await db.notification.findFirst({
              where: { companyId: ctx.companyId, userId: ctx.memberId, message: { contains: DM_MARKER } },
            });
            if (row) return row;
            await new Promise((r) => setTimeout(r, 300));
          }
          return null;
        })();
        if (!notif) {
          skip("rep-009 private-DM leak check", "the DM fan-out notification never landed");
        } else {
          // The admin is not a member of that DM channel — assert it rather
          // than assume it, so the leak claim cannot be explained away.
          const dmChannels = await db.channel.findMany({
            where: { companyId: ctx.companyId, kind: "dm" },
            select: { id: true },
          });
          const adminInAnyDm = await db.channelMember.count({
            where: { userId: ctx.adminId, channelId: { in: dmChannels.map((c) => c.id) } },
          });
          note(`admin is a member of ${adminInAnyDm} of this tenant's ${dmChannels.length} DM channels`);

          const again = await admin.evaluate(async () => {
            const res = await fetch("/api/export");
            return { status: res.status, text: await res.text() };
          });
          if (again.status === 200 && again.text.includes(DM_MARKER)) {
            fail(
              "rep-009 the workspace export hands an admin the contents of other people's private DMs",
              `the marker "${DM_MARKER}" — typed in a DM between the co-founder and the ` +
                `member, a conversation the admin is not a party to — appears in the admin's ` +
                `/api/export JSON. Route dumps db.notification.findMany({ where: { companyId } }) ` +
                `with no userId scope, and chat fan-out stores a 140-char body preview ` +
                `(lib/actions/chat.ts:254,302,362). lib/queries/notifications.ts:46 scopes by ` +
                `userId, so the app itself never shows this.`
            );
          } else if (again.status === 200) {
            ok("rep-009 negative: the DM body preview did not reach the admin's export");
          } else {
            skip("rep-009 private-DM leak check", `second export returned ${again.status}`);
          }
        }
      }
    } else {
      skip("rep-009 private-DM leak check", "needed both a co-founder and a member");
    }

    /* ── 11. rep-010 — role gate on the export and on /reports ─────────── */

    if (memRes.ok) {
      const memberExport = await memRes.page.evaluate(async () => {
        const res = await fetch("/api/export", { redirect: "manual" });
        let text = "";
        try {
          text = await res.text();
        } catch {
          /* opaque */
        }
        return { status: res.status, type: res.type, bytes: text.length, text: text.slice(0, 400) };
      });
      if (memberExport.status === 403) {
        ok("rep-010 negative: a member gets 403 from /api/export");
      } else {
        fail(
          "rep-010 the finance wall does not hold on /api/export",
          `member got status ${memberExport.status} (${memberExport.type}); body starts: ${memberExport.text}`
        );
      }
      if (!memberExport.text.includes(LONG_DESCRIPTION)) {
        ok("rep-010 negative: no transaction data in the member's response body");
      } else {
        fail("rep-010 member export body leaked finance data", "the expense description was in it");
      }

      await memRes.page.goto(`${BASE}/reports`, { waitUntil: "networkidle0" }).catch(() => {});
      const memberOnReports = await memRes.page.evaluate(() => ({
        path: location.pathname,
        hasTable: !!document.querySelector("table tbody tr"),
        body: document.body.innerText.slice(0, 200),
      }));
      if (memberOnReports.path !== "/reports" || !memberOnReports.hasTable) {
        ok(`rep-010 negative: a member cannot read /reports (landed ${memberOnReports.path})`);
      } else {
        fail("rep-010 a member reached the reports table", memberOnReports.body);
      }
      await memRes.page.screenshot({ path: `${OUT}/04-member-reports.png` });
    }

    /* ── 12. rep-011 — deactivating a founder strands their capital ────── */

    if (ctx.coId) {
      await admin.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
      await admin.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
      await setReportsRange(admin, "All time");
      const before = await readFounderTable(admin);
      const beforeInvested = before
        .map((r) => moneyToNumber(r.invested) ?? 0)
        .reduce((a, b) => a + b, 0);

      // Deactivate through the real team UI, inside my tenant only.
      await admin.goto(`${BASE}/team`, { waitUntil: "networkidle0" });
      const removed = await admin.evaluate((needle) => {
        const rows = [...document.querySelectorAll("tr, li, div")];
        const row = rows.find((r) => (r.textContent ?? "").includes(needle));
        if (!row) return false;
        const btn = [...row.querySelectorAll("button")].find((b) =>
          /remove|deactivate/i.test((b.textContent ?? "") + (b.getAttribute("aria-label") ?? ""))
        );
        if (!btn) return false;
        btn.click();
        return true;
      }, CO_EMAIL);
      if (removed) {
        // Confirm dialog, if the app raises one.
        await admin
          .waitForFunction(
            () =>
              [...document.querySelectorAll("button")].some((b) =>
                /^(remove|deactivate|confirm)$/i.test(b.textContent.trim())
              ),
            { timeout: 5000 }
          )
          .then(async () => {
            await admin.evaluate(() => {
              const b = [...document.querySelectorAll("button")].find((x) =>
                /^(remove|deactivate|confirm)$/i.test(x.textContent.trim())
              );
              b?.click();
            });
          })
          .catch(() => {});
      }
      const deactivated = await (async () => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const row = await db.user.findFirst({
            where: { companyId: ctx.companyId, id: ctx.coId },
          });
          if (row?.deletedAt) return true;
          await new Promise((r) => setTimeout(r, 300));
        }
        return false;
      })();

      if (!deactivated) {
        skip("rep-011 deactivated-founder capital check", "could not deactivate via the team UI");
      } else {
        const coStillLive = await db.transaction.count({
          where: { companyId: ctx.companyId, addedBy: ctx.coId, deletedAt: null },
        });
        note(`co-founder deactivated; ${coStillLive} of their transactions are still live`);

        await admin.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
        await admin.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
        await setReportsRange(admin, "All time");
        const after = await readFounderTable(admin);
        await admin.screenshot({ path: `${OUT}/05-reports-after-deactivation.png`, fullPage: true });
        const afterInvested = after
          .map((r) => moneyToNumber(r.invested) ?? 0)
          .reduce((a, b) => a + b, 0);
        const investTruth = await db.transaction
          .findMany({ where: { companyId: ctx.companyId, type: "investment", deletedAt: null } })
          .then((rows) => rows.reduce((s, t) => s + Number(t.amount), 0));

        const pcts = after.map((r) => Number(String(r.pct).replace(/[^\d.]/g, "")) || 0);
        const pctSum = pcts.reduce((a, b) => a + b, 0);

        if (Math.abs(afterInvested - investTruth) <= 1) {
          ok("rep-011 negative: the founder breakdown still accounts for every invested unit");
        } else {
          fail(
            "rep-011 a deactivated founder's capital vanishes from the founder breakdown",
            `rows now sum to ${afterInvested} but companyId=${ctx.companyId} holds ` +
              `${investTruth.toFixed(2)} in live investments (was ${beforeInvested} before ` +
              `deactivation). /reports iterates getCompanyUsers(), which filters deletedAt:null ` +
              `(lib/queries/users.ts:35), while the totals come from every live transaction.`
          );
        }
        if (Math.abs(pctSum - 100) <= 2) {
          ok(`rep-011 negative: "% of capital" still sums to ~100% (${pctSum.toFixed(1)}%)`);
        } else {
          fail(
            'rep-011 the "% of capital" column no longer sums to 100%',
            `rows sum to ${pctSum.toFixed(1)}% — an investor reading this cap-table view ` +
              `cannot see whose money the missing share is`
          );
        }
        // Reactivate so the tenant teardown is a plain delete.
        await db.user.update({ where: { id: ctx.coId }, data: { deletedAt: null } });
      }
    }

    /* ── 13. rep-012 — month bucketing under a western timezone ────────── */

    {
      const tzCtx = await browser.createBrowserContext();
      const tzPage = await newPage(tzCtx, "tz");
      await tzPage.emulateTimezone("America/Los_Angeles").catch(() => {});
      const inTz = await signIn(tzPage, ADMIN_EMAIL, PASSWORD);
      if (!inTz) {
        skip("rep-012 timezone bucketing", "could not sign in under the emulated timezone");
      } else {
        await tzPage.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
        await tzPage.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
        await setReportsRange(tzPage, "6 months");
        const rows = await readFounderTable(tzPage);
        const mine = rows.find((r) => r.member.includes(ADMIN_EMAIL));
        const shown = moneyToNumber(mine?.expenses);
        await tzPage.screenshot({ path: `${OUT}/06-reports-tz-la.png`, fullPage: true });

        const windowStart = firstOfMonthsBack(5);
        const expectedIn = myTxns
          .filter(
            (t) =>
              t.type === "expense" &&
              t.addedBy === ctx.adminId &&
              new Date(t.date) >= windowStart
          )
          .reduce((s, t) => s + Number(t.amount), 0);
        note(`TZ=America/Los_Angeles 6m window: page=${shown}, expected>=${expectedIn.toFixed(2)}`);
        if (shown != null && shown >= Math.floor(expectedIn) - 1) {
          ok("rep-012 negative: the first-of-month row stayed inside the 6-month window");
        } else {
          fail(
            "rep-012 west of UTC, a transaction dated the 1st drops out of the reporting window",
            `expected at least ${expectedIn.toFixed(2)} in the 6-month window, page shows ${shown}. ` +
              `Transaction.date is stored at UTC midnight (lib/actions/transactions.ts:155) but ` +
              `reports-client.tsx:99 builds the window with date-fns startOfMonth(), which is LOCAL ` +
              `— so in a UTC-negative zone the 1st of the first month sorts before the window opens.`
          );
        }
      }
      await tzCtx.close().catch(() => {});
    }

    /* ── 14. rep-013 — a hostile custom range ──────────────────────────── */

    {
      const dosCtx = await browser.createBrowserContext();
      const dosPage = await newPage(dosCtx, "range");
      const inDos = await signIn(dosPage, ADMIN_EMAIL, PASSWORD);
      if (!inDos) {
        skip("rep-013 custom-range stress", "could not sign in");
      } else {
        await dosPage.goto(`${BASE}/reports`, { waitUntil: "networkidle0" });
        await setReportsRange(dosPage, "Custom");
        await dosPage.waitForSelector('input[type="date"]', { timeout: 15000 }).catch(() => {});
        const t0 = Date.now();
        await dosPage.evaluate(() => {
          const inputs = [...document.querySelectorAll('input[type="date"]')];
          const set = (el, v) => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
              el,
              v
            );
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };
          // The inputs carry only relative min/max, so nothing stops a range
          // spanning ten thousand month buckets.
          if (inputs[0]) set(inputs[0], "0001-01-01");
          if (inputs[1]) set(inputs[1], "9999-12-31");
        });
        const responsive = await dosPage
          .waitForFunction(() => document.readyState === "complete" && !!document.body, {
            timeout: 30000,
            polling: 1000,
          })
          .then(() => true)
          .catch(() => false);
        const elapsed = Date.now() - t0;
        await dosPage
          .screenshot({ path: `${OUT}/07-reports-custom-range.png` })
          .catch(() => {});
        if (responsive && elapsed < 10000) {
          ok(`rep-013 negative: a 0001→9999 custom range stayed responsive (${elapsed}ms)`);
        } else {
          fail(
            "rep-013 a wide custom date range locks up the reports page",
            `the page took ${elapsed}ms to answer a trivial DOM query after the range was set ` +
              `(responsive=${responsive}). reports-client.tsx:119 calls eachMonthOfInterval over ` +
              `the whole span and buckets every transaction per month, then hands every bucket ` +
              `to recharts. Nothing bounds the span.`
          );
        }

        // Reversed range must be forgiven, not shown as empty.
        await dosPage.evaluate(() => {
          const inputs = [...document.querySelectorAll('input[type="date"]')];
          const set = (el, v) => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
              el,
              v
            );
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };
          if (inputs[0]) set(inputs[0], "2099-01-01");
          if (inputs[1]) set(inputs[1], "2000-01-01");
        });
        const reversedOk = await dosPage
          .waitForFunction(() => !!document.querySelector("table tbody tr"), { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        if (reversedOk) ok("rep-013 negative: a reversed custom range is forgiven, not blanked");
        else fail("rep-013 reversed custom range broke the page", "the breakdown table disappeared");
      }
      await dosCtx.close().catch(() => {});
    }

    /* ── 15. rep-014 — /reports loading skeleton vs the real page ──────── */

    {
      const loaded = await admin.evaluate(() => ({
        statSections: document.querySelectorAll('section[aria-label$="metrics"]').length,
        container: document.querySelector("div.mx-auto")?.className ?? "",
      }));
      if (loaded.statSections === 0) {
        note(
          "/reports renders no stat cards, while app/(app)/reports/loading.tsx paints a " +
            "4-up StatGridSkeleton at max-w-[1280px] against the page's max-w-[1600px]"
        );
        fail(
          "rep-014 the /reports loading skeleton does not match the page it stands in for",
          `loaded page has ${loaded.statSections} stat sections and container "${loaded.container}"; ` +
            `loading.tsx renders StatGridSkeleton count={4} plus a 2:1 chart grid at ` +
            `max-w-[1280px] — the layout jumps on every navigation to /reports`
        );
      } else {
        ok("rep-014 negative: the loading skeleton's stat grid matches the page");
      }
    }

    /* ── 16. rep-015 — export cost against a bulkier workspace ─────────── */

    {
      const bulk = [];
      for (let i = 0; i < 2000; i++) {
        bulk.push({
          companyId: ctx.companyId,
          type: "task_created",
          message: `qa7 bulk activity ${i}`,
          userId: ctx.adminId,
          userName: `QA Reporting ${STAMP}`,
        });
      }
      await db.activity.createMany({ data: bulk });
      note(`seeded 2000 activity rows into companyId=${ctx.companyId}`);

      const big = await admin.evaluate(async () => {
        const t0 = performance.now();
        const res = await fetch("/api/export");
        const text = await res.text();
        return { status: res.status, ms: Math.round(performance.now() - t0), bytes: text.length };
      });
      note(`export with +2000 activities: ${big.status} in ${big.ms}ms, ${big.bytes} bytes`);
      if (big.status === 200 && big.ms < 60000) {
        ok(`rep-015 negative: the export held under maxDuration at this size (${big.ms}ms)`);
      } else {
        fail(
          "rep-015 the workspace export does not survive a realistic workspace",
          `status ${big.status} after ${big.ms}ms against maxDuration=60 ` +
            `(app/api/export/route.ts:68). The handler loads 12 tables fully into memory and ` +
            `JSON.stringify's one document; nothing is streamed or paged.`
        );
      }
    }

    await admin.screenshot({ path: `${OUT}/08-final-reports.png`, fullPage: true });
  } catch (e) {
    fail("unhandled error in the run", `${e.message}\n${e.stack}`);
  } finally {
    await browser.close().catch(() => {});

    /* ── teardown: my tenant only, children before parents ─────────────── */
    if (ctx.companyId) {
      const id = ctx.companyId;
      try {
        await db.messageReaction.deleteMany({ where: { message: { companyId: id } } });
        await db.message.deleteMany({ where: { companyId: id } });
        await db.channelMember.deleteMany({ where: { channel: { companyId: id } } });
        await db.channel.deleteMany({ where: { companyId: id } });
        await db.comment.deleteMany({ where: { companyId: id } });
        await db.timeEntry.deleteMany({ where: { companyId: id } });
        await db.notification.deleteMany({ where: { companyId: id } });
        await db.activity.deleteMany({ where: { companyId: id } });
        await db.inviteToken.deleteMany({ where: { companyId: id } });
        await db.recurringRule.deleteMany({ where: { companyId: id } });
        await db.budget.deleteMany({ where: { companyId: id } });
        await db.transaction.deleteMany({ where: { companyId: id } });
        await db.task.deleteMany({ where: { companyId: id } });
        await db.project.deleteMany({ where: { companyId: id } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId: id } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId: id } } });
        await db.company.update({ where: { id }, data: { ownerId: null } }).catch(() => {});
        await db.user.deleteMany({ where: { companyId: id } });
        await db.company.deleteMany({ where: { id } });
        const leftUsers = await db.user.count({ where: { companyId: id } });
        const leftCompany = await db.company.count({ where: { id } });
        console.log(`(teardown: users left=${leftUsers}, company left=${leftCompany})`);
      } catch (e) {
        console.error(`  teardown warning: ${e.message}`);
      }
    }
    await db.$disconnect();
  }

  console.log(`\n-- ${DOMAIN}: ${results.filter((r) => r.state === "ok").length} ok, ` +
    `${failures} failed, ${results.filter((r) => r.state === "skip").length} skipped`);
  console.log(failures === 0 ? "✅ ALL PASS" : "❌ FAILURES");
}

await main();
