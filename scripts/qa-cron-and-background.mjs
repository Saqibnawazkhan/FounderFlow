/*
 * QA audit — CRON & BACKGROUND JOBS surface.   AGENT_INDEX = 13
 *
 * Phase 2 runner for the static findings in the cron/background domain:
 *   /api/cron/materialize-recurring, /api/cron/sweep-time-entries,
 *   /api/cron/purge-soft-deleted, CRON_SECRET auth, PURGE_ENABLED,
 *   lib/safety/bulk-mutation-guard.ts, lib/recurring/materialize.ts,
 *   sweepAutoCloseEntries in lib/time/sweep.ts (moved out of lib/actions/time.ts
 *   on 2026-09-26 to remove its public Server Action id), .github/workflows/backup.yml.
 *
 * ── DATA SAFETY — READ THIS BEFORE CHANGING ANYTHING IN HERE ─────────────
 *
 * This domain is the ONLY one in the audit whose endpoints are NOT
 * tenant-scoped. `GET /api/cron/materialize-recurring` mints Transaction +
 * Activity rows for EVERY workspace whose rule is due, and
 * `GET /api/cron/sweep-time-entries` writes clockOutAt + autoClosed into
 * EVERY workspace's stale open entries. Firing either one blind would
 * UPDATE pre-existing rows — including demo-nimbus — and
 * `node scripts/_qa-guard.mjs verify` compares row HASHES, so it would catch
 * it and fail the whole run. Worse, it would silently corrupt every other
 * agent's fixtures.
 *
 * So every destructive invocation in this file is gated by a PRE-FLIGHT that
 * asks the database, read-only, whether the route would touch anything
 * outside my tenant RIGHT NOW:
 *
 *   • materialize-recurring → `foreignDueRules()` replicates the route's own
 *     `where` (a deliberate superset of it — see the note on the function) +
 *     the pure predicate in lib/recurring/materialize.ts for every company
 *     EXCEPT mine. Non-empty ⇒ the fire is SKIPPED and reported, never forced.
 *   • sweep-time-entries   → `foreignStaleEntries()` replicates
 *     sweepAutoCloseEntries' `where` for every company EXCEPT mine.
 *     Non-empty ⇒ SKIPPED.
 *   • purge-soft-deleted   → refuses to fire at all unless the EFFECTIVE
 *     PURGE_ENABLED (resolved through Next's dev env precedence, the same
 *     way the running server resolves it) is anything other than "true".
 *     In dry-run the route writes nothing; that is the only reason it is
 *     safe to call an unscoped erasure endpoint from an audit script.
 *
 * The pre-flights re-run immediately before each fire, not once at startup.
 *
 * Everything else: the tenant is created through the REAL signup flow
 * (`qa-cron-<stamp>`, the prefix scripts/_qa-guard.mjs sweeps on) and EVERY
 * database read, write and assertion carries `companyId: TENANT.companyId`.
 * A bare `db.transaction.count()` would be satisfied by another agent's
 * concurrent insert and produce a FALSE PASS — the most expensive outcome in
 * a pre-launch audit — so there are none. The FK-jam probe deliberately runs
 * a `deleteMany` scoped to my companyId inside a transaction that ALWAYS
 * rolls back, so it proves the constraint error without deleting a row.
 *
 * ── CONVENTIONS ─────────────────────────────────────────────────────────
 *   • localDb() only — a bare `new PrismaClient()` auto-loads the root .env,
 *     which points at PRODUCTION Supabase (tests/lib/db/script-safety.test.ts).
 *   • fail() records and returns, never throws, so one run reports every
 *     broken assertion. A literal ❌ is printed so the runner counts it.
 *   • x-real-ip: 10.99.0.13 on every page before its first navigation, and
 *     on every bare fetch() too — getClientIp() falls back to the literal
 *     "unknown" in dev, so without it all agents share one limiters.auth
 *     bucket of 5/60s.
 *   • Waits are state predicates (waitForFunction); the only fixed sleeps are
 *     the hydration pauses copied verbatim from scripts/smoke-chat.mjs
 *     (FaultsAudit A14 — a pre-hydration click does a native GET submit).
 *   • Screenshots to a per-agent directory so no agent overwrites evidence.
 */

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

// fileURLToPath, not import.meta.dirname — the portable form, kept now that the
// Node pin has moved. The original reason was narrower: import.meta.dirname needs
// Node >= 20.11 while .github/workflows/ci.yml pinned node-version "20". CI and
// `engines.node` pin "24" today (tests/ops/node-runtime-pin.test.ts enforces
// that they agree), so this is a preference, not a constraint.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_IP = "10.99.0.13";
const SHOTS = "C:/Users/USER/AppData/Local/Temp/ff-qa/cron-and-background";
const STAMP = Date.now().toString().slice(-8);

/** Mirrors RETENTION_DAYS in app/api/cron/purge-soft-deleted/route.ts. */
const RETENTION_DAYS = 90;
/** Mirrors AUTO_CLOSE_MS in lib/time/thresholds.ts (12h warn + 30m window). */
const AUTO_CLOSE_MS = 12 * 60 * 60 * 1000 + 30 * 60 * 1000;

const CRON_ROUTES = {
  materialize: "/api/cron/materialize-recurring",
  sweep: "/api/cron/sweep-time-entries",
  purge: "/api/cron/purge-soft-deleted",
};

const db = localDb();

const TENANT = {
  companyId: null,
  companyName: `qa-cron-${STAMP}`,
  adminEmail: `qa-cron-${STAMP}@founderflow.test`,
  adminPassword: `qa-Cron-${STAMP}!`,
  adminUserId: null,
  adminName: `QA Cron Admin ${STAMP}`,
  projectId: null,
  ruleId: null,
};

let passes = 0;
let failures = 0;
let blocked = 0;

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

/**
 * A check that could NOT be performed because performing it would have
 * written outside my tenant. Reported loudly and separately from a pass so
 * "clean domain" and "never looked" can't be confused.
 */
function skip(label, why) {
  blocked++;
  console.log(`  BLOCKED  ${label} — ${why}`);
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
 * Env resolution — exactly how the running dev server resolves it
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Next.js dev loads, first-wins: .env.development.local, .env.local,
 * .env.development, .env. Reading the same order is the only way this script
 * can know which CRON_SECRET the SERVER will compare against, and whether
 * PURGE_ENABLED is hot. Getting this wrong in the PURGE_ENABLED direction
 * would fire a real erasure across every workspace in the database.
 */
const ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];

function readEnvKey(key) {
  for (const file of ENV_FILES) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== key) continue;
      return {
        value: trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
        from: file,
      };
    }
  }
  return null;
}

const CRON_SECRET_ENTRY = readEnvKey("CRON_SECRET");
const PURGE_ENTRY = readEnvKey("PURGE_ENABLED");
const CRON_SECRET = CRON_SECRET_ENTRY?.value ?? null;
/** The route computes `dryRun = process.env.PURGE_ENABLED !== "true"`. */
const PURGE_IS_LIVE = PURGE_ENTRY?.value === "true";

/* ────────────────────────────────────────────────────────────────────────
 * HTTP helper — carries the agent IP so the shared rate-limit bucket in dev
 * doesn't starve the other twelve agents.
 * ──────────────────────────────────────────────────────────────────────── */

async function hit(path, { method = "GET", headers = {}, body } = {}) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-real-ip": AGENT_IP, ...headers },
    body,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json — 405s and redirects aren't */
  }
  return { status: res.status, json, text, ms: Date.now() - started, headers: res.headers };
}

const authed = (extra = {}) => ({ Authorization: `Bearer ${CRON_SECRET}`, ...extra });

/* ────────────────────────────────────────────────────────────────────────
 * Blast-radius pre-flights. Read-only. Re-run before every fire.
 * ──────────────────────────────────────────────────────────────────────── */

/** Replicates isRuleDueOn() from lib/recurring/materialize.ts. */
function isRuleDueOn(rule, when) {
  if (!rule.active) return false;
  const start = rule.startDate;
  const startOfDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  );
  if (when < startOfDay) return false;
  if (rule.frequency === "monthly") {
    if (rule.dayOfMonth == null) return false;
    const today = when.getUTCDate();
    const daysInMonth = new Date(
      Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + 1, 0)
    ).getUTCDate();
    return today === rule.dayOfMonth || (rule.dayOfMonth > daysInMonth && today === daysInMonth);
  }
  if (rule.frequency === "weekly") {
    if (rule.dayOfWeek == null) return false;
    return when.getUTCDay() === rule.dayOfWeek;
  }
  return false;
}

function sameUTCDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Every rule the materializer would fire right now that is NOT mine. The
 * route's own filter is `{ active: true, company: { deletedAt: null } }`;
 * anything this returns is a row in somebody else's workspace that a fire
 * would create a Transaction + Activity for.
 *
 * DELIBERATELY WIDER THAN THE ROUTE SINCE finance-planning-013: the route also
 * skips a rule whose AUTHOR has been deactivated, and this does not ask. So
 * this can over-report and cost a skipped fire, never under-report and let one
 * through — which is the only direction a pre-flight may be wrong in. Do not
 * "reconcile" it by adding the author filter here.
 */
async function foreignDueRules() {
  const now = new Date();
  const rules = await db.recurringRule.findMany({
    where: {
      active: true,
      company: { deletedAt: null },
      companyId: { not: TENANT.companyId ?? "__none__" },
    },
  });
  return rules.filter(
    (r) => isRuleDueOn(r, now) && !(r.lastMaterializedAt && sameUTCDay(r.lastMaterializedAt, now))
  );
}

/** Every open, stale entry the sweep would close that is NOT mine. */
async function foreignStaleEntries() {
  return db.timeEntry.findMany({
    where: {
      clockOutAt: null,
      lastActivityAt: { lt: new Date(Date.now() - AUTO_CLOSE_MS) },
      companyId: { not: TENANT.companyId ?? "__none__" },
    },
    select: { id: true, companyId: true },
  });
}

/**
 * Fire a cron route only if the pre-flight says the write set is inside my
 * tenant. Returns null when blocked, so callers must handle it.
 */
async function fireIfSafe(routeKey, preflight, label) {
  const foreign = await preflight();
  if (foreign.length > 0) {
    const where = [...new Set(foreign.map((f) => f.companyId))].join(", ");
    skip(
      label,
      `pre-flight found ${foreign.length} row(s) this unscoped route would write OUTSIDE my tenant ` +
        `(companies: ${where}). Refusing to fire — that would mutate pre-existing data and fail _qa-guard verify.`
    );
    return null;
  }
  return hit(CRON_ROUTES[routeKey], { headers: authed() });
}

/* ────────────────────────────────────────────────────────────────────────
 * Page setup + auth helpers
 * ──────────────────────────────────────────────────────────────────────── */

async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  await page.setViewport({ width: 1440, height: 1000 });
  page.__consoleErrors = [];
  page.on("pageerror", (e) => page.__consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") page.__consoleErrors.push(`console: ${m.text()}`);
  });
  return { ctx, page };
}

// COPIED VERBATIM from scripts/smoke-chat.mjs (FaultsAudit A14).
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

async function setNative(page, selector, value, index = 0) {
  await page.evaluate(
    ({ selector, value, index }) => {
      const el = document.querySelectorAll(selector)[index];
      if (!el) throw new Error(`no element for ${selector}[${index}]`);
      el.focus();
      const proto =
        el.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { selector, value, index }
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Tenant creation — the REAL signup flow
 * ──────────────────────────────────────────────────────────────────────── */

async function signUpTenant(page) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
  await page.waitForSelector("input[name=email]", { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500)); // hydration — see signIn()

  await page.type("input[name=name]", TENANT.adminName);
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
    select: { id: true },
  });
  if (!admin) throw new Error("signup did not create the admin user in my tenant");
  TENANT.adminUserId = admin.id;

  const project = await db.project.findFirst({
    where: { companyId: TENANT.companyId },
    select: { id: true },
  });
  if (!project) throw new Error("signup did not create a default project in my tenant");
  TENANT.projectId = project.id;

  ok(`tenant created via real signup — ${TENANT.companyName} (${TENANT.companyId})`);
}

/* ════════════════════════════════════════════════════════════════════════
 * A. CRON_SECRET auth surface. Writes nothing on any path asserted here:
 *    every request below is rejected before the handler reaches the DB.
 * ════════════════════════════════════════════════════════════════════════ */

async function checkAuthSurface() {
  section("A. CRON_SECRET auth surface (all three routes)");

  if (!CRON_SECRET) {
    fail(
      "CRON_SECRET resolution",
      `no CRON_SECRET in ${ENV_FILES.join(" / ")} — the dev server will 500 on every cron route ` +
        "and none of the authorized-path checks below can run"
    );
    return;
  }
  ok(`CRON_SECRET resolved from ${CRON_SECRET_ENTRY.from} (${CRON_SECRET.length} chars)`);

  // Same length as the real header, one byte different: this is the case a
  // naive `!==` leaks a timing signal on and the only case timingSafeEqual
  // actually covers (safeEqual compares length first, in NON-constant time).
  const realHeader = `Bearer ${CRON_SECRET}`;
  const flipLast = realHeader.slice(0, -1) + (realHeader.slice(-1) === "a" ? "b" : "a");
  const flipFirstSecretByte =
    `Bearer ` + (CRON_SECRET[0] === "a" ? "b" : "a") + CRON_SECRET.slice(1);

  const cases = [
    ["no Authorization header", {}, 401],
    ["wrong secret, same length (last byte flipped)", { Authorization: flipLast }, 401],
    ["wrong secret, same length (first byte flipped)", { Authorization: flipFirstSecretByte }, 401],
    ["wrong secret, different length", { Authorization: `Bearer ${CRON_SECRET}xx` }, 401],
    ["empty bearer", { Authorization: "Bearer " }, 401],
    ["raw secret with no Bearer prefix", { Authorization: CRON_SECRET }, 401],
    ["lowercase scheme: 'bearer <secret>'", { Authorization: `bearer ${CRON_SECRET}` }, 401],
  ];

  for (const [key, path] of Object.entries(CRON_ROUTES)) {
    for (const [label, headers, expected] of cases) {
      const res = await hit(path, { headers });
      if (res.status === expected) ok(`${key}: ${label} → ${expected}`);
      else
        fail(
          `${key}: ${label}`,
          `expected ${expected}, got ${res.status} body=${res.text.slice(0, 160)}`
        );
    }

    // A query-string backdoor would make the secret leak into access logs
    // and browser history. There must not be one.
    const qs = await hit(`${path}?secret=${encodeURIComponent(CRON_SECRET)}`);
    if (qs.status === 401) ok(`${key}: ?secret= query param is not accepted → 401`);
    else fail(`${key}: query-param secret`, `expected 401, got ${qs.status}`);

    // Only GET is exported. A POST with a valid bearer must not run the job.
    const post = await hit(path, { method: "POST", headers: authed() });
    if (post.status === 405) ok(`${key}: POST with a valid bearer → 405 (GET-only)`);
    else
      fail(
        `${key}: POST with a valid bearer`,
        `expected 405, got ${post.status} — if this is 2xx the job ran on a POST`
      );
  }

  // Fail-closed-when-unset cannot be exercised without editing .env.local and
  // restarting the server, which this audit forbids (HMR/env changes
  // contaminate every other agent). Assert the structure instead — the same
  // technique tests/lib/db/script-safety.test.ts uses.
  for (const [key, path] of Object.entries(CRON_ROUTES)) {
    const src = readFileSync(join(ROOT, "app", path.replace(/^\/api/, "api"), "route.ts"), "utf8");
    const guard =
      /const expected = process\.env\.CRON_SECRET;[\s\S]{0,200}?if \(!expected\)[\s\S]{0,200}?status: 500/.test(
        src
      );
    const guardBeforeDb = src.indexOf("CRON_SECRET") < src.indexOf("db.") || !src.includes("db.");
    if (guard && guardBeforeDb)
      ok(`${key}: fails CLOSED with 500 when CRON_SECRET is unset, before any DB access`);
    else
      fail(
        `${key}: fail-closed guard`,
        `could not find the "if (!expected) → 500" guard ahead of DB access in ${path}/route.ts`
      );
  }

  // Timing: advisory only. Over loopback the signal is tiny and the medians
  // are noisy, so this NEVER fails on a small delta — it reports the numbers
  // so a regression to a plain `!==` would be visible as a growing spread.
  const timeIt = async (header, n = 25) => {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const r = await hit(CRON_ROUTES.purge, { headers: { Authorization: header } });
      samples.push(r.ms);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  };
  const medFirst = await timeIt(flipFirstSecretByte);
  const medLast = await timeIt(flipLast);
  note(
    "constant-time compare (advisory)",
    `median ms with first secret byte wrong = ${medFirst}, with last byte wrong = ${medLast}; ` +
      `delta ${Math.abs(medFirst - medLast)}ms — a plain !== would trend last > first`
  );
}

/* ════════════════════════════════════════════════════════════════════════
 * B. Materializer — idempotency, concurrency, and the missed-day gap.
 * ════════════════════════════════════════════════════════════════════════ */

async function createRecurringRuleViaUi(page) {
  section("B. Materializer (/api/cron/materialize-recurring)");

  await page.goto(`${BASE}/recurring`, { waitUntil: "networkidle0" });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) =>
        /new rule|add first rule/i.test(b.textContent || "")
      ),
    { timeout: 30000 }
  );
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /new rule|add first rule/i.test(b.textContent || "")
    );
    btn?.click();
  });
  await page.waitForSelector('[role="dialog"] input', { timeout: 15000 });

  const todayDom = new Date().getUTCDate();
  await page.evaluate(
    ({ desc, dayOfMonth }) => {
      const dialog = document.querySelector('[role="dialog"]');
      const nums = dialog.querySelectorAll('input[type="number"]');
      const set = (el, v) => {
        if (!el) return;
        el.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
          el,
          String(v)
        );
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      set(nums[0], "1234.56"); // amount
      set(nums[nums.length - 1], String(dayOfMonth)); // day of month
      set(dialog.querySelector('input[name="description"]'), desc);
    },
    { desc: `qa-cron rule ${STAMP}`, dayOfMonth: todayDom }
  );
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 20000 })
    .catch(() => {});
  await shot(page, "recurring-after-create");

  const rule = await db.recurringRule.findFirst({
    where: { companyId: TENANT.companyId, description: `qa-cron rule ${STAMP}` },
  });
  if (!rule) {
    fail(
      "recurring rule creation",
      "the rule never landed in my tenant; materializer checks cannot run"
    );
    return null;
  }
  TENANT.ruleId = rule.id;
  ok(`rule created in my tenant: monthly, dayOfMonth=${rule.dayOfMonth}, amount=${rule.amount}`);

  // The action posts a seed transaction and stamps lastMaterializedAt so the
  // same night's cron can't double-post. Both halves matter.
  const seeds = await db.transaction.count({
    where: { companyId: TENANT.companyId, ruleId: rule.id },
  });
  if (seeds === 1) ok("rule creation posted exactly 1 seed transaction in my tenant");
  else fail("seed transaction count", `expected exactly 1 for my ruleId, got ${seeds}`);

  if (rule.lastMaterializedAt && sameUTCDay(rule.lastMaterializedAt, new Date()))
    ok("lastMaterializedAt stamped today at creation — tonight's cron will skip the rule");
  else
    fail(
      "lastMaterializedAt at creation",
      `expected today's UTC date, got ${rule.lastMaterializedAt?.toISOString() ?? "null"} — ` +
        "the same-day cron run would double-post this rule"
    );
  return rule;
}

async function myRuleTxnCount() {
  return db.transaction.count({
    where: { companyId: TENANT.companyId, ruleId: TENANT.ruleId },
  });
}

/** Backdate MY rule so the materializer considers it due. My row only. */
async function backdateMyRule(days = 2) {
  await db.recurringRule.update({
    where: { id: TENANT.ruleId },
    data: { lastMaterializedAt: new Date(Date.now() - days * 864e5) },
  });
}

async function checkMaterializerIdempotency() {
  if (!TENANT.ruleId) return;

  await backdateMyRule();
  const before = await myRuleTxnCount();

  const first = await fireIfSafe("materialize", foreignDueRules, "materializer: single fire");
  if (!first) return;
  if (first.status === 200) ok("materializer: authorized fire → 200");
  else
    fail(
      "materializer: authorized fire",
      `expected 200, got ${first.status} body=${first.text.slice(0, 200)}`
    );

  const afterFirst = await myRuleTxnCount();
  if (afterFirst === before + 1)
    ok(`materializer created exactly 1 transaction for MY rule (${before} → ${afterFirst})`);
  else
    fail(
      "materializer single fire",
      `expected my ruleId's transaction count to go ${before} → ${before + 1}, got ${afterFirst}`
    );

  // Sequential rerun on the same UTC day must be a no-op.
  const second = await fireIfSafe("materialize", foreignDueRules, "materializer: same-day rerun");
  if (second) {
    const afterSecond = await myRuleTxnCount();
    if (afterSecond === afterFirst)
      ok("materializer: same-day rerun is idempotent for MY rule (no second post)");
    else
      fail(
        "materializer same-day rerun",
        `expected ${afterFirst}, got ${afterSecond} — the rule double-posted`
      );
  }
}

async function checkMaterializerConcurrency() {
  if (!TENANT.ruleId) return;

  // The idempotency guard is a read-then-write with no unique constraint
  // behind it: the route reads every due rule, THEN loops. Two overlapping
  // invocations (Vercel cron is at-least-once, and a manual trigger can
  // coincide) both see lastMaterializedAt as stale and both create a
  // Transaction. There is no @@unique([ruleId, date]) on Transaction to stop
  // it, so the money row posts twice.
  await backdateMyRule();
  const before = await myRuleTxnCount();

  const foreign = await foreignDueRules();
  if (foreign.length > 0) {
    skip(
      "materializer: concurrent double-post",
      `pre-flight found ${foreign.length} due rule(s) outside my tenant — refusing to fire`
    );
    return;
  }
  const [a, b] = await Promise.all([
    hit(CRON_ROUTES.materialize, { headers: authed() }),
    hit(CRON_ROUTES.materialize, { headers: authed() }),
  ]);
  const after = await myRuleTxnCount();
  note("concurrent fire statuses", `${a.status} / ${b.status}`);
  if (after === before + 1)
    ok(`materializer: two concurrent fires posted MY rule once (${before} → ${after})`);
  else
    fail(
      "materializer concurrent double-post",
      `expected my ruleId's transactions to go ${before} → ${before + 1}; got ${after}. ` +
        `Two overlapping cron deliveries each posted a real money row for the same rule and ` +
        `the same day — Transaction has no @@unique([ruleId, date]) to stop it.`
    );
}

async function checkMissedDayIsNeverBackfilled() {
  if (!TENANT.ruleId) return;

  // Simulate "the cron did not run on the day this rule was due": move the
  // rule's dayOfMonth to yesterday and leave lastMaterializedAt stale. A
  // materializer with catch-up would notice the gap between
  // lastMaterializedAt and now and post the missed entry.
  const yesterday = new Date(Date.now() - 864e5).getUTCDate();
  const today = new Date().getUTCDate();
  if (yesterday === today) {
    note("missed-day check", "skipped: month boundary makes yesterday's DOM equal today's");
    return;
  }
  await db.recurringRule.update({
    where: { id: TENANT.ruleId },
    data: { dayOfMonth: yesterday, lastMaterializedAt: new Date(Date.now() - 5 * 864e5) },
  });
  const before = await myRuleTxnCount();
  const res = await fireIfSafe("materialize", foreignDueRules, "materializer: missed-day catch-up");
  if (!res) return;
  const after = await myRuleTxnCount();
  if (after === before + 1) ok("materializer backfilled a missed due-day for MY rule");
  else
    fail(
      "materializer missed-day catch-up",
      `my rule was due ${new Date(Date.now() - 864e5).toISOString().slice(0, 10)} and last ` +
        `materialized 5 days ago; expected the run to post the missed entry (${before} → ${before + 1}), ` +
        `got ${after}. isRuleDueOn() matches the EXACT calendar day only, Vercel cron does not retry, ` +
        `and nothing reconciles from lastMaterializedAt — so any night the cron does not run silently ` +
        `drops that period's recurring expense/income from the customer's books forever.`
    );
  // Put the rule back so later checks see a due-today rule.
  await db.recurringRule.update({
    where: { id: TENANT.ruleId },
    data: { dayOfMonth: today },
  });
}

/* ════════════════════════════════════════════════════════════════════════
 * C. Sweep — threshold, idempotency, tombstoned-workspace leak, and the
 *    publicly-callable server action behind it.
 * ════════════════════════════════════════════════════════════════════════ */

/** An open entry in MY tenant with a chosen idle age. My rows only. */
async function makeOpenEntry(idleMs, label) {
  const lastActivityAt = new Date(Date.now() - idleMs);
  return db.timeEntry.create({
    data: {
      companyId: TENANT.companyId,
      userId: TENANT.adminUserId,
      userName: TENANT.adminName,
      projectId: TENANT.projectId,
      description: `qa-cron ${label} ${STAMP}`,
      clockInAt: new Date(lastActivityAt.getTime() - 60 * 60 * 1000),
      clockOutAt: null,
      lastActivityAt,
    },
  });
}

async function checkSweep() {
  section("C. Sweep (/api/cron/sweep-time-entries)");

  const stale = await makeOpenEntry(AUTO_CLOSE_MS + 30 * 60 * 1000, "stale");
  const fresh = await makeOpenEntry(AUTO_CLOSE_MS - 30 * 60 * 1000, "fresh");

  const res = await fireIfSafe("sweep", foreignStaleEntries, "sweep: authorized fire");
  if (!res) return;
  if (res.status === 200) ok("sweep: authorized fire → 200");
  else fail("sweep: authorized fire", `expected 200, got ${res.status} ${res.text.slice(0, 200)}`);

  const closed = await db.timeEntry.findFirst({
    where: { companyId: TENANT.companyId, id: stale.id },
  });
  if (closed?.clockOutAt && closed.autoClosed)
    ok("sweep closed MY stale entry and flagged autoClosed");
  else
    fail(
      "sweep closes a stale entry",
      `entry ${stale.id} still has clockOutAt=${closed?.clockOutAt ?? "null"} autoClosed=${closed?.autoClosed}`
    );

  if (closed?.clockOutAt && stale.lastActivityAt.getTime() === closed.clockOutAt.getTime())
    ok("sweep set clockOutAt = lastActivityAt, so the recorded duration is sweep-time independent");
  else
    fail(
      "sweep clockOutAt value",
      `expected clockOutAt to equal lastActivityAt (${stale.lastActivityAt.toISOString()}), ` +
        `got ${closed?.clockOutAt?.toISOString() ?? "null"}`
    );

  const stillOpen = await db.timeEntry.findFirst({
    where: { companyId: TENANT.companyId, id: fresh.id },
  });
  if (stillOpen && stillOpen.clockOutAt === null)
    ok(
      `sweep respected the ${(AUTO_CLOSE_MS / 3.6e6).toFixed(1)}h threshold (12h-idle entry left open)`
    );
  else
    fail(
      "sweep auto-close threshold",
      `an entry idle for 12h (under the 12.5h AUTO_CLOSE_MS) was closed at ${stillOpen?.clockOutAt?.toISOString()}`
    );

  const rerun = await fireIfSafe("sweep", foreignStaleEntries, "sweep: rerun");
  if (rerun) {
    const again = await db.timeEntry.findFirst({
      where: { companyId: TENANT.companyId, id: stale.id },
    });
    if (again?.clockOutAt?.getTime() === closed?.clockOutAt?.getTime())
      ok("sweep: rerun is idempotent (clockOutAt unchanged)");
    else fail("sweep rerun", `clockOutAt moved to ${again?.clockOutAt?.toISOString()}`);
  }
}

async function checkSweepIgnoresTombstonedWorkspace() {
  // The materializer explicitly filters `company: { deletedAt: null }` and
  // says why: writing into a tombstoned workspace resurrects "deleted" data
  // inside the 90-day recovery window. The sweep has no such filter.
  await db.company.update({
    where: { id: TENANT.companyId },
    data: { deletedAt: new Date() },
  });
  const entry = await makeOpenEntry(AUTO_CLOSE_MS + 60 * 60 * 1000, "tombstoned-ws");

  const res = await fireIfSafe("sweep", foreignStaleEntries, "sweep: tombstoned-workspace filter");
  if (res) {
    const after = await db.timeEntry.findFirst({
      where: { companyId: TENANT.companyId, id: entry.id },
    });
    if (after && after.clockOutAt === null)
      ok("sweep skips entries in a soft-deleted workspace, matching the materializer's filter");
    else
      fail(
        "sweep writes into a soft-deleted workspace",
        `my company was tombstoned at ${new Date().toISOString()} yet the sweep set ` +
          `clockOutAt=${after?.clockOutAt?.toISOString()} autoClosed=${after?.autoClosed} on one of its ` +
          `entries. sweepAutoCloseEntries (lib/actions/time.ts:411) has no ` +
          `company: { deletedAt: null } filter, so for the whole 90-day recovery window the nightly ` +
          `cron keeps mutating rows an operator may still restore.`
      );
  }
  await db.company.update({ where: { id: TENANT.companyId }, data: { deletedAt: null } });
}

/**
 * C2 — was the P0, is now the regression guard.
 *
 * ORIGINALLY this check asserted the VULNERABILITY: sweepAutoCloseEntries was
 * an exported async function in a `"use server"` module (lib/actions/time.ts)
 * whose other exports are imported by four client components, so Next assigned
 * a Server Action id to every export in that module — including a function with
 * no auth(), no role check, no rate limit and a `where` clause spanning every
 * workspace. One anonymous POST closed every running timer for every customer.
 *
 * It was fixed 2026-09-26 by MOVING the function to lib/time/sweep.ts, a plain
 * server module with no directive, so the action id ceases to exist. Adding
 * auth() would have been the wrong fix: the cron carries no session, so the
 * job would simply have started failing.
 *
 * So the polarity here is now INVERTED. The old code failed when the function
 * was absent from lib/actions/time.ts ("re-point this check"), which after the
 * fix reported a CLOSED vulnerability as a live failure. Absence is now the
 * pass condition, and re-introduction is the failure. The live unauthenticated
 * POST below is retained but is unreachable by construction once the structural
 * half passes — there is no id left to invoke.
 */
async function checkSweepIsNotAPublicAction() {
  section("C2. sweepAutoCloseEntries must not be a public Server Action");

  const actionsSrc = readFileSync(join(ROOT, "lib", "actions", "time.ts"), "utf8");
  const actionsIsUseServer = /^\s*["']use server["'];/.test(actionsSrc);
  const stillInActions = actionsSrc.includes("export async function sweepAutoCloseEntries");

  const sweepPath = join(ROOT, "lib", "time", "sweep.ts");
  const sweepExists = existsSync(sweepPath);
  const sweepSrc = sweepExists ? readFileSync(sweepPath, "utf8") : "";
  const sweepIsUseServer = /^\s*["']use server["'];/.test(sweepSrc);
  const sweepExports = sweepSrc.includes("export async function sweepAutoCloseEntries");

  if (stillInActions && actionsIsUseServer) {
    fail(
      "sweepAutoCloseEntries is a public, unauthenticated Server Action",
      'lib/actions/time.ts starts with "use server" and exports sweepAutoCloseEntries. Next assigns a ' +
        'Server Action id to every export of a "use server" module that is in the client graph ' +
        "(time-client.tsx, clock-widget.tsx, edit-entry-modal.tsx and manual-entry-modal.tsx all import " +
        "from it), so anyone holding that id can POST it with no session and close every open time entry " +
        "in EVERY workspace. This was fixed once by moving it to lib/time/sweep.ts; it has come back."
    );
  } else if (!sweepExists || !sweepExports) {
    fail(
      "sweepAutoCloseEntries could not be located",
      "it is not exported from lib/actions/time.ts (good) but lib/time/sweep.ts does not export it " +
        "either, so either the auto-close job has been deleted or it moved again. This check needs " +
        "re-pointing at its new home before it means anything."
    );
    return;
  } else if (sweepIsUseServer) {
    fail(
      "sweepAutoCloseEntries was moved into another Server Action module",
      'lib/time/sweep.ts carries a "use server" directive, which re-publishes the exact endpoint the ' +
        "move was made to remove. The fix depends on the ABSENCE of that directive."
    );
  } else {
    ok(
      'sweepAutoCloseEntries lives in lib/time/sweep.ts, a plain server module with no "use server" ' +
        "directive, so it has no Server Action id and no public endpoint"
    );
    skip(
      "unauthenticated invocation of sweepAutoCloseEntries",
      'structurally impossible now — the function is not exported from any "use server" module, so ' +
        "Next mints no action id for it and there is nothing to POST. The probe below is kept only for " +
        "the case where the structural assertion above fails."
    );
    return;
  }

  // Try to actually do it. Discover candidate action ids from the dev build's
  // server-reference manifest, then invoke them unauthenticated and see
  // whether MY backdated entry closes.
  const manifestPaths = [
    join(ROOT, ".next", "server", "server-reference-manifest.json"),
    join(ROOT, ".next", "server", "server-reference-manifest.js"),
  ];
  let manifest = null;
  for (const p of manifestPaths) if (existsSync(p)) manifest = readFileSync(p, "utf8");
  if (!manifest) {
    skip(
      "unauthenticated invocation of sweepAutoCloseEntries",
      "no .next/server/server-reference-manifest.* on disk — cannot recover the action id without " +
        "a build, and this audit may not run `npm run build`. The structural finding above stands."
    );
    return;
  }
  const timeModuleIds = [
    ...new Set(
      [...manifest.matchAll(/"([0-9a-f]{40,64})":\s*\{[^}]*?actions\/time[^}]*?\}/g)].map(
        (m) => m[1]
      )
    ),
  ];
  const ids = timeModuleIds.length
    ? timeModuleIds
    : [...new Set([...manifest.matchAll(/"([0-9a-f]{40,64})"/g)].map((m) => m[1]))].slice(0, 40);
  if (ids.length === 0) {
    skip("unauthenticated invocation", "no action ids recoverable from the manifest");
    return;
  }

  const foreign = await foreignStaleEntries();
  if (foreign.length > 0) {
    skip(
      "unauthenticated invocation of sweepAutoCloseEntries",
      `${foreign.length} stale open entry/entries exist outside my tenant — a successful exploit would ` +
        "write to them. Refusing to attempt it."
    );
    return;
  }

  const bait = await makeOpenEntry(AUTO_CLOSE_MS + 90 * 60 * 1000, "exploit-bait");
  let firedWith = null;
  for (const id of ids) {
    // No cookie jar: this is a cold, unauthenticated POST.
    await hit("/time", {
      method: "POST",
      headers: {
        "Next-Action": id,
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: "[]",
    }).catch(() => {});
    const row = await db.timeEntry.findFirst({
      where: { companyId: TENANT.companyId, id: bait.id },
      select: { clockOutAt: true },
    });
    if (row?.clockOutAt) {
      firedWith = id;
      break;
    }
  }
  if (firedWith)
    fail(
      "unauthenticated Server Action closed a time entry",
      `POST /time with Next-Action: ${firedWith} and NO session closed my open entry ${bait.id}. ` +
        "The same call closes every stale open entry in every other customer's workspace."
    );
  else
    ok(
      `tried ${ids.length} recovered action id(s) unauthenticated; none closed my open entry — ` +
        "the sweep action was not reachable this way"
    );
}

/* ════════════════════════════════════════════════════════════════════════
 * D. Purge — dry-run default, what the dry run can actually tell you, the
 *    uncounted user-scoped tables, and the scope-2 Restrict jam.
 * ════════════════════════════════════════════════════════════════════════ */

async function checkPurgeGate() {
  section("D. Purge (/api/cron/purge-soft-deleted)");

  note(
    "effective PURGE_ENABLED",
    PURGE_ENTRY
      ? `"${PURGE_ENTRY.value}" from ${PURGE_ENTRY.from} → dryRun=${!PURGE_IS_LIVE}`
      : `unset in ${ENV_FILES.join(" / ")} → dryRun=true (the route's default)`
  );
  if (PURGE_IS_LIVE) {
    skip(
      "every purge check",
      'PURGE_ENABLED resolves to "true", so this route would HARD-DELETE every overdue workspace ' +
        "in the database, not just mine. Refusing to call it at all."
    );
    return false;
  }

  // Fail-safe parsing: only the exact string "true" arms it.
  const res = await hit(CRON_ROUTES.purge, { headers: authed() });
  if (res.status === 200) ok("purge: authorized fire → 200");
  else fail("purge: authorized fire", `expected 200, got ${res.status} ${res.text.slice(0, 200)}`);
  if (res.json?.dryRun === true) ok("purge: dryRun is true by default — nothing is deleted");
  else
    fail("purge dry-run default", `expected dryRun:true, got ${JSON.stringify(res.json?.dryRun)}`);
  if (res.json?.retentionDays === RETENTION_DAYS)
    ok(`purge: retention window is ${RETENTION_DAYS} days`);
  else fail("purge retentionDays", `expected ${RETENTION_DAYS}, got ${res.json?.retentionDays}`);
  if (Array.isArray(res.json?.excludedModels) && res.json.excludedModels.length === 0)
    ok("purge: excludedModels is empty (nothing knowingly left behind)");
  else note("purge excludedModels", `route reports ${JSON.stringify(res.json?.excludedModels)}`);
  return true;
}

async function checkDryRunCannotSizeTheBlastRadius() {
  // Tombstone MY workspace past the cutoff so it is exactly what the route
  // calls "overdue". My rows only.
  const overdueAt = new Date(Date.now() - (RETENTION_DAYS + 1) * 864e5);
  await db.company.update({ where: { id: TENANT.companyId }, data: { deletedAt: overdueAt } });

  // Count what a live run would actually destroy in MY tenant.
  const mine = {
    message: await db.message.count({ where: { companyId: TENANT.companyId } }),
    channel: await db.channel.count({ where: { companyId: TENANT.companyId } }),
    comment: await db.comment.count({ where: { companyId: TENANT.companyId } }),
    timeEntry: await db.timeEntry.count({ where: { companyId: TENANT.companyId } }),
    transaction: await db.transaction.count({ where: { companyId: TENANT.companyId } }),
    budget: await db.budget.count({ where: { companyId: TENANT.companyId } }),
    recurringRule: await db.recurringRule.count({ where: { companyId: TENANT.companyId } }),
    task: await db.task.count({ where: { companyId: TENANT.companyId } }),
    activity: await db.activity.count({ where: { companyId: TENANT.companyId } }),
    notification: await db.notification.count({ where: { companyId: TENANT.companyId } }),
    inviteToken: await db.inviteToken.count({ where: { companyId: TENANT.companyId } }),
    project: await db.project.count({ where: { companyId: TENANT.companyId } }),
    user: await db.user.count({ where: { companyId: TENANT.companyId } }),
  };
  const myRows = Object.values(mine).reduce((a, b) => a + b, 0) + 1; // + the company row

  const res = await hit(CRON_ROUTES.purge, { headers: authed() });
  const r = res.json?.result ?? {};

  // Advisory: the route's counts are global, so my tenant can only ever be a
  // lower bound on them. The authoritative check is the scoped one below.
  const iAmOverdue = await db.company.count({
    where: {
      id: TENANT.companyId,
      deletedAt: { not: null, lt: new Date(Date.now() - RETENTION_DAYS * 864e5) },
    },
  });
  if (iAmOverdue === 1) ok("my tombstoned workspace matches the route's own overdue filter");
  else fail("overdue filter", "my workspace was tombstoned past the cutoff but does not match");

  if ((r.companiesPurged ?? 0) >= 1)
    ok(`purge dry-run counted ${r.companiesPurged} overdue workspace(s) (mine is one of them)`);
  else
    fail(
      "purge dry-run company count",
      `my workspace is overdue by the route's own filter, but the dry run reported ` +
        `companiesPurged=${r.companiesPurged}`
    );

  // THE FINDING (cron-005, now FIXED): the dry run is the only pre-flight before
  // an irreversible global erasure, and it could not say how many rows were at
  // stake — purgeCompany() was never called in dry-run, so the number
  // warnBulkMutation thresholds on was always 0 and the 100-row canary could not
  // fire even once before the deletion was already permanent.
  //
  // The pass condition is the FIXED state. `countCompanyRows()` now reports
  // `workspaceRowsWouldDelete` (+ a per-table breakdown); the old field name
  // `workspaceRowsDeleted` is still accepted so this probe keeps working against
  // an older deployment. If NEITHER is present the check has drifted from the
  // route and says so, rather than reporting a closed finding as a live bug —
  // which is exactly how a stale probe trains people to ignore the suite.
  const sized = r.workspaceRowsWouldDelete ?? r.workspaceRowsDeleted;
  if (sized === undefined)
    fail(
      "re-point this check: the purge dry run reports neither row-count field",
      `expected workspaceRowsWouldDelete (or the legacy workspaceRowsDeleted) in the dry-run ` +
        `body, got keys: ${Object.keys(r).join(", ")}. The route's response shape changed and this ` +
        `probe no longer measures anything.`
    );
  else if (sized > 0)
    ok(
      `purge dry-run sizes its own blast radius (${sized} rows` +
        `${r.workspaceRowsByTable ? `, ${Object.keys(r.workspaceRowsByTable).length} tables` : ""})`
    );
  else
    fail(
      "purge dry-run cannot size its own blast radius",
      `my single overdue workspace holds ${myRows} rows (${JSON.stringify(mine)}), yet the dry run ` +
        `reports ${sized}. The one number an operator needs before flipping PURGE_ENABLED=true — and ` +
        `the number warnBulkMutation thresholds on — is 0.`
    );

  // Tables purgeCompany never names. The schema-derived guard in
  // tests/lib/db/purge-invariants.test.ts only looks at models carrying
  // deletedAt or companyId, so USER-scoped-only tables are invisible to it —
  // the same undercount that made the chat-table bug (X17) real, still open
  // for these two.
  const purgeSrc = readFileSync(
    join(ROOT, "app", "api", "cron", "purge-soft-deleted", "route.ts"),
    "utf8"
  );
  const fnStart = purgeSrc.indexOf("async function purgeCompany");
  const fnBody = purgeSrc.slice(fnStart, purgeSrc.indexOf("\n}", fnStart));
  const userScopedOnly = [
    ["pushSubscription", "PushSubscription"],
    ["notificationPreference", "NotificationPreference"],
  ];
  for (const [delegate, model] of userScopedOnly) {
    const named = new RegExp(`\\btx\\.${delegate}\\.delete(?:Many)?\\s*\\(`).test(fnBody);
    const rows = await db[delegate].count({ where: { user: { companyId: TENANT.companyId } } });
    if (named) ok(`purgeCompany names tx.${delegate} explicitly`);
    else
      fail(
        `purgeCompany never names ${model}`,
        `${model} has neither companyId nor deletedAt, so tests/lib/db/purge-invariants.test.ts ` +
          `cannot derive it and passes; purgeCompany relies on the ON DELETE CASCADE from User. ` +
          `My tenant holds ${rows} such row(s) that a live purge would destroy without counting — ` +
          `the exact undercount X17 was filed for, and the day that FK becomes Restrict the ` +
          `transaction jams on a table named nowhere in the file.`
      );
  }
}

async function checkScope2RestrictJam(page) {
  section("D2. Purge scope 2 — the empty-project claim");

  // Build the shape the route's own comment says is impossible: a
  // soft-deleted project that still has a child row behind a Restrict FK.
  // deleteProjectAction's emptiness check counts only tasks with
  // deletedAt: null, so a project whose every task was deleted first passes.
  const project = await db.project.create({
    data: {
      companyId: TENANT.companyId,
      name: `qa-cron jam ${STAMP}`,
      supervisorId: TENANT.adminUserId,
      createdBy: TENANT.adminUserId,
      status: "active",
    },
  });
  const task = await db.task.create({
    data: {
      companyId: TENANT.companyId,
      projectId: project.id,
      title: `qa-cron jam task ${STAMP}`,
      status: "pending",
      priority: "medium",
      assignedTo: TENANT.adminUserId,
      assignedToName: TENANT.adminName,
      assignedBy: TENANT.adminUserId,
      assignedByName: TENANT.adminName,
      deadline: new Date(Date.now() + 7 * 864e5),
      order: -Date.now(),
      deletedAt: new Date(), // soft-deleted, as deleteTaskAction leaves it
    },
  });

  // Drive the REAL delete through the UI so the finding rests on the
  // product's own permission + emptiness logic, not on my db.update.
  let uiDeleted = false;
  try {
    await page.goto(`${BASE}/projects/${project.id}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.innerText.length > 0, { timeout: 20000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /^\s*delete\b/i.test(b.textContent || "")
      );
      btn?.click();
    });
    await page.waitForFunction(() => document.querySelector('[role="dialog"]') !== null, {
      timeout: 8000,
    });
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const btn = [...dialog.querySelectorAll("button")].find((b) =>
        /delete|confirm|yes/i.test(b.textContent || "")
      );
      btn?.click();
    });
    uiDeleted = await page
      .waitForFunction(() => location.pathname === "/projects", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    await shot(page, "project-delete-with-soft-deleted-task");
  } catch (e) {
    note("UI project delete", `could not drive it (${e.message}); falling back to the DB probe`);
  }

  const afterUi = await db.project.findFirst({
    where: { companyId: TENANT.companyId, id: project.id },
    select: { deletedAt: true },
  });
  if (uiDeleted && afterUi?.deletedAt)
    fail(
      "a project holding a soft-deleted task can be deleted",
      `project ${project.id} still has task ${task.id} (deletedAt set, row physically present) behind ` +
        `a Restrict FK, yet deleteProjectAction accepted the delete because its emptiness check counts ` +
        `only tasks with deletedAt: null (lib/actions/projects.ts:651-654).`
    );
  else if (afterUi?.deletedAt) note("project soft-deleted", "via fallback, not the UI");
  else
    await db.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });

  // Age it past the retention cutoff and run the route's OWN scope-2
  // statement — scoped to my companyId, inside a transaction that always
  // rolls back, so this proves the constraint error without deleting a row.
  await db.project.update({
    where: { id: project.id },
    data: { deletedAt: new Date(Date.now() - (RETENTION_DAYS + 1) * 864e5) },
  });

  let jamError = null;
  try {
    await db.$transaction(async (tx) => {
      await tx.project.deleteMany({
        where: {
          companyId: TENANT.companyId, // never unscoped, even inside a rollback
          deletedAt: { not: null, lt: new Date(Date.now() - RETENTION_DAYS * 864e5) },
          company: { deletedAt: null },
        },
      });
      throw new Error("__qa_rollback__");
    });
  } catch (e) {
    jamError = e.message === "__qa_rollback__" ? null : e.message;
  }

  if (jamError)
    fail(
      "purge scope 2 jams permanently on one bad project",
      `the route's scope-2 statement (app/api/cron/purge-soft-deleted/route.ts:195) is a single ` +
        `project.deleteMany, and it threw: ${jamError.split("\n").slice(0, 3).join(" ")}. ` +
        `Because it is ONE statement, the one project holding a soft-deleted task fails the whole ` +
        `stage — no overdue project in ANY workspace is ever purged again, every night, forever. The ` +
        `route's comment ("Safe: an empty project has no children and its inbound refs are SetNull") ` +
        `is wrong: Task.project and Budget.project are onDelete: Restrict (schema.prisma:344, 471).`
    );
  else
    ok("purge scope 2's deleteMany survived a project holding a soft-deleted task (rolled back)");

  // cron-008, now FIXED. This used to be a note() explaining that the failure
  // was silent: the route answered 206, which is a 2xx, and Vercel cron only
  // escalates 5xx — so a permanently failing stage produced no page. It is now an
  // assertion, because a note cannot regress. A 2xx here means the escalation
  // path is gone again.
  const res = await hit(CRON_ROUTES.purge, { headers: authed() });
  if (res.status >= 500)
    ok(`purge answers ${res.status} on a failing stage, so Vercel cron escalates it`);
  else
    fail(
      "a failing purge stage is invisible to Vercel cron",
      `route returned ${res.status} (ok=${res.json?.ok}, failures=` +
        `${JSON.stringify(res.json?.failures ?? [])}). Anything below 500 is success to the cron ` +
        `dashboard, so a stage that fails every night produces no page and no alert.`
    );

  await db.task.deleteMany({ where: { companyId: TENANT.companyId, id: task.id } });
  await db.project.deleteMany({ where: { companyId: TENANT.companyId, id: project.id } });
}

/* ════════════════════════════════════════════════════════════════════════
 * E. Bulk-mutation canary wiring + F. schedules and the backup workflow.
 *    Source-level invariants: cheap, and they are the ones that rot.
 * ════════════════════════════════════════════════════════════════════════ */

function checkCanaryWiring() {
  section("E. Bulk-mutation canary wiring");

  const guard = readFileSync(join(ROOT, "lib", "safety", "bulk-mutation-guard.ts"), "utf8");
  const threshold = /BULK_MUTATION_THRESHOLD\s*=\s*(\d+)/.exec(guard)?.[1];
  if (threshold === "100") ok("BULK_MUTATION_THRESHOLD is 100");
  else fail("BULK_MUTATION_THRESHOLD", `expected 100, got ${threshold}`);
  if (/try\s*\{[\s\S]*?catch/.test(guard)) ok("warnBulkMutation cannot throw into its caller");
  else fail("warnBulkMutation", "no try/catch — a Sentry failure would abort the caller");

  for (const [key, path] of Object.entries(CRON_ROUTES)) {
    const src = readFileSync(join(ROOT, "app", path.replace(/^\/api/, "api"), "route.ts"), "utf8");
    const wired = /warnBulkMutation\s*\(/.test(src);
    if (key === "purge") {
      if (wired) ok("purge route fires warnBulkMutation");
      else fail("purge canary", "warnBulkMutation is not called from the purge route");
    } else if (wired) {
      ok(`${key} route fires warnBulkMutation`);
    } else {
      fail(
        `${key} route has no bulk-mutation canary`,
        `${path} mutates rows in EVERY workspace with no ceiling and no canary. ` +
          (key === "materialize"
            ? "A bad rule set can mint unbounded Transaction rows (real money entries) overnight with no alert."
            : "A clock skew or a lastActivityAt regression can close every open entry in the product with no alert.")
      );
    }
  }
}

function checkSchedulesAndBackup() {
  section("F. Schedules, maxDuration, backup workflow");

  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const crons = vercel.crons ?? [];
  note("registered crons", crons.map((c) => `${c.path} @ ${c.schedule}`).join(" | "));

  // Vercel's Hobby plan allows 2 cron jobs per project and daily cadence only
  // — and app/api/cron/sweep-time-entries/route.ts says in prose that this
  // project is on Hobby. A third entry does not get scheduled.
  if (crons.length <= 2) ok(`cron count is ${crons.length} — within the Hobby ceiling of 2`);
  else
    fail(
      "more cron jobs declared than a Hobby project can schedule",
      `vercel.json declares ${crons.length} crons (${crons.map((c) => c.path).join(", ")}). ` +
        "Vercel Hobby allows 2 per project; the route comment at " +
        "app/api/cron/sweep-time-entries/route.ts:6 states this project is on Hobby. On Hobby the " +
        "third job is never scheduled, and nothing in the repo would notice: verify the plan and the " +
        "Crons tab actually lists all three."
    );

  // maxDuration must be the plan ceiling, and every route must declare one.
  for (const [key, path] of Object.entries(CRON_ROUTES)) {
    const src = readFileSync(join(ROOT, "app", path.replace(/^\/api/, "api"), "route.ts"), "utf8");
    const md = /maxDuration\s*=\s*(\d+)/.exec(src)?.[1];
    if (md) ok(`${key}: maxDuration = ${md}s`);
    else fail(`${key}: maxDuration`, "not declared — defaults to the platform minimum");
  }

  // purgeCompany runs 17 sequential deleteManys inside one INTERACTIVE
  // Prisma transaction. Prisma's default interactive-transaction timeout is
  // 5s (maxWait 2s) and lib/db.ts passes no transactionOptions, so the
  // 60s maxDuration is not the real ceiling — 5s is.
  const dbSrc = readFileSync(join(ROOT, "lib", "db.ts"), "utf8");
  const purgeSrc = readFileSync(
    join(ROOT, "app", "api", "cron", "purge-soft-deleted", "route.ts"),
    "utf8"
  );
  const hasTxOptions =
    /transactionOptions/.test(dbSrc) ||
    /\$transaction\([\s\S]{0,4000}?\}\s*,\s*\{\s*timeout/.test(purgeSrc);
  if (hasTxOptions) ok("purgeCompany's interactive transaction has an explicit timeout");
  else
    fail(
      "purgeCompany relies on Prisma's 5s default transaction timeout",
      "lib/db.ts constructs PrismaClient with no transactionOptions and purgeCompany passes no " +
        "{ timeout } to db.$transaction, so its 17 sequential deleteManys must finish in 5000ms. " +
        "A chat-heavy workspace blows that and fails with P2028 every night — the 60s maxDuration " +
        "is irrelevant, and the workspace can never be erased."
    );

  // The dump must run AFTER the purge, or it snapshots rows the purge is
  // about to destroy and the backup silently stops being a post-purge state.
  const backupPath = join(ROOT, ".github", "workflows", "backup.yml");
  if (!existsSync(backupPath)) {
    fail("backup workflow", ".github/workflows/backup.yml is missing");
    return;
  }
  const backup = readFileSync(backupPath, "utf8");
  const backupCron = /cron:\s*"(\d+)\s+(\d+)\s/.exec(backup);
  const purgeCron = crons.find((c) => c.path.includes("purge"));
  if (backupCron && purgeCron) {
    const [, bMin, bHour] = backupCron;
    const [pMin, pHour] = purgeCron.schedule.split(" ");
    const backupMins = Number(bHour) * 60 + Number(bMin);
    const purgeMins = Number(pHour) * 60 + Number(pMin);
    if (backupMins > purgeMins)
      ok(`backup at ${bHour}:${bMin} UTC runs after the purge at ${pHour}:${pMin} UTC`);
    else
      fail(
        "backup runs before the purge",
        `backup ${bHour}:${bMin} UTC vs purge ${pHour}:${pMin} UTC — the dump no longer reflects ` +
          "post-purge state, which is what the workflow header promises."
      );
  }
  if (/set -euo pipefail/.test(backup))
    ok("backup: pipefail set, so a pg_dump failure fails the step");
  else fail("backup: pipefail", "a failing pg_dump would still upload a near-empty gzip");
  if (/CREATE TABLE/.test(backup) && /COPY /.test(backup))
    ok("backup: validates DDL + a COPY data block before uploading");
  else fail("backup: content validation", "size-only checks cannot catch a schema-only dump");

  // A backup nobody is told about, and nobody has restored, is a hope.
  const hasAlert = /(slack|webhook|mail|issues|notify|SENTRY|curl -X POST)/i.test(backup);
  if (hasAlert) ok("backup: has a failure notification path");
  else
    fail(
      "a failed nightly backup notifies nobody",
      "backup.yml has no notification step. GitHub emails only the last committer of the workflow " +
        "file on a scheduled-run failure, and disables scheduled workflows entirely after 60 days " +
        "of repository inactivity — so backups can stop for weeks with no signal, and there is no " +
        "dead-man's-switch that fails loudly when a dump is MISSING rather than broken."
    );
  if (/restore/i.test(backup))
    note(
      "backup: restore",
      "documented in prose only — no automated or periodic restore drill exists"
    );
}

/* ────────────────────────────────────────────────────────────────────────
 * Teardown — children before parents, scoped to the tenant I created
 * ──────────────────────────────────────────────────────────────────────── */

async function destroyTenant(companyId) {
  if (!companyId) return;
  const byCompany = { where: { companyId } };
  await db.company.update({ where: { id: companyId }, data: { deletedAt: null } }).catch(() => {});
  await db.messageReaction.deleteMany({ where: { message: { companyId } } }).catch(() => {});
  await db.message.deleteMany(byCompany).catch(() => {});
  await db.channelMember.deleteMany({ where: { channel: { companyId } } }).catch(() => {});
  await db.channel.deleteMany(byCompany).catch(() => {});
  await db.comment.deleteMany(byCompany).catch(() => {});
  await db.timeEntry.deleteMany(byCompany).catch(() => {});
  await db.notification.deleteMany(byCompany).catch(() => {});
  await db.activity.deleteMany(byCompany).catch(() => {});
  await db.inviteToken.deleteMany(byCompany).catch(() => {});
  await db.transaction.deleteMany(byCompany).catch(() => {});
  await db.recurringRule.deleteMany(byCompany).catch(() => {});
  await db.budget.deleteMany(byCompany).catch(() => {});
  await db.task.deleteMany(byCompany).catch(() => {});
  await db.project.deleteMany(byCompany).catch(() => {});
  await db.notificationPreference.deleteMany({ where: { user: { companyId } } }).catch(() => {});
  await db.pushSubscription.deleteMany({ where: { user: { companyId } } }).catch(() => {});
  await db.company.update({ where: { id: companyId }, data: { ownerId: null } }).catch(() => {});
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
  console.log(`== qa: cron-and-background (agent 13, ip ${AGENT_IP}) ==`);

  let adminCtx = null;
  try {
    // Source-level invariants first: they need no tenant and no server, so
    // they still report if the dev server is down.
    checkCanaryWiring();
    checkSchedulesAndBackup();

    const admin = await newPage(browser);
    adminCtx = admin.ctx;
    await signUpTenant(admin.page);
    await signIn(admin.page, TENANT.adminEmail, TENANT.adminPassword);

    await checkAuthSurface();

    await createRecurringRuleViaUi(admin.page);
    await checkMaterializerIdempotency();
    await checkMaterializerConcurrency();
    await checkMissedDayIsNeverBackfilled();

    await checkSweep();
    await checkSweepIgnoresTombstonedWorkspace();
    await checkSweepIsNotAPublicAction();

    // Everything past here tombstones my workspace, which kills my session,
    // so all UI-driven work must already be done.
    await checkScope2RestrictJam(admin.page);
    if (await checkPurgeGate()) await checkDryRunCannotSizeTheBlastRadius();
  } catch (e) {
    fail("run aborted", e.message);
    console.error(e.stack);
  } finally {
    await adminCtx?.close().catch(() => {});
    await browser.close().catch(() => {});
    await destroyTenant(TENANT.companyId);
    await db.$disconnect();
  }

  console.log(
    `\n== cron-and-background: ${passes} ok, ${failures} failed, ${blocked} blocked by blast-radius pre-flight ==`
  );
  if (failures > 0) console.log("❌ cron-and-background has failures");
}

main().catch(async (err) => {
  console.error("❌ qa-cron-and-background threw:", err);
  process.exitCode = 1;
  await db.$disconnect().catch(() => {});
});
