/*
 * Go-live QA — domain: auth-and-sessions (AGENT_INDEX 1).
 *
 * WHAT THIS EXERCISES
 *   /signup, /login, /forgot-password, /reset-password, /verify-email,
 *   /verify-email-change, /invite/[token], /offline, and the session layer
 *   (lib/auth.ts, auth.config.ts, middleware.ts, lib/auth/session-version.ts,
 *   and the three stateless-token modules under lib/auth/).
 *
 * DATA SAFETY — the hardest constraint in this audit.
 *   This script signs its OWN workspace up through the real signup form and
 *   never touches a pre-existing row. Every database assertion carries
 *   `where: { companyId: TENANT.companyId }` (or `{ id: <one of my own ids> }`)
 *   so a concurrent agent's insert can never satisfy a "did mine land?" check
 *   and produce a FALSE PASS. The `finally` block removes the tenant,
 *   children before parents.
 *
 *   This script writes outside the browser in exactly three places, all of
 *   them rows it created itself and all of them restored:
 *     - an InviteToken it back-dates, to exercise the expired-invite page;
 *     - its OWN Company.deletedAt, to ask whether a pending invite into a
 *       tombstoned workspace is still claimable (restored immediately);
 *     - its OWN invited member's deletedAt, to walk the three doors a
 *       customer tries after deleting their account (restored immediately).
 *   Nothing seeded is written, and nothing seeded is asserted on.
 *
 * TOKEN MINTING, AND WHY IT IS LEGITIMATE.
 *   Password-reset / email-verification / email-change links are stateless
 *   JWS blobs signed with AUTH_SECRET; locally SMTP is unconfigured, so they
 *   are only written to the server console, which a driver cannot read.
 *   Rather than skip every token path, this script re-derives the SAME tokens
 *   the product would have emailed, with `jose` and the local AUTH_SECRET, for
 *   its OWN user rows only. `pv` is sha256(passwordHash).slice(0,16) — exactly
 *   what lib/auth/password-reset-token.ts computes.
 *
 * CONVENTIONS
 *   - localDb() only. `new PrismaClient()` auto-loads the root .env, which
 *     points at PRODUCTION Supabase (tests/lib/db/script-safety.test.ts).
 *   - fail() records and prints a literal ❌ but never throws, so one run
 *     reports every broken assertion.
 *   - x-real-ip is set on every context before its first navigation. NOT because
 *     of a shared "unknown" bucket any more: sec-001 removed that fallback, and
 *     lib/client-ip.ts now returns UNTRUSTED_CLIENT_IP, which ipBucketKey()
 *     degrades to a PER-ACCOUNT key rather than one global 5/60s bucket nine
 *     agents share. The header is set so each agent gets its own per-address
 *     budget instead of every agent's probes piling onto the same account keys,
 *     and so the two classes that have NO account to fall back on
 *     (`tokenRedeem`, `invitePageView`) are exercised at all — both of those
 *     fail OPEN when no trusted address is supplied. Every probe that
 *     deliberately BURNS a bucket uses its own suffixed key, so it can never
 *     starve the rest of this run.
 *   - The same rule applies to the per-ACCOUNT failure bucket, which is the one
 *     that bites harder: a suffixed x-real-ip does nothing for it, because it is
 *     keyed on the EMAIL. So a probe that deliberately spends failures spends
 *     BURN_EMAIL's ten, not the founder's — see the comment on that constant.
 *   - No fixed setTimeout for state; waitUntil() polls a predicate. The only
 *     fixed waits are the 1200-1500ms pre-hydration pauses copied from
 *     scripts/smoke-chat.mjs (FaultsAudit A14) — those wait for React to own
 *     the click, which no DOM predicate can report.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import puppeteer from "puppeteer-core";
import { SignJWT } from "jose";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const AGENT_INDEX = 1;
const IP = `10.99.0.${AGENT_INDEX}`;
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/auth-and-sessions";
const STAMP = `${Date.now().toString().slice(-7)}${randomBytes(2).toString("hex")}`;

const COMPANY_NAME = `qa-auth-${STAMP}`;
const ADMIN_EMAIL = `qa-auth-${STAMP}@founderflow.test`;
const ADMIN_PW = "QaAudit1Pass";
const ADMIN_PW_2 = "QaAudit2Reset";
/**
 * The address the deliberate per-IP burns in section 4 spend, and nothing else.
 *
 * WHY IT EXISTS. `limiters.credentialsEmail` gives each ADDRESS ten failures per
 * fifteen minutes, and that bucket is CHECKED before bcrypt — so an empty one
 * refuses the CORRECT password too. Section 4b's throttle probe used to make its
 * wrong guesses at ADMIN_EMAIL, which put the founder's account at 8 of 10
 * before section 5 had started; signIn()'s three hydration retries then took it
 * to the ceiling and sections 5 and 6 reported "new password does not sign in"
 * and "stuck tab cannot recover" — two failures about the password reset, caused
 * entirely by a timing probe.
 *
 * WHY IT COSTS THE PROBE NOTHING. 4b and 4c assert on the per-IP bucket, and
 * `ipBucketKey(ip, email)` returns the address verbatim whenever the client
 * address is trusted (it is here: x-real-ip is set on every context), so the
 * email does not enter that bucket's key at all. Burning an address with no row
 * spends exactly the same per-IP budget, down the same authorize() path, and
 * pays the same bcrypt against ABSENT_ACCOUNT_PASSWORD_HASH.
 *
 * Pinned by tests/lib/auth/login-throttle.test.ts, "leaves the founder enough
 * failure budget for the sign-ins that follow it", which reads the address out
 * of THIS file and replays the run through the real limiter.
 */
const BURN_EMAIL = `qa-auth-burn-${STAMP}@founderflow.test`;
const MEMBER_EMAIL = `qa-auth-member-${STAMP}@founderflow.test`;
const MEMBER_PW = "QaAudit1Member";
const NEW_EMAIL_B = `qa-auth-b-${STAMP}@founderflow.test`;
const NEW_EMAIL_C = `qa-auth-c-${STAMP}@founderflow.test`;
const HYDRATE_MS = 1500; // A14: the window before React owns the submit button

mkdirSync(OUT, { recursive: true });

// Pinned to the local docker Postgres. See scripts/_local-db.mjs.
const db = localDb();

/* ───────────────────────── reporting ───────────────────────── */

let passes = 0;
const failures = [];

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
function section(title) {
  console.log(`\n── ${title} ──`);
}

/* ───────────────────────── waiting ───────────────────────── */

/**
 * Poll a (possibly async) predicate until it is truthy. Fixed sleeps are the
 * number-one source of false failures under nine-agent load; this waits on the
 * state itself and says so honestly when the state never arrives.
 */
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
 * A fresh, cookie-isolated context. `ip` is the rate-limit key the server sees:
 * getClientIp() reads x-real-ip verbatim, so a distinct suffix buys a distinct
 * limiters.auth bucket.
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

/** One login attempt that is EXPECTED to fail; returns the visible page text. */
async function attemptLogin(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.waitForSelector("input[type=email]", { timeout: 30000 });
  await pause(HYDRATE_MS);
  await page.type("input[type=email]", email);
  await page.type("input[type=password]", password);
  await page.click("button[type=submit]");
  const text = await waitUntil(
    async () => {
      const t = await bodyText(page);
      return /invalid email or password|too many requests|couldn't sign you in/i.test(t)
        ? t
        : false;
    },
    { timeout: 20000, label: "login rejection toast" }
  );
  return text ?? (await bodyText(page));
}

/** Click the first button/link/option-ish element whose text matches. */
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

/** Replace a controlled input's value without leaving the old text behind. */
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

/* ───────────────────────── token minting ───────────────────────── */

function readEnvLocal(key) {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
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

const AUTH_SECRET = readEnvLocal("AUTH_SECRET");
const secretBytes = (s) => new TextEncoder().encode(s);

/** Mirrors passwordVersion() in lib/auth/password-reset-token.ts exactly. */
const passwordVersion = (hash) => createHash("sha256").update(hash).digest("hex").slice(0, 16);

async function mintToken(claims, { ttl = "900s", secret = AUTH_SECRET } = {}) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secretBytes(secret));
}
const resetToken = (userId, pv, ttl = "900s") =>
  mintToken({ sub: userId, purpose: "password-reset", pv }, { ttl });
const verifyToken = (userId, ttl = "7d") =>
  mintToken({ sub: userId, purpose: "email-verification" }, { ttl });
const changeToken = (userId, newEmail, ttl = "3600s") =>
  mintToken({ sub: userId, newEmail, purpose: "email-change" }, { ttl });

/* ───────────────────────── tenant state ───────────────────────── */

const TENANT = { companyId: null, adminId: null, memberId: null };

/** Every read below is scoped to THIS tenant. Never a bare count(). */
const myUsers = (where = {}) =>
  db.user.findMany({
    where: { companyId: TENANT.companyId, ...where },
    orderBy: { createdAt: "asc" },
  });
const myAdmin = () => db.user.findUnique({ where: { id: TENANT.adminId } });
const myMember = () => db.user.findUnique({ where: { id: TENANT.memberId } });

/* ═══════════════════════════ main ═══════════════════════════ */

async function main() {
  if (!AUTH_SECRET) {
    fail(
      "AUTH_SECRET readable from .env.local",
      "every token-path check below is inert without it"
    );
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log(`== qa auth-and-sessions == tenant ${COMPANY_NAME} @ ${IP}`);

  let backdatedInviteId = null;
  let adminCtx = null;
  let admin = null;
  let teamCtx = null;
  let team = null;
  let teamSignedIn = false;
  let seCtx = null;
  let settings = null;
  let generalChannel = null;

  /* Declared here (not inside a section) because later sections reuse them. */

  /** Drive /reset-password?token=… to a verdict. */
  async function submitReset(token, password, ipKey) {
    const { ctx, page } = await newCtx(browser, ipKey);
    await page.goto(`${BASE}/reset-password?token=${encodeURIComponent(token)}`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    const hasForm = await waitUntil(() => page.$('input[type="password"]'), {
      timeout: 15000,
      label: "reset form",
    });
    if (!hasForm) {
      const t = await bodyText(page);
      await shut(page, ctx);
      return { rendered: false, text: t };
    }
    await pause(HYDRATE_MS);
    await page.type('input[type="password"]', password);
    await page.click("button[type=submit]");
    const t = await waitUntil(
      async () => {
        const body = await bodyText(page);
        return /expired|invalid|already been used|no longer exists|couldn't reset|sign in|updated|set/i.test(
          body
        )
          ? body
          : false;
      },
      { timeout: 25000, label: "reset outcome" }
    );
    await page.screenshot({ path: `${OUT}/05-reset-${ipKey.split("-").pop()}.png` });
    await shut(page, ctx);
    return { rendered: true, text: t ?? "" };
  }

  /**
   * Open a token-landing page (/verify-email, /verify-email-change) and read it.
   *
   * THE TWO PAGES NO LONGER BEHAVE THE SAME, and this helper has to know it
   * (auth-015). `/verify-email` still applies on load: confirming an address
   * only records that the mailbox received our token, which stays true when a
   * scanner inside that mailbox's own delivery path follows the link.
   * `/verify-email-change` now waits for a click, because that link MOVES the
   * address /forgot-password delivers to, so a mail scanner fetching it used to
   * complete the change on the customer's behalf.
   *
   * So this function clicks, for that path only. It must, and not merely to
   * avoid a false failure: `confirm` used to sit in the outcome alternation
   * below, so `waitUntil` returned the instant the PRE-CLICK card painted and
   * the helper reported success having submitted nothing. The email-change
   * replay check further down this file then found the login address unmoved —
   * which is exactly what a working `bv` binding looks like — and printed a
   * green `ok()` with no evidence behind it. A false failure announces itself;
   * a false pass reads as reassurance, which is why `confirm` is gone from the
   * alternation rather than left in as a convenience.
   */
  async function openTokenPage(path, token, ipKey) {
    const { ctx, page } = await newCtx(browser, ipKey);
    await page.goto(`${BASE}${path}?token=${encodeURIComponent(token)}`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    if (path === "/verify-email-change") {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) =>
          /confirm/i.test(x.textContent ?? "")
        );
        if (b) b.click();
      });
    }
    const t = await waitUntil(
      async () => {
        const body = await bodyText(page);
        return /verified|expired|invalid|malformed|no longer exists|updated|changed|in use/i.test(
          body
        )
          ? body
          : false;
      },
      { timeout: 25000, label: `${path} outcome` }
    );
    await page.screenshot({ path: `${OUT}/token-${ipKey.split("-").pop()}.png` });
    await shut(page, ctx);
    return t ?? "";
  }

  try {
    /* ═══ 1. SIGNUP — the two-step form, and the first-run state it leaves ═══ */
    section("1. signup (two-step) + first-run state");

    ({ ctx: adminCtx, page: admin } = await newCtx(browser));
    await admin.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector('input[name="email"]', { timeout: 30000 });
    await pause(HYDRATE_MS);

    // Step 1 must gate on its own three fields and nothing else.
    await clickByText(admin, /continue/);
    const stillStep1 = await waitUntil(
      async () =>
        /required|valid email|at least 8|lowercase|uppercase|digit/i.test(await bodyText(admin)),
      { timeout: 6000, label: "step-1 validation" }
    );
    if (stillStep1) ok("signup step 1 refuses to advance with empty fields");
    else
      fail("signup step-1 validation", "Continue advanced, or surfaced no error, on an empty form");

    await admin.type('input[name="name"]', `QA Auth ${STAMP}`);
    await admin.type('input[name="email"]', ADMIN_EMAIL);
    await admin.type('input[name="password"]', "weakpass"); // no uppercase, no digit
    await clickByText(admin, /continue/);
    const weakRejected = await waitUntil(
      async () => /uppercase|digit|at least 8/i.test(await bodyText(admin)),
      { timeout: 6000, label: "weak-password rejection" }
    );
    if (weakRejected)
      ok("signup rejects a password missing uppercase/digit (shared PasswordSchema)");
    else fail("weak password accepted at signup", "no policy error surfaced");

    await setInput(admin, 'input[name="password"]', ADMIN_PW);
    await clickByText(admin, /continue/);
    const onStep2 = await waitUntil(() => admin.$('input[name="companyName"]'), {
      timeout: 10000,
      label: "signup step 2",
    });
    if (!onStep2) {
      fail("signup step 2 never rendered", "cannot continue — aborting this run");
      await admin.screenshot({ path: `${OUT}/01-signup-stuck.png` });
      return;
    }
    ok("signup advances to step 2 with a compliant password");

    await admin.type('input[name="companyName"]', COMPANY_NAME);
    await admin.click("button[type=submit]");

    const landed = await waitUntil(() => pathOf(admin) !== "/signup" && pathOf(admin) !== "", {
      timeout: 40000,
      label: "signup navigation",
    });
    await admin.screenshot({ path: `${OUT}/01-after-signup.png` });
    if (landed) ok(`signup lands inside the app (${pathOf(admin)})`);
    else fail("signup did not navigate", (await bodyText(admin)).slice(0, 200));

    const company = await db.company.findFirst({ where: { name: COMPANY_NAME } });
    if (!company) {
      fail("workspace row", `no Company named ${COMPANY_NAME} — aborting`);
      return;
    }
    TENANT.companyId = company.id;

    const founders = await myUsers();
    if (founders.length === 1) ok("exactly one user exists in the new workspace");
    else fail("founder count", `expected 1 user in ${TENANT.companyId}, found ${founders.length}`);
    const founder = founders[0];
    if (!founder) return;
    TENANT.adminId = founder.id;

    if (founder.role === "admin") ok("the founder is an admin");
    else fail("founder role", `expected "admin", got "${founder.role}"`);
    if (founder.email === ADMIN_EMAIL) ok("the founder's email is stored lowercased and intact");
    else fail("founder email", `expected ${ADMIN_EMAIL}, got ${founder.email}`);
    if (founder.handle) ok(`the founder got an @mention handle (@${founder.handle})`);
    else
      fail("founder handle is NULL", "the founder is unmentionable in their own workspace (T16)");
    if (founder.emailVerifiedAt === null) ok("a fresh account starts unverified");
    else fail("fresh verification state", `emailVerifiedAt is ${founder.emailVerifiedAt}`);
    if (founder.sessionVersion === 0) ok("a fresh account starts at sessionVersion 0");
    else fail("fresh sessionVersion", String(founder.sessionVersion));
    if (company.ownerId === founder.id) ok("Company.ownerId is back-filled to the founder");
    else fail("Company.ownerId", `expected ${founder.id}, got ${company.ownerId}`);

    generalChannel = await db.channel.findFirst({
      where: { companyId: TENANT.companyId, slug: "general" },
    });
    if (generalChannel) ok("#general is created inside the signup transaction");
    else fail("#general missing", "a workspace committed without its default channel");

    /* ═══ 2. DUPLICATE SIGNUP + the enumeration surface it opens ═══ */
    section("2. duplicate signup + account-enumeration surface");

    const { ctx: dupCtx, page: dup } = await newCtx(browser, `${IP}-dup`);
    await dup.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
    await dup.waitForSelector('input[name="email"]', { timeout: 30000 });
    await pause(HYDRATE_MS);
    await dup.type('input[name="name"]', "QA Dup");
    await dup.type('input[name="email"]', ADMIN_EMAIL.toUpperCase()); // case-folding too
    await dup.type('input[name="password"]', ADMIN_PW);
    await clickByText(dup, /continue/);
    await waitUntil(() => dup.$('input[name="companyName"]'), { timeout: 10000 });
    await dup.type('input[name="companyName"]', `qa-auth-dup-${STAMP}`);
    await dup.click("button[type=submit]");
    const dupMsg = await waitUntil(
      async () => {
        const t = await bodyText(dup);
        return /already exists|couldn't create/i.test(t) ? t : false;
      },
      { timeout: 25000, label: "duplicate-signup rejection" }
    );
    const dupCompanies = await db.company.count({ where: { name: `qa-auth-dup-${STAMP}` } });
    if (dupCompanies === 0) ok("a rejected duplicate signup leaves no orphan Company row");
    else
      fail("orphan company on duplicate signup", `${dupCompanies} row(s) survived the rejection`);

    // THE SIGNUP HALF OF auth-011: ACCEPTED, NOT UNNOTICED. This used to fail()
    // the whole run on the message text, permanently, which trains a reader to
    // skim past a red line in a security audit. It is a note() now because
    // re-wording the message DOES NOT CLOSE ANYTHING: a genuine signup ends in
    // `signIn("credentials")` and a redirect to /dashboard
    // (lib/actions/auth.ts, pinned by tests/lib/actions/signup-integrity.test.ts),
    // so "did this address already exist?" is legible from the response SHAPE —
    // session cookie or no session cookie — whatever words are in the body. And
    // the duplicate branch returns before the bcrypt(12) a real signup pays, so
    // it is legible from the latency too. Neutral copy over an unchanged flow
    // would report as fixed and leak exactly as much, while re-breaking acct-001
    // (a user who deleted their own account being told it still exists).
    // Genuinely closing it means signup never granting access until the address
    // is confirmed by email — a product decision with a conversion cost, a Gmail
    // quota cost per probe, and a rewrite of app/signup/page.tsx's success path.
    // Escalated, not silently accepted; see lib/actions/auth.ts at the duplicate
    // check for the full argument. If that decision is taken, turn this back
    // into a fail() as the first step.
    if (dupMsg && /an account with this email already exists/i.test(dupMsg)) {
      note(
        "signup names the reason: this address is already registered (accepted oracle, auth-011)",
        "the unauthenticated response says so outright, at 15 probes per IP per 10 min — accepted " +
          "because the response shape and the latency leak the same fact regardless of wording, so " +
          "only a confirm-before-access signup flow would actually close it"
      );
    } else if (dupMsg && /couldn't create/i.test(dupMsg)) {
      // Not a pass. The waitUntil predicate above accepts this string too, and
      // the old `else if` counted it as "rejected without naming the reason" —
      // a false pass over the exact failure acct-001 warns about: the duplicate
      // lookup missing the row, the INSERT tripping the unique index, and the
      // catch-all answering with a server error.
      fail(
        "duplicate signup answered with the generic server-error fallback",
        `the response was "${dupMsg.slice(0, 120)}" — a duplicate address must be recognised by the ` +
          "lookup in signupAction, not by a P2002 from the unique index landing in the catch-all"
      );
    } else if (dupMsg) {
      ok("duplicate signup is rejected without naming the reason");
    } else {
      fail("duplicate signup", "no rejection surfaced at all");
    }
    await dup.screenshot({ path: `${OUT}/02-duplicate-signup.png` });
    await shut(dup, dupCtx);

    /* ═══ 3. FORGOT-PASSWORD anti-enumeration ═══ */
    section("3. forgot-password anti-enumeration posture");

    async function forgotProbe(email, ipKey) {
      const { ctx, page } = await newCtx(browser, ipKey);
      const bodies = [];
      page.on("response", async (res) => {
        if (res.request().method() !== "POST") return;
        try {
          bodies.push(await res.text());
        } catch {
          /* stream already consumed */
        }
      });
      await page.goto(`${BASE}/forgot-password`, { waitUntil: "networkidle0", timeout: 60000 });
      await page.waitForSelector("input[type=email]", { timeout: 30000 });
      await pause(HYDRATE_MS);
      await page.type("input[type=email]", email);
      const t0 = Date.now();
      await page.click("button[type=submit]");
      await waitUntil(() => bodies.length > 0, {
        timeout: 25000,
        label: "forgot-password response",
      });
      const ms = Date.now() - t0;
      const visible = await bodyText(page);
      await page.screenshot({ path: `${OUT}/03-forgot-${ipKey.split("-").pop()}.png` });
      await shut(page, ctx);
      return { ms, visible, payload: bodies.join("") };
    }

    const known = await forgotProbe(ADMIN_EMAIL, `${IP}-fg1`);
    const unknown = await forgotProbe(`qa-auth-nobody-${STAMP}@founderflow.test`, `${IP}-fg2`);

    const sameScreen =
      /mail|sent|check/i.test(known.visible) && /mail|sent|check/i.test(unknown.visible);
    if (sameScreen) ok("forgot-password shows the identical confirmation for both addresses");
    else
      fail(
        "forgot-password UI differs by account existence",
        `known="${known.visible.slice(0, 110)}" vs unknown="${unknown.visible.slice(0, 110)}"`
      );

    const flagOf = (p) => /"?dispatched"?\s*:?\s*(true|false)/i.exec(p)?.[1];
    const dKnown = flagOf(known.payload);
    const dUnknown = flagOf(unknown.payload);
    if (dKnown !== undefined || dUnknown !== undefined) {
      note(
        "requestPasswordResetAction ships a `dispatched` flag to the client",
        `registered=${dKnown} unregistered=${dUnknown}`
      );
      if (dKnown !== undefined && dKnown !== dUnknown) {
        fail(
          "the reset action's own response reveals whether the account exists",
          `dispatched=${dKnown} for a registered address vs ${dUnknown} for an unregistered one — ` +
            "the same-screen UI is cosmetic; the payload is the oracle"
        );
      } else {
        // Locally GMAIL_USER is unset, so sendEmail() never "delivers" and both
        // branches collapse to false. The field still reaches the client, so the
        // oracle opens the moment SMTP is configured in production.
        note(
          "dispatched matches here ONLY because SMTP is unconfigured on this box",
          "with GMAIL_USER set, a registered address returns dispatched=true and an unregistered one false"
        );
        ok("no dispatched-flag divergence observable on this SMTP-less box");
      }
    } else {
      ok("the reset action's response body carries no account-existence signal");
    }
    note("forgot-password latency", `registered ${known.ms}ms vs unregistered ${unknown.ms}ms`);

    /* ═══ 4. LOGIN: the brute-force control, and whether it can be walked around ═══ */
    section("4. login rate limiting + the /api/auth/callback/credentials path");

    // 4a. THE TIMING ORACLE (auth-011) — AND IT RUNS FIRST, ON PURPOSE.
    //
    //     WHY FIRST. This probe used to sit at the END of this section, on the
    //     `${IP}-burn` context, AFTER 4c had deliberately spent that IP's whole
    //     5-per-60s credential budget on 12 guesses. A throttled attempt returns
    //     from authorize() BEFORE the user lookup — fast for both addresses — so
    //     the two medians converged and this printed "no usable timing split"
    //     while the oracle was wide open. It was a guaranteed false pass, which
    //     is worse than no probe: three fix waves read it as a clean bill.
    //
    //     WHY THE SAMPLE COUNTS ARE SO SMALL, AND THE ARITHMETIC THAT SETS THEM.
    //     One fresh x-real-ip per round, 3 requests each (under the 5/60s per-IP
    //     budget), 3 rounds. Three samples are ample to tell a bcrypt(12)
    //     (~250ms here) from an indexed SELECT (~1ms) — and the cap is not
    //     patience, it is ADMIN_EMAIL's per-ACCOUNT budget, which this probe is
    //     the only thing in section 4 still allowed to touch:
    //
    //       limiters.credentialsEmail = 10 failures / 15 min, CHECKED BEFORE
    //       bcrypt — so an empty bucket refuses the RIGHT password too.
    //         4a (here):   3   one registered sample per round; the two fake
    //                          samples per round go to TIMING_FAKE_EMAIL.
    //         4b:          0   burns BURN_EMAIL instead (it asserts on the
    //                          per-IP bucket, whose key holds no email).
    //         4c:          0   same per-IP key as 4b, already empty, so every
    //                          guess is refused before the account bucket.
    //         section 5:   3   signIn() retries the now-wrong pre-reset password
    //                          up to 3 times (its hydration-race loop).
    //         ────────────────
    //         total:       6   leaving 4, and the two sign-ins that MUST succeed
    //                          — section 5's "the new password signs in" and
    //                          section 6's "recovers the stuck tab" — are inside
    //                          it. At 3 + 5 they were not, and both failed.
    //
    //     Raising the round count spends that headroom. The arithmetic above is
    //     replayed through the real limiter by
    //     tests/lib/auth/login-throttle.test.ts,
    //     "leaves the founder enough failure budget for the sign-ins that follow
    //     it", which reads these numbers out of this file.
    //
    //     The discarded first sample of each round is the warm-up: on a cold dev
    //     server the first POST to /api/auth/callback/credentials pays route
    //     compilation, and charging that to whichever address went first would
    //     manufacture a split out of nothing. It is spent on the UNREGISTERED
    //     address, whose budget nothing else in this run wants.
    //
    //     WHAT IT VERIFIES: lib/auth.ts compares the submitted password against
    //     a constant bcrypt(12) digest (ABSENT_ACCOUNT_PASSWORD_HASH) on the
    //     no-such-user branch, so both answers pay the same bill. The unit half
    //     is tests/lib/auth/login-throttle.test.ts, "credential timing parity for
    //     an address with no row" — and it CANNOT measure time, because bcryptjs
    //     is mocked there. That is the whole reason this probe exists.
    const TIMING_FAKE_EMAIL = `qa-auth-nobody2-${STAMP}@founderflow.test`;
    const timingSamples = { real: [], fake: [] };
    for (let round = 1; round <= 3; round++) {
      const { ctx: tCtx, page: tPage } = await newCtx(browser, `${IP}-t${round}`);
      try {
        await tPage.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
        const pair = await tPage.evaluate(
          async (realEmail, fakeEmail) => {
            const csrf = await (await fetch("/api/auth/csrf")).json();
            async function sample(email) {
              const t0 = performance.now();
              await fetch("/api/auth/callback/credentials", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  csrfToken: csrf.csrfToken,
                  email,
                  password: "timing-probe-Aa1",
                  callbackUrl: "/",
                  json: "true",
                }),
                redirect: "manual",
              }).then((r) => r.text().catch(() => ""));
              return performance.now() - t0;
            }
            await sample(fakeEmail); // warm-up, discarded
            const real = await sample(realEmail);
            const fake = await sample(fakeEmail);
            return { real, fake };
          },
          ADMIN_EMAIL,
          TIMING_FAKE_EMAIL
        );
        timingSamples.real.push(pair.real);
        timingSamples.fake.push(pair.fake);
      } finally {
        await shut(tPage, tCtx);
      }
    }

    const medianMs = (xs) =>
      Math.round(xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
    const tReal = medianMs(timingSamples.real);
    const tFake = medianMs(timingSamples.fake);
    note(
      "credentials timing",
      `registered ${tReal}ms vs unregistered ${tFake}ms (n=${timingSamples.real.length} each)`
    );
    // A bcrypt(12) is ~250ms on this box; an indexed SELECT on a miss is ~1ms.
    // 80ms is the "something expensive happened here" line between them.
    const BCRYPT_FLOOR_MS = 80;
    /* TIMING-VERDICT-START
     * Everything between these two markers is SLICED OUT OF THIS FILE AND
     * EXECUTED by tests/lib/auth/login-throttle.test.ts ("the live timing
     * probe's verdict"), which replays a grid of median pairs — including the
     * unfixed oracle (registered ~250ms, unregistered ~4ms) — through this exact
     * source. That is the only way to unit-test a verdict that lives in a script
     * needing a dev server and a browser, and it is here because the first
     * version of this block reported INCONCLUSIVE on precisely the input it was
     * built to catch.
     *
     * KEEP THE BLOCK SELF-CONTAINED: it may read only `tReal`, `tFake`,
     * `BCRYPT_FLOOR_MS` and `IP`, and may call only `fail()` and `ok()`. Adding
     * a reference to anything else breaks the extraction (the test fails with a
     * ReferenceError naming it, which is the intended signal, not a puzzle).
     */
    const tSlower = Math.max(tReal, tFake);
    const tFaster = Math.min(tReal, tFake);
    // INCONCLUSIVE means "neither answer ran a bcrypt", so the test is on the
    // SLOWER median: if even the dearer of the two is under the floor, no bcrypt
    // happened on either branch and the pair says nothing about parity.
    //
    // THIS WAS `tFaster < 80` AND THAT IS THE ONE INPUT THAT MATTERS. In the
    // unfixed state (registered ~250ms, unregistered ~4ms) the MINIMUM is 4, so
    // the probe took this branch — reporting INCONCLUSIVE on exactly the oracle
    // it was built to detect, and printing a message its own two numbers
    // refuted. A probe that says "inconclusive, go and check something else" on
    // a live finding is worse than no probe.
    //
    // The message cites `tSlower`, the value the condition actually tested, so
    // it cannot be printed beside a median that contradicts it. Pinned by
    // tests/lib/auth/login-throttle.test.ts, "never prints a verdict whose own
    // numbers refute it", which sweeps a grid of median pairs through this
    // block's real source.
    if (tSlower < BCRYPT_FLOOR_MS) {
      fail(
        "the credentials timing probe is inconclusive — not clean",
        `the SLOWER of the two medians is ${tSlower}ms, under the ${BCRYPT_FLOOR_MS}ms floor ` +
          `(registered ${tReal}ms, unregistered ${tFake}ms), so NEITHER answer can have run a ` +
          "bcrypt(12). Either the throttle refused these attempts before the lookup (check that " +
          `nothing above spent the 5/60s budget for ${IP}-t1..t3, or ADMIN_EMAIL's 10/15min ` +
          "per-account budget), or RATE_LIMIT_DISABLED is set. A converged pair of fast answers " +
          "is NOT evidence of parity."
      );
    } else if (tSlower > tFaster * 2 && tSlower - tFaster > 40) {
      fail(
        "login timing reveals whether an email is registered",
        `median ${tReal}ms for a registered address vs ${tFake}ms for an unregistered one — the ` +
          `${tSlower === tReal ? "registered" : "unregistered"} branch is doing bcrypt work the other is ` +
          "not. lib/auth.ts must compare against ABSENT_ACCOUNT_PASSWORD_HASH on the no-such-user branch, " +
          "at the same cost factor bcrypt.hash() uses everywhere else (auth-011)."
      );
    } else {
      ok(
        `no usable timing split between registered and unregistered addresses (${tReal}ms vs ${tFake}ms, ` +
          "both paying a bcrypt)"
      );
    }
    /* TIMING-VERDICT-END */

    const { ctx: burnCtx, page: burn } = await newCtx(browser, `${IP}-burn`);

    // 4b. Prove the limiter is live on this box at all. If RATE_LIMIT_DISABLED
    //     is "true" nothing below means anything, so say so loudly.
    //
    //     BURN_EMAIL, NOT ADMIN_EMAIL, and that is load-bearing rather than
    //     tidy: this loop's five accepted attempts used to spend HALF the
    //     founder's per-account failure budget, which sections 5 and 6 need in
    //     order to sign in at all. See the comment on BURN_EMAIL. The assertion
    //     is unchanged in meaning — it is the per-IP bucket that refuses attempt
    //     6, and its key does not contain the email.
    let burnedAt = null;
    for (let i = 1; i <= 7 && burnedAt === null; i++) {
      const text = await attemptLogin(burn, BURN_EMAIL, "definitely-not-the-password-1A");
      if (/too many requests/i.test(text)) burnedAt = i;
    }
    if (burnedAt !== null) {
      ok(`the login server action throttles after ${burnedAt} attempts from one IP`);
    } else {
      fail(
        "loginAction never throttled",
        "7 wrong-password attempts from one x-real-ip were all accepted — is RATE_LIMIT_DISABLED=true?"
      );
    }
    await burn.screenshot({ path: `${OUT}/04-login-throttled.png` });

    // 4c. The bypass that WAS here (P0 auth-001 / sec-008), now a regression
    //     guard. /api/auth/* is public in auth.config.ts, so the Credentials
    //     callback endpoint is reachable from the SAME IP just locked out of
    //     the /login form. It used to reach bcrypt directly because
    //     authorize() consumed no limiter; fixed 2026-09-26 by gating
    //     authorize() itself (lib/auth.ts -> lib/auth/login-throttle.ts).
    //     These 12 guesses spend the per-IP budget; 4c-ii below is what
    //     actually decides whether the gate is live.
    //
    //     ADMIN_EMAIL HERE, unlike 4b, and deliberately: `stillAnon` below has
    //     to be asked about an address that HAS a row and a password, or "none
    //     of the wrong-password probes established a session" is true by
    //     construction and asserts nothing. It costs the founder's account
    //     budget nothing because 4b has already emptied this per-IP key, so
    //     every one of these is refused before the account bucket is read. In
    //     the one world where that is not true — the per-IP window sliding far
    //     enough for the budget to refill mid-loop — 4c-ii immediately below
    //     fails loudly, so the overspend cannot happen silently.
    //
    //     NOTHING TIMING-SENSITIVE MAY BE ADDED AFTER THIS POINT in section 4:
    //     from here on this context's budget is deliberately empty, so every
    //     answer is fast for every address. That is what made the old placement
    //     of 4a a false pass.
    const attempts = await burn.evaluate(async (email) => {
      const csrf = await (await fetch("/api/auth/csrf")).json();
      const out = [];
      for (let i = 0; i < 12; i++) {
        const body = new URLSearchParams({
          csrfToken: csrf.csrfToken,
          email,
          password: `wrong-guess-${i}-A1`,
          callbackUrl: "/",
          json: "true",
        });
        const r = await fetch("/api/auth/callback/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          redirect: "manual",
        });
        const text = await r.text().catch(() => "");
        // `throttled` is recorded for the log only. It can never be true now:
        // a denied attempt is deliberately indistinguishable from a rejected
        // one (see 4c-ii). Do not assert on it.
        out.push({ status: r.status, throttled: /too many requests/i.test(text) });
      }
      return out;
    }, ADMIN_EMAIL);

    // Nothing above may have actually signed anyone in.
    const stillAnon = await burn.evaluate(async () => {
      const s = await (await fetch("/api/auth/session")).json().catch(() => null);
      return !s || !s.user;
    });
    if (stillAnon) ok("none of the wrong-password probes established a session");
    else fail("a brute-force probe signed in", "a wrong password was accepted");

    // ── 4c-ii. Is the endpoint actually throttled? ────────────────────────
    //
    // WHY NOT GREP FOR "Too many requests": it is absent BY DESIGN, and the
    // old version of this check read that absence as the vulnerability.
    // `authorize()` returns null when the throttle denies, which NextAuth
    // surfaces as the same CredentialsSignin error a wrong password produces.
    // That sameness is deliberate — a distinct "you are throttled" reply on an
    // unauthenticated endpoint is an oracle, telling an attacker their guesses
    // are landing and which addresses are worth spraying. So the response body
    // cannot distinguish a throttled attempt from a rejected one, and any probe
    // that looks for a string there will report a working throttle as a bypass.
    //
    // The discriminator that survives: the budget above is now spent, so POST
    // the CORRECT password from the SAME IP. A password check would accept it.
    // Only a throttle refuses it. No oracle is required and none is leaked.
    //
    // Recovery (that this is a throttle and not a permanent lockout) is proved
    // by unit test instead — tests/lib/auth/login-throttle.test.ts, "is a
    // throttle, not a lockout — per-IP budget refills as the window slides" —
    // rather than by parking this script on a 60-second sleep.
    const correctPwProbe = await burn.evaluate(
      async (email, password) => {
        const csrf = await (await fetch("/api/auth/csrf")).json();
        const r = await fetch("/api/auth/callback/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            csrfToken: csrf.csrfToken,
            email,
            password,
            callbackUrl: "/",
            json: "true",
          }),
          redirect: "manual",
        });
        const status = r.status;
        const session = await (await fetch("/api/auth/session")).json().catch(() => null);
        return { status, signedIn: Boolean(session && session.user) };
      },
      ADMIN_EMAIL,
      ADMIN_PW
    );

    if (correctPwProbe.signedIn) {
      fail(
        "the login rate limit is bypassable — POST /api/auth/callback/credentials is not throttled",
        `12 wrong guesses from ${IP}-burn (already locked out of the /login form) were all served, and a ` +
          `13th request carrying the CORRECT password then SIGNED IN (status ${correctPwProbe.status}). ` +
          "A spent per-IP budget must refuse a valid credential too; accepting one proves the provider " +
          "path consumed no limiter. That gate EXISTS — lib/auth.ts's authorize() calls gateLoginAttempt " +
          "from lib/auth/login-throttle.ts, the choke point both the /login form and this endpoint " +
          "share — so this firing is a regression in it, or the per-IP window refilled mid-loop, not a " +
          "fix that was never written."
      );
      // Do not leave a live session behind for the sections that follow.
      await burn.evaluate(async () => {
        const csrf = await (await fetch("/api/auth/csrf")).json();
        await fetch("/api/auth/signout", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: "/", json: "true" }),
          redirect: "manual",
        }).catch(() => {});
      });
    } else {
      ok(
        "the Credentials callback endpoint is throttled: with the per-IP budget spent, even the CORRECT " +
          `password was refused (status ${correctPwProbe.status}, no session) — ` +
          `${attempts.length} guesses preceded it`
      );
    }

    await shut(burn, burnCtx);

    /* ═══ 5. PASSWORD RESET: TTL, single use, pv binding, cross-purpose ═══ */
    section("5. password reset — TTL, single use, cross-user, cross-purpose");

    const beforeReset = await myAdmin();
    const pv = passwordVersion(beforeReset.passwordHash);

    const expired = await submitReset(
      await resetToken(TENANT.adminId, pv, "-30s"),
      ADMIN_PW_2,
      `${IP}-r1`
    );
    if (/expired/i.test(expired.text))
      ok("an expired reset link is refused with an expiry message");
    else
      fail(
        "expired reset token",
        `expected an "expired" message, got: ${expired.text.slice(0, 160)}`
      );

    const forged = await submitReset(
      await mintToken(
        { sub: TENANT.adminId, purpose: "password-reset", pv },
        { secret: "not-the-real-auth-secret-at-all-0000" }
      ),
      ADMIN_PW_2,
      `${IP}-r2`
    );
    if (/invalid/i.test(forged.text)) ok("a reset token signed with a foreign secret is rejected");
    else fail("forged reset token accepted", forged.text.slice(0, 160));

    const crossPurpose = await submitReset(
      await verifyToken(TENANT.adminId),
      ADMIN_PW_2,
      `${IP}-r3`
    );
    if (/invalid/i.test(crossPurpose.text)) {
      ok("an email-verification token cannot be replayed as a password-reset token");
    } else {
      fail("cross-purpose token replay", crossPurpose.text.slice(0, 160));
    }

    // A stale pv is what an OLD outstanding link looks like after any reset.
    const stalePv = await submitReset(
      await resetToken(
        TENANT.adminId,
        passwordVersion("$2a$12$not.this.accounts.hash.at.all.0000")
      ),
      ADMIN_PW_2,
      `${IP}-r4`
    );
    if (/already been used/i.test(stalePv.text)) {
      ok("a reset link bound to a stale password hash is refused");
    } else {
      fail("stale-pv reset token", stalePv.text.slice(0, 160));
    }

    const midReset = await myAdmin();
    if (midReset.passwordHash === beforeReset.passwordHash) {
      ok("four rejected reset attempts left the password hash untouched");
    } else {
      fail("a rejected reset still wrote", "passwordHash moved after tokens that were all refused");
    }

    // The real thing.
    const good = await submitReset(await resetToken(TENANT.adminId, pv), ADMIN_PW_2, `${IP}-r5`);
    const applied = await waitUntil(
      async () => {
        const u = await myAdmin();
        return u.passwordHash !== beforeReset.passwordHash ? u : false;
      },
      { timeout: 20000, label: "password hash rotation" }
    );
    if (applied) ok("a valid reset link rotates the stored password hash");
    else fail("valid reset did not persist", good.text.slice(0, 200));

    if (applied && applied.sessionVersion === beforeReset.sessionVersion + 1) {
      ok("a password reset bumps sessionVersion in the same UPDATE");
    } else if (applied) {
      fail(
        "reset did not bump sessionVersion",
        `expected ${beforeReset.sessionVersion + 1}, got ${applied.sessionVersion} — every other live session survives`
      );
    }

    // Replay the very same link.
    const replay = await submitReset(
      await resetToken(TENANT.adminId, pv),
      "QaAudit3Replay",
      `${IP}-r6`
    );
    if (/already been used/i.test(replay.text)) {
      ok("the same reset link cannot be used twice (pv rebinding holds)");
    } else {
      fail("reset token replay accepted", replay.text.slice(0, 200));
    }
    const afterReplay = await myAdmin();
    if (applied && afterReplay.passwordHash === applied.passwordHash) {
      ok("the replayed link wrote nothing");
    } else if (applied) {
      fail("replayed reset link wrote a new hash", "single-use enforcement failed");
    }

    // Old password dead, new password alive.
    const { ctx: pw1Ctx, page: pw1 } = await newCtx(browser, `${IP}-pw1`);
    if (!(await signIn(pw1, ADMIN_EMAIL, ADMIN_PW)))
      ok("the pre-reset password no longer signs in");
    else fail("old password still valid after reset", "the reset did not take effect for sign-in");
    await shut(pw1, pw1Ctx);

    const { ctx: pw2Ctx, page: pw2 } = await newCtx(browser, `${IP}-pw2`);
    if (await signIn(pw2, ADMIN_EMAIL, ADMIN_PW_2)) ok("the new password signs in");
    else fail("new password does not sign in", "the reset wrote a hash nobody can use");
    await shut(pw2, pw2Ctx);

    /* ═══ 6. SESSION REVOCATION — what the stale tab actually shows ═══ */
    section("6. session revocation UX (the stale tab)");

    // `admin` has been signed in since step 1; the reset in step 5 bumped
    // sessionVersion out from under it. This is the real-customer shape:
    // "I reset my password on my laptop — what does my phone do now?"
    await admin
      .goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded", timeout: 30000 })
      .catch(() => {});
    const revoked = await waitUntil(
      async () => {
        const p = pathOf(admin);
        const t = await bodyText(admin);
        if (p.startsWith("/login")) return { where: "login" };
        if (/something broke loading this page/i.test(t)) return { where: "error-boundary" };
        if (/loading workspace/i.test(t)) return { where: "loading-spinner" };
        if (t.length > 300 && !/loading/i.test(t)) return { where: "still-authenticated" };
        return false;
      },
      { timeout: 25000, label: "revoked-session landing" }
    );
    await admin.screenshot({ path: `${OUT}/06-revoked-session.png` });
    const where = revoked?.where ?? "indeterminate";
    note("a session whose sessionVersion was bumped lands on", where);
    if (where === "still-authenticated") {
      fail(
        "a revoked session keeps working",
        "sessionVersion was bumped by the password reset and the old cookie still renders app data"
      );
    } else if (where === "login") {
      ok("a revoked session is redirected to /login");
    } else {
      fail(
        "a revoked session dead-ends instead of returning to /login",
        `the tab shows "${where}". Middleware's Edge jwt callback cannot read the DB, so it lets the ` +
          "cryptographically-valid cookie through; the Node callback then returns null and " +
          "requireScopedSession() throws. The stale cookie is never cleared and neither the error " +
          "boundary nor the app shell offers a sign-in link, so the user is stuck until they type /login."
      );
    }
    // Recovery must at least be possible.
    if (await signIn(admin, ADMIN_EMAIL, ADMIN_PW_2)) ok("signing in again recovers the stuck tab");
    else fail("stuck tab cannot recover", "the stale cookie blocks a fresh sign-in");

    /* ═══ 7. EMAIL VERIFICATION — 7-day TTL, idempotence, purpose binding ═══ */
    section("7. email verification");

    const vExpired = await openTokenPage(
      "/verify-email",
      await verifyToken(TENANT.adminId, "-30s"),
      `${IP}-v1`
    );
    if (/expired/i.test(vExpired)) ok("an expired verification link says so");
    else fail("expired verification token", vExpired.slice(0, 160));

    const vWrongPurpose = await openTokenPage(
      "/verify-email",
      await resetToken(TENANT.adminId, pv),
      `${IP}-v2`
    );
    if (/invalid/i.test(vWrongPurpose)) {
      ok("a password-reset token is not accepted as a verification token");
    } else {
      fail("cross-purpose verification replay", vWrongPurpose.slice(0, 160));
    }

    await openTokenPage("/verify-email", await verifyToken(TENANT.adminId), `${IP}-v3`);
    const verified = await waitUntil(
      async () => {
        const u = await myAdmin();
        return u.emailVerifiedAt ? u : false;
      },
      { timeout: 20000, label: "emailVerifiedAt stamp" }
    );
    if (verified) ok("a valid verification link stamps emailVerifiedAt");
    else fail("verification did not persist", "emailVerifiedAt is still NULL");

    // Re-clicking must be idempotent AND must not re-stamp the original time.
    await openTokenPage("/verify-email", await verifyToken(TENANT.adminId), `${IP}-v4`);
    const reVerified = await myAdmin();
    if (verified && reVerified.emailVerifiedAt?.getTime() === verified.emailVerifiedAt?.getTime()) {
      ok("re-clicking the verification link does not overwrite the original timestamp");
    } else if (verified) {
      fail(
        "verification replay re-stamps emailVerifiedAt",
        `${verified.emailVerifiedAt?.toISOString()} → ${reVerified.emailVerifiedAt?.toISOString()}`
      );
    }

    /* ═══ 8. EMAIL CHANGE — deferred swap, replay, session impact ═══ */
    section("8. email change");

    ({ ctx: seCtx, page: settings } = await newCtx(browser, `${IP}-se`));
    const signedForSettings = await signIn(settings, ADMIN_EMAIL, ADMIN_PW_2);
    if (!signedForSettings) {
      fail("could not sign in for the settings checks", "8a skipped");
    } else {
      await settings.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
      if (await clickByText(settings, /change email/)) {
        const field = await waitUntil(() => settings.$('input[type="email"]'), {
          timeout: 10000,
          label: "change-email field",
        });
        if (field) {
          await pause(1200);
          await settings.type('input[type="email"]', NEW_EMAIL_B);
          await clickByText(settings, /send|confirm|change/);
          await waitUntil(
            async () => /sent|check|confirm|already|invalid|exists/i.test(await bodyText(settings)),
            { timeout: 20000, label: "change-email response" }
          );
          await settings.screenshot({ path: `${OUT}/08-change-email-requested.png` });
        }
      } else {
        note(
          "no 'Change email' control on /settings",
          "requesting the change via the UI was skipped"
        );
      }
      const afterRequest = await myAdmin();
      if (afterRequest.email === ADMIN_EMAIL) {
        ok("requesting an email change does NOT move the login email before confirmation");
      } else {
        fail(
          "the login email changed before the new address was proved",
          `email is already ${afterRequest.email} — a typo would lock the customer out`
        );
      }
    }

    // Confirm A → B.
    const beforeSwap = await myAdmin();
    await openTokenPage(
      "/verify-email-change",
      await changeToken(TENANT.adminId, NEW_EMAIL_B),
      `${IP}-c1`
    );
    const swapped = await waitUntil(
      async () => {
        const u = await myAdmin();
        return u.email === NEW_EMAIL_B ? u : false;
      },
      { timeout: 20000, label: "email swap A→B" }
    );
    if (swapped) ok("confirming the link sent to the proposed address applies the swap");
    else fail("email change did not apply", `email is still ${(await myAdmin()).email}`);

    if (swapped?.emailVerifiedAt) ok("the swapped-in address lands already verified");
    else if (swapped) fail("swapped email is unverified", "the clicked link proved that address");

    if (swapped && swapped.sessionVersion === beforeSwap.sessionVersion) {
      fail(
        "changing the login email does not revoke any other session",
        `sessionVersion stayed ${swapped.sessionVersion}. Someone who reaches an unlocked tab can ` +
          "move the login address to their own, and every other session — including the victim's — " +
          "stays alive while the OLD address is never told anything happened"
      );
    } else if (swapped) {
      ok("changing the login email bumps sessionVersion");
    }

    // Swap again B → C, then REPLAY the original A→B link inside its 1h TTL.
    await openTokenPage(
      "/verify-email-change",
      await changeToken(TENANT.adminId, NEW_EMAIL_C),
      `${IP}-c2`
    );
    const swappedC = await waitUntil(
      async () => {
        const u = await myAdmin();
        return u.email === NEW_EMAIL_C ? u : false;
      },
      { timeout: 20000, label: "email swap B→C" }
    );
    if (swappedC) ok("a second email change applies over the first");
    else fail("second email change did not apply", `email is ${(await myAdmin()).email}`);

    const replayText = await openTokenPage(
      "/verify-email-change",
      await changeToken(TENANT.adminId, NEW_EMAIL_B),
      `${IP}-c3`
    );
    const afterReplayEmail = (await myAdmin()).email;
    if (afterReplayEmail === NEW_EMAIL_B) {
      fail(
        "a superseded email-change link silently reverts the login address",
        `after A→B→C, replaying the A→B link within its 1-hour TTL set the login email back to ` +
          `${NEW_EMAIL_B}, so the customer's login address moved under them. The mechanism that is ` +
          `supposed to stop this EXISTS: the token carries a \`bv\` binding digest over ` +
          `{sessionVersion, email, …} and confirmEmailChange bumps sessionVersion in the same UPDATE ` +
          `as the swap (lib/actions/email-change.ts), which both makes the link single-use and kills ` +
          `every other outstanding one. A firing here means that binding check broke, not that it was ` +
          `never written (page said: ${replayText.slice(0, 90)})`
      );
    } else {
      ok("a superseded email-change link no longer applies");
    }

    // Put the account back on an address this script can sign in with.
    if ((await myAdmin()).email !== ADMIN_EMAIL) {
      await openTokenPage(
        "/verify-email-change",
        await changeToken(TENANT.adminId, ADMIN_EMAIL),
        `${IP}-c4`
      );
      await waitUntil(async () => (await myAdmin()).email === ADMIN_EMAIL, {
        timeout: 20000,
        label: "login email restored",
      });
    }

    /* ═══ 9. INVITE — an unauthenticated, metered, single-use token ═════════ */
    section("9. invite lifecycle");

    ({ ctx: teamCtx, page: team } = await newCtx(browser, `${IP}-team`));
    teamSignedIn = await signIn(team, ADMIN_EMAIL, ADMIN_PW_2);
    if (!teamSignedIn) {
      fail("could not sign in to /team", "the invite checks are skipped");
    } else {
      await team.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
      await clickByText(team, /invite member/);
      const inviteForm = await waitUntil(() => team.$('input[name="email"]'), {
        timeout: 15000,
        label: "invite form",
      });
      if (!inviteForm) {
        fail("invite form never opened", "the admin cannot invite anyone");
      } else {
        await pause(1200);
        await team.type('input[name="name"]', `QA Member ${STAMP}`);
        await team.type('input[name="email"]', MEMBER_EMAIL);
        await clickByText(team, /team member/);
        await team.click("button[type=submit]");
        const invite = await waitUntil(
          () =>
            db.inviteToken.findFirst({
              where: { companyId: TENANT.companyId, email: MEMBER_EMAIL, usedAt: null },
            }),
          { timeout: 25000, label: "InviteToken row" }
        );
        await team.screenshot({ path: `${OUT}/09-invite-created.png` });

        if (!invite) {
          fail(
            "invite was not persisted",
            `no InviteToken for ${MEMBER_EMAIL} in ${TENANT.companyId}`
          );
        } else {
          ok("the invite is persisted against this workspace");
          if (invite.role === "member") ok("the chosen role is stored on the token");
          else fail("invite role", `expected "member", got "${invite.role}"`);
          if (invite.token.length >= 32)
            ok(`the invite token carries ${invite.token.length} hex chars`);
          else fail("weak invite token", `${invite.token.length} chars`);
          const ttlDays = Math.round((invite.expiresAt - invite.createdAt) / 86400000);
          if (ttlDays === 7) ok("the invite expires in 7 days");
          else fail("invite TTL", `${ttlDays} days`);

          // 9a. An unknown token must look identical to a dead one.
          const { ctx: fCtx, page: forgedPage } = await newCtx(browser, `${IP}-i1`);
          await forgedPage.goto(`${BASE}/invite/${randomBytes(64).toString("hex")}`, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });
          const forgedBody = await bodyText(forgedPage);
          if (/invalid/i.test(forgedBody)) ok("an unknown invite token renders the invalid state");
          else fail("forged invite token", forgedBody.slice(0, 160));
          await shut(forgedPage, fCtx);

          // 9b. Is an attempt against the invite surface priced? BOTH HALVES ARE
          // METERED as of auth-008, so this probe is now a regression detector
          // rather than a finding:
          //   GET  /invite/<token>   `invitePageView`, 15/min per client address
          //                          (app/invite/[token]/page.tsx, before the
          //                          token lookup — a refused render costs no
          //                          database round trip)
          //   POST acceptInviteAction `tokenRedeem`, 30/min per client address
          //                          (lib/actions/team.ts, before the parse)
          // Separate buckets, deliberately, so a flood of renders can never
          // refuse the submit of somebody who already has the form open.
          //
          // 20 GETs from one address therefore has to trip the 15 valve. What
          // this loop measures is the GET half only — which is the half an
          // attacker would pick, and the half the first fix for auth-008 missed.
          //
          // BOTH CLASSES FAIL OPEN WHERE NO CLIENT ADDRESS IS TRUSTWORTHY
          // (lib/rate-limit.ts returns "allowed, uncounted" rather than pooling
          // every visitor into one bucket an attacker could use to lock everyone
          // out). Trust is declared: with TRUSTED_PROXY_HEADER unset, x-real-ip
          // is read on Vercel and in any non-production NODE_ENV, and NOWHERE
          // else — so on a self-hosted production runtime both gates are a
          // documented no-op. This harness sets x-real-ip per browser context
          // against a dev server, so here the address IS trusted and the gates
          // DO count.
          const { ctx: rlCtx, page: rlPage } = await newCtx(browser, `${IP}-i2`);
          await rlPage.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 60000 });
          const probes = await rlPage.evaluate(async () => {
            const out = [];
            for (let i = 0; i < 20; i++) {
              const r = await fetch(`/invite/${"a".repeat(127)}${i % 10}`, { redirect: "manual" });
              const t = await r.text().catch(() => "");
              out.push({ status: r.status, throttled: /too many requests/i.test(t) });
            }
            return out;
          });
          const inviteThrottled = probes.filter((p) => p.throttled).length;
          if (inviteThrottled === 0) {
            fail(
              "the invite-token surface no longer throttles its GET half",
              `20 consecutive /invite/<128-char> probes from one IP were all served (statuses ` +
                `${[...new Set(probes.map((p) => p.status))].join(",")}), and 20 is past the 15/min ` +
                "`invitePageView` allowance. Both halves of this surface ARE metered — the render on " +
                "`invitePageView` (15/min/address, app/invite/[token]/page.tsx) and the submit on " +
                "`tokenRedeem` (30/min/address, acceptInviteAction) — so an all-served result means " +
                "one of two things, and neither is 'no gate was ever written': either a gate was " +
                "removed, or no trusted client address reached one. Check the second first — both " +
                "classes fail OPEN when `isTrustedIpKey` rejects the key, which is what happens with " +
                "TRUSTED_PROXY_HEADER unset outside Vercel and outside a non-production NODE_ENV. " +
                "This harness supplies x-real-ip per context, so against a dev server it should count"
            );
          } else {
            ok(`the invite GET half throttles — invitePageView rejected ${inviteThrottled}/20`);
          }
          await shut(rlPage, rlCtx);

          // 9c. Accept it for real.
          const { ctx: acceptCtx, page: accept } = await newCtx(browser, `${IP}-i3`);
          await accept.goto(`${BASE}/invite/${invite.token}`, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });
          const acceptForm = await waitUntil(() => accept.$('input[type="password"]'), {
            timeout: 15000,
            label: "accept-invite form",
          });
          if (!acceptForm) {
            fail(
              "the invite page did not render the password form",
              (await bodyText(accept)).slice(0, 200)
            );
          } else {
            const shown = await bodyText(accept);
            if (shown.includes(MEMBER_EMAIL)) ok("the invite page shows the address being claimed");
            else fail("invite page context", "the invitee's own email is not shown");

            await pause(HYDRATE_MS);
            await accept.type('input[type="password"]', MEMBER_PW);
            await accept.click("button[type=submit]");
            const joined = await waitUntil(
              () =>
                db.user.findFirst({
                  where: { companyId: TENANT.companyId, email: MEMBER_EMAIL },
                }),
              { timeout: 30000, label: "invited User row" }
            );
            await accept.screenshot({ path: `${OUT}/09-invite-accepted.png` });

            if (!joined) {
              fail(
                "accepting the invite created no user",
                `nothing for ${MEMBER_EMAIL} in ${TENANT.companyId}`
              );
            } else {
              TENANT.memberId = joined.id;
              ok("accepting the invite creates the teammate");
              if (joined.role === "member") ok("the teammate lands with the invited role");
              else fail("invited role not honoured", `got "${joined.role}"`);
              if (joined.handle) ok(`the teammate got a handle (@${joined.handle})`);
              else fail("invitee handle is NULL", "they are unmentionable in their own workspace");
              if (joined.companyId === TENANT.companyId)
                ok("the teammate lands in the inviting workspace");
              else fail("cross-tenant invite landing", `companyId ${joined.companyId}`);

              const membership = generalChannel
                ? await db.channelMember.findFirst({
                    where: { channelId: generalChannel.id, userId: joined.id },
                  })
                : null;
              if (membership) ok("the teammate is joined to #general by the acceptance");
              else fail("invitee not in #general", "no unread badges, absent from the member list");

              const burnt = await db.inviteToken.findUnique({ where: { id: invite.id } });
              if (burnt?.usedAt) ok("the invite token is burnt on acceptance");
              else fail("invite token not marked used", "the link stays claimable");

              const roster = await myUsers();
              if (roster.length === 2) ok("the workspace now holds exactly two users");
              else fail("roster size", `expected 2 in ${TENANT.companyId}, found ${roster.length}`);
            }
          }
          await shut(accept, acceptCtx);

          // 9d. Replay the burnt link.
          const { ctx: rCtx, page: replayPage } = await newCtx(browser, `${IP}-i4`);
          await replayPage.goto(`${BASE}/invite/${invite.token}`, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });
          const replayBody = await bodyText(replayPage);
          if (/already been used/i.test(replayBody))
            ok("a claimed invite link reports itself used");
          else fail("burnt invite link replay", replayBody.slice(0, 200));
          await replayPage.screenshot({ path: `${OUT}/09-invite-replay.png` });
          await shut(replayPage, rCtx);
        }

        // 9e. An EXPIRED invite — written into THIS tenant only, removed in finally.
        const backdated = await db.inviteToken.create({
          data: {
            token: randomBytes(64).toString("hex"),
            email: `qa-auth-expired-${STAMP}@founderflow.test`,
            name: "QA Expired",
            role: "member",
            companyId: TENANT.companyId,
            invitedBy: TENANT.adminId,
            expiresAt: new Date(Date.now() - 86400000),
          },
        });
        backdatedInviteId = backdated.id;

        const { ctx: eCtx, page: expiredPage } = await newCtx(browser, `${IP}-i5`);
        await expiredPage.goto(`${BASE}/invite/${backdated.token}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        const expiredBody = await bodyText(expiredPage);
        if (/expired/i.test(expiredBody)) ok("an expired invite link renders the expired state");
        else fail("expired invite still offers the form", expiredBody.slice(0, 200));

        // 9f. The same link once the WORKSPACE itself is tombstoned. Both the
        //     write and the restore are against this script's own company, and
        //     the restore also happens unconditionally in `finally`.
        try {
          await db.company.update({
            where: { id: TENANT.companyId },
            data: { deletedAt: new Date() },
          });
          const freshToken = randomBytes(64).toString("hex");
          await db.inviteToken.update({
            where: { id: backdated.id },
            data: { token: freshToken, expiresAt: new Date(Date.now() + 86400000) },
          });
          await expiredPage.goto(`${BASE}/invite/${freshToken}`, {
            waitUntil: "networkidle0",
            timeout: 60000,
          });
          const tombstonedBody = await bodyText(expiredPage);
          const offersForm = !!(await expiredPage.$('input[type="password"]'));
          await expiredPage.screenshot({ path: `${OUT}/09-invite-tombstoned-workspace.png` });
          if (offersForm) {
            fail(
              "a pending invite into a DELETED workspace still offers the join form",
              "neither app/invite/[token]/page.tsx nor acceptInviteAction checks Company.deletedAt, " +
                "so a recipient can set a password and join a workspace that is queued for permanent erasure"
            );
          } else {
            ok("an invite into a tombstoned workspace is refused");
          }
          note("tombstoned-workspace invite page reads", tombstonedBody.slice(0, 110));
        } finally {
          await db.company
            .update({ where: { id: TENANT.companyId }, data: { deletedAt: null } })
            .catch(() => {});
        }
        await shut(expiredPage, eCtx);
      }
    }

    /* ═══ 10. MIDDLEWARE, ROLE GATES, AND ROLE-CHANGE FRESHNESS ═══ */
    section("10. middleware, role gates, role-change freshness");

    // 10a. Anonymous.
    const { ctx: anonCtx, page: anon } = await newCtx(browser, `${IP}-anon`);
    for (const route of ["/dashboard", "/settings", "/team", "/budgets", "/chat"]) {
      await anon
        .goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 })
        .catch(() => {});
      const p = pathOf(anon);
      if (p.startsWith("/login")) ok(`anonymous ${route} → /login`);
      else fail(`anonymous ${route} is reachable`, `landed on ${p}`);
    }

    // The deep link the user actually asked for.
    await anon
      .goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 })
      .catch(() => {});
    const cbUrl = anon.url();
    note("the /login bounce URL", cbUrl.replace(BASE, ""));
    if (/callbackUrl/i.test(cbUrl)) {
      const back = await signIn(anon, ADMIN_EMAIL, ADMIN_PW_2);
      const landedOn = pathOf(anon);
      if (back && landedOn.startsWith("/expenses")) {
        ok("signing in after a bounce returns the user to the page they asked for");
      } else {
        fail(
          "the deep link is dropped on sign-in",
          `middleware preserved callbackUrl but /login hard-navigates to /dashboard, so the user ` +
            `lands on ${landedOn} — every emailed or bookmarked deep link loses its destination ` +
            "the moment a session expires"
        );
      }
    } else {
      note("no callbackUrl on the bounce", "a deep link cannot be restored even in principle");
    }
    await shut(anon, anonCtx);

    // /offline must work with no session at all — it is the PWA fallback.
    const { ctx: offCtx, page: off } = await newCtx(browser, `${IP}-off`);
    await off
      .goto(`${BASE}/offline`, { waitUntil: "networkidle0", timeout: 60000 })
      .catch(() => {});
    if (pathOf(off) === "/offline" && /offline/i.test(await bodyText(off))) {
      ok("/offline renders without a session");
    } else {
      fail("/offline is gated", `landed on ${pathOf(off)}`);
    }
    await shut(off, offCtx);

    // 10b. A signed-in user visiting the public auth pages.
    const { ctx: dupeCtx, page: dupe } = await newCtx(browser, `${IP}-onlogin`);
    if (await signIn(dupe, ADMIN_EMAIL, ADMIN_PW_2)) {
      for (const route of ["/login", "/signup"]) {
        await dupe.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 });
        const p = pathOf(dupe);
        if (p === route) {
          note(`a signed-in user still sees ${route}`, "no redirect to their home route");
        } else {
          ok(`a signed-in user visiting ${route} is redirected to ${p}`);
        }
      }
    }
    await shut(dupe, dupeCtx);

    // 10c. The member's gates, then whether a role change reaches middleware.
    if (TENANT.memberId) {
      const { ctx: memCtx, page: member } = await newCtx(browser, `${IP}-mem`);
      if (!(await signIn(member, MEMBER_EMAIL, MEMBER_PW))) {
        fail(
          "the invited member cannot sign in",
          "the auto-sign-in on accept left an unusable hash"
        );
      } else {
        ok("the invited member can sign in with the password they set");

        const FINANCE = [
          "/dashboard",
          "/expenses",
          "/revenue",
          "/investments",
          "/recurring",
          "/budgets",
          "/reports",
          "/activities",
        ];
        for (const route of FINANCE) {
          await member
            .goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 })
            .catch(() => {});
          const p = pathOf(member);
          const body = await bodyText(member);
          if (p !== route || /not found|404/i.test(body))
            ok(`a member is kept off ${route} (→ ${p})`);
          else fail(`a member reached ${route}`, "a finance surface is exposed to a member");
        }
        await member.goto(`${BASE}/dashboard?ref=newsletter`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        if (member.url().includes("ref=newsletter"))
          ok("the bounce preserves the original querystring");
        else fail("querystring dropped on the member bounce", member.url().replace(BASE, ""));
        await member.screenshot({ path: `${OUT}/10-member-bounced.png` });

        // PROMOTE them through the real /team UI, without them re-authenticating.
        // updateUserRoleAction writes `role` and nothing else — no sessionVersion
        // bump — while middleware reads the role baked into their cookie.
        if (teamSignedIn) {
          await team.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
          const selector = `#role-${TENANT.memberId}`;
          const hasSelect = await waitUntil(() => team.$(selector), {
            timeout: 15000,
            label: "role select on /team",
          });
          if (!hasSelect) {
            note("no role control for the member on /team", "the role-freshness probe is skipped");
          } else {
            await team.select(selector, "cofounder");
            const promoted = await waitUntil(
              async () => {
                const u = await myMember();
                return u.role === "cofounder" ? u : false;
              },
              { timeout: 20000, label: "member promoted to cofounder" }
            );
            if (!promoted) {
              fail(
                "the promotion never landed in the database",
                "updateUserRoleAction rejected it"
              );
            } else {
              ok("the admin's promotion is persisted");
              if (promoted.sessionVersion === 0) {
                note("updateUserRoleAction leaves sessionVersion at 0", "no forced re-auth");
              }
              await member
                .goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 })
                .catch(() => {});
              const p = pathOf(member);
              await member.screenshot({ path: `${OUT}/10-promoted-member.png` });
              if (p === "/dashboard") {
                ok("a promotion takes effect on the promoted user's next navigation");
              } else {
                fail(
                  "a promoted teammate is still locked out of the pages they were just given",
                  `they were promoted to cofounder and /dashboard still bounced them to ${p}. ` +
                    "updateUserRoleAction writes role but never bumps sessionVersion, so middleware " +
                    "keeps reading the stale role in their cookie; they must sign out and back in " +
                    "before the change the admin just made is real to them"
                );
              }

              // And the dangerous direction: demote, then see whether the
              // finance pages are still reachable on the stale cookie.
              await team.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
              await team.select(`#role-${TENANT.memberId}`, "member");
              const demoted = await waitUntil(
                async () => {
                  const u = await myMember();
                  return u.role === "member" ? u : false;
                },
                { timeout: 20000, label: "member demoted back" }
              );
              if (demoted) {
                await member
                  .goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 })
                  .catch(() => {});
                const ep = pathOf(member);
                const ebody = await bodyText(member);
                const leaked = ep === "/expenses" && !/not found|404/i.test(ebody);
                await member.screenshot({ path: `${OUT}/10-demoted-member.png` });
                if (leaked) {
                  fail(
                    "a demoted teammate can still open the finance pages on their old cookie",
                    "/expenses and /dashboard have no RSC role check of their own (only /reports " +
                      "calls canSeeFinances), and the demotion bumped nothing, so middleware keeps " +
                      "honouring the cofounder role in the cookie after the admin revoked it"
                  );
                } else {
                  ok(`a demotion takes effect immediately (/expenses → ${ep})`);
                }
              }
            }
          }
        }
      }
      await shut(member, memCtx);
    }

    /* ═══ 11. WHAT HAPPENS AFTER A USER DELETES THEIR ACCOUNT ═══ */
    section("11. the deleted-account recovery path");

    // Exercised against THIS tenant's own member row: tombstone it, walk the
    // three doors a real customer would try, then restore it.
    if (TENANT.memberId) {
      try {
        await db.user.update({ where: { id: TENANT.memberId }, data: { deletedAt: new Date() } });

        const { ctx: dCtx, page: dead } = await newCtx(browser, `${IP}-dead`);
        if (!(await signIn(dead, MEMBER_EMAIL, MEMBER_PW))) ok("a tombstoned user cannot sign in");
        else fail("a tombstoned user signed in", "deletedAt is not enforced at authorize()");

        // Door 2: sign up again with the same address.
        await dead.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
        await dead.waitForSelector('input[name="email"]', { timeout: 30000 });
        await pause(HYDRATE_MS);
        await dead.type('input[name="name"]', "QA Returning");
        await dead.type('input[name="email"]', MEMBER_EMAIL);
        await dead.type('input[name="password"]', "QaAudit9Return");
        await clickByText(dead, /continue/);
        await waitUntil(() => dead.$('input[name="companyName"]'), { timeout: 10000 });
        await dead.type('input[name="companyName"]', `qa-auth-return-${STAMP}`);
        await dead.click("button[type=submit]");
        const returnMsg = await waitUntil(
          async () => {
            const t = await bodyText(dead);
            return /already exists|couldn't create/i.test(t) || pathOf(dead) !== "/signup"
              ? t
              : false;
          },
          { timeout: 25000, label: "re-signup outcome" }
        );
        await dead.screenshot({ path: `${OUT}/11-resignup.png` });

        const remade = await db.company.findFirst({ where: { name: `qa-auth-return-${STAMP}` } });
        if (remade) {
          ok("a deleted user can sign up again with the same address");
          // Tear down the second tenant right away — it is not TENANT.companyId.
          await db.channelMember
            .deleteMany({ where: { channel: { companyId: remade.id } } })
            .catch(() => {});
          await db.channel.deleteMany({ where: { companyId: remade.id } }).catch(() => {});
          await db.activity.deleteMany({ where: { companyId: remade.id } }).catch(() => {});
          await db.company
            .update({ where: { id: remade.id }, data: { ownerId: null } })
            .catch(() => {});
          await db.user.deleteMany({ where: { companyId: remade.id } }).catch(() => {});
          await db.company.delete({ where: { id: remade.id } }).catch(() => {});
        } else {
          fail(
            "a customer who deletes their account can never come back",
            `signup refuses the address (${/[^\n]*already exists[^\n]*/i.exec(returnMsg || "")?.[0] ?? "already exists"}) ` +
              "because signupAction's uniqueness check does not filter deletedAt, while authorize() " +
              "does — so the address is simultaneously un-signup-able and un-sign-in-able, and " +
              "PURGE_ENABLED defaults to false so the tombstone never ages out"
          );
        }

        // Door 3: "I'll just reset my password then."
        const tombstoned = await myMember();
        const deadReset = await submitReset(
          await resetToken(TENANT.memberId, passwordVersion(tombstoned.passwordHash)),
          "QaAudit9Reset",
          `${IP}-dead2`
        );
        const resetLanded = await myMember();
        if (resetLanded.passwordHash !== tombstoned.passwordHash) {
          fail(
            "password reset reports success for a deleted account that still cannot sign in",
            "requestPasswordResetAction and resetPasswordAction both look the user up with no " +
              "deletedAt filter, so the reset completes and the customer is told their new password " +
              `is set — then /login answers "Invalid email or password" forever (page said: ${deadReset.text.slice(0, 80)})`
          );
        } else {
          ok("password reset refuses a tombstoned account");
        }
        await shut(dead, dCtx);
      } finally {
        await db.user
          .update({ where: { id: TENANT.memberId }, data: { deletedAt: null } })
          .catch(() => {});
      }
    }
  } finally {
    section("cleanup");
    await shut(admin, adminCtx);
    await shut(team, teamCtx);
    await shut(settings, seCtx);
    await browser.close().catch(() => {});

    try {
      if (backdatedInviteId) {
        await db.inviteToken.deleteMany({ where: { id: backdatedInviteId } }).catch(() => {});
      }
      if (TENANT.companyId) {
        const cid = TENANT.companyId;
        // Belt and braces: never leave this tenant tombstoned if 9f threw
        // between its two company.update calls.
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
        console.log(`  cleaned tenant ${COMPANY_NAME} (${cid})`);
      }
    } catch (e) {
      console.error(`  ❌ cleanup failed for ${COMPANY_NAME}:`, e.message);
      process.exitCode = 1;
    }
    await db.$disconnect();
  }
}

await main()
  .catch((err) => {
    console.error("❌ qa-auth-and-sessions threw:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(`\n${passes} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ❌ ${f}`);
    console.log(failures.length ? "\n== FAIL ==" : "\n== pass ==");
  });
