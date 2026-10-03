/*
 * QA agent 5 — transactions-ledger.
 *
 * Surface: /expenses, /revenue, /investments, components/transactions/
 * transaction-form.tsx, components/transactions/import-transactions-modal.tsx,
 * lib/transactions/csv.ts, lib/actions/transactions.ts.
 *
 * DATA SAFETY — the rule this file is built around:
 *   Nothing here reads or writes a pre-existing row. The script signs up TWO
 *   of its own workspaces through the real signup form (`qa-txn-<stamp>` and
 *   `qa-txnb-<stamp>`), invites a cofounder and a member into the first through
 *   the real invite flow, and every single DB assertion carries
 *   `where: { companyId: <one of my two tenant ids> }`. There is no bare
 *   `db.transaction.count()` anywhere: under concurrency a sibling agent's
 *   insert would satisfy a global "did mine land?" check and hand back a FALSE
 *   PASS. Both tenants are torn down children-first in `finally`.
 *
 *   Tenant A is deliberately created with currency USD, not PKR. Almost half
 *   the findings below are only visible in a non-PKR workspace, and the seeded
 *   demo workspace is PKR — which is exactly why they shipped.
 *
 * Every check prints `ok` / `FAIL`; `fail()` never throws, so one run reports
 * every broken assertion rather than stopping at the first.
 */

import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/transactions-ledger";
const AGENT_INDEX = 5;
/** getClientIp() falls back to the literal "unknown" in dev, which would put
 *  all nine agents in ONE limiters.auth bucket of 5/60s. Per-agent IP instead. */
const AGENT_IP = `10.99.0.${AGENT_INDEX}`;
const STAMP = Date.now().toString().slice(-7);
const PASSWORD = "QaLedger!2026x";

// Pinned to the local docker Postgres. `new PrismaClient()` would auto-load the
// root .env, which points at production Supabase — see scripts/_local-db.mjs.
const db = localDb();

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

let okCount = 0;
let failCount = 0;
function ok(label) {
  okCount += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  failCount += 1;
  console.error(`  FAIL ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Harness helpers                                                             */
/* ─────────────────────────────────────────────────────────────────────────── */

async function newPage(ctx) {
  const page = await ctx.newPage();
  // BEFORE the first navigation, per the audit's shared-rate-limit rule.
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
  return page;
}

/** Copied verbatim from scripts/smoke-chat.mjs. On a cold dev server the form
 *  paints before React hydrates; a click that lands first performs a NATIVE
 *  submit, which (the form declares no method) becomes a GET with the
 *  credentials in the query string and no sign-in. FaultsAudit A14. */
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

/** Drive the real two-step signup form. Returns the new companyId, proven to
 *  be mine by looking it up through the email I just chose. */
async function signUpWorkspace(page, { name, email, companyName, currency }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));

    await page.evaluate(
      (n, e, p) => {
        const set = (el, v) => {
          const proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll("form input")];
        set(
          inputs.find((i) => i.type === "text" && !/company/i.test(i.id)),
          n
        );
        set(
          inputs.find((i) => i.type === "email"),
          e
        );
        set(
          inputs.find((i) => i.type === "password"),
          p
        );
      },
      name,
      email,
      PASSWORD
    );

    // Step 1 -> 2 is a type="button" Continue; it does nothing before hydration.
    await page.evaluate(() => {
      [...document.querySelectorAll("form button")]
        .find((b) => /continue/i.test(b.textContent ?? ""))
        ?.click();
    });
    const atStep2 = await page
      .waitForFunction(() => Boolean(document.querySelector("form select")), { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (!atStep2) continue; // hydration lost the race; start over

    await page.evaluate(
      (co, cur) => {
        const set = (el, v) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const company = [...document.querySelectorAll("form input")].find((i) =>
          /company/i.test(i.id)
        );
        if (company) set(company, co);
        const selects = [...document.querySelectorAll("form select")];
        for (const s of selects) {
          const hasCurrency = [...s.options].some((o) => o.value === cur);
          const target = hasCurrency ? cur : s.options[1]?.value ?? s.options[0]?.value;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, target);
          s.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      companyName,
      currency
    );

    await page.click('form button[type="submit"]');
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!left) continue;
    await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});

    const me = await db.user.findUnique({ where: { email }, select: { companyId: true } });
    if (!me?.companyId) throw new Error(`signup for ${email} left no user row`);
    return me.companyId;
  }
  throw new Error(`could not sign up ${companyName} after 3 attempts`);
}

/** Invite through the real flow, then accept it in a fresh context. Keeps the
 *  new user inside MY tenant and exercises the invite path at the same time. */
async function inviteAndAccept(browser, adminPage, companyId, { name, email, role }) {
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0" });
  await adminPage.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => /invite/i.test(b.textContent ?? ""))
      ?.click();
  });
  await adminPage.waitForSelector('[role="dialog"] input[type="email"]', { timeout: 15000 });
  await adminPage.evaluate(
    (n, e, r) => {
      const dlg = document.querySelector('[role="dialog"]');
      const set = (el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const inputs = [...dlg.querySelectorAll("input")];
      set(
        inputs.find((i) => i.type === "text"),
        n
      );
      set(
        inputs.find((i) => i.type === "email"),
        e
      );
      const sel = dlg.querySelector("select");
      if (sel) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, r);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      dlg.querySelector("form")?.requestSubmit();
    },
    name,
    email,
    role
  );

  // The token row is the only reliable handle on the invite URL; scoped to MINE.
  const token = await waitFor(
    () => db.inviteToken.findFirst({ where: { companyId, email }, orderBy: { createdAt: "desc" } }),
    (r) => Boolean(r),
    20000
  );
  if (!token) throw new Error(`no invite token for ${email} in ${companyId}`);

  const ctx = await browser.createBrowserContext();
  const page = await newPage(ctx);
  await page.goto(`${BASE}/invite/${token.token}`, { waitUntil: "networkidle0" });
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1200));
  await page.type('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page
    .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 30000 })
    .catch(() => {});

  const user = await db.user.findFirst({ where: { companyId, email } });
  if (!user) throw new Error(`invite accept for ${email} left no user in ${companyId}`);
  return { ctx, page, user };
}

/** Poll a DB read until a predicate holds. Never a fixed setTimeout — under
 *  nine concurrent agents a fixed wait is the #1 source of false failures. */
async function waitFor(read, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
}

/** Open the Import CSV modal on the current finance page and paste a CSV via
 *  a synthesized File on the hidden <input type=file>. */
async function pasteCsvIntoImporter(page, csv, filename = "ledger.csv") {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => /import csv/i.test(b.textContent ?? ""))
      ?.click();
  });
  await page.waitForSelector('[role="dialog"] input[type="file"]', { timeout: 15000 });
  const input = await page.$('[role="dialog"] input[type="file"]');
  const path = `${OUT}/${filename}`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, csv, "utf8");
  await input.uploadFile(path);
  // FileReader + parse + preview render. Wait on the preview table, not a timer.
  await page
    .waitForFunction(
      () =>
        Boolean(document.querySelector('[role="dialog"] tbody tr')) ||
        Boolean(document.querySelector('[role="dialog"] p.text-danger')),
      { timeout: 30000 }
    )
    .catch(() => {});
}

async function clickImportConfirm(page) {
  await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    [...(dlg?.querySelectorAll("button") ?? [])]
      .find((b) => /^import(\s|$)/i.test((b.textContent ?? "").trim()))
      ?.click();
  });
}

/** Open the Add/Log modal and submit one transaction through the real form. */
async function addTransactionViaForm(page, { amount, description, projectName }) {
  await page.evaluate(() => {
    [...document.querySelectorAll("header button")]
      .find((b) => /^(log expense|add revenue|add investment)$/i.test((b.textContent ?? "").trim()))
      ?.click();
  });
  await page.waitForSelector('[role="dialog"] input[type="number"]', { timeout: 15000 });
  await page.evaluate(
    (amt, desc, proj) => {
      const dlg = document.querySelector('[role="dialog"]');
      const set = (el, v, proto) => {
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(dlg.querySelector('input[type="number"]'), amt, HTMLInputElement.prototype);
      set(dlg.querySelector("textarea"), desc, HTMLTextAreaElement.prototype);
      if (proj) {
        const sel = [...dlg.querySelectorAll("select")].find((s) =>
          [...s.options].some((o) => o.textContent.trim() === proj)
        );
        if (sel) {
          const opt = [...sel.options].find((o) => o.textContent.trim() === proj);
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(
            sel,
            opt.value
          );
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    },
    String(amount),
    description,
    projectName ?? null
  );
  await page.evaluate(() => {
    document.querySelector('[role="dialog"] form')?.requestSubmit();
  });
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main                                                                        */
/* ─────────────────────────────────────────────────────────────────────────── */

const TENANT_A = `qa-txn-${STAMP}`;
const TENANT_B = `qa-txnb-${STAMP}`;
const ADMIN_A = `qa-txn-${STAMP}@founderflow.test`;
const COFO_A = `qa-txn-cofo-${STAMP}@founderflow.test`;
const MEMBER_A = `qa-txn-member-${STAMP}@founderflow.test`;
const ADMIN_B = `qa-txnb-${STAMP}@founderflow.test`;

let companyA = null;
let companyB = null;

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log(`== transactions-ledger QA (agent ${AGENT_INDEX}, ip ${AGENT_IP}) ==`);

  const opened = [];
  try {
    /* ── tenant A: a USD workspace, because PKR hides half the bugs ────── */
    const ctxA = await browser.createBrowserContext();
    opened.push(ctxA);
    const admin = await newPage(ctxA);
    companyA = await signUpWorkspace(admin, {
      name: `QA Ledger Admin ${STAMP}`,
      email: ADMIN_A,
      companyName: TENANT_A,
      currency: "USD",
    });
    const companyARow = await db.company.findUnique({ where: { id: companyA } });
    if (companyARow?.currency === "USD") ok(`tenant A ${TENANT_A} created with currency USD`);
    else fail("tenant A currency", `expected USD, got ${companyARow?.currency}`);
    const adminAUser = await db.user.findFirst({ where: { companyId: companyA, email: ADMIN_A } });

    /* ── TXN-001: the transaction form must name the workspace currency ──
       It used to label the field "Amount (PKR)" and print PKR inside the
       input whatever the workspace had chosen. Both now read `useCurrency()`
       (money-011), so a USD workspace's own "Log expense" form must contain
       no "PKR" anywhere. */
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await admin.evaluate(() => {
      [...document.querySelectorAll("header button")]
        .find((b) => /log expense/i.test(b.textContent ?? ""))
        ?.click();
    });
    await admin.waitForSelector('[role="dialog"] input[type="number"]', { timeout: 15000 });
    const formCurrency = await admin.evaluate(
      () => document.querySelector('[role="dialog"]').innerText
    );
    await shot(admin, "001-form-currency");
    if (/PKR/.test(formCurrency)) {
      fail(
        "TXN-001 transaction form currency",
        `USD workspace: form text contains "PKR" — ${JSON.stringify(
          formCurrency.split("\n").find((l) => /PKR/.test(l))
        )}`
      );
    } else {
      ok("TXN-001 transaction form renders the workspace currency");
    }
    await admin.keyboard.press("Escape");

    /* ── TXN-002: SSR paints PKR for a non-PKR workspace ─────────────────
       useMoney falls back to "PKR" until CompanyHydrator's client fetch
       lands, so the server HTML of a USD workspace is denominated wrong. */
    const ssrHtml = await admin.evaluate(async () => {
      const r = await fetch("/expenses", { headers: { "cache-control": "no-cache" } });
      return r.text();
    });
    if (/PKR/.test(ssrHtml)) {
      fail("TXN-002 first-paint currency", "server HTML of /expenses in a USD workspace says PKR");
    } else {
      ok("TXN-002 server HTML is denominated in the workspace currency");
    }

    /* ── TXN-003: add one expense; DB must agree, and the activity + ─────
       notification copy must not hardcode PKR. */
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    const desc1 = `qa-one-expense-${STAMP}`;
    await addTransactionViaForm(admin, { amount: "12345.67", description: desc1 });
    const row1 = await waitFor(
      () => db.transaction.findFirst({ where: { companyId: companyA, description: desc1 } }),
      (r) => Boolean(r),
      20000
    );
    if (row1) ok("TXN-003 an expense added through the form persists");
    else fail("TXN-003 expense persistence", `no row for "${desc1}" in ${companyA}`);

    if (row1 && Number(row1.amount) !== 12345.67) {
      fail("TXN-003b amount fidelity", `sent 12345.67, stored ${row1.amount}`);
    } else if (row1) {
      ok("TXN-003b Decimal(12,2) kept the cents exactly");
    }

    const act1 = await db.activity.findFirst({
      where: { companyId: companyA, type: "expense_added" },
      orderBy: { createdAt: "desc" },
    });
    if (act1 && /PKR/.test(act1.message)) {
      fail(
        "TXN-004 activity feed currency",
        `USD workspace activity reads: ${JSON.stringify(act1.message)}`
      );
    } else if (act1) {
      ok("TXN-004 activity message uses the workspace currency");
    } else {
      fail("TXN-004 activity row", "no expense_added activity in my tenant");
    }

    /* ── TXN-005: sub-cent input is silently rounded, not rejected ─────── */
    const descRound = `qa-round-${STAMP}`;
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await addTransactionViaForm(admin, { amount: "10.999", description: descRound });
    const rounded = await waitFor(
      () => db.transaction.findFirst({ where: { companyId: companyA, description: descRound } }),
      (r) => Boolean(r),
      20000
    );
    if (rounded && Number(rounded.amount) !== 10.999) {
      fail(
        "TXN-005 sub-cent rounding",
        `entered 10.999, stored ${rounded.amount} with no warning to the user`
      );
    } else if (rounded) {
      ok("TXN-005 sub-cent amounts round-trip");
    } else {
      note("TXN-005 skipped — 10.999 was rejected outright (that would be the fix)");
    }

    /* ── TXN-006: an empty description is accepted ─────────────────────── */
    const beforeBlank = await db.transaction.count({
      where: { companyId: companyA, description: "" },
    });
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await addTransactionViaForm(admin, { amount: "777", description: "" });
    const blank = await waitFor(
      () => db.transaction.count({ where: { companyId: companyA, description: "" } }),
      (n) => n > beforeBlank,
      12000
    );
    if (blank > beforeBlank) {
      fail("TXN-006 blank description", "a ledger row with no description was accepted");
    } else {
      ok("TXN-006 a blank description is rejected");
    }

    /* ── /revenue: the CSV importer is wired to the wrong noun + set ───── */
    await admin.goto(`${BASE}/revenue`, { waitUntil: "networkidle0" });
    await admin.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => /import csv/i.test(b.textContent ?? ""))
        ?.click();
    });
    await admin.waitForSelector('[role="dialog"]', { timeout: 15000 });
    const revImport = await admin.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const a = [...dlg.querySelectorAll("a[download]")][0];
      return {
        title: dlg.querySelector("h2,h3")?.textContent?.trim() ?? dlg.innerText.split("\n")[0],
        text: dlg.innerText,
        href: a?.getAttribute("href") ?? "",
        download: a?.getAttribute("download") ?? "",
      };
    });
    await shot(admin, "007-revenue-import-modal");
    if (/investment/i.test(revImport.title) || /investment/i.test(revImport.text)) {
      fail(
        "TXN-007 /revenue importer noun",
        `modal on the Revenue page says: ${JSON.stringify(revImport.title)}`
      );
    } else {
      ok("TXN-007 /revenue importer is labelled for revenue");
    }
    const template = decodeURIComponent(revImport.href.replace(/^data:[^,]*,/, ""));
    const revenueCats = [
      "Product Sales",
      "Service Revenue",
      "Subscriptions",
      "Consulting",
      "Licensing",
      "Interest & Other",
    ];
    if (template && !revenueCats.some((c) => template.includes(c))) {
      fail(
        "TXN-008 /revenue CSV template",
        `template offers no revenue category — rows: ${JSON.stringify(template.slice(0, 200))}`
      );
    } else if (template) {
      ok("TXN-008 /revenue CSV template uses revenue categories");
    } else {
      fail("TXN-008 /revenue CSV template", "no download link in the modal");
    }
    await admin.keyboard.press("Escape");

    /* ── TXN-009: the shipped /revenue template imports ZERO rows ──────── */
    if (template) {
      await admin.goto(`${BASE}/revenue`, { waitUntil: "networkidle0" });
      await pasteCsvIntoImporter(admin, template, `revenue-template-${STAMP}.csv`);
      const preview = await admin.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return {
          text: dlg.innerText,
          bad: [...dlg.querySelectorAll("tbody tr")].filter((tr) =>
            /unknown category/i.test(tr.innerText)
          ).length,
          rows: dlg.querySelectorAll("tbody tr").length,
        };
      });
      await shot(admin, "009-revenue-template-preview");
      if (preview.rows > 0 && preview.bad === preview.rows) {
        fail(
          "TXN-009 /revenue template is unusable",
          `all ${preview.rows} rows of the page's own template preview as "Unknown category"`
        );
      } else {
        ok("TXN-009 the /revenue template previews as importable");
      }
      await admin.keyboard.press("Escape");
    }

    /* ── TXN-010/011/012: hostile + locale-shaped CSV, on /expenses ─────
       Each row is engineered so a SILENT mis-parse is visible in the DB. */
    const tricky = [
      "date,amount,category,description",
      // European thousands/decimal: strip-non-numeric turns 1.234,56 into 1.23456
      `2026-06-02,"1.234,56",Marketing,qa-eu-amount-${STAMP}`,
      // Accounting parenthesised negative: "(500.00)" -> 500.00, sign flipped
      `2026-06-02,"(500.00)",Marketing,qa-paren-amount-${STAMP}`,
      // DD/MM/YYYY, the format every non-US spreadsheet exports
      `02/06/2026,100,Marketing,qa-ddmm-date-${STAMP}`,
      // CSV formula injection in a free-text field
      `2026-06-02,50,Marketing,"=cmd|' /C calc'!A0 qa-formula-${STAMP}"`,
      // Duplicate of the row above it, byte for byte
      `2026-06-02,50,Marketing,"=cmd|' /C calc'!A0 qa-formula-${STAMP}"`,
    ].join("\n");

    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await pasteCsvIntoImporter(admin, tricky, `tricky-${STAMP}.csv`);
    await shot(admin, "010-tricky-preview");
    await clickImportConfirm(admin);
    await waitFor(
      () =>
        db.transaction.count({
          where: { companyId: companyA, description: { contains: `qa-eu-amount-${STAMP}` } },
        }),
      (n) => n > 0,
      25000
    );

    const eu = await db.transaction.findFirst({
      where: { companyId: companyA, description: { contains: `qa-eu-amount-${STAMP}` } },
    });
    if (!eu) {
      ok("TXN-010 a European-formatted amount is rejected rather than mis-parsed");
    } else if (Number(eu.amount) !== 1234.56) {
      fail(
        "TXN-010 European amount silently wrong",
        `CSV said 1.234,56 (1234.56); ledger stored ${eu.amount}`
      );
    } else {
      ok("TXN-010 European-formatted amount imported correctly");
    }

    const paren = await db.transaction.findFirst({
      where: { companyId: companyA, description: { contains: `qa-paren-amount-${STAMP}` } },
    });
    if (paren) {
      fail(
        "TXN-011 accounting negative imported as positive",
        `CSV said (500.00) — an accounting negative — and it landed as +${paren.amount}`
      );
    } else {
      ok("TXN-011 a parenthesised accounting negative is rejected");
    }

    const ddmm = await db.transaction.findFirst({
      where: { companyId: companyA, description: { contains: `qa-ddmm-date-${STAMP}` } },
    });
    if (ddmm) {
      const m = ddmm.date.getUTCMonth() + 1;
      if (m === 2) {
        fail(
          "TXN-012 DD/MM date silently re-read as MM/DD",
          `CSV said 02/06/2026 (2 June); ledger stored ${ddmm.date.toISOString().slice(0, 10)}`
        );
      } else {
        ok("TXN-012 DD/MM/YYYY parsed as the day, not the month");
      }
    } else {
      note("TXN-012 skipped — the DD/MM row did not import at all");
    }

    const formulas = await db.transaction.findMany({
      where: { companyId: companyA, description: { contains: `qa-formula-${STAMP}` } },
    });
    if (formulas.some((f) => f.description.trimStart().startsWith("="))) {
      fail(
        "TXN-013 CSV formula injection stored verbatim",
        `description begins "=" and is re-exported into Reports' XLSX/PDF: ${JSON.stringify(
          formulas[0].description
        )}`
      );
    } else {
      ok("TXN-013 a leading = in an imported description is neutralised");
    }
    if (formulas.length > 1) {
      fail(
        "TXN-014 duplicate CSV rows",
        `${formulas.length} identical rows imported from one file with no de-dup and no warning`
      );
    } else {
      ok("TXN-014 byte-identical duplicate rows are collapsed or flagged");
    }

    /* ── TXN-015: re-importing the SAME file doubles the ledger ────────── */
    const beforeReimport = await db.transaction.count({
      where: { companyId: companyA, description: { contains: `qa-eu-amount-${STAMP}` } },
    });
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await pasteCsvIntoImporter(admin, tricky, `tricky-again-${STAMP}.csv`);
    await clickImportConfirm(admin);
    const afterReimport = await waitFor(
      () =>
        db.transaction.count({
          where: { companyId: companyA, description: { contains: `qa-eu-amount-${STAMP}` } },
        }),
      (n) => n > beforeReimport,
      25000
    );
    if (afterReimport > beforeReimport) {
      fail(
        "TXN-015 no import idempotency",
        `the same file imported twice: ${beforeReimport} -> ${afterReimport} copies, no duplicate warning`
      );
    } else {
      ok("TXN-015 re-importing the same file is detected");
    }

    /* ── TXN-016: wrong columns must fail safely, not half-import ──────── */
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await pasteCsvIntoImporter(
      admin,
      "foo,bar,baz\n1,2,3\n4,5,6",
      `wrong-columns-${STAMP}.csv`
    );
    const wrongCols = await admin.evaluate(
      () => document.querySelector('[role="dialog"]').innerText
    );
    if (/required columns|needs headers/i.test(wrongCols)) {
      ok("TXN-016 a CSV with the wrong headers is refused with a readable reason");
    } else {
      fail("TXN-016 wrong-header CSV", `no column error shown: ${JSON.stringify(wrongCols)}`);
    }
    await admin.keyboard.press("Escape");

    /* ── TXN-017: header sniffing picks "subtotal" as the amount column ── */
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await pasteCsvIntoImporter(
      admin,
      `date,subtotal,amount,category,description\n2026-06-03,7,999,Marketing,qa-subtotal-${STAMP}`,
      `subtotal-${STAMP}.csv`
    );
    const sniffed = await admin.evaluate(() => {
      const tr = document.querySelector('[role="dialog"] tbody tr');
      return tr ? [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()) : null;
    });
    await shot(admin, "017-column-sniffing");
    if (sniffed && sniffed.join("|").includes("7")) {
      fail(
        "TXN-017 amount column mis-detected",
        `headers were subtotal,amount — the preview shows ${JSON.stringify(sniffed)} (took "subtotal")`
      );
    } else {
      ok("TXN-017 the real amount column wins over a look-alike header");
    }
    await admin.keyboard.press("Escape");

    /* ── TXN-018: >1000 valid rows fails wholesale, with no chunking ───── */
    const bigRows = ["date,amount,category,description"];
    for (let i = 0; i < 1200; i++) {
      bigRows.push(`2026-06-04,10,Marketing,qa-big-${STAMP}-${i}`);
    }
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await pasteCsvIntoImporter(admin, bigRows.join("\n"), `big-${STAMP}.csv`);
    const previewedRows = await admin.evaluate(
      () => document.querySelectorAll('[role="dialog"] tbody tr').length
    );
    note(`TXN-018 preview rendered ${previewedRows} DOM rows for a 1200-row file (no virtualisation)`);
    await clickImportConfirm(admin);
    const bigOutcome = await waitFor(
      async () => ({
        landed: await db.transaction.count({
          where: { companyId: companyA, description: { contains: `qa-big-${STAMP}-` } },
        }),
        text: await admin.evaluate(() => document.body.innerText),
      }),
      (s) => s.landed > 0 || /at most 1000|too many|try again/i.test(s.text),
      30000
    );
    if (bigOutcome.landed === 0) {
      fail(
        "TXN-018 over-cap import is all-or-nothing",
        `1200 valid rows imported 0 — the 1000-row server cap rejects the whole file and the UI offers no way to split it`
      );
    } else if (bigOutcome.landed === 1200) {
      ok("TXN-018 a 1200-row import landed in full");
    } else {
      fail("TXN-018 partial import", `1200 rows requested, ${bigOutcome.landed} landed`);
    }
    await admin.keyboard.press("Escape");

    /* ── TXN-019: a failed import wedges the modal on "Importing…" ─────
       No try/catch around the action call, so a rejected promise never
       clears `busy`. */
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await pasteCsvIntoImporter(
      admin,
      `date,amount,category,description\n2026-06-05,42,Marketing,qa-offline-${STAMP}`,
      `offline-${STAMP}.csv`
    );
    await admin.setOfflineMode(true);
    await clickImportConfirm(admin);
    const wedged = await admin
      .waitForFunction(
        () => {
          const dlg = document.querySelector('[role="dialog"]');
          if (!dlg) return false;
          const btn = [...dlg.querySelectorAll("button")].find((b) =>
            /importing/i.test(b.textContent ?? "")
          );
          return Boolean(btn);
        },
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    await shot(admin, "019-import-offline");
    await admin.setOfflineMode(false);
    if (wedged) {
      const stillWedged = await admin.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        const btn = [...(dlg?.querySelectorAll("button") ?? [])].find((b) =>
          /importing/i.test(b.textContent ?? "")
        );
        return Boolean(btn) && btn.disabled;
      });
      if (stillWedged) {
        fail(
          "TXN-019 import modal wedges on a failed request",
          'the confirm button stays disabled reading "Importing…" with no error toast; the only escape is a page reload'
        );
      } else {
        ok("TXN-019 a failed import re-enables the confirm button");
      }
    } else {
      ok("TXN-019 a failed import reports an error and resets");
    }
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });

    /* ── TXN-020: imported rows can never be tagged to a project, so they
       are invisible to every project budget and every budget alert. ───── */
    const project = await db.project.findFirst({ where: { companyId: companyA } });
    let projectName = project?.name ?? null;
    if (!projectName) {
      note("TXN-020 no project in my tenant yet — creating one through /projects");
      await admin.goto(`${BASE}/projects`, { waitUntil: "networkidle0" });
      await admin.evaluate(() => {
        [...document.querySelectorAll("button")]
          .find((b) => /new project/i.test(b.textContent ?? ""))
          ?.click();
      });
      await admin.waitForSelector('[role="dialog"] input', { timeout: 15000 }).catch(() => {});
      projectName = `qa-proj-${STAMP}`;
      await admin.evaluate((nm) => {
        const dlg = document.querySelector('[role="dialog"]');
        const input = dlg?.querySelector('input[type="text"], input:not([type])');
        if (input) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, nm);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        dlg?.querySelector("form")?.requestSubmit();
      }, projectName);
      await waitFor(
        () => db.project.findFirst({ where: { companyId: companyA, name: projectName } }),
        (r) => Boolean(r),
        20000
      );
    }
    const imported = await db.transaction.findMany({
      where: { companyId: companyA, description: { contains: `qa-eu-amount-${STAMP}` } },
      select: { projectId: true },
    });
    if (imported.length > 0 && imported.every((t) => t.projectId === null)) {
      fail(
        "TXN-020 CSV import forces projectId: null",
        "bulkImportTransactionsAction hardcodes projectId: null, the importer shows no project picker, and lib/budgets/check.ts skips every project-less expense — so imported spend never counts against a budget or fires a threshold alert"
      );
    } else if (imported.length > 0) {
      ok("TXN-020 imported rows can carry a project tag");
    }

    /* ── TXN-021: the transaction form CAN tag a project (control) ─────── */
    if (projectName) {
      const descProj = `qa-tagged-${STAMP}`;
      await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
      await addTransactionViaForm(admin, {
        amount: "250",
        description: descProj,
        projectName,
      });
      const tagged = await waitFor(
        () => db.transaction.findFirst({ where: { companyId: companyA, description: descProj } }),
        (r) => Boolean(r),
        20000
      );
      if (tagged?.projectId) ok("TXN-021 the manual form does tag a project (control for TXN-020)");
      else fail("TXN-021 manual project tag", `projectId=${tagged?.projectId ?? "none"}`);
    }

    /* ── TXN-022: the 5000-row read ceiling silently truncates the ledger.
       Filled inside MY tenant only. /revenue then reports zero revenue
       while my own revenue rows sit in my own tenant's table. ────────── */
    const filler = [];
    for (let i = 0; i < 5100; i++) {
      filler.push({
        companyId: companyA,
        type: "expense",
        amount: 1,
        category: "Marketing",
        description: `qa-cap-filler-${STAMP}-${i}`,
        // NEWER than the revenue rows below, so date-desc + take:5000 evicts them.
        date: new Date(Date.UTC(2026, 8, 1, 0, 0, i % 60)),
        addedBy: adminAUser.id,
        addedByName: adminAUser.name,
      });
    }
    await db.transaction.createMany({ data: filler });
    const capRevenueDesc = `qa-cap-revenue-${STAMP}`;
    await db.transaction.create({
      data: {
        companyId: companyA,
        type: "income",
        amount: 999999,
        category: "Product Sales",
        description: capRevenueDesc,
        date: new Date(Date.UTC(2024, 0, 2)), // deliberately OLD
        addedBy: adminAUser.id,
        addedByName: adminAUser.name,
      },
    });
    const myRevenueRows = await db.transaction.count({
      where: { companyId: companyA, type: "income", deletedAt: null },
    });
    await admin.goto(`${BASE}/revenue`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 500));
    const revenueShown = await admin.evaluate((needle) => {
      const body = document.body.innerText;
      return {
        showsRow: body.includes(needle),
        emptyState: /no revenue yet/i.test(body),
        text: body.slice(0, 400),
      };
    }, capRevenueDesc);
    await shot(admin, "022-revenue-after-5000-cap");
    if (myRevenueRows > 0 && !revenueShown.showsRow) {
      fail(
        "TXN-022 the 5000-row ceiling silently hides money",
        `my tenant holds ${myRevenueRows} income row(s) but /revenue does not show "${capRevenueDesc}"${
          revenueShown.emptyState ? " and renders the empty state" : ""
        } — getTransactions() takes the 5000 newest rows across ALL types, so totals, runway and reports understate with no warning anywhere in the UI`
      );
    } else {
      ok("TXN-022 revenue is still visible past 5000 total transactions");
    }

    /* ── TXN-023: per-row delete is a HARD delete, contradicting the
       documented Tier-3 soft-delete recovery path for Transaction. ───── */
    const descDel = `qa-delete-me-${STAMP}`;
    await admin.goto(`${BASE}/investments`, { waitUntil: "networkidle0" });
    await addTransactionViaForm(admin, { amount: "4321", description: descDel });
    const delRow = await waitFor(
      () => db.transaction.findFirst({ where: { companyId: companyA, description: descDel } }),
      (r) => Boolean(r),
      20000
    );
    if (!delRow) {
      fail("TXN-023 setup", "could not create the investment to delete");
    } else {
      // Give it a comment first, so the cascade is observable too.
      await db.comment.create({
        data: {
          companyId: companyA,
          body: `qa-comment-${STAMP}`,
          authorId: adminAUser.id,
          authorName: adminAUser.name,
          transactionId: delRow.id,
        },
      });
      await admin.goto(`${BASE}/investments`, { waitUntil: "networkidle0" });
      await admin.waitForFunction(
        (d) => document.body.innerText.includes(d),
        { timeout: 20000 },
        descDel
      );
      await admin.evaluate((d) => {
        const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
          (b.getAttribute("aria-label") ?? "").includes(d)
        );
        btn?.click();
      }, descDel);
      // Confirm dialog, gated on its TITLE rather than its body copy: the
      // description no longer claims the delete is permanent (it is a soft
      // delete — R4-money-016-trail), and a wait pinned to that old sentence
      // would hang here for 15s and then abort the whole run.
      await admin.waitForFunction(() => /delete this investment\?/i.test(document.body.innerText), {
        timeout: 15000,
      });
      await shot(admin, "023-delete-confirm");
      await admin.evaluate(() => {
        [...document.querySelectorAll("button")]
          .filter((b) => /^delete$/i.test((b.textContent ?? "").trim()))
          .pop()
          ?.click();
      });
      const gone = await waitFor(
        () => db.transaction.findFirst({ where: { companyId: companyA, id: delRow.id } }),
        (r) => r === null,
        20000
      );
      if (gone === null) {
        fail(
          "TXN-023 per-row delete is permanent",
          "the row is physically gone; deletedAt is never set, so CLAUDE.md's documented one-UPDATE recovery cannot restore an individually deleted transaction"
        );
      } else if (gone?.deletedAt) {
        ok("TXN-023 per-row delete writes the soft-delete sentinel");
      } else {
        fail("TXN-023 delete outcome", "row still live and not tombstoned — the delete did nothing");
      }
      const orphanComments = await db.comment.count({
        where: { companyId: companyA, transactionId: delRow.id },
      });
      if (orphanComments === 0) {
        fail(
          "TXN-024 delete destroys the discussion",
          "Comment.transactionId cascades, so deleting a transaction erases its whole comment thread — and nothing in the confirm dialog warns that the discussion goes with it"
        );
      } else {
        ok("TXN-024 comments survive their transaction's deletion");
      }
    }

    /* ── roles: cofounder + member, invited through the real flow ──────── */
    const cofo = await inviteAndAccept(browser, admin, companyA, {
      name: `QA Cofounder ${STAMP}`,
      email: COFO_A,
      role: "cofounder",
    });
    opened.push(cofo.ctx);
    const member = await inviteAndAccept(browser, admin, companyA, {
      name: `QA Member ${STAMP}`,
      email: MEMBER_A,
      role: "member",
    });
    opened.push(member.ctx);

    /* ── TXN-025 (negative-result candidate): a member is kept out ─────── */
    for (const route of ["/expenses", "/revenue", "/investments"]) {
      await member.page.goto(`${BASE}${route}`, { waitUntil: "networkidle0" });
      const landed = new URL(member.page.url()).pathname;
      if (landed !== route) ok(`TXN-025 a member is bounced off ${route} (-> ${landed})`);
      else fail("TXN-025 member finance gate", `a member reached ${route}`);
    }
    await shot(member.page, "025-member-bounced");

    /* ── TXN-026: a member who SUPERVISES a project still cannot record
       that project's spend — the escape hatch is read-only. ──────────── */
    if (projectName) {
      const proj = await db.project.findFirst({
        where: { companyId: companyA, name: projectName },
      });
      if (proj) {
        // Reassign supervision to the member through the real UI.
        await admin.goto(`${BASE}/projects/${proj.id}`, { waitUntil: "networkidle0" });
        await admin.evaluate(() => {
          [...document.querySelectorAll("button")]
            .find((b) => /supervisor/i.test(b.textContent ?? ""))
            ?.click();
        });
        const hasModal = await admin
          .waitForSelector('[role="dialog"] select', { timeout: 10000 })
          .then(() => true)
          .catch(() => false);
        if (hasModal) {
          await admin.evaluate((uid) => {
            const dlg = document.querySelector('[role="dialog"]');
            const sel = dlg.querySelector("select");
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, uid);
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            dlg.querySelector("form")?.requestSubmit();
          }, member.user.id);
          await waitFor(
            () => db.project.findFirst({ where: { companyId: companyA, id: proj.id } }),
            (p) => p?.supervisorId === member.user.id,
            20000
          );
        }
        const nowSupervised = await db.project.findFirst({
          where: { companyId: companyA, id: proj.id },
        });
        if (nowSupervised?.supervisorId === member.user.id) {
          await member.page.goto(`${BASE}/projects/${proj.id}`, { waitUntil: "networkidle0" });
          const supervisorSurface = await member.page.evaluate(() => ({
            text: document.body.innerText,
            hasSpendCta: [...document.querySelectorAll("button, a")].some((el) =>
              /log expense|add expense|record spend/i.test(el.textContent ?? "")
            ),
          }));
          await shot(member.page, "026-supervisor-project");
          if (!supervisorSurface.hasSpendCta) {
            fail(
              "TXN-026 supervisor escape hatch is read-only for spend",
              "a member supervising this project can see its budget and month-to-date spend but has no way anywhere in the product to record an expense against it — addTransactionAction gates on canSeeFinances(role), and the only form that can tag a project lives on /expenses, which members cannot reach"
            );
          } else {
            ok("TXN-026 a supervising member can record spend on their own project");
          }
        } else {
          note("TXN-026 skipped — could not hand supervision to the member through the UI");
        }
      }
    }

    /* ── TXN-027: per-row delete permission, both directions ───────────── */
    const cofoDesc = `qa-cofo-expense-${STAMP}`;
    await cofo.page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await addTransactionViaForm(cofo.page, { amount: "1500", description: cofoDesc });
    const cofoRow = await waitFor(
      () => db.transaction.findFirst({ where: { companyId: companyA, description: cofoDesc } }),
      (r) => Boolean(r),
      20000
    );
    if (!cofoRow) {
      fail("TXN-027 setup", "the cofounder could not log an expense");
    } else {
      ok("TXN-027a a cofounder can log an expense");
      // The admin's row (desc1) must NOT be deletable by the cofounder.
      await cofo.page.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
      const cofoSeesAdminDelete = await cofo.page.evaluate(
        (d) =>
          [...document.querySelectorAll("button[aria-label]")].some((b) =>
            (b.getAttribute("aria-label") ?? "").includes(d)
          ),
        desc1
      );
      if (cofoSeesAdminDelete) {
        fail(
          "TXN-027b delete affordance leaks",
          `a cofounder is offered a Delete button for the admin's "${desc1}", which deleteTransactionAction then refuses — the UI promises an action the server denies`
        );
      } else {
        ok("TXN-027b a cofounder is not offered Delete on someone else's row");
      }
    }

    /* ── TXN-028: cross-tenant forge. Tenant B is my own second workspace,
       so nothing pre-existing is touched. The delete request's body id is
       rewritten in flight to point at B's row. ─────────────────────── */
    const ctxB = await browser.createBrowserContext();
    opened.push(ctxB);
    const adminB = await newPage(ctxB);
    companyB = await signUpWorkspace(adminB, {
      name: `QA Ledger B ${STAMP}`,
      email: ADMIN_B,
      companyName: TENANT_B,
      currency: "PKR",
    });
    const adminBUser = await db.user.findFirst({ where: { companyId: companyB, email: ADMIN_B } });
    const victimDesc = `qa-victim-${STAMP}`;
    await adminB.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await addTransactionViaForm(adminB, { amount: "9100", description: victimDesc });
    const victim = await waitFor(
      () => db.transaction.findFirst({ where: { companyId: companyB, description: victimDesc } }),
      (r) => Boolean(r),
      20000
    );
    if (!victim || !cofoRow) {
      note("TXN-028 skipped — could not stage both sides of the forge");
    } else {
      await admin.setRequestInterception(true);
      const swap = (req) => {
        const data = req.postData();
        if (data && data.includes(cofoRow.id)) {
          req.continue({ postData: data.split(cofoRow.id).join(victim.id) }).catch(() => {});
          return;
        }
        req.continue().catch(() => {});
      };
      admin.on("request", swap);
      await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
      await admin
        .waitForFunction((d) => document.body.innerText.includes(d), { timeout: 20000 }, cofoDesc)
        .catch(() => {});
      await admin.evaluate((d) => {
        [...document.querySelectorAll("button[aria-label]")]
          .find((b) => (b.getAttribute("aria-label") ?? "").includes(d))
          ?.click();
      }, cofoDesc);
      // The title again, for the same reason as TXN-023 above.
      await admin
        .waitForFunction(() => /delete this expense\?/i.test(document.body.innerText), {
          timeout: 15000,
        })
        .catch(() => {});
      await admin.evaluate(() => {
        [...document.querySelectorAll("button")]
          .filter((b) => /^delete$/i.test((b.textContent ?? "").trim()))
          .pop()
          ?.click();
      });
      await new Promise((r) => setTimeout(r, 2500));
      admin.off("request", swap);
      await admin.setRequestInterception(false);
      await shot(admin, "028-cross-tenant-forge");

      const victimAfter = await db.transaction.findFirst({
        where: { companyId: companyB, id: victim.id },
      });
      if (victimAfter) {
        ok("TXN-028 a forged cross-tenant delete is refused — the other tenant's row survives");
      } else {
        fail(
          "TXN-028 CROSS-TENANT DELETE",
          `tenant A's admin destroyed transaction ${victim.id} belonging to tenant B (${companyB})`
        );
      }
    }

    /* ── TXN-029: a tombstoned teammate keeps receiving finance pings ──── */
    await admin.goto(`${BASE}/team`, { waitUntil: "networkidle0" });
    const removed = await admin.evaluate((email) => {
      const rows = [...document.querySelectorAll("tr, li")];
      const row = rows.find((r) => r.innerText.includes(email));
      const btn = [...(row?.querySelectorAll("button") ?? [])].find((b) =>
        /remove|deactivate/i.test((b.textContent ?? "") + (b.getAttribute("aria-label") ?? ""))
      );
      btn?.click();
      return Boolean(btn);
    }, MEMBER_A);
    if (removed) {
      await admin
        .waitForFunction(() => /cannot be undone|remove|deactivate/i.test(document.body.innerText), {
          timeout: 10000,
        })
        .catch(() => {});
      await admin.evaluate(() => {
        [...document.querySelectorAll("button")]
          .filter((b) => /^(remove|deactivate|confirm)$/i.test((b.textContent ?? "").trim()))
          .pop()
          ?.click();
      });
      await waitFor(
        () => db.user.findFirst({ where: { companyId: companyA, id: member.user.id } }),
        (u) => Boolean(u?.deletedAt),
        20000
      );
    }
    const memberRow = await db.user.findFirst({
      where: { companyId: companyA, id: member.user.id },
    });
    if (!memberRow?.deletedAt) {
      note("TXN-029 skipped — could not deactivate the member through the UI");
    } else {
      const beforeNotif = await db.notification.count({
        where: { companyId: companyA, userId: member.user.id },
      });
      const pingDesc = `qa-ping-${STAMP}`;
      await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
      await addTransactionViaForm(admin, { amount: "60", description: pingDesc });
      await waitFor(
        () => db.transaction.findFirst({ where: { companyId: companyA, description: pingDesc } }),
        (r) => Boolean(r),
        20000
      );
      const afterNotif = await waitFor(
        () =>
          db.notification.count({ where: { companyId: companyA, userId: member.user.id } }),
        (n) => n > beforeNotif,
        10000
      );
      if (afterNotif > beforeNotif) {
        fail(
          "TXN-029 finance notifications fan out to a deactivated user",
          `a tombstoned teammate in MY tenant gained a notification carrying an amount (${beforeNotif} -> ${afterNotif}); addTransactionAction's recipient query omits deletedAt: null, unlike the same query in comments.ts and chat.ts, and firePush is fed the same unfiltered list`
        );
      } else {
        ok("TXN-029 a deactivated teammate is excluded from the finance fan-out");
      }
    }

    /* ── TXN-030: /revenue ships without a loading skeleton ────────────── */
    const hasRevenueLoading = existsSync(
      new URL("../app/(app)/revenue/loading.tsx", import.meta.url)
    );
    if (!hasRevenueLoading) {
      fail(
        "TXN-030 /revenue has no loading.tsx",
        "its two siblings /expenses and /investments both ship one, so Revenue is the only finance page that shows a blank frame while its RSC awaits getTransactions()"
      );
    } else {
      ok("TXN-030 /revenue ships a loading skeleton");
    }

    /* ── TXN-031: comments exist on expenses only ──────────────────────── */
    await admin.goto(`${BASE}/revenue`, { waitUntil: "networkidle0" });
    const revenueHasComments = await admin.evaluate(() =>
      [...document.querySelectorAll("button[aria-label]")].some((b) =>
        /comment/i.test(b.getAttribute("aria-label") ?? "")
      )
    );
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    const expensesHaveComments = await admin.evaluate(() =>
      [...document.querySelectorAll("button[aria-label]")].some((b) =>
        /comment/i.test(b.getAttribute("aria-label") ?? "")
      )
    );
    if (expensesHaveComments && !revenueHasComments) {
      fail(
        "TXN-031 comments are missing on revenue and investments",
        "Comment.transactionId works for any transaction and /expenses exposes a thread per row, but /revenue and /investments expose none — the same data model, three inconsistent surfaces"
      );
    } else {
      ok("TXN-031 comment affordance is consistent across the three ledgers");
    }

    /* ── TXN-032: refresh / back-forward mid-flow must not double-post ── */
    const dupDesc = `qa-doublepost-${STAMP}`;
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0" });
    await addTransactionViaForm(admin, { amount: "31", description: dupDesc });
    await waitFor(
      () => db.transaction.count({ where: { companyId: companyA, description: dupDesc } }),
      (n) => n >= 1,
      20000
    );
    await admin.reload({ waitUntil: "networkidle0" });
    await admin.goBack({ waitUntil: "networkidle0" }).catch(() => {});
    await admin.goForward({ waitUntil: "networkidle0" }).catch(() => {});
    const dupCount = await db.transaction.count({
      where: { companyId: companyA, description: dupDesc },
    });
    if (dupCount === 1) {
      ok("TXN-032 reload + back/forward after a submit does not re-post the transaction");
    } else {
      fail("TXN-032 double-post", `expected 1 row for "${dupDesc}", found ${dupCount}`);
    }

    console.log("");
    console.log(`  ${okCount} ok, ${failCount} failed`);
    if (failCount > 0) console.log("❌ transactions-ledger has failures");
    else console.log("✅ transactions-ledger clean");
  } finally {
    /* ── teardown: both of MY tenants, children before parents ─────────── */
    for (const ctx of opened) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});

    const scoped = [
      ["messageReaction", (id) => ({ message: { companyId: id } })],
      ["message", (id) => ({ companyId: id })],
      ["channelMember", (id) => ({ channel: { companyId: id } })],
      ["channel", (id) => ({ companyId: id })],
      ["comment", (id) => ({ companyId: id })],
      ["timeEntry", (id) => ({ companyId: id })],
      ["notification", (id) => ({ companyId: id })],
      ["activity", (id) => ({ companyId: id })],
      ["inviteToken", (id) => ({ companyId: id })],
      ["recurringRule", (id) => ({ companyId: id })],
      ["budget", (id) => ({ companyId: id })],
      ["transaction", (id) => ({ companyId: id })],
      ["task", (id) => ({ companyId: id })],
      ["project", (id) => ({ companyId: id })],
      ["notificationPreference", (id) => ({ user: { companyId: id } })],
      ["pushSubscription", (id) => ({ user: { companyId: id } })],
    ];
    for (const id of [companyA, companyB].filter(Boolean)) {
      try {
        for (const [model, scope] of scoped) {
          await db[model].deleteMany({ where: scope(id) });
        }
        await db.company.update({ where: { id }, data: { ownerId: null } }).catch(() => {});
        await db.user.deleteMany({ where: { companyId: id } });
        await db.company.delete({ where: { id } });
        console.log(`  cleaned tenant ${id}`);
      } catch (e) {
        console.error(`  cleanup failed for ${id}: ${e.message}`);
      }
    }
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error("❌ qa-transactions-ledger threw:", e.stack ?? e.message);
  process.exitCode = 1;
});
