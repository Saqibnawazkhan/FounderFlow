/*
 * QA — production-readiness surface (go-live audit, AGENT_INDEX 20).
 *
 * WHAT THIS EXERCISES (everything about running FounderFlow in production):
 *   A. Security headers + the CSP actually served on real responses
 *   B. robots.txt / sitemap.xml correctness and base-URL derivation
 *   C. The PWA: manifest, every precached shell URL, SW activation, offline
 *   D. The three vercel.json crons: auth posture, route parity, purge dry-run
 *   E. Observability: is browser-side Sentry actually wired? /api/health?
 *   F. Env + runtime contract: what a prod build is allowed to forget
 *   G. CVE-2025-29927 — middleware auth bypass against the pinned Next 14.2.5
 *   H. Whether the rate limiter's key (x-real-ip) is client-forgeable
 *   I. 404 / offline / CSP-violation states
 *
 * DATA SAFETY (the hardest constraint in this audit):
 *   • This script signs up its OWN workspace through the real signup flow
 *     (`qa-prodready-<stamp>`) and every DB assertion carries
 *     `where: { companyId: myCompanyId }`. There is not one bare count().
 *   • It never writes a row it did not create. The purge cron is only invoked
 *     after PROVING, from .env.local, that PURGE_ENABLED !== "true" — i.e.
 *     that the endpoint is in dry-run and physically cannot delete.
 *   • The rate-limit probe authenticates as a NON-EXISTENT email so it can
 *     never lock out a seeded or real account, and it uses dedicated forged
 *     IPs (10.99.20.20x) so it does not poison this agent's own auth bucket.
 *   • Cleanup deletes only rows under myCompanyId, children before parents,
 *     and re-verifies the company's NAME matches this run's tenant first.
 *
 * `import { localDb }` — never `new PrismaClient()`: a bare client auto-loads
 * the root `.env`, which points at PRODUCTION Supabase (tests/lib/db/
 * script-safety.test.ts enforces this across scripts/).
 *
 * Run:  node scripts/qa-production-readiness.mjs
 */

import puppeteer from "puppeteer-core";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { localDb } from "./_local-db.mjs";

// ── constants ──────────────────────────────────────────────────────────────
const AGENT_INDEX = 20;
const AGENT_IP = `10.99.0.${AGENT_INDEX}`; // one auth bucket per agent
const RL_IP_A = "10.99.20.201"; // dedicated to the rate-limit probe
const RL_IP_B = "10.99.20.202"; // the "rotate the header" half of it
const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/production-readiness";
const STAMP = Date.now().toString().slice(-6);
const TENANT = `qa-prodready-${STAMP}`;
const EMAIL = `qa-prodready-${STAMP}@founderflow.test`;
const PASSWORD = "QaProdReady1"; // satisfies lib/schemas/password.ts
const REPO = new URL("..", import.meta.url);

/** Patched floor for CVE-2025-29927 (x-middleware-subrequest auth bypass). */
const NEXT_CVE_FLOOR = "14.2.25";

const db = localDb();
/** Set after signup. EVERY db assertion below is scoped to this. */
let myCompanyId = null;
let myUserId = null;

// ── reporting ──────────────────────────────────────────────────────────────
function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  // Must NOT throw: one run has to report every broken assertion.
  console.error(`  FAIL ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}
function section(label) {
  console.log(`\n-- ${label}`);
}

// ── tiny helpers ───────────────────────────────────────────────────────────
/** Read one key out of .env.local. NEVER the root .env (that is production). */
function readEnvLocal(key) {
  const raw = readFileSync(new URL(".env.local", REPO), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1 || t.slice(0, eq).trim() !== key) continue;
    return t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

function repoText(rel) {
  return readFileSync(new URL(rel, REPO), "utf8");
}

/** HTTP with forged edge headers. redirect:manual so we can read the gate. */
async function http(path, { headers = {}, ip = AGENT_IP } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    headers: { "x-real-ip": ip, ...headers },
  });
  return res;
}

function semverGte(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return true;
}

function wire(page, cspSink) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    const text = m.text();
    if (/Content Security Policy|violates the following/i.test(text)) cspSink.push(text);
    if (m.type() === "error") console.error("CONSOLE.error:", text);
  });
}

/**
 * Every page/context gets x-real-ip BEFORE its first navigation: getClientIp()
 * falls back to the literal "unknown" in dev, so without this all agents share
 * one limiters.auth bucket of 5/60s and starve each other.
 */
async function newPage(ctx, cspSink, ip = AGENT_IP) {
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": ip });
  wire(page, cspSink);
  return page;
}

// The retry-until-hydrated sign-in helper — copied verbatim (FaultsAudit A14):
// on a cold dev server the form paints before React hydrates, and a click that
// lands first performs a NATIVE GET submit with no sign-in.
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

/** Sign up this run's own workspace through the real signup flow. */
async function signUpTenant(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input[name="companyName"]', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500)); // hydration, as in signIn
    await page.type('input[name="name"]', "QA ProdReady");
    await page.type('input[name="email"]', EMAIL);
    await page.type('input[name="password"]', PASSWORD);
    await page.type('input[name="companyName"]', TENANT);
    await page.click('button[type="submit"]');
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
      // Scoped by this run's globally unique email — never a bare query.
      const me = await db.user.findUnique({
        where: { email: EMAIL },
        select: { id: true, companyId: true },
      });
      if (!me) throw new Error("signup appeared to succeed but no user row exists");
      myUserId = me.id;
      myCompanyId = me.companyId;
      return;
    }
  }
  throw new Error("could not sign up the qa tenant after 3 attempts");
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  console.log("== production-readiness qa ==");
  console.log(`   tenant=${TENANT} ip=${AGENT_IP} out=${OUT}`);

  const APP_URL = readEnvLocal("NEXT_PUBLIC_APP_URL") ?? BASE;
  const CRON_SECRET = readEnvLocal("CRON_SECRET");
  const PURGE_ENABLED = readEnvLocal("PURGE_ENABLED");
  const RATE_LIMIT_DISABLED = readEnvLocal("RATE_LIMIT_DISABLED");

  const csp = []; // CSP violation console lines, collected across pages
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  try {
    // ══ A. security headers + the CSP actually served ═══════════════════════
    section("A. security headers");
    const REQUIRED_HEADERS = [
      "content-security-policy",
      "x-frame-options",
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
    ];
    for (const path of ["/", "/login", "/api/export"]) {
      const res = await http(path);
      const missing = REQUIRED_HEADERS.filter((h) => !res.headers.get(h));
      if (missing.length === 0) ok(`${path} carries all ${REQUIRED_HEADERS.length} headers`);
      else fail(`${path} security headers`, `missing ${missing.join(", ")}`);
      if (res.headers.get("x-powered-by")) {
        fail(`${path} x-powered-by`, res.headers.get("x-powered-by"));
      } else ok(`${path} hides x-powered-by`);
    }

    const cspValue = (await http("/")).headers.get("content-security-policy") ?? "";
    const scriptSrc = (cspValue.split(";").find((d) => d.trim().startsWith("script-src")) ?? "")
      .trim();
    // PROMOTION CHECK for prodready-002: the CSP must not hand XSS a free pass.
    if (/'unsafe-inline'/.test(scriptSrc)) {
      fail(
        "CSP script-src allows 'unsafe-inline'",
        `served value: "${scriptSrc}" — a nonce/hash is required for CSP to stop injected <script>`
      );
    } else ok("CSP script-src has no 'unsafe-inline'");
    for (const directive of ["object-src", "frame-src", "worker-src"]) {
      if (cspValue.includes(directive)) ok(`CSP declares ${directive}`);
      else fail(`CSP omits ${directive}`, `falls back to default-src; served CSP: ${cspValue}`);
    }
    if (/upgrade-insecure-requests/.test(cspValue)) ok("CSP upgrades insecure requests");
    else note("CSP has no upgrade-insecure-requests (HSTS covers prod, absent in dev)");
    note(`HSTS on this (dev) origin: ${(await http("/")).headers.get("strict-transport-security") ?? "absent — prod-only branch, never exercised before launch"}`);

    // ══ B. robots + sitemap ════════════════════════════════════════════════
    section("B. robots + sitemap");
    const robotsRes = await http("/robots.txt");
    const robots = await robotsRes.text();
    if (robotsRes.status === 200) ok("/robots.txt is 200");
    else fail("/robots.txt", `status ${robotsRes.status}`);
    const sitemapLine = (robots.match(/Sitemap:\s*(\S+)/i) ?? [])[1] ?? "";
    if (sitemapLine.startsWith(APP_URL)) ok(`robots advertises ${sitemapLine}`);
    else fail("robots Sitemap host", `expected to start with ${APP_URL}, got "${sitemapLine}"`);
    if (/localhost|127\.0\.0\.1/.test(sitemapLine)) {
      note(`robots Sitemap points at localhost here because NEXT_PUBLIC_APP_URL=${APP_URL}; the SAME code path ships that value to prod and nothing in scripts/vercel-build.mjs requires the var`);
    }
    // Which authenticated routes are crawlable. Already-filed finding — logged
    // as a note so it is visible without double-counting as a failure.
    const APP_ROUTES = [
      "/dashboard", "/expenses", "/revenue", "/investments", "/budgets", "/recurring",
      "/reports", "/tasks", "/projects", "/time", "/team", "/activities",
      "/notifications", "/settings", "/chat", "/invite",
    ];
    const crawlable = APP_ROUTES.filter((r) => !robots.includes(`Disallow: ${r}`));
    note(`robots.txt omits ${crawlable.length} app routes from Disallow: ${crawlable.join(" ")}`);

    const smRes = await http("/sitemap.xml");
    const sm = await smRes.text();
    if (smRes.status === 200 && sm.includes("<urlset")) ok("/sitemap.xml is 200 and well-formed");
    else fail("/sitemap.xml", `status ${smRes.status}`);
    const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const loc of locs) {
      const path = loc.replace(APP_URL, "") || "/";
      const r = await http(path);
      if (r.status === 200) ok(`sitemap entry ${path} is 200`);
      else fail(`sitemap entry ${path}`, `status ${r.status} — advertising a broken URL to crawlers`);
    }

    // ══ C. PWA: manifest, precache, SW activation, offline ═════════════════
    section("C. PWA");
    const manRes = await http("/manifest.json");
    if (manRes.status === 200) ok("/manifest.json is 200");
    else fail("/manifest.json", `status ${manRes.status}`);
    const manifest = JSON.parse(await manRes.text());
    if (manifest.start_url === "/dashboard") ok("manifest start_url is /dashboard");
    else fail("manifest start_url", `got ${manifest.start_url}`);

    // Every icon the manifest declares must resolve, with its declared type.
    for (const icon of manifest.icons ?? []) {
      const r = await http(icon.src);
      const ct = r.headers.get("content-type") ?? "";
      if (r.status === 200 && ct.includes(icon.type.split("/")[1].replace("svg+xml", "svg"))) {
        ok(`manifest icon ${icon.src} → 200 ${ct}`);
      } else {
        fail(`manifest icon ${icon.src}`, `status ${r.status}, content-type "${ct}", declared "${icon.type}"`);
      }
    }

    // The SW precache list, parsed out of public/sw.js so it cannot drift.
    // cache.addAll() rejects ATOMICALLY on any non-2xx: one bad URL here and
    // the install handler never settles and the whole offline layer is dead.
    const swSource = repoText("public/sw.js");
    const shellUrls = [
      ...(swSource.match(/const SHELL_URLS = \[([\s\S]*?)\]/) ?? ["", ""])[1].matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    const cacheVersion = (swSource.match(/CACHE_VERSION = "([^"]+)"/) ?? [])[1];
    if (shellUrls.length > 0) ok(`parsed ${shellUrls.length} SHELL_URLS from sw.js (${cacheVersion})`);
    else fail("sw.js SHELL_URLS", "could not parse the precache list");
    for (const u of shellUrls) {
      const r = await http(u);
      if (r.status === 200) ok(`precache ${u} → 200`);
      else fail(`precache ${u}`, `status ${r.status} — cache.addAll rejects atomically, killing the entire SW install`);
    }
    const swRes = await http("/sw.js");
    const swCt = swRes.headers.get("content-type") ?? "";
    if (swRes.status === 200 && /javascript/.test(swCt)) ok(`/sw.js → 200 ${swCt}`);
    else fail("/sw.js", `status ${swRes.status}, content-type "${swCt}" — registration needs a JS type`);

    // ══ signup: this run's own tenant ══════════════════════════════════════
    section("own tenant (real signup flow)");
    const ctx = await browser.createBrowserContext();
    const page = await newPage(ctx, csp);
    await signUpTenant(page);
    ok(`signed up ${TENANT} (companyId=${myCompanyId})`);
    // Scoped assertions only — a bare count() could be satisfied by another
    // agent's insert and produce a FALSE PASS.
    const mine = await db.company.count({ where: { id: myCompanyId, name: TENANT } });
    if (mine === 1) ok("my company row exists, scoped by id + name");
    else fail("tenant persistence", `company.count({id:${myCompanyId},name:${TENANT}}) = ${mine}`);
    const myUsers = await db.user.count({ where: { companyId: myCompanyId } });
    if (myUsers === 1) ok("exactly one user in my tenant");
    else fail("tenant users", `expected 1, got ${myUsers}`);

    // SW lifecycle in a real browser, inside my own session.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
    const swState = await page
      .waitForFunction(
        async () => {
          if (!("serviceWorker" in navigator)) return false;
          const reg = await navigator.serviceWorker.getRegistration("/");
          return !!(reg && reg.active && reg.active.state === "activated");
        },
        { timeout: 30000, polling: 500 }
      )
      .then(() => true)
      .catch(() => false);
    if (swState) ok("service worker reached state=activated");
    else fail("service worker activation", "no activated registration after 30s — offline layer is dead");

    await page.reload({ waitUntil: "networkidle0" });
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    if (controlled) ok("the page is controlled by the SW after one reload");
    else fail("SW control", "navigator.serviceWorker.controller is null — clients.claim() did not take");

    const cacheReport = await page.evaluate(async (version) => {
      const keys = await caches.keys();
      const shell = keys.find((k) => k.startsWith("ff-shell-"));
      let offlineCached = false;
      if (shell) {
        const c = await caches.open(shell);
        offlineCached = !!(await c.match("/offline"));
      }
      return { keys, shell, offlineCached, version };
    }, cacheVersion);
    if (cacheReport.shell === `ff-shell-${cacheVersion}`) {
      ok(`shell cache ${cacheReport.shell} exists`);
    } else {
      fail("shell cache", `expected ff-shell-${cacheVersion}, caches.keys()=${JSON.stringify(cacheReport.keys)}`);
    }
    if (cacheReport.offlineCached) ok("/offline is precached in the shell cache");
    else fail("/offline precache", "not in the shell cache — the offline fallback cannot work");

    await page.screenshot({ path: `${OUT}/${STAMP}-pwa-dashboard.png` });

    // Offline navigation → the SW must serve /offline, not a browser error page.
    await page.setOfflineMode(true);
    await page.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    const offlineBody = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/offline/i.test(offlineBody)) ok("an offline navigation renders the /offline fallback");
    else fail("offline fallback", `body did not read as offline: ${offlineBody.slice(0, 160)}`);
    await page.screenshot({ path: `${OUT}/${STAMP}-offline.png` });
    await page.setOfflineMode(false);

    // ══ D. crons ══════════════════════════════════════════════════════════
    section("D. crons (vercel.json)");
    const vercelJson = JSON.parse(repoText("vercel.json"));
    const cronPaths = (vercelJson.crons ?? []).map((c) => c.path);
    note(`vercel.json declares ${cronPaths.length} crons; Vercel's Hobby plan caps at 2 — verify the account plan before launch`);
    for (const p of cronPaths) {
      // Route parity: a renamed route leaves a cron pointing at a 404 forever.
      const routeFile = `app${p}/route.ts`;
      if (existsSync(new URL(routeFile, REPO))) ok(`${p} has a route file`);
      else fail(`${p} route parity`, `no ${routeFile} — this cron 404s every night`);

      const bare = await http(p);
      if (bare.status === 401) ok(`${p} unauthenticated → 401`);
      else fail(`${p} unauthenticated`, `expected 401, got ${bare.status} (${(await bare.text()).slice(0, 120)})`);

      const wrong = await http(p, { headers: { authorization: "Bearer not-the-secret" } });
      if (wrong.status === 401) ok(`${p} wrong bearer → 401`);
      else fail(`${p} wrong bearer`, `expected 401, got ${wrong.status}`);
    }

    // The purge cron, ONLY in proven dry-run. PURGE_ENABLED must not be "true".
    if (!CRON_SECRET) {
      note("CRON_SECRET is empty in .env.local — skipping the authorized purge probe. NOTE: with it unset every cron returns 500 and emits NO Sentry event, so all three silently die in prod.");
    } else if (PURGE_ENABLED === "true") {
      note("PURGE_ENABLED=true in .env.local — REFUSING to invoke the purge endpoint (it would hard-delete). Data safety wins over coverage.");
    } else {
      const pr = await http("/api/cron/purge-soft-deleted", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      });
      const body = await pr.json().catch(() => ({}));
      if (pr.status === 200 && body.dryRun === true) ok("purge cron authorizes and reports dryRun=true");
      else fail("purge cron dry-run", `status ${pr.status}, body ${JSON.stringify(body).slice(0, 240)}`);
      if (body.workspaceRowsDeleted === undefined || body.result?.workspaceRowsDeleted === 0) {
        ok("purge cron deleted zero rows");
      } else {
        fail("purge cron deleted rows in dry-run", JSON.stringify(body.result));
      }
      // My tenant is untouched (it has no tombstone, so it is out of scope).
      const still = await db.company.count({ where: { id: myCompanyId } });
      if (still === 1) ok("my workspace survived the purge probe");
      else fail("purge touched my tenant", `company.count({id:${myCompanyId}}) = ${still}`);
      note(`purge retentionDays=${body.retentionDays}, excludedModels=${JSON.stringify(body.excludedModels)} — dryRun means the 90-day retention promise has never actually been enforced in prod`);
    }

    // ══ E. observability ══════════════════════════════════════════════════
    section("E. observability");
    // Is the browser Sentry SDK even in the bundle? sentry.client.config.ts is
    // injected by withSentryConfig, which next.config.js only applies when
    // SENTRY_AUTH_TOKEN + ORG + PROJECT are ALL set. And it reads
    // NEXT_PUBLIC_SENTRY_DSN, which nothing validates or requires.
    const html = await (await http("/login")).text();
    const chunkUrls = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
    let sentryMarker = false;
    for (const u of chunkUrls.slice(0, 40)) {
      const text = await (await http(u)).text();
      if (/replaysOnErrorSampleRate|replayIntegration/.test(text)) {
        sentryMarker = true;
        break;
      }
    }
    if (sentryMarker) ok("sentry.client.config.ts is present in the client bundle");
    else fail("browser Sentry not bundled", `scanned ${Math.min(chunkUrls.length, 40)} chunks, no client-init marker — every Sentry.captureException in app/(app)/error.tsx and app/global-error.tsx is a no-op, so "The team has been notified" is false`);

    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    const hasSentryGlobal = await page.evaluate(() => typeof window.__SENTRY__ !== "undefined");
    if (hasSentryGlobal) ok("window.__SENTRY__ is defined (client SDK initialised)");
    else fail("window.__SENTRY__ undefined", "no browser error reporting at all");

    const tunnel = await http("/monitoring");
    note(`Sentry tunnelRoute /monitoring → ${tunnel.status} (404 confirms withSentryConfig is not applied, so source maps are unuploaded and prod stacks stay minified)`);

    const health = await http("/api/health");
    if (health.status === 200) ok("/api/health is 200");
    else fail("/api/health missing", `status ${health.status} — no endpoint for an uptime monitor or a Vercel health check to poll`);

    // ══ F. env + runtime contract ═════════════════════════════════════════
    section("F. env + runtime contract");
    const buildScript = repoText("scripts/vercel-build.mjs");
    const requiredProd = [
      ...(buildScript.match(/const requiredProdEnv = \{([\s\S]*?)\n  \};/) ?? ["", ""])[1].matchAll(
        /^\s{4}([A-Z0-9_]+):/gm
      ),
    ].map((m) => m[1]);
    ok(`vercel-build.mjs requires: ${requiredProd.join(", ") || "(none parsed)"}`);
    // Vars the app cannot function without, that a green prod build may omit.
    const MUST_ALSO_REQUIRE = {
      NEXT_PUBLIC_APP_URL: "every invite / reset / verify link and robots+sitemap fall back to http://localhost:3000",
      CRON_SECRET: "all three crons return 500 forever, with no Sentry event",
      GMAIL_USER: "no transactional email is sent; password reset still says 'check your email'",
      GMAIL_APP_PASSWORD: "same — the dev-stub branch prints the reset link to the function log instead",
      NEXT_PUBLIC_SENTRY_DSN: "browser-side error reporting is silently off",
    };
    for (const [k, why] of Object.entries(MUST_ALSO_REQUIRE)) {
      if (requiredProd.includes(k)) ok(`prod build requires ${k}`);
      else fail(`prod build may omit ${k}`, why);
    }

    const nvmrc = repoText(".nvmrc").trim();
    const pkg = JSON.parse(repoText("package.json"));
    const localMajor = process.versions.node.split(".")[0];
    if (localMajor === nvmrc.replace(/[^0-9].*$/, "")) ok(`local Node ${process.version} matches .nvmrc (${nvmrc})`);
    else fail("Node version parity", `this machine builds on ${process.version}, prod pins .nvmrc=${nvmrc} / engines=${pkg.engines?.node} — "works on my machine" divergence, and Node 20 is past end-of-life (2026-04-30) so it receives no security patches`);

    const nextVersion = JSON.parse(repoText("node_modules/next/package.json")).version;
    if (semverGte(nextVersion, NEXT_CVE_FLOOR)) {
      ok(`next ${nextVersion} is at or past the CVE-2025-29927 floor (${NEXT_CVE_FLOOR})`);
    } else {
      fail(
        "next is below the CVE-2025-29927 patch floor",
        `installed ${nextVersion}, patched ${NEXT_CVE_FLOOR}+ — this app's route protection IS middleware (auth.config.ts authorized()), which is exactly what that advisory bypasses`
      );
    }

    // ══ G. CVE-2025-29927 — try to walk past the middleware auth gate ══════
    section("G. middleware auth bypass attempt (unauthenticated)");
    const BYPASS_HEADERS = [
      { "x-middleware-subrequest": "middleware" },
      { "x-middleware-subrequest": "src/middleware" },
      { "x-middleware-subrequest": "middleware:middleware:middleware:middleware:middleware" },
      { "x-middleware-subrequest": "pages/_middleware" },
    ];
    // Baseline first: without the header the gate must redirect to /login.
    for (const target of ["/budgets", "/dashboard", "/api/export"]) {
      const baseline = await http(target, { ip: "10.99.20.210" });
      if ([301, 302, 303, 307, 308, 401, 403].includes(baseline.status)) {
        ok(`${target} unauthenticated baseline → ${baseline.status}`);
      } else {
        fail(`${target} unauthenticated baseline`, `expected a redirect/401, got ${baseline.status}`);
      }
      for (const headers of BYPASS_HEADERS) {
        const res = await http(target, { headers, ip: "10.99.20.210" });
        const body = res.status === 200 ? (await res.text()).slice(0, 200) : "";
        if (res.status === baseline.status) {
          ok(`${target} still ${res.status} with ${JSON.stringify(headers)}`);
        } else {
          fail(
            `AUTH BYPASS: ${target} with ${JSON.stringify(headers)}`,
            `baseline ${baseline.status} → forged ${res.status}. Body: ${body}`
          );
        }
      }
    }

    // ══ H. is the rate-limit key client-forgeable? ═════════════════════════
    section("H. rate-limit key integrity");
    if (RATE_LIMIT_DISABLED === "true") {
      note("RATE_LIMIT_DISABLED=true in .env.local — cannot probe the limiter. NOTE: nothing in scripts/vercel-build.mjs stops this same var being set in the Production scope, where it silently disables brute-force protection with zero signal.");
    } else {
      // A non-existent email: this can never lock out a seeded or real account.
      const victim = `qa-prodready-rl-${STAMP}@founderflow.test`;
      const rlCtx = await browser.createBrowserContext();
      const rlPage = await newPage(rlCtx, csp, RL_IP_A);
      let limitedAt = 0;
      for (let i = 1; i <= 7 && !limitedAt; i++) {
        await rlPage.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
        await rlPage.waitForSelector("input[type=email]", { timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200));
        await rlPage.type("input[type=email]", victim);
        await rlPage.type("input[type=password]", "WrongPassword1");
        await rlPage.click("button[type=submit]");
        const sawLimit = await rlPage
          .waitForFunction(() => /too many requests/i.test(document.body.innerText), {
            timeout: 8000,
            polling: 300,
          })
          .then(() => true)
          .catch(() => false);
        if (sawLimit) limitedAt = i;
      }
      if (limitedAt > 0 && limitedAt <= 6) ok(`auth limiter engaged on attempt ${limitedAt} from ${RL_IP_A}`);
      else fail("auth limiter never engaged", `7 failed logins from one IP were all accepted (limiters.auth is 5/60s)`);
      await rlPage.screenshot({ path: `${OUT}/${STAMP}-ratelimit-a.png` });

      if (limitedAt > 0) {
        // Rotate the ONE header the limiter keys on. If the bucket resets, the
        // control is decorative wherever a client can supply x-real-ip.
        const rlPage2 = await newPage(rlCtx, csp, RL_IP_B);
        await rlPage2.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
        await rlPage2.waitForSelector("input[type=email]", { timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200));
        await rlPage2.type("input[type=email]", victim);
        await rlPage2.type("input[type=password]", "WrongPassword1");
        await rlPage2.click("button[type=submit]");
        const stillLimited = await rlPage2
          .waitForFunction(() => /too many requests/i.test(document.body.innerText), {
            timeout: 8000,
            polling: 300,
          })
          .then(() => true)
          .catch(() => false);
        if (stillLimited) ok("rotating x-real-ip did NOT reset the bucket");
        else fail("rate limiter bypassable by rotating x-real-ip", `bucket reset for ${RL_IP_B} after ${RL_IP_A} was blocked — getClientIp() trusts an unvalidated request header with no proxy allow-list (lib/client-ip.ts:25)`);
        await rlPage2.screenshot({ path: `${OUT}/${STAMP}-ratelimit-b.png` });
      }
      await rlCtx.close();
    }

    // ══ I. error / empty / 404 states ═════════════════════════════════════
    section("I. error + empty states");
    const missRes = await http(`/no-such-route-${STAMP}`);
    if (missRes.status === 404) ok("an unknown route answers 404");
    else fail("404 status", `expected 404, got ${missRes.status}`);
    await page.goto(`${BASE}/no-such-route-${STAMP}`, { waitUntil: "networkidle0" });
    const notFoundLinks = await page.evaluate(() =>
      [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    );
    if (["/dashboard", "/tasks", "/projects"].every((h) => notFoundLinks.includes(h))) {
      ok("the 404 page offers the three recovery links");
    } else {
      fail("404 recovery links", JSON.stringify(notFoundLinks));
    }
    await page.screenshot({ path: `${OUT}/${STAMP}-404.png` });

    const offlineRes = await http("/offline");
    if (offlineRes.status === 200) ok("/offline is reachable without a session");
    else fail("/offline public", `status ${offlineRes.status} — the PWA fallback needs no-session access`);

    // Walk the app shell so any CSP violation has a chance to fire.
    for (const p of ["/dashboard", "/chat", "/settings", "/reports"]) {
      await page.goto(`${BASE}${p}`, { waitUntil: "networkidle0", timeout: 60000 }).catch(() => {});
    }
    if (csp.length === 0) ok("no CSP violations reported across the app shell");
    else fail("CSP violations", csp.slice(0, 5).join(" | "));
  } catch (err) {
    fail("run threw", err.message);
  } finally {
    // ── cleanup: my tenant only, children before parents ─────────────────
    try {
      if (myCompanyId) {
        const guard = await db.company.findUnique({
          where: { id: myCompanyId },
          select: { id: true, name: true },
        });
        if (!guard) {
          note("nothing to clean up");
        } else if (guard.name !== TENANT) {
          fail("cleanup refused", `company ${myCompanyId} is named "${guard.name}", not "${TENANT}" — refusing to delete data this run did not create`);
        } else {
          const where = { where: { companyId: myCompanyId } };
          await db.messageReaction.deleteMany({ where: { message: { companyId: myCompanyId } } });
          await db.message.deleteMany(where);
          await db.channelMember.deleteMany({ where: { channel: { companyId: myCompanyId } } });
          await db.channel.deleteMany(where);
          await db.comment.deleteMany(where);
          await db.timeEntry.deleteMany(where);
          await db.notification.deleteMany(where);
          await db.activity.deleteMany(where);
          await db.inviteToken.deleteMany(where);
          await db.recurringRule.deleteMany(where);
          await db.budget.deleteMany(where);
          await db.transaction.deleteMany(where);
          await db.task.deleteMany(where);
          await db.project.deleteMany(where);
          await db.notificationPreference.deleteMany({ where: { user: { companyId: myCompanyId } } });
          await db.pushSubscription.deleteMany({ where: { user: { companyId: myCompanyId } } });
          await db.company.update({ where: { id: myCompanyId }, data: { ownerId: null } });
          await db.user.deleteMany(where);
          await db.company.delete({ where: { id: myCompanyId } });
          note(`cleaned up ${TENANT}`);
        }
      }
    } catch (e) {
      fail("cleanup failed", e.message);
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(process.exitCode ? "\n== FAIL ❌ ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("qa-production-readiness threw:", err);
  process.exit(1);
});
