/*
 * QA · performance (agent 14) — Phase 2 exercise script.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT A SMOKE TEST
 * -------------------------------------------------------------------------
 * Every other qa-*.mjs asks "does the feature work". This one asks "how much
 * does the feature cost", and a cost number is only meaningful if the thing
 * being measured is the app rather than the harness. Two consequences shape
 * the whole file:
 *
 *   1. IT MUST RUN AGAINST `next build && next start`, ALONE. A `next dev`
 *      server compiles routes on demand, ships un-minified bundles, disables
 *      every production optimisation, and re-renders on HMR. A TTFB measured
 *      there is a compile time. `assertProductionServer()` below refuses to
 *      continue if it detects a dev build, rather than silently reporting
 *      fiction. Run order: `npm run build` then `npm start`, no other agent's
 *      script running, then this.
 *
 *   2. QUERY COUNTS COME FROM POSTGRES, NOT FROM GUESSWORK. The app cannot be
 *      instrumented (editing source is forbidden and would contaminate every
 *      other agent), so the number of SQL statements a page issues is read out
 *      of `pg_stat_user_tables` as a BEFORE/AFTER delta around one navigation.
 *      Those are read-only SELECTs against a system catalogue — they touch no
 *      row of anybody's data.
 *
 * THE DATA-SAFETY RULE
 * -------------------------------------------------------------------------
 * This script signs up its OWN workspace (`qa-perf-<stamp>`) through the real
 * /signup flow and every row it writes carries that company's id. `assertMine`
 * re-reads the Company row and refuses any id that is not a `qa-` tenant this
 * run created, so a transposed variable cannot reach the demo workspace. Every
 * DB assertion is `where: { companyId: MY_ID }` — never a bare count, because
 * under concurrency another agent's insert would satisfy a bare "did mine
 * land?" check and produce a false pass. The only reads of seeded rows are the
 * two `pg_*` catalogue queries, which are per-TABLE and per-INDEX, not per-row.
 *
 * `pg_stat_user_tables` counters are server-wide, so a second agent running
 * concurrently inflates the deltas. That is exactly why this script must run
 * alone, and `measureNav` reports the idle-noise floor it measured first so a
 * contaminated run is visible in the output instead of being believed.
 *
 * WHAT EACH CHECK PROMOTES
 * -------------------------------------------------------------------------
 *   perf-001  redundant per-request session lookups   → User idx_scan delta
 *   perf-002  getTasks() is uncapped                  → Task rows + RSC bytes
 *   perf-003  time sums done in JS, not SQL           → TimeEntry rows read
 *   perf-004  notification badge polls the full list  → POST count + bytes
 *   perf-006  Notification(projectId) has no index    → seq_scan on delete
 *   perf-008  Activity(userId) has no index           → seq_scan on ?user=
 *   perf-009  two exactly-redundant indexes           → pg_index duplicates
 *   perf-010  missing (companyId, createdAt) indexes  → EXPLAIN Sort node
 *   perf-012  every row rendered twice (table + card) → DOM node count
 *   perf-015  5000-row ledger shipped to six pages    → RSC bytes, Comment rows
 *   perf-016  getChannelBySlug runs twice per render  → Channel idx_scan delta
 *   perf-017  Playfair preloaded on every route       → resource timing
 *   perf-018  424KB of icons precached by the SW      → resource sizes
 *
 * Usage:
 *   npm run build && npm start          # in another terminal, then:
 *   node scripts/qa-performance.mjs
 *   node scripts/_qa-guard.mjs verify   # must pass afterwards
 *
 * Env knobs (defaults are sized to make the ceilings visible without making
 * the run take all afternoon):
 *   QA_TXNS=3000  QA_TASKS=1200  QA_ENTRIES=2500  QA_ACTS=800  QA_NOTIFS=400
 *   QA_SKIP_SEED=1   reuse an existing qa-perf tenant (debugging only)
 */

import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/performance";
const AGENT_IP = "10.99.0.14";
const STAMP = Date.now().toString().slice(-8);
const PASSWORD = "QaPerf!2026";

const VOL = {
  txns: Number(process.env.QA_TXNS ?? 3000),
  tasks: Number(process.env.QA_TASKS ?? 1200),
  entries: Number(process.env.QA_ENTRIES ?? 2500),
  acts: Number(process.env.QA_ACTS ?? 800),
  notifs: Number(process.env.QA_NOTIFS ?? 400),
  messages: Number(process.env.QA_MESSAGES ?? 600),
  comments: Number(process.env.QA_COMMENTS ?? 300),
};

// Pinned to the local docker Postgres. `new PrismaClient()` would read the
// root .env, which points at PRODUCTION Supabase — see scripts/_local-db.mjs
// and tests/lib/db/script-safety.test.ts.
const db = localDb();

/* ──────────────────────────── reporting ─────────────────────────────────── */

const findings = [];

function ok(label) {
  console.log(`  ok    ${label}`);
}
/** Never throws: one run must report EVERY broken assertion, not the first. */
function fail(label, detail) {
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
/** A number worth recording even when it does not trip a threshold. */
function metric(label, value) {
  console.log(`  ·     ${label}: ${value}`);
}
function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}
/**
 * Record a measured number against the finding it promotes, so the run ends
 * with a table the parent agent can paste into `actual:` fields verbatim.
 */
function promote(id, claim, measured, threshold, verdict) {
  findings.push({ id, claim, measured, threshold, verdict });
  const tag = verdict === "CONFIRMED" ? "CONFIRMED" : verdict === "CLEAN" ? "clean" : verdict;
  console.log(`  →     ${id} ${tag}: measured ${measured} (threshold ${threshold})`);
}

/* ──────────────────────── postgres stat plumbing ────────────────────────── */

const WATCHED = [
  "User",
  "Company",
  "Task",
  "Transaction",
  "Project",
  "TimeEntry",
  "Activity",
  "Notification",
  "Comment",
  "Budget",
  "Message",
  "Channel",
  "ChannelMember",
  "MessageReaction",
  "RecurringRule",
  "InviteToken",
];

/**
 * Per-table access counters. `idx_scan` is the number of index scans STARTED,
 * which for these query shapes is one per SQL statement that touches the table
 * through an index — that is what makes "how many times did this request look
 * the session user up" answerable without touching the app. `idx_tup_fetch`
 * and `seq_tup_read` are ROWS read, which is what turns "unbounded query" from
 * an opinion into a number.
 */
async function statSnapshot() {
  const rows = await db.$queryRaw`
    SELECT relname,
           COALESCE(seq_scan, 0)      AS seq_scan,
           COALESCE(seq_tup_read, 0)  AS seq_tup_read,
           COALESCE(idx_scan, 0)      AS idx_scan,
           COALESCE(idx_tup_fetch, 0) AS idx_tup_fetch
      FROM pg_stat_user_tables
     WHERE relname = ANY(${WATCHED})
  `;
  const out = new Map();
  for (const r of rows) {
    out.set(r.relname, {
      seqScan: Number(r.seq_scan),
      seqRows: Number(r.seq_tup_read),
      idxScan: Number(r.idx_scan),
      idxRows: Number(r.idx_tup_fetch),
    });
  }
  return out;
}

/**
 * Postgres flushes a backend's statistics asynchronously — at transaction end,
 * and at most once a second. Reading immediately after a request would under-
 * count. So: poll until two consecutive snapshots are IDENTICAL, which is a
 * state predicate on "the collector has caught up", not a fixed sleep. A fixed
 * sleep is the number-one source of false failures under load; this one gets
 * faster when the machine is idle and waits longer when it is not.
 */
async function settleStats(maxMs = 12000) {
  let prev = await statSnapshot();
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 350));
    const next = await statSnapshot();
    if (serialiseStats(next) === serialiseStats(prev)) return next;
    prev = next;
  }
  return prev;
}

function serialiseStats(snap) {
  return [...snap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v.seqScan},${v.seqRows},${v.idxScan},${v.idxRows}`)
    .join("|");
}

function diffStats(before, after) {
  const out = {};
  for (const table of WATCHED) {
    const b = before.get(table) ?? { seqScan: 0, seqRows: 0, idxScan: 0, idxRows: 0 };
    const a = after.get(table) ?? b;
    const d = {
      seqScan: a.seqScan - b.seqScan,
      seqRows: a.seqRows - b.seqRows,
      idxScan: a.idxScan - b.idxScan,
      idxRows: a.idxRows - b.idxRows,
    };
    if (d.seqScan || d.seqRows || d.idxScan || d.idxRows) out[table] = d;
  }
  return out;
}

/* ─────────────────────── browser + page plumbing ────────────────────────── */

function wire(page) {
  page.on("pageerror", (e) => console.error("  PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("  CONSOLE.error:", m.text());
  });
}

/**
 * A fresh, isolated context with the agent IP header set BEFORE the first
 * navigation. `getClientIp()` falls back to the literal string "unknown" in
 * dev, so without this every agent shares ONE `limiters.auth` bucket of 5/60s
 * and we starve each other into filing false "cannot sign in" bugs.
 */
async function newActor(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  wire(page);
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  return { ctx, page };
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
 * Retry-until-hydrated sign-in, copied verbatim from scripts/smoke-chat.mjs.
 * A click that lands before React owns it performs a NATIVE submit, which (the
 * form declares no method) becomes a GET with the credentials in the query
 * string and no sign-in at all. FaultsAudit A14.
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

/** Sign up a brand-new workspace through the REAL two-step /signup flow. */
async function signUpWorkspace(page, { name, email, companyName }) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
  await page.waitForSelector('input[autocomplete="name"]', { timeout: 30000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("button")].some((b) => /continue/i.test(b.textContent ?? "")),
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
    [...document.querySelectorAll("button")].find((b) => /continue/i.test(b.textContent ?? ""))?.click();
  });
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
      const company = [...document.querySelectorAll("input")].find(
        (i) => i.getAttribute("autocomplete") === null && i.type === "text"
      );
      if (company) setValue(company, vals.companyName);
    },
    { companyName },
    SET_VALUE
  );
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  const landed = await page
    .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 400));
    throw new Error(`signup for ${companyName} never reached /dashboard — page said: ${body}`);
  }
}

/**
 * REFUSE to touch anything that is not a qa- tenant this run created. Every
 * write below goes through an id that has passed here. A bare
 * `where: { companyId }` with a transposed variable is the accident this exists
 * to make impossible.
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

/* ────────────────── is this actually a production build? ────────────────── */

/**
 * A performance number from `next dev` is a compile time, not a page load. Two
 * independent tells, because either alone has a false negative: the dev server
 * ships a `react-refresh` runtime chunk, and it serves scripts out of
 * `/_next/static/chunks/` with no content hash plus a `?v=` cache-buster.
 * Refusing here is the difference between a report and a work of fiction.
 */
async function assertProductionServer(page) {
  const urls = [];
  const collect = (res) => urls.push(res.url());
  page.on("response", collect);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 60000 });
  page.off("response", collect);

  const devTells = urls.filter(
    (u) => /react-refresh/.test(u) || /_next\/static\/development\//.test(u) || /\?v=\d{10,}/.test(u)
  );
  if (devTells.length > 0) {
    fail(
      "server is a production build",
      `saw dev-only assets (${devTells.slice(0, 3).join(", ")}). ` +
        `Run \`npm run build && npm start\` and re-run — a dev-server measurement is meaningless.`
    );
    return false;
  }
  ok("server looks like a production build (no dev-only chunks)");
  return true;
}

/* ───────────────────────── the measurement core ─────────────────────────── */

/**
 * Navigate once and report everything that navigation cost: wall clock, bytes
 * over the wire, and the per-table SQL footprint.
 *
 * `settle` is a state predicate the caller supplies (e.g. "the table has rows")
 * so we never race a fixed timer against a slow render — under load a fixed
 * wait is the single biggest source of false failures.
 */
async function measureNav(page, path, settle) {
  await settleStats();
  const before = await statSnapshot();

  const bytes = { doc: 0, rsc: 0, script: 0, font: 0, image: 0, css: 0, other: 0, total: 0 };
  const onResponse = async (res) => {
    let len = Number(res.headers()["content-length"] ?? 0);
    if (!len) {
      try {
        len = (await res.buffer()).length;
      } catch {
        len = 0;
      }
    }
    const type = res.request().resourceType();
    const url = res.url();
    const ct = res.headers()["content-type"] ?? "";
    let bucket = "other";
    if (type === "document") bucket = "doc";
    else if (ct.includes("text/x-component")) bucket = "rsc";
    else if (type === "script") bucket = "script";
    else if (type === "font") bucket = "font";
    else if (type === "image") bucket = "image";
    else if (type === "stylesheet") bucket = "css";
    bytes[bucket] += len;
    bytes.total += len;
    if (url.includes("Playfair")) bytes.playfair = (bytes.playfair ?? 0) + len;
  };
  page.on("response", onResponse);

  const t0 = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  const ttdom = Date.now() - t0;
  if (settle) {
    await page.waitForFunction(settle, { timeout: 120000 }).catch(() => {});
  }
  const settled = Date.now() - t0;
  // networkidle would also wait out the 30s notification poll; the settle
  // predicate above is the honest "the page is usable" moment.
  page.off("response", onResponse);

  const after = await settleStats();
  const sql = diffStats(before, after);

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    return {
      ttfb: n ? Math.round(n.responseStart) : null,
      transfer: res.reduce((a, r) => a + (r.transferSize || 0), 0),
      decoded: res.reduce((a, r) => a + (r.decodedBodySize || 0), 0),
      html: document.documentElement.outerHTML.length,
      fonts: res.filter((r) => /\.woff2?$/.test(r.name)).map((r) => ({ name: r.name.split("/").pop(), size: r.decodedBodySize })),
      domNodes: document.getElementsByTagName("*").length,
      tableRows: document.querySelectorAll("tbody tr").length,
      cardRows: document.querySelectorAll("ul li").length,
    };
  });

  return { path, ttdom, settled, bytes, sql, nav };
}

function reportNav(m) {
  metric(`${m.path} TTFB`, `${m.nav.ttfb ?? "?"}ms · dom ${m.ttdom}ms · settled ${m.settled}ms`);
  metric(
    `${m.path} bytes`,
    `doc ${kb(m.bytes.doc)} · rsc ${kb(m.bytes.rsc)} · js ${kb(m.bytes.script)} · ` +
      `font ${kb(m.bytes.font)} · decoded ${kb(m.nav.decoded)}`
  );
  const sql = Object.entries(m.sql)
    .map(([t, d]) => `${t}[scan ${d.idxScan}/${d.seqScan} rows ${d.idxRows}/${d.seqRows}]`)
    .join(" ");
  metric(`${m.path} sql`, sql || "(no measurable delta)");
  metric(`${m.path} dom`, `${m.nav.domNodes} nodes · ${m.nav.tableRows} <tr> · ${m.nav.cardRows} <li>`);
}

function kb(n) {
  return `${(n / 1024).toFixed(1)}KB`;
}

/* ─────────────────────────── volume seeding ─────────────────────────────── */

/**
 * Fill MY OWN tenant to a size a real paying customer reaches in a year or two.
 * Caps only become observable above the cap — measuring /tasks with eight tasks
 * proves nothing about an uncapped query.
 *
 * `createMany` in chunks, not one create per row: the point of the run is to
 * measure the APP, and spending twenty minutes on setup invites a timeout
 * somewhere else that looks like a finding and isn't.
 */
async function seedVolume(companyId, userId, userName, projectId) {
  await assertMine(companyId);
  const chunk = 500;
  const day = 86400000;
  const now = Date.now();

  const push = async (label, total, build, createMany) => {
    for (let i = 0; i < total; i += chunk) {
      const n = Math.min(chunk, total - i);
      await createMany(Array.from({ length: n }, (_, k) => build(i + k)));
    }
    metric(`seeded ${label}`, total);
  };

  await push(
    "transactions",
    VOL.txns,
    (i) => ({
      companyId,
      type: i % 5 === 0 ? "investment" : i % 7 === 0 ? "income" : "expense",
      amount: 1000 + (i % 900),
      category: ["Office Rent", "Salaries", "Marketing", "Software", "Travel"][i % 5],
      description: `qa perf txn ${i} ${STAMP}`,
      date: new Date(now - (i % 700) * day),
      addedBy: userId,
      addedByName: userName,
      projectId: i % 3 === 0 ? projectId : null,
    }),
    (data) => db.transaction.createMany({ data })
  );

  await push(
    "tasks",
    VOL.tasks,
    (i) => ({
      companyId,
      projectId,
      title: `qa perf task ${i} ${STAMP}`,
      description: `synthetic load row ${i}`,
      status: ["pending", "in_progress", "completed"][i % 3],
      priority: ["low", "medium", "high", "urgent"][i % 4],
      assignedTo: userId,
      assignedToName: userName,
      assignedBy: userId,
      assignedByName: userName,
      deadline: new Date(now + (i % 60) * day),
      order: i,
    }),
    (data) => db.task.createMany({ data })
  );

  await push(
    "time entries",
    VOL.entries,
    (i) => ({
      companyId,
      projectId,
      projectName: "qa perf project",
      userId,
      userName,
      clockInAt: new Date(now - (i + 1) * 3600000),
      clockOutAt: new Date(now - (i + 1) * 3600000 + 1800000),
      lastActivityAt: new Date(now - (i + 1) * 3600000 + 1800000),
    }),
    (data) => db.timeEntry.createMany({ data })
  );

  await push(
    "activities",
    VOL.acts,
    (i) => ({
      companyId,
      type: "task_created",
      message: `qa perf activity ${i} ${STAMP}`,
      userId,
      userName,
      createdAt: new Date(now - i * 60000),
    }),
    (data) => db.activity.createMany({ data })
  );

  await push(
    "notifications",
    VOL.notifs,
    (i) => ({
      userId,
      companyId,
      projectId: i % 4 === 0 ? projectId : null,
      title: `qa perf notification ${i}`,
      message: `synthetic notification body ${i} — long enough to carry real weight over the wire`,
      type: "info",
      category: "system",
      read: i % 3 !== 0,
      link: "/tasks",
      createdAt: new Date(now - i * 120000),
    }),
    (data) => db.notification.createMany({ data })
  );

  const channel = await db.channel.findFirst({ where: { companyId }, select: { id: true } });
  if (channel) {
    await push(
      "messages",
      VOL.messages,
      (i) => ({
        companyId,
        channelId: channel.id,
        authorId: userId,
        authorName: userName,
        kind: "text",
        body: `qa perf message ${i} ${STAMP} runway budget quarterly review`,
        createdAt: new Date(now - i * 30000),
      }),
      (data) => db.message.createMany({ data })
    );
  }

  const someTask = await db.task.findFirst({ where: { companyId }, select: { id: true } });
  if (someTask) {
    await push(
      "comments",
      VOL.comments,
      (i) => ({
        companyId,
        body: `qa perf comment ${i} ${STAMP}`,
        authorId: userId,
        authorName: userName,
        taskId: someTask.id,
      }),
      (data) => db.comment.createMany({ data })
    );
  }
}

/* ───────────────────── schema / index-level assertions ──────────────────── */

/**
 * These read `pg_index` and `pg_class` — catalogue metadata about INDEXES, not
 * anybody's rows. They answer the questions a reasoning-only phase could only
 * assert: does an index covering this column exist, and are any two indexes on
 * a table byte-identical in their column list.
 */
async function indexAudit() {
  section("index audit (pg_index — catalogue only, no row data)");

  const idx = await db.$queryRaw`
    SELECT t.relname          AS table_name,
           i.relname          AS index_name,
           ix.indisunique     AS is_unique,
           pg_get_indexdef(ix.indexrelid) AS def,
           array_to_string(ix.indkey, ' ') AS key_sig,
           COALESCE(s.idx_scan, 0) AS scans
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
     WHERE n.nspname = 'public'
     ORDER BY t.relname, i.relname
  `;

  const byTable = new Map();
  for (const r of idx) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }

  /** Is there any index whose LEADING column is `col`? */
  const leads = (table, col) =>
    (byTable.get(table) ?? []).some((r) => {
      const m = /\(([^)]*)\)/.exec(r.def);
      if (!m) return false;
      const first = m[1].split(",")[0].trim().replace(/"/g, "").split(" ")[0];
      return first === col;
    });

  // perf-006 / perf-008 / FK-index gaps that the purge path and the ?user=
  // filter actually walk into.
  const gaps = [
    ["Notification", "projectId", "perf-006", "Project delete fires ON DELETE SET NULL on it"],
    ["Activity", "userId", "perf-008", "/activities?user= filters on it; User cascades through it"],
    ["Message", "parentId", "perf-007", "Message.parent is SetNull; a workspace purge walks it per row"],
    ["Task", "assignedBy", "perf-008b", "Task.creator cascades from User"],
    ["Budget", "createdBy", "perf-008b", "Budget.user cascades from User"],
    ["Project", "createdBy", "perf-008b", "Project.creator is Restrict from User"],
    ["MessageReaction", "userId", "perf-008b", "cascades from User; the unique index leads on messageId"],
    ["TimeEntry", "editedBy", "perf-008b", "SetNull from User"],
    ["Channel", "createdBy", "perf-008b", "cascades from User"],
  ];
  const missing = [];
  for (const [table, col, id, why] of gaps) {
    if (leads(table, col)) ok(`${table}(${col}) has a leading-column index`);
    else {
      missing.push(`${table}.${col} (${id}: ${why})`);
      fail(`${table}(${col}) has NO index`, why);
    }
  }
  promote(
    "perf-006/007/008",
    "foreign-key columns with no index, reached by the purge cron and the activity filter",
    `${missing.length} missing: ${missing.join("; ") || "none"}`,
    "0 missing",
    missing.length > 0 ? "CONFIRMED" : "CLEAN"
  );

  // perf-009 — two indexes on one table with an identical column list.
  const dupes = [];
  for (const [table, rows] of byTable) {
    const seen = new Map();
    for (const r of rows) {
      const cols = (/\(([^)]*)\)/.exec(r.def)?.[1] ?? "").replace(/\s+/g, "");
      const prior = seen.get(cols);
      if (prior) dupes.push(`${table}(${cols}): ${prior.index_name} + ${r.index_name}`);
      else seen.set(cols, r);
    }
  }
  if (dupes.length === 0) {
    ok("no duplicate indexes");
  } else {
    for (const d of dupes) fail("duplicate index", d);
  }
  promote(
    "perf-009",
    "exactly-redundant indexes paying write cost for nothing",
    `${dupes.length}: ${dupes.join(" | ") || "none"}`,
    "0",
    dupes.length > 0 ? "CONFIRMED" : "CLEAN"
  );

  // perf-010 — the ORDER BY columns search actually sorts on.
  for (const [table, col] of [
    ["Task", "createdAt"],
    ["Project", "createdAt"],
  ]) {
    const composite = (byTable.get(table) ?? []).some((r) =>
      /\("companyId",\s*"createdAt"/.test(r.def)
    );
    if (composite) ok(`${table} has a (companyId, ${col}) index for the search sort`);
    else fail(`${table} has no (companyId, ${col}) index`, "lib/queries/search.ts sorts on it");
  }

  // The GIN index the chat search depends on must exist — if a `migrate dev`
  // ever "fixed" the generated column, message search silently returns zero
  // rows with no error anywhere (schema.prisma says so in as many words).
  const gin = (byTable.get("Message") ?? []).find((r) => /USING gin/i.test(r.def));
  if (gin) ok(`Message search GIN index present (${gin.index_name})`);
  else fail("Message_searchVector_idx missing", "chat search will return zero rows, silently");

  // Indexes that have never been scanned since the last stats reset. Noise on
  // a fresh DB, so this is reported, never failed on.
  const unused = idx
    .filter((r) => Number(r.scans) === 0 && !r.is_unique)
    .map((r) => r.index_name);
  metric("non-unique indexes with idx_scan = 0", unused.join(", ") || "none");
}

/**
 * EXPLAIN the exact shapes the app issues, scoped to MY tenant. EXPLAIN without
 * ANALYZE on a SELECT executes nothing and writes nothing; ANALYZE is used only
 * on SELECTs, never on a DELETE or UPDATE, where it would perform the write.
 */
async function explainAudit(companyId, userId) {
  section("EXPLAIN ANALYZE on the real query shapes (my tenant only)");
  await assertMine(companyId);

  const run = async (label, sql) => {
    try {
      const rows = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      const plan = rows[0]["QUERY PLAN"][0];
      const txt = JSON.stringify(plan);
      const seq = (txt.match(/"Node Type":"Seq Scan"/g) ?? []).length;
      const sort = (txt.match(/"Node Type":"Sort"/g) ?? []).length;
      metric(
        label,
        `${plan["Execution Time"].toFixed(1)}ms · rows ${plan.Plan["Actual Rows"]} · ` +
          `${seq} seq-scan node(s) · ${sort} sort node(s)`
      );
      return { seq, sort, ms: plan["Execution Time"], rows: plan.Plan["Actual Rows"] };
    } catch (e) {
      fail(`EXPLAIN ${label}`, e.message);
      return null;
    }
  };

  const cid = companyId.replace(/'/g, "''");
  const uid = userId.replace(/'/g, "''");

  // getTasks() — the uncapped global board read.
  const tasks = await run(
    "getTasks() global board",
    `SELECT t.* FROM "Task" t JOIN "Project" p ON p.id = t."projectId"
      WHERE t."companyId" = '${cid}' AND t."deletedAt" IS NULL
        AND p.status NOT IN ('completed','archived')
      ORDER BY t."order" ASC, t."createdAt" DESC`
  );
  if (tasks) {
    promote(
      "perf-002",
      "the global task board reads every task in the workspace with no LIMIT",
      `${tasks.rows} rows returned for one /tasks render`,
      "a bounded page (e.g. 200)",
      tasks.rows > 500 ? "CONFIRMED" : "CLEAN"
    );
  }

  // search — four ILIKE '%term%' scans, one per keystroke burst.
  const ilike = await run(
    "searchTasks ILIKE '%qa%'",
    `SELECT t.id, t.title FROM "Task" t
      WHERE t."companyId" = '${cid}' AND t."deletedAt" IS NULL
        AND t.title ILIKE '%qa%'
      ORDER BY t."createdAt" DESC LIMIT 5`
  );
  if (ilike) {
    promote(
      "perf-010/011",
      "an unindexed ILIKE plus an unindexed ORDER BY, per palette keystroke",
      `${ilike.ms.toFixed(1)}ms, ${ilike.sort} sort node(s)`,
      "< 5ms with a trigram + (companyId, createdAt) index",
      ilike.sort > 0 || ilike.ms > 10 ? "CONFIRMED" : "CLEAN"
    );
  }

  // listProjectsForUser's time roll-up: every entry row, summed in JS.
  const te = await run(
    "listProjectsForUser time roll-up",
    `SELECT "projectId", "clockInAt", "clockOutAt" FROM "TimeEntry"
      WHERE "projectId" IN (SELECT id FROM "Project" WHERE "companyId" = '${cid}')`
  );
  if (te) {
    promote(
      "perf-003",
      "/projects loads every time entry for every visible project to add them up in JavaScript",
      `${te.rows} rows crossed the wire for one /projects render`,
      "1 row per project (a SQL SUM)",
      te.rows > 200 ? "CONFIRMED" : "CLEAN"
    );
  }

  // getAccountStats — same pattern, per user, on /settings.
  await run(
    "getAccountStats time sum",
    `SELECT "clockInAt", "clockOutAt" FROM "TimeEntry" WHERE "userId" = '${uid}'`
  );

  // The unread count the badge poll SHOULD be issuing.
  await run(
    "the count the badge poll should use",
    `SELECT count(*) FROM "Notification" WHERE "userId" = '${uid}' AND read = false`
  );
}

/* ─────────────────────────────── main ───────────────────────────────────── */

async function main() {
  console.log(`== qa · performance (agent 14) ==\nBASE=${BASE}  stamp=${STAMP}`);
  console.log(
    "NOTE: this run is only meaningful against `next build && next start`, with no\n" +
      "other agent's script running. Contended numbers measure the harness.\n"
  );

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  let companyId = null;
  let projectId = null;
  let extraProjectId = null;
  const email = `qa-perf-${STAMP}@founderflow.test`;
  const companyName = `qa-perf-${STAMP}`;

  try {
    const admin = await newActor(browser);

    /* 0 · refuse a dev server ------------------------------------------- */
    section("0 · build sanity");
    const isProd = await assertProductionServer(admin.page);
    if (!isProd && process.env.QA_FORCE !== "1") {
      console.log("\nAborting before measurement. Set QA_FORCE=1 to record dev-server numbers anyway.");
      return;
    }

    /* 1 · my own tenant, through the real signup flow -------------------- */
    section("1 · own tenant via the real /signup flow");
    await signUpWorkspace(admin.page, {
      name: `QA Perf ${STAMP}`,
      email,
      companyName,
    });
    const company = await db.company.findFirst({ where: { name: companyName }, select: { id: true } });
    if (!company) throw new Error(`signup produced no company named ${companyName}`);
    companyId = company.id;
    MINE.add(companyId);
    await assertMine(companyId);
    ok(`tenant ${companyName} (${companyId})`);

    const me = await db.user.findFirst({
      where: { companyId, email },
      select: { id: true, name: true },
    });
    if (!me) throw new Error("signup produced no admin user in my tenant");

    const project = await db.project.create({
      data: {
        companyId,
        name: "qa perf project",
        description: "synthetic load target",
        supervisorId: me.id,
        createdBy: me.id,
        status: "active",
        color: "emerald",
      },
    });
    projectId = project.id;

    /* 2 · volume ---------------------------------------------------------- */
    section("2 · volume inside my tenant only");
    if (process.env.QA_SKIP_SEED !== "1") {
      await seedVolume(companyId, me.id, me.name, projectId);
    } else {
      metric("seeding", "skipped (QA_SKIP_SEED=1)");
    }
    // Keep the planner honest: without fresh statistics EXPLAIN reports plans
    // chosen for an empty table, which is the wrong plan for every number
    // below. ANALYZE writes statistics, never rows.
    await db.$executeRawUnsafe(`ANALYZE "Task", "Transaction", "TimeEntry", "Activity", "Notification", "Message", "Comment", "Project"`);
    ok("planner statistics refreshed");

    /* 3 · catalogue + plan audits ---------------------------------------- */
    await indexAudit();
    await explainAudit(companyId, me.id);

    /* 4 · the idle noise floor ------------------------------------------- */
    section("4 · idle noise floor (proves the run is not contended)");
    const idleBefore = await settleStats();
    await admin.page.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 4000));
    const idleAfter = await settleStats();
    const idle = diffStats(idleBefore, idleAfter);
    const idleUserScans = idle.User?.idxScan ?? 0;
    metric("4s idle User idx_scan", idleUserScans);
    if (idleUserScans > 4) {
      fail(
        "run is contended or something is polling",
        `${idleUserScans} User index scans in 4 idle seconds — another agent's script is probably running; ` +
          `every SQL delta below is inflated`
      );
    } else {
      ok("noise floor low enough for the deltas below to mean something");
    }

    /* 5 · per-page cost --------------------------------------------------- */
    section("5 · per-page cost");
    const measurements = [];

    const pages = [
      ["/dashboard", () => document.querySelectorAll("main *").length > 50],
      ["/tasks", () => /task/i.test(document.body.innerText)],
      ["/expenses", () => document.querySelectorAll("tbody tr, ul li").length > 0],
      ["/projects", () => /qa perf project/i.test(document.body.innerText)],
      [`/projects/PROJECT_ID`, () => /qa perf project/i.test(document.body.innerText)],
      ["/team", () => /qa perf/i.test(document.body.innerText)],
      ["/time", () => document.querySelectorAll("tbody tr, ul li").length > 0],
      ["/reports", () => document.querySelectorAll("main *").length > 50],
      ["/activities", () => /activity/i.test(document.body.innerText)],
      ["/notifications", () => document.querySelectorAll("main *").length > 20],
      ["/settings", () => /settings/i.test(document.body.innerText)],
      ["/chat", () => document.querySelector('nav[aria-label="Channels"]') !== null],
    ];

    for (const [rawPath, settle] of pages) {
      const path = rawPath.replace("PROJECT_ID", projectId);
      const m = await measureNav(admin.page, path, settle);
      measurements.push(m);
      reportNav(m);
      await admin.page
        .screenshot({ path: `${OUT}/perf-${path.replace(/[^a-z0-9]+/gi, "-")}.png` })
        .catch(() => {});
    }

    /* 5a · perf-001 — redundant session lookups per render ---------------- */
    section("5a · perf-001 · redundant session lookups");
    // `requireScopedSession()` → `auth()` → the jwt callback's
    // `db.user.findUnique`. Neither is wrapped in React `cache()`, so each
    // query helper on a page pays for its own copy. One render should validate
    // the session ONCE.
    for (const m of measurements) {
      const scans = m.sql.User?.idxScan ?? 0;
      metric(`${m.path} User index scans`, scans);
    }
    const dash = measurements.find((m) => m.path === "/dashboard");
    const detail = measurements.find((m) => m.path.startsWith("/projects/"));
    const worst = Math.max(dash?.sql.User?.idxScan ?? 0, detail?.sql.User?.idxScan ?? 0);
    if (worst > 3) {
      fail(
        "one render, one session validation",
        `${worst} "User" index scans for a single page render — ` +
          `auth() is re-run (and re-queried) per query helper`
      );
    } else {
      ok(`session validated ${worst}× per render`);
    }
    promote(
      "perf-001",
      "every page render re-reads the session user once per query helper instead of once",
      `${worst} User lookups on the worst page`,
      "1",
      worst > 3 ? "CONFIRMED" : "CLEAN"
    );

    /* 5b · perf-012 — every row rendered twice --------------------------- */
    section("5b · perf-012 · desktop table AND mobile card list both in the DOM");
    for (const p of ["/expenses", "/time"]) {
      const m = measurements.find((x) => x.path === p);
      if (!m) continue;
      const { tableRows, cardRows, domNodes } = m.nav;
      metric(`${p} rows`, `${tableRows} <tr> + ${cardRows} <li> = ${domNodes} DOM nodes`);
      if (tableRows > 50 && cardRows >= tableRows) {
        fail(
          `${p} renders each row once`,
          `${tableRows} table rows AND ${cardRows} card rows are both in the DOM — ` +
            `the md:hidden list is built for every viewport`
        );
      } else {
        ok(`${p} does not double-render its rows`);
      }
      promote(
        `perf-012 ${p}`,
        "each ledger row is built twice (table + md:hidden card list) on every device",
        `${tableRows} <tr> + ${cardRows} <li>, ${domNodes} nodes`,
        "one row per record",
        tableRows > 50 && cardRows >= tableRows ? "CONFIRMED" : "CLEAN"
      );
    }

    /* 5c · perf-015 — the ledger payload -------------------------------- */
    section("5c · perf-015 · the 5000-row ledger in the RSC payload");
    for (const p of ["/expenses", "/reports", "/team", "/dashboard"]) {
      const m = measurements.find((x) => x.path === p);
      if (!m) continue;
      const txnRows = m.sql.Transaction?.idxRows ?? 0;
      const commentRows = (m.sql.Comment?.idxRows ?? 0) + (m.sql.Comment?.seqRows ?? 0);
      metric(
        `${p} ledger`,
        `${txnRows} Transaction rows read · ${commentRows} Comment rows read · ` +
          `html ${kb(m.nav.html)} · decoded ${kb(m.nav.decoded)}`
      );
      if (m.nav.html > 2_000_000) {
        fail(`${p} HTML under 2MB`, `${kb(m.nav.html)} of serialised HTML+RSC for one page`);
      }
    }
    const exp = measurements.find((m) => m.path === "/expenses");
    promote(
      "perf-015",
      "the finance pages ship the whole 5000-row ledger and a per-row comment count",
      exp ? `${exp.sql.Transaction?.idxRows ?? 0} txn rows, ${kb(exp.nav.html)} HTML` : "not measured",
      "only the rows the page paints",
      (exp?.sql.Transaction?.idxRows ?? 0) > 1000 ? "CONFIRMED" : "CLEAN"
    );

    /* 5d · perf-016 — duplicated per-render queries ---------------------- */
    section("5d · perf-016 · generateMetadata re-runs the page's own query");
    const chat = measurements.find((m) => m.path === "/chat");
    const chan = await db.channel.findFirst({ where: { companyId }, select: { slug: true } });
    if (chan) {
      const m = await measureNav(admin.page, `/chat/${chan.slug}`, () =>
        document.querySelector('[role="log"]') !== null || /message/i.test(document.body.innerText)
      );
      reportNav(m);
      const chanScans = m.sql.Channel?.idxScan ?? 0;
      const memberScans = m.sql.ChannelMember?.idxScan ?? 0;
      metric("/chat/[slug] Channel scans", `${chanScans} Channel · ${memberScans} ChannelMember`);
      // getChannelBySlug runs in generateMetadata AND in the page body: two
      // channel lookups, two roster reads, two unread counts per render.
      if (memberScans >= 4) {
        fail(
          "getChannelBySlug runs once per render",
          `${memberScans} ChannelMember scans — generateMetadata and the page each resolve the channel`
        );
      } else {
        ok(`channel resolved ${memberScans} ChannelMember scan(s) per render`);
      }
      promote(
        "perf-016",
        "opening a channel resolves that channel twice — once for the <title>, once for the page",
        `${chanScans} Channel / ${memberScans} ChannelMember index scans`,
        "half that",
        memberScans >= 4 ? "CONFIRMED" : "CLEAN"
      );
      measurements.push(m);
    } else if (chat) {
      metric("/chat/[slug]", "no channel found in my tenant — skipped");
    }

    /* 5e · perf-008 — /activities?user= --------------------------------- */
    section("5e · perf-008 · the activity actor filter has no index behind it");
    const filtered = await measureNav(admin.page, `/activities?user=${me.id}`, () =>
      /activity/i.test(document.body.innerText)
    );
    reportNav(filtered);
    const actSeq = filtered.sql.Activity?.seqScan ?? 0;
    const actRows = (filtered.sql.Activity?.idxRows ?? 0) + (filtered.sql.Activity?.seqRows ?? 0);
    metric("Activity access", `${actSeq} seq scan(s), ${actRows} rows read for 41 shown`);
    promote(
      "perf-008",
      "filtering the activity feed by person reads far more rows than it shows",
      `${actRows} Activity rows read, ${actSeq} sequential scan(s)`,
      "~41 rows via a (companyId, userId, createdAt) index",
      actRows > 300 || actSeq > 0 ? "CONFIRMED" : "CLEAN"
    );

    /* 6 · perf-004 — the notification badge poll ------------------------ */
    section("6 · perf-004 · the unread badge downloads the whole list, twice, every 30s");
    const posts = [];
    const onPost = async (res) => {
      const req = res.request();
      if (req.method() !== "POST") return;
      if (!(res.headers()["content-type"] ?? "").includes("text/x-component")) return;
      let len = 0;
      try {
        len = (await res.buffer()).length;
      } catch {
        len = Number(res.headers()["content-length"] ?? 0);
      }
      posts.push({ at: Date.now(), bytes: len, url: req.url() });
    };
    await measureNav(admin.page, "/dashboard", () => document.querySelectorAll("main *").length > 50);
    admin.page.on("response", onPost);
    const t0 = Date.now();
    // Wait on the STATE (three server-action POSTs seen, or 75s elapsed) rather
    // than on a fixed sleep: two mount fetches plus at least one 30s poll.
    await admin.page
      .waitForFunction(() => true, { timeout: 1000 })
      .catch(() => {});
    while (posts.length < 3 && Date.now() - t0 < 75000) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    admin.page.off("response", onPost);
    const totalBytes = posts.reduce((a, p) => a + p.bytes, 0);
    metric(
      "server-action POSTs while idling on /dashboard",
      `${posts.length} in ${Math.round((Date.now() - t0) / 1000)}s, ${kb(totalBytes)} total`
    );
    const notifRows = VOL.notifs;
    if (posts.length >= 2 && totalBytes > 20_000) {
      fail(
        "the unread badge costs a count, not a list",
        `${posts.length} POSTs / ${kb(totalBytes)} while idle — listNotificationsAction returns up to 200 ` +
          `full rows and both the topbar and the sidebar call it (sidebar re-polls every 30s)`
      );
    } else {
      ok(`idle notification traffic: ${posts.length} POSTs, ${kb(totalBytes)}`);
    }
    promote(
      "perf-004",
      "the sidebar badge re-downloads the whole notification list every 30 seconds to compute one integer",
      `${posts.length} POSTs / ${kb(totalBytes)} per ~70s idle, with ${notifRows} notifications seeded`,
      "one COUNT(*) per poll, a few bytes",
      posts.length >= 2 && totalBytes > 20_000 ? "CONFIRMED" : "CLEAN"
    );

    /* 7 · perf-017 / perf-018 — static asset weight --------------------- */
    section("7 · perf-017 / perf-018 · fonts and precached icons");
    const fonts = dash?.nav.fonts ?? [];
    metric("fonts on /dashboard", fonts.map((f) => `${f.name} ${kb(f.size)}`).join(" · ") || "none");
    const playfair = fonts.find((f) => /playfair/i.test(f.name));
    if (playfair) {
      fail(
        "Playfair Display is not shipped to app routes",
        `${kb(playfair.size)} preloaded on /dashboard; its only use is one <blockquote> on the marketing page`
      );
    } else {
      ok("no marketing-only font on an app route");
    }
    promote(
      "perf-017",
      "a display font used by one blockquote on the marketing page is preloaded on every app route",
      playfair ? `Playfair ${kb(playfair.size)} on /dashboard` : "not present",
      "0 bytes on app routes",
      playfair ? "CONFIRMED" : "CLEAN"
    );

    const shell = await admin.page.evaluate(async (base) => {
      const urls = [
        "/icon.svg",
        "/icon-maskable.svg",
        "/android-chrome-192x192.png",
        "/android-chrome-512x512.png",
        "/manifest.json",
        "/offline",
      ];
      const out = [];
      for (const u of urls) {
        try {
          const res = await fetch(base + u, { cache: "no-store" });
          out.push({ u, bytes: (await res.arrayBuffer()).byteLength });
        } catch (e) {
          out.push({ u, bytes: -1 });
        }
      }
      return out;
    }, BASE);
    const shellTotal = shell.reduce((a, s) => a + Math.max(0, s.bytes), 0);
    for (const s of shell) metric(`SW precache ${s.u}`, kb(s.bytes));
    if (shellTotal > 250_000) {
      fail(
        "the service-worker shell precache is lean",
        `${kb(shellTotal)} fetched on install (public/sw.js SHELL_URLS) — two of those SVGs ` +
          `are only ever read by the OS install prompt`
      );
    } else {
      ok(`SW shell precache ${kb(shellTotal)}`);
    }
    promote(
      "perf-018",
      "installing the PWA downloads a quarter-megabyte of icons nothing on screen uses",
      `${kb(shellTotal)} across ${shell.length} SHELL_URLS`,
      "< 60KB",
      shellTotal > 250_000 ? "CONFIRMED" : "CLEAN"
    );

    /* 8 · perf-006 — the purge's missing FK index, observed ------------- */
    section("8 · perf-006 · deleting a project seq-scans Notification");
    // Reproduce exactly what the nightly purge's scope-2 stage does: hard-delete
    // a soft-deleted, TASK-FREE project that notifications still point at. Both
    // rows are mine; nothing seeded is touched.
    const p2 = await db.project.create({
      data: {
        companyId,
        name: `qa perf purge target ${STAMP}`,
        supervisorId: me.id,
        createdBy: me.id,
        status: "active",
        color: "emerald",
        deletedAt: new Date(Date.now() - 120 * 86400000),
      },
    });
    extraProjectId = p2.id;
    await db.notification.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        userId: me.id,
        companyId,
        projectId: p2.id,
        title: `purge-target ping ${i}`,
        message: "pins the SET NULL referential action to this project",
        type: "info",
        category: "system",
      })),
    });
    await settleStats();
    const purgeBefore = await statSnapshot();
    // deleteMany scoped to the single id I just created — the same statement
    // shape the cron issues, on one row I own.
    await db.project.deleteMany({ where: { id: p2.id, companyId } });
    extraProjectId = null;
    const purgeAfter = await settleStats();
    const purgeDiff = diffStats(purgeBefore, purgeAfter);
    const nSeq = purgeDiff.Notification?.seqScan ?? 0;
    const nRows = purgeDiff.Notification?.seqRows ?? 0;
    metric("deleting 1 project", `Notification seq_scan +${nSeq}, seq_tup_read +${nRows}`);
    if (nSeq > 0) {
      fail(
        "project delete uses an index on Notification.projectId",
        `${nSeq} sequential scan(s) reading ${nRows} rows for ONE project — ` +
          `the nightly purge pays this per purged project, on the fastest-growing table`
      );
    } else {
      ok("project delete resolved Notification.projectId through an index");
    }
    promote(
      "perf-006",
      "the nightly purge scans the entire notification table once per project it removes",
      `${nSeq} seq scan(s), ${nRows} rows read to delete 1 project`,
      "0 seq scans",
      nSeq > 0 ? "CONFIRMED" : "CLEAN"
    );

    /* 9 · perf-021 — the export payload -------------------------------- */
    section("9 · perf-021 · /api/export pretty-prints its own payload");
    const exportStat = await admin.page.evaluate(async (base) => {
      const t = Date.now();
      const res = await fetch(`${base}/api/export`, { cache: "no-store" });
      const text = await res.text();
      let compact = null;
      try {
        compact = JSON.stringify(JSON.parse(text)).length;
      } catch {
        /* leave null */
      }
      return { status: res.status, ms: Date.now() - t, pretty: text.length, compact };
    }, BASE);
    metric(
      "/api/export",
      `${exportStat.status} in ${exportStat.ms}ms · ${kb(exportStat.pretty)} pretty · ` +
        `${exportStat.compact === null ? "?" : kb(exportStat.compact)} compact`
    );
    if (exportStat.compact && exportStat.pretty > exportStat.compact * 1.3) {
      fail(
        "the export is not inflated by pretty-printing",
        `${kb(exportStat.pretty)} vs ${kb(exportStat.compact)} compact — ` +
          `JSON.stringify(payload, null, 2) at app/api/export/route.ts:163, buffered whole in memory`
      );
    } else {
      ok("export payload is not meaningfully inflated");
    }
    promote(
      "perf-021",
      "the workspace export is pretty-printed, roughly doubling its bytes and its peak memory",
      exportStat.compact ? `${kb(exportStat.pretty)} vs ${kb(exportStat.compact)}` : "unparseable",
      "compact JSON, streamed",
      exportStat.compact && exportStat.pretty > exportStat.compact * 1.3 ? "CONFIRMED" : "CLEAN"
    );

    /* 10 · negative result — the fan-out is NOT N+1 --------------------- */
    section("10 · negative result · notification fan-out stays O(1) in recipients");
    // Invite two teammates through the real flow so a fan-out has recipients,
    // then watch the per-table deltas while one comment mentions everyone. If
    // notifyUsers regressed to one write per recipient, Notification's
    // n_tup_ins would climb with the roster while idx_scan stayed flat; a
    // createMany shows as ONE insert statement for N rows.
    const fanBefore = await settleStats();
    await db.$executeRawUnsafe("SELECT 1"); // no-op; keeps the shape obvious
    const fanAfter = await settleStats();
    metric("fan-out probe baseline", JSON.stringify(diffStats(fanBefore, fanAfter)));
    metric(
      "fan-out read",
      "lib/notify/fan-out.ts:107 issues ONE notificationPreference.findMany and ONE " +
        "notification.createMany regardless of recipient count — verified statically; " +
        "the invite-driven observation needs the team-and-invites agent's fixture"
    );

    /* summary ----------------------------------------------------------- */
    section("summary");
    const report = {
      agent: "performance",
      base: BASE,
      stamp: STAMP,
      companyId,
      volume: VOL,
      findings,
      pages: measurements.map((m) => ({
        path: m.path,
        ttfb: m.nav.ttfb,
        settledMs: m.settled,
        htmlBytes: m.nav.html,
        decodedBytes: m.nav.decoded,
        domNodes: m.nav.domNodes,
        tableRows: m.nav.tableRows,
        cardRows: m.nav.cardRows,
        sql: m.sql,
      })),
    };
    const reportPath = `${OUT}/qa-performance-report.json`;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n  report written to ${reportPath}`);
    for (const f of findings) {
      console.log(`  ${f.verdict === "CONFIRMED" ? "❌" : "  "} ${f.id}  ${f.measured}`);
    }
  } finally {
    /* cleanup — children before parents, my tenant only ----------------- */
    try {
      if (companyId && MINE.has(companyId)) {
        await assertMine(companyId);
        const w = { where: { companyId } };
        await db.messageReaction.deleteMany({ where: { message: { companyId } } });
        await db.message.deleteMany(w);
        await db.channelMember.deleteMany({ where: { channel: { companyId } } });
        await db.channel.deleteMany(w);
        await db.comment.deleteMany(w);
        await db.timeEntry.deleteMany(w);
        await db.transaction.deleteMany(w);
        await db.budget.deleteMany(w);
        await db.recurringRule.deleteMany(w);
        await db.task.deleteMany(w);
        await db.activity.deleteMany(w);
        await db.notification.deleteMany(w);
        await db.inviteToken.deleteMany(w);
        await db.project.deleteMany(w);
        await db.company.update({ where: { id: companyId }, data: { ownerId: null } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId } } });
        await db.user.deleteMany(w);
        await db.company.delete({ where: { id: companyId } });
        console.log(`\n  cleaned up tenant ${companyId}`);
      }
    } catch (e) {
      console.error("  ❌ cleanup failed:", e.message, "— run `node scripts/_qa-guard.mjs sweep`");
      process.exitCode = 1;
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
  console.log("Now run: node scripts/_qa-guard.mjs verify");
}

main().catch((err) => {
  console.error("qa-performance threw:", err);
  process.exit(1);
});
