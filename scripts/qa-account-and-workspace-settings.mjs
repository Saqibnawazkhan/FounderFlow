/*
 * QA EXERCISE SCRIPT — domain: account-and-workspace-settings (AGENT_INDEX = 11)
 *
 * Authored in Phase 1 (static). Phase 2 RUNS it; every assertion below exists
 * to promote one Phase-1 `static` finding to `observed`, or to hold a
 * negativeResult honest. The finding id each block proves is named in its
 * header, e.g. [ACCT-003].
 *
 * Surface under test:
 *   /settings in full — profile name, @handle (+ the 3/hour budget), password
 *   change (+ sessionVersion bump + forced sign-out), two-step email change,
 *   appearance, language, the notification-preferences matrix, push toggle,
 *   data export, "Reset local preferences", sign out, and the DANGER ZONE:
 *   lib/actions/account.ts `deleteAccountAction` + `deleteWorkspaceAction`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DATA SAFETY — the hardest rule in this audit.
 *
 * This script never writes a row it did not create. It signs up its OWN
 * workspaces through the real /signup flow; every tenant name starts with
 * `qa-` so scripts/_qa-guard.mjs's sweeper can find it; and EVERY database
 * assertion carries `where: { companyId: <one of MY tenant ids> }` or
 * `where: { id: <one of MY row ids> }`. There is not a single bare
 * `db.X.count()`: under concurrency another agent's insert could satisfy a
 * global "did mine land?" check and produce a FALSE PASS, which is the most
 * expensive outcome in a pre-launch audit.
 *
 * Seeded data (demo-nimbus and anything else that predates this run) is READ
 * NOWHERE and asserted on nowhere. `scripts/_qa-guard.mjs verify` must pass
 * after this script, including its row-content hashes.
 *
 * Direct DB writes this script makes, all to rows IT created, each justified
 * at its call site:
 *   W1. `company.plan/billingSubscriptionId/subscriptionStatus` on my own
 *       tenant D — to give the danger zone a PAID workspace to destroy, which
 *       is the only way to observe that the delete leaves the subscription
 *       running (ACCT-002). Faking the columns is the honest move: driving a
 *       real LemonSqueezy checkout would take money and an external service.
 *   W2. One `task` + one `transaction` + one `budget` + one `message` in my
 *       own tenants — so the tombstone sweep has something to sweep and the
 *       "Reset local preferences" dialog has something it claims to wipe.
 *   W3. One `pushSubscription` row for my own user — to observe that account
 *       deletion leaves the device registration behind (ACCT-008).
 *   W4. Nothing else. No UPDATE, no DELETE outside `myTenants` teardown.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Conventions copied from scripts/smoke-chat.mjs / scripts/qa-team-and-invites.mjs:
 *   - localDb() only. A bare `new PrismaClient()` auto-loads the ROOT .env,
 *     which points at PRODUCTION Supabase.
 *   - ok()/fail() with process.exitCode. fail() NEVER throws, so one run
 *     reports every broken assertion; a literal ❌ is printed so the runner's
 *     summary counts it.
 *   - The retry-until-hydrated signIn helper, verbatim (FaultsAudit A14).
 *   - x-real-ip on every context BEFORE its first navigation. getClientIp()
 *     falls back to the literal "unknown" in dev, so without it all agents
 *     share ONE limiters.auth bucket (5/60s) fed by nine call sites.
 *   - waitForFunction on state predicates, never a fixed setTimeout for
 *     correctness (the two short sleeps that remain are hydration windows
 *     copied verbatim from the reference helpers).
 *   - Per-agent screenshot directory. A shared fixed filename destroys evidence.
 *   - db.$disconnect() in finally; tenant teardown children-before-parents.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SignJWT } from "jose";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/account-and-workspace-settings";
mkdirSync(OUT, { recursive: true });

const STAMP = Date.now().toString().slice(-8);

/**
 * AGENT_INDEX 11 → x-real-ip 10.99.0.11.
 *
 * Distinct SUFFIXES per browser context, inside this agent's own lane. This
 * script performs six signups plus a dozen logins, and both
 * `deleteAccountAction` and `deleteWorkspaceAction` consume `limiters.auth`
 * keyed on the IP (5 per 60s) — one lane could not survive its own test plan.
 * The limiter keys on the raw header string, so `10.99.0.11-d` is a separate
 * bucket that still reads unmistakably as agent 11's.
 */
const IP = (suffix) => (suffix ? `10.99.0.11-${suffix}` : "10.99.0.11");

const db = localDb();

/** Tenant ids this run created. Everything here is torn down in `finally`. */
const myTenants = [];

let passes = 0;
function ok(label) {
  passes += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  ❌  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}

/* ───────────────────────────── helpers ─────────────────────────────────── */

function wire(page, tag) {
  page.on("pageerror", (e) => console.error(`PAGEERROR[${tag}]:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`CONSOLE.error[${tag}]:`, m.text());
  });
}

/** A fresh browser context: own cookie jar, own rate-limit key. */
async function newCtx(browser, tag, ipSuffix) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  wire(page, tag);
  // BEFORE the first navigation, per the audit brief.
  await page.setExtraHTTPHeaders({ "x-real-ip": IP(ipSuffix) });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}-${STAMP}.png`, fullPage: true }).catch(() => {});
}

/**
 * Sign in. Copied verbatim from scripts/smoke-chat.mjs.
 *
 * On a cold dev server the form paints before React hydrates; a click that
 * lands first performs a NATIVE submit, which (the form declares no method)
 * becomes a GET with the credentials in the query string and no sign-in.
 * Retry until React owns the click. Tracked as FaultsAudit A14.
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
      return true;
    }
  }
  return false;
}

/**
 * Create one of THIS AGENT'S tenants through the real /signup flow.
 *
 * companyId is resolved by the OWNER'S EMAIL, never by "the newest company":
 * another agent signing up in the same second would otherwise hand us their
 * tenant id and every later assertion would be scoped to somebody else's data.
 */
async function signUpTenant(page, slug) {
  const companyName = `qa-${slug}-${STAMP}`;
  const email = `qa-${slug}-${STAMP}@founderflow.test`;
  const password = `QaAudit${STAMP}!a`;
  const name = `QA ${slug} ${STAMP}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input[name="name"]', { timeout: 30000 });
    await page
      .waitForFunction(
        () => {
          const b = document.querySelector('form button[type="submit"]');
          return !b || !b.disabled;
        },
        { timeout: 30000 }
      )
      .catch(() => {});

    await page.type('input[name="name"]', name);
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);

    const advanced = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("form button[type=button]")].find((b) =>
        /continue/i.test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!advanced) continue;

    const onStep2 = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('input[name="companyName"]');
          return !!el && el.offsetParent !== null;
        },
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!onStep2) continue;

    await page.type('input[name="companyName"]', companyName);
    await page.click('form button[type="submit"]');

    const landed = await page
      .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (landed) break;
    if (attempt === 3) throw new Error(`signup failed for ${companyName}: ${page.url()}`);
  }

  const owner = await db.user.findUnique({
    where: { email },
    select: { id: true, companyId: true },
  });
  if (!owner) throw new Error(`signup produced no user row for ${email}`);
  myTenants.push(owner.companyId);
  return { companyId: owner.companyId, userId: owner.id, email, password, companyName, name };
}

/** Land on /settings and wait for the page's own sections, not a clock. */
async function gotoSettings(page) {
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(() => /Danger zone|ناقابل/i.test(document.body.innerText), { timeout: 30000 })
    .catch(() => {});
}

const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** Click the first <button> whose visible text matches `re`. */
async function clickButton(page, re, scope = "body") {
  return page.evaluate(
    ({ pattern, sel }) => {
      const root = document.querySelector(sel) ?? document.body;
      const btn = [...root.querySelectorAll("button")].find((b) =>
        new RegExp(pattern, "i").test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    { pattern: re.source ?? String(re), sel: scope }
  );
}

/** React-safe value set (RHF ignores a naive el.value = x). */
async function setInput(page, selector, value) {
  return page.evaluate(
    ({ sel, v }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { sel: selector, v: value }
  );
}

/** Text of every live toast currently on screen. */
const toastsOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="status"],[role="alert"]')].map((t) => t.innerText).join(" | ")
  );

async function waitForToast(page, timeout = 20000) {
  await page
    .waitForFunction(
      () => document.querySelectorAll('[role="status"],[role="alert"]').length > 0,
      { timeout }
    )
    .catch(() => {});
  return toastsOf(page);
}

/** Wait until every toast has faded, so the next read can't see a stale one. */
async function drainToasts(page) {
  await page
    .waitForFunction(
      () => document.querySelectorAll('[role="status"],[role="alert"]').length === 0,
      { timeout: 8000 }
    )
    .catch(() => {});
}

/** The confirm dialog's own text + the two button labels it is offering. */
async function readConfirmDialog(page) {
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 }).catch(() => {});
  return page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    return {
      text: d.innerText,
      buttons: [...d.querySelectorAll("button")].map((b) => b.textContent.trim()),
      inputs: [...d.querySelectorAll("input")].map((i) => i.type),
    };
  });
}

async function closeDialog(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 8000 })
    .catch(() => {});
}

/** AUTH_SECRET out of .env.local — never process.env, never the root .env. */
function authSecret() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (key !== "AUTH_SECRET" && key !== "NEXTAUTH_SECRET") continue;
    return t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * Mint an email-change token for MY OWN user, exactly as
 * lib/auth/email-change-token.ts does.
 *
 * WHY FORGE IT INSTEAD OF READING THE EMAIL. In dev `sendEmail()` logs the
 * link to the SERVER console, which this process cannot read. Signing the same
 * payload with the same secret exercises the same code path on the way in
 * (`verifyEmailChangeToken`) and is the only way to observe what the token
 * survives. It is minted for a user THIS SCRIPT created, for an address in my
 * own `qa-` namespace, and it is what makes [ACCT-004] observable.
 */
async function mintEmailChangeToken(userId, newEmail) {
  const secret = authSecret();
  if (!secret) return null;
  return new SignJWT({ sub: userId, newEmail, purpose: "email-change" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("3600s")
    .sign(new TextEncoder().encode(secret));
}

/** Tombstone snapshot for ONE of my tenants. Every clause is companyId-scoped. */
async function tombstoneShape(companyId) {
  const [
    company,
    usersLive,
    usersDead,
    tasksLive,
    txnsLive,
    budgetsLive,
    projectsLive,
    messagesLive,
    commentsAll,
    timeAll,
    activityAll,
    notifAll,
    invitesUnused,
    channelsAll,
  ] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { deletedAt: true, plan: true, subscriptionStatus: true, billingSubscriptionId: true },
    }),
    db.user.count({ where: { companyId, deletedAt: null } }),
    db.user.count({ where: { companyId, deletedAt: { not: null } } }),
    db.task.count({ where: { companyId, deletedAt: null } }),
    db.transaction.count({ where: { companyId, deletedAt: null } }),
    db.budget.count({ where: { companyId, deletedAt: null } }),
    db.project.count({ where: { companyId, deletedAt: null } }),
    db.message.count({ where: { companyId, deletedAt: null } }),
    db.comment.count({ where: { companyId } }),
    db.timeEntry.count({ where: { companyId } }),
    db.activity.count({ where: { companyId } }),
    db.notification.count({ where: { companyId } }),
    db.inviteToken.count({ where: { companyId, usedAt: null } }),
    db.channel.count({ where: { companyId } }),
  ]);
  return {
    companyDeletedAt: company?.deletedAt ?? null,
    plan: company?.plan ?? null,
    subscriptionStatus: company?.subscriptionStatus ?? null,
    billingSubscriptionId: company?.billingSubscriptionId ?? null,
    usersLive,
    usersDead,
    tasksLive,
    txnsLive,
    budgetsLive,
    projectsLive,
    messagesLive,
    commentsAll,
    timeAll,
    activityAll,
    notifAll,
    invitesUnused,
    channelsAll,
  };
}

/**
 * Seed one row of each tombstone-bearing kind into MY OWN tenant (W2).
 *
 * Written straight to the DB rather than driven through nine UIs: this is
 * scaffolding, not the thing under test, and every row carries my tenant's
 * companyId. Field names mirror prisma/schema.prisma exactly (the denormalized
 * *Name columns are required).
 */
async function seedMyTenantContent(t) {
  const project = await db.project.create({
    data: {
      companyId: t.companyId,
      name: `qa-proj-${STAMP}`,
      status: "active",
      supervisorId: t.userId,
      createdBy: t.userId,
    },
  });
  const task = await db.task.create({
    data: {
      companyId: t.companyId,
      projectId: project.id,
      title: `qa-task-${STAMP}`,
      description: "QA audit fixture",
      status: "pending",
      priority: "medium",
      assignedTo: t.userId,
      assignedToName: t.name,
      assignedBy: t.userId,
      assignedByName: t.name,
      deadline: new Date(Date.now() + 7 * 864e5),
    },
  });
  await db.transaction.create({
    data: {
      companyId: t.companyId,
      type: "expense",
      category: "Other",
      amount: "12.34",
      description: `qa-txn-${STAMP}`,
      date: new Date(),
      addedBy: t.userId,
      addedByName: t.name,
      projectId: project.id,
    },
  });
  await db.budget.create({
    data: {
      companyId: t.companyId,
      projectId: project.id,
      category: "Other",
      monthlyLimit: "100.00",
      createdBy: t.userId,
      createdByName: t.name,
    },
  });
  const channel = await db.channel.findFirst({
    where: { companyId: t.companyId },
    select: { id: true },
  });
  if (channel) {
    await db.message.create({
      data: {
        companyId: t.companyId,
        channelId: channel.id,
        authorId: t.userId,
        authorName: t.name,
        body: `qa-msg-${STAMP}`,
      },
    });
  } else {
    note(`no #general in ${t.companyName} — Message tombstone assertions will read 0`);
  }
  await db.comment.create({
    data: {
      companyId: t.companyId,
      body: `qa-comment-${STAMP}`,
      authorId: t.userId,
      authorName: t.name,
      taskId: task.id,
    },
  });
  await db.timeEntry.create({
    data: {
      companyId: t.companyId,
      userId: t.userId,
      userName: t.name,
      projectId: project.id,
      taskId: task.id,
      clockInAt: new Date(Date.now() - 3600_000),
      clockOutAt: new Date(),
    },
  });
  return { projectId: project.id, taskId: task.id };
}

/* ═══════════════════════════════════ main ═════════════════════════════════ */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*"],
  });

  console.log("\n== qa-account-and-workspace-settings (agent 11) ==\n");

  try {
    /* ══ BLOCK 1 — /settings renders, admin view ═════════════════════════ */
    console.log("-- block 1: admin /settings surface --");
    const a = await newCtx(browser, "admin-A", "a");
    const A = await signUpTenant(a.page, "acct-a");
    note(`tenant A = ${A.companyName} (${A.companyId})`);
    await seedMyTenantContent(A);

    await gotoSettings(a.page);
    await shot(a.page, "01-admin-settings");
    const adminText = await bodyText(a.page);
    for (const section of [
      "Profile",
      "Handle",
      "Company",
      "Plan & billing",
      "Notifications",
      "Appearance",
      "Language",
      "Data & storage",
      "Sign out",
      "Danger zone",
    ]) {
      if (adminText.includes(section)) ok(`admin /settings shows "${section}"`);
      else fail(`admin /settings shows "${section}"`, "section missing");
    }
    if (adminText.includes("Delete this workspace")) ok("admin sees the workspace-delete row");
    else fail("admin sees the workspace-delete row", "missing");

    /* ══ BLOCK 2 — profile name change vs. the chrome [ACCT-006] ════════ */
    console.log("\n-- block 2: profile name change --");
    const newName = `QA Renamed ${STAMP}`;
    await clickButton(a.page, /Edit profile/i);
    await a.page.waitForSelector('[role="dialog"] input', { timeout: 15000 });
    await setInput(a.page, '[role="dialog"] input', newName);
    await a.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await waitForToast(a.page);

    const renamed = await db.user.findUnique({
      where: { id: A.userId },
      select: { name: true, email: true },
    });
    if (renamed?.name === newName) ok("[persistence] DB User.name holds the new name");
    else fail("[persistence] DB User.name", `expected ${newName}, got ${renamed?.name}`);

    // [ACCT-006] the topbar/sidebar identity comes from the JWT + Zustand, and
    // the jwt callback refreshes role/companyId but NOT name. Expect the OLD
    // name still on screen outside the server-rendered /settings body.
    await a.page.reload({ waitUntil: "networkidle0" });
    await gotoSettings(a.page);
    const chrome = await a.page.evaluate(() => {
      const t = document.querySelector("header")?.innerText ?? "";
      const s = document.querySelector("aside")?.innerText ?? "";
      return `${t}\n${s}`;
    });
    await shot(a.page, "02-after-rename");
    if (chrome.includes(A.name) && !chrome.includes(newName)) {
      fail(
        "[ACCT-006] chrome shows the new name after rename",
        `chrome still renders the pre-rename name "${A.name}" — session token name is never refreshed`
      );
    } else if (chrome.includes(newName)) {
      ok("[ACCT-006 NEGATIVE] chrome picked up the new name (finding does not reproduce)");
    } else {
      note("[ACCT-006] chrome rendered neither name — inspect 02-after-rename screenshot");
    }

    /* ══ BLOCK 3 — handle: validation, uniqueness, 3/hour budget ════════ */
    console.log("\n-- block 3: @handle --");
    const handleInput = "input[placeholder='ali-khan'], input[placeholder='Loading…']";
    await a.page.waitForSelector(handleInput, { timeout: 20000 }).catch(() => {});
    // The field fetches its own value on mount (getMyHandleAction).
    await a.page
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !!el && !el.disabled;
        },
        { timeout: 20000 },
        "input[autocapitalize='none']"
      )
      .catch(() => {});

    async function saveHandle(value) {
      await setInput(a.page, "input[autocapitalize='none']", value);
      await drainToasts(a.page);
      const clicked = await clickButton(a.page, /Save handle/i);
      if (!clicked) return { clicked: false, toast: "", inline: "" };
      const toast = await waitForToast(a.page, 15000);
      const inline = await a.page.evaluate(() => {
        const el = [...document.querySelectorAll("p")].find((p) => p.id?.endsWith("-err"));
        return el?.innerText ?? "";
      });
      return { clicked: true, toast, inline };
    }

    // 3a. invalid shape is refused client-side (leading digit).
    const bad = await saveHandle("2024ali");
    if (/lowercase letters|Start with a letter/i.test(`${bad.toast} ${bad.inline}`)) {
      ok("[validation] handle starting with a digit is refused");
    } else {
      fail("[validation] handle starting with a digit", `no rejection: ${bad.toast}|${bad.inline}`);
    }

    // 3b. happy path.
    const h1 = `qa${STAMP}a`;
    const good = await saveHandle(h1);
    const handleRow = await db.user.findUnique({ where: { id: A.userId }, select: { handle: true } });
    if (handleRow?.handle === h1) ok("[persistence] handle saved to my own User row");
    else fail("[persistence] handle saved", `expected ${h1}, got ${handleRow?.handle} (${good.toast})`);

    // 3c. the 3/hour budget. Changes 2, 3 and 4 in this hour; the 4th must be
    //     refused by `handleLimiter`, NOT by limiters.write.
    let limiterTripped = false;
    let limiterMessage = "";
    for (let i = 2; i <= 5; i++) {
      const r = await saveHandle(`qa${STAMP}${String.fromCharCode(96 + i)}`);
      const msg = `${r.toast} ${r.inline}`;
      if (/Too many requests|changed your handle a few times/i.test(msg)) {
        limiterTripped = true;
        limiterMessage = `${msg} (on change #${i})`;
        break;
      }
    }
    if (limiterTripped) ok(`[rate-limit] handle budget trips: ${limiterMessage.trim()}`);
    else fail("[rate-limit] handle budget of 3/hour", "five handle changes in a row all succeeded");
    await shot(a.page, "03-handle");

    /* ══ BLOCK 4 — email change: two-step, and what the token survives ══ */
    console.log("\n-- block 4: email change --");
    const movedEmail = `qa-acct-a-${STAMP}-moved@founderflow.test`;
    await gotoSettings(a.page);
    await clickButton(a.page, /Change email/i);
    await a.page.waitForSelector('[role="dialog"] input[type=email]', { timeout: 15000 });
    await setInput(a.page, '[role="dialog"] input[type=email]', movedEmail);
    await a.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await a.page
      .waitForFunction(() => /check|inbox|confirm/i.test(document.querySelector('[role="dialog"]')?.innerText ?? ""), { timeout: 20000 })
      .catch(() => {});
    await shot(a.page, "04-email-change-requested");

    const stillOld = await db.user.findUnique({
      where: { id: A.userId },
      select: { email: true, emailVerifiedAt: true },
    });
    if (stillOld?.email === A.email) {
      ok("[two-step] requesting the change does NOT move the login email yet");
    } else {
      fail("[two-step] request must not move the email", `email is already ${stillOld?.email}`);
    }
    await closeDialog(a.page);

    // [ACCT-005] nothing is sent to the CURRENT address and nothing records
    // that a change is pending, so the account's owner has no signal at all.
    // Observable proxy: no Notification row, and /settings renders no
    // "pending email change" state after a reload.
    const pendingNotif = await db.notification.count({
      where: { companyId: A.companyId, OR: [{ title: { contains: "email" } }, { message: { contains: "email" } }] },
    });
    await gotoSettings(a.page);
    const afterRequestText = await bodyText(a.page);
    if (pendingNotif === 0 && !/pending|awaiting confirmation/i.test(afterRequestText)) {
      fail(
        "[ACCT-005] the account is told a change is pending",
        "no notification row in MY tenant and no pending state on /settings — a session thief can start an email swap silently"
      );
    } else {
      ok("[ACCT-005 NEGATIVE] a pending-change signal exists (finding does not reproduce)");
    }

    /* ══ BLOCK 5 — password change: bump, self sign-out, other devices ══ */
    console.log("\n-- block 5: password change --");
    const before = await db.user.findUnique({
      where: { id: A.userId },
      select: { sessionVersion: true, passwordHash: true },
    });

    // A SECOND live session for the same user, to observe the bump reaching it.
    const a2 = await newCtx(browser, "admin-A-second-device", "a2");
    const secondIn = await signIn(a2.page, A.email, A.password);
    if (secondIn) ok("[setup] a second device is signed in as the same user");
    else fail("[setup] second device sign-in", "could not establish the second session");

    // Wrong current password must be refused, and must not write.
    await gotoSettings(a.page);
    await clickButton(a.page, /Change password/i);
    await a.page.waitForSelector('[role="dialog"] input[type=password]', { timeout: 15000 });
    const newPassword = `QaAudit${STAMP}!Z`;
    await a.page.evaluate(
      ({ wrong, next }) => {
        const d = document.querySelector('[role="dialog"]');
        const inputs = [...d.querySelectorAll("input")];
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(inputs[0], wrong);
        set(inputs[1], next);
        set(inputs[2], next);
      },
      { wrong: "definitely-not-the-password", next: newPassword }
    );
    await a.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    const wrongPwToast = await waitForToast(a.page);
    if (/Current password is incorrect/i.test(wrongPwToast)) {
      ok("[error path] wrong current password is refused");
    } else {
      fail("[error path] wrong current password", `toast was: ${wrongPwToast}`);
    }
    const unchanged = await db.user.findUnique({
      where: { id: A.userId },
      select: { sessionVersion: true, passwordHash: true },
    });
    if (unchanged.passwordHash === before.passwordHash && unchanged.sessionVersion === before.sessionVersion) {
      ok("[error path] a refused password change writes nothing");
    } else {
      fail("[error path] refused change wrote anyway", "hash or sessionVersion moved");
    }

    // Correct current password.
    await drainToasts(a.page);
    await a.page.evaluate(
      ({ cur, next }) => {
        const d = document.querySelector('[role="dialog"]');
        const inputs = [...d.querySelectorAll("input")];
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(inputs[0], cur);
        set(inputs[1], next);
        set(inputs[2], next);
      },
      { cur: A.password, next: newPassword }
    );
    await a.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await a.page
      .waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 30000 })
      .catch(() => {});
    if (a.page.url().includes("/login")) ok("[happy path] password change redirects the caller to /login");
    else fail("[happy path] password change redirect", `landed on ${a.page.url()}`);

    const after = await db.user.findUnique({
      where: { id: A.userId },
      select: { sessionVersion: true, passwordHash: true },
    });
    if (after.sessionVersion === before.sessionVersion + 1) {
      ok("[persistence] sessionVersion bumped exactly once by the password change");
    } else {
      fail(
        "[persistence] sessionVersion bump",
        `expected ${before.sessionVersion + 1}, got ${after.sessionVersion}`
      );
    }
    if (after.passwordHash !== before.passwordHash) ok("[persistence] password hash rotated");
    else fail("[persistence] password hash rotated", "hash unchanged");

    // The OTHER device must now be dead on its next request.
    await a2.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" }).catch(() => {});
    await a2.page
      .waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 20000 })
      .catch(() => {});
    if (a2.page.url().includes("/login")) {
      ok("[session] the second device is signed out by the version bump");
    } else {
      fail("[session] second device still authenticated", `at ${a2.page.url()}`);
    }
    A.password = newPassword;

    // [ACCT-004] the email-change token minted BEFORE the password change and
    // the session revocation must, if the product is safe, be dead. It is a
    // stateless JWT with no sessionVersion / passwordHash claim, so expect it
    // to still swap the login email.
    const forged = await mintEmailChangeToken(A.userId, movedEmail);
    if (!forged) {
      note("[ACCT-004] no AUTH_SECRET in .env.local — cannot mint; finding stays static");
    } else {
      const v = await newCtx(browser, "email-change-token", "v");
      await v.page.goto(`${BASE}/verify-email-change?token=${encodeURIComponent(forged)}`, {
        waitUntil: "networkidle0",
      });
      await v.page
        .waitForFunction(() => !/verifying/i.test(document.body.innerText), { timeout: 25000 })
        .catch(() => {});
      await shot(v.page, "05-email-change-token-after-password-change");
      const swapped = await db.user.findUnique({
        where: { id: A.userId },
        select: { email: true, emailVerifiedAt: true },
      });
      if (swapped?.email === movedEmail) {
        fail(
          "[ACCT-004] email-change token survives a password change + full session revocation",
          `login email moved to ${movedEmail} AFTER the password was changed and every session killed`
        );
        A.email = movedEmail;
      } else {
        ok("[ACCT-004 NEGATIVE] the email-change token was rejected after the password change");
      }
      await v.ctx.close().catch(() => {});
    }

    /* ══ BLOCK 6 — appearance, language, notification matrix ════════════ */
    console.log("\n-- block 6: preferences --");
    const a3 = await newCtx(browser, "admin-A-prefs", "a3");
    if (!(await signIn(a3.page, A.email, A.password))) {
      fail("[setup] re-sign-in after password change", `as ${A.email}`);
    } else {
      ok("[happy path] the new password signs in");
    }
    await gotoSettings(a3.page);

    await clickButton(a3.page, /^Light/i);
    await a3.page
      .waitForFunction(() => !document.documentElement.classList.contains("dark"), { timeout: 10000 })
      .catch(() => {});
    // updateAppearanceAction is fire-and-forget; poll the row, don't sleep.
    let themeRow = null;
    for (let i = 0; i < 20 && themeRow?.theme !== "light"; i++) {
      themeRow = await db.user.findUnique({ where: { id: A.userId }, select: { theme: true } });
      if (themeRow?.theme !== "light") await new Promise((r) => setTimeout(r, 250));
    }
    if (themeRow?.theme === "light") ok("[persistence] theme=light reached my User row");
    else fail("[persistence] theme persisted", `User.theme is ${themeRow?.theme}`);

    await clickButton(a3.page, /اردو|Urdu/i);
    let localeRow = null;
    for (let i = 0; i < 20 && localeRow?.locale !== "ur"; i++) {
      localeRow = await db.user.findUnique({ where: { id: A.userId }, select: { locale: true } });
      if (localeRow?.locale !== "ur") await new Promise((r) => setTimeout(r, 250));
    }
    if (localeRow?.locale === "ur") ok("[persistence] locale=ur reached my User row");
    else fail("[persistence] locale persisted", `User.locale is ${localeRow?.locale}`);
    await shot(a3.page, "06-appearance-urdu");
    // Put it back so later blocks read English labels.
    await clickButton(a3.page, /English/i);
    await a3.page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 10000 }).catch(() => {});

    // Notification matrix: flip the first email checkbox, assert the row, reload.
    const flipped = await a3.page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"][aria-label*="Email"]')];
      if (boxes.length === 0) return null;
      const b = boxes[0];
      const was = b.checked;
      b.click();
      return { label: b.getAttribute("aria-label"), was, now: !was };
    });
    if (!flipped) {
      fail("[matrix] notification matrix email checkboxes", "none found on /settings");
    } else {
      let prefRows = [];
      for (let i = 0; i < 24; i++) {
        prefRows = await db.notificationPreference.findMany({
          where: { userId: A.userId },
          select: { event: true, inApp: true, email: true, push: true },
        });
        if (prefRows.length > 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (prefRows.length > 0) {
        ok(`[persistence] a NotificationPreference row exists for MY user (${prefRows[0].event})`);
        if (prefRows[0].email === flipped.now) ok("[persistence] the flipped channel matches the DB");
        else fail("[persistence] flipped channel", `UI says ${flipped.now}, DB says ${prefRows[0].email}`);
      } else {
        fail("[persistence] NotificationPreference upsert", "no row for my user after the flip");
      }
      await gotoSettings(a3.page);
      const afterReload = await a3.page.evaluate(() => {
        const b = [...document.querySelectorAll('input[type="checkbox"][aria-label*="Email"]')][0];
        return b ? b.checked : null;
      });
      if (afterReload === flipped.now) ok("[persistence] the matrix survives a reload");
      else fail("[persistence] matrix after reload", `expected ${flipped.now}, got ${afterReload}`);
    }
    await shot(a3.page, "07-notification-matrix");

    /* ══ BLOCK 7 — export: admin JSON, member 403 ═══════════════════════ */
    console.log("\n-- block 7: data export --");
    const exportRes = await a3.page.evaluate(async () => {
      const r = await fetch("/api/export");
      const ct = r.headers.get("content-type") ?? "";
      const text = await r.text();
      return { status: r.status, ct, len: text.length, hasHash: /passwordHash/.test(text), body: text.slice(0, 400) };
    });
    if (exportRes.status === 200 && exportRes.ct.includes("application/json")) {
      ok("[happy path] admin export returns JSON");
    } else {
      fail("[happy path] admin export", `status ${exportRes.status} ct ${exportRes.ct}`);
    }
    if (!exportRes.hasHash) ok("[security] export carries no passwordHash");
    else fail("[security] export leaks passwordHash", "the string appears in the body");
    writeFileSync(`${OUT}/export-head-${STAMP}.json`, exportRes.body);

    /* ══ BLOCK 8 — "Reset local preferences" tells the truth? [ACCT-007] ═ */
    console.log("\n-- block 8: reset local preferences --");
    const beforeReset = await tombstoneShape(A.companyId);
    await gotoSettings(a3.page);
    await clickButton(a3.page, /Reset local preferences|لوکل ترجیحات/i);
    const resetDialog = await readConfirmDialog(a3.page);
    await shot(a3.page, "08-reset-confirm");
    if (!resetDialog) {
      fail("[ACCT-007] reset opens a confirm dialog", "no dialog appeared");
    } else {
      note(`reset dialog says: ${JSON.stringify(resetDialog.text)}`);
      const claimsServerWipe =
        /transactions|tasks|activity|team members|workspace data/i.test(resetDialog.text) &&
        /cannot be undone|wiped/i.test(resetDialog.text);
      // Confirm it, then measure what actually changed.
      await a3.page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        const btn = [...d.querySelectorAll("button")].find((b) => /Reset everything|سب کچھ/i.test(b.textContent));
        btn?.click();
      });
      await a3.page
        .waitForFunction(() => !location.pathname.startsWith("/settings"), { timeout: 20000 })
        .catch(() => {});
      const afterReset = await tombstoneShape(A.companyId);
      const nothingWiped =
        afterReset.tasksLive === beforeReset.tasksLive &&
        afterReset.txnsLive === beforeReset.txnsLive &&
        afterReset.activityAll === beforeReset.activityAll &&
        afterReset.usersLive === beforeReset.usersLive;
      if (claimsServerWipe && nothingWiped) {
        fail(
          "[ACCT-007] the reset confirm dialog claims a server wipe it does not perform",
          `dialog promised "${resetDialog.text.replace(/\s+/g, " ").slice(0, 160)}" — my tenant still has ${afterReset.tasksLive} task(s), ${afterReset.txnsLive} transaction(s), ${afterReset.activityAll} activity row(s), ${afterReset.usersLive} user(s)`
        );
      } else if (!claimsServerWipe) {
        ok("[ACCT-007 NEGATIVE] the dialog copy no longer promises a server wipe");
      } else {
        fail("[data safety] reset actually destroyed server rows", JSON.stringify({ beforeReset, afterReset }));
      }
      // Still signed in? (the redirect to /login bounces straight back)
      await a3.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" }).catch(() => {});
      if (!a3.page.url().includes("/login")) {
        ok("[ACCT-007] after 'Reset everything' the user is still signed in with all data intact");
      } else {
        note("[ACCT-007] the reset did end the session — re-read the dialog copy against that");
      }
    }

    /* ══ BLOCK 9 — member view + member self-delete ═════════════════════ */
    console.log("\n-- block 9: roles in the danger zone --");
    const b = await newCtx(browser, "admin-B", "b");
    const B = await signUpTenant(b.page, "acct-b");
    note(`tenant B = ${B.companyName} (${B.companyId})`);
    await seedMyTenantContent(B);

    // Invite a member through the REAL invite flow (keeps us inside my tenant).
    const memberEmail = `qa-acct-b-${STAMP}-mem@founderflow.test`;
    const memberPassword = `QaAudit${STAMP}!m`;
    await b.page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
    await b.page.waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 30000 }).catch(() => {});
    await clickButton(b.page, /Invite member/i);
    await b.page.waitForSelector('[role="dialog"] input', { timeout: 15000 });
    await b.page.evaluate(
      ({ n, e }) => {
        const d = document.querySelector('[role="dialog"]');
        const inputs = d.querySelectorAll("input");
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(inputs[0], n);
        set(inputs[1], e);
        const roleBtn = [...d.querySelectorAll("button[aria-pressed]")].find((x) => /team member/i.test(x.textContent ?? ""));
        roleBtn?.click();
      },
      { n: `QA Member ${STAMP}`, e: memberEmail }
    );
    await b.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await waitForToast(b.page);
    await closeDialog(b.page);

    const inviteRow = await db.inviteToken.findFirst({
      where: { companyId: B.companyId, email: memberEmail, usedAt: null },
      select: { token: true },
    });
    if (!inviteRow) {
      fail("[setup] invite created in tenant B", "no unused InviteToken row for my tenant");
    } else {
      ok("[setup] invite created through the real flow");
      const m = await newCtx(browser, "member-B", "m");
      await m.page.goto(`${BASE}/invite/${inviteRow.token}`, { waitUntil: "networkidle0", timeout: 60000 });
      await m.page
        .waitForFunction(() => {
          const btn = document.querySelector('form button[type="submit"]');
          return !!btn && !btn.disabled;
        }, { timeout: 30000 })
        .catch(() => {});
      await m.page.type("input[type=password]", memberPassword);
      await m.page.click('form button[type="submit"]');
      await m.page.waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30000 }).catch(() => {});

      const memberRow = await db.user.findFirst({
        where: { companyId: B.companyId, email: memberEmail },
        select: { id: true, role: true, deletedAt: true },
      });
      if (memberRow?.role === "member") ok("[setup] member joined tenant B");
      else fail("[setup] member joined", JSON.stringify(memberRow));

      // 9a. member /settings: no Company, no Billing, no Export, no workspace delete.
      await gotoSettings(m.page);
      await shot(m.page, "09-member-settings");
      const memberText = await bodyText(m.page);
      const hiddenFromMember = [
        ["Delete this workspace", /Delete this workspace/i],
        ["Export workspace", /Export workspace/i],
        ["Plan & billing", /Plan & billing/i],
      ];
      for (const [label, re] of hiddenFromMember) {
        if (!re.test(memberText)) ok(`[role gate] member does not see "${label}"`);
        else fail(`[role gate] member sees "${label}"`, "must be admin/cofounder only");
      }
      if (/Delete my account/i.test(memberText)) ok("[role gate] member CAN delete their own account");
      else fail("[role gate] member account-delete row", "missing");

      // 9b. member export must 403 even by direct fetch.
      const memberExport = await m.page.evaluate(async () => {
        const r = await fetch("/api/export");
        return { status: r.status, body: (await r.text()).slice(0, 200) };
      });
      if (memberExport.status === 403) ok("[security] /api/export refuses a member with 403");
      else fail("[security] /api/export member gate", `status ${memberExport.status}: ${memberExport.body}`);

      // 9c. [ACCT-009] a member has no way to take their own data before
      //     deleting their account — the only export is finance-gated.
      if (memberExport.status === 403 && !/Export workspace/i.test(memberText)) {
        fail(
          "[ACCT-009] a member can export their own data before deleting their account",
          "no export control on /settings for a member and /api/export returns 403 — the account-delete row is the only exit and it takes their data with it"
        );
      }

      // 9d. member self-delete: only that user is tombstoned, their content stays.
      const beforeMemberDelete = await tombstoneShape(B.companyId);
      await clickButton(m.page, /Delete account/i);
      const delModal = await m.page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? { text: d.innerText, inputs: [...d.querySelectorAll("input")].map((i) => i.type) } : null;
      });
      await shot(m.page, "10-member-delete-account-modal");
      if (delModal) {
        note(`member delete modal inputs: ${JSON.stringify(delModal.inputs)}`);
        // Wrong password first.
        await setInput(m.page, '[role="dialog"] input[type=password]', "wrong-password-entirely");
        await m.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
        const wrongToast = await waitForToast(m.page);
        if (/Password doesn't match/i.test(wrongToast)) ok("[error path] account delete refuses a wrong password");
        else fail("[error path] account delete wrong password", `toast: ${wrongToast}`);
        const midway = await tombstoneShape(B.companyId);
        if (midway.usersDead === beforeMemberDelete.usersDead) ok("[data safety] a refused delete tombstones nothing");
        else fail("[data safety] refused delete tombstoned rows", JSON.stringify({ beforeMemberDelete, midway }));

        await drainToasts(m.page);
        await setInput(m.page, '[role="dialog"] input[type=password]', memberPassword);
        await m.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
        await m.page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});

        const afterMemberDelete = await tombstoneShape(B.companyId);
        if (afterMemberDelete.companyDeletedAt === null) ok("[happy path] a member self-delete leaves the workspace live");
        else fail("[data safety] member self-delete tombstoned the WORKSPACE", `companyDeletedAt=${afterMemberDelete.companyDeletedAt}`);
        if (afterMemberDelete.usersDead === beforeMemberDelete.usersDead + 1) ok("[happy path] exactly one user tombstoned");
        else fail("[happy path] one user tombstoned", JSON.stringify({ beforeMemberDelete, afterMemberDelete }));
        if (afterMemberDelete.tasksLive === beforeMemberDelete.tasksLive) ok("[happy path] the workspace's tasks survive the member leaving");
        else fail("[data safety] member delete took tasks with it", `${beforeMemberDelete.tasksLive} → ${afterMemberDelete.tasksLive}`);

        // They must not be able to sign back in.
        const reIn = await signIn(m.page, memberEmail, memberPassword);
        if (!reIn) ok("[session] a tombstoned user cannot sign back in");
        else fail("[security] tombstoned user signed back in", `landed ${m.page.url()}`);

        // [ACCT-001] their email is now permanently occupied: signup is refused
        // with "already exists" while login is refused too. Dead end.
        await m.page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
        await m.page.waitForSelector('input[name="name"]', { timeout: 30000 });
        await new Promise((r) => setTimeout(r, 1200));
        await m.page.type('input[name="name"]', `QA Return ${STAMP}`);
        await m.page.type('input[name="email"]', memberEmail);
        await m.page.type('input[name="password"]', `QaAudit${STAMP}!r`);
        await m.page.evaluate(() => {
          const btn = [...document.querySelectorAll("form button[type=button]")].find((x) => /continue/i.test(x.textContent ?? ""));
          btn?.click();
        });
        await m.page.waitForFunction(() => {
          const el = document.querySelector('input[name="companyName"]');
          return !!el && el.offsetParent !== null;
        }, { timeout: 15000 }).catch(() => {});
        await m.page.type('input[name="companyName"]', `qa-return-${STAMP}`);
        await m.page.click('form button[type="submit"]');
        const signupToast = await waitForToast(m.page, 25000);
        await shot(m.page, "11-deleted-email-cannot-resignup");
        if (/already exists/i.test(signupToast)) {
          fail(
            "[ACCT-001] a deleted account's email is unusable forever",
            `signup says "${signupToast.trim()}" while login is refused — the address is trapped by the tombstoned row's global unique index for the full 90-day retention window, with no self-service way out`
          );
        } else if (/created|dashboard/i.test(signupToast) || m.page.url().includes("/dashboard")) {
          ok("[ACCT-001 NEGATIVE] the address can be reused after an account delete");
          const strays = await db.user.findMany({ where: { email: memberEmail }, select: { companyId: true } });
          for (const s of strays) if (!myTenants.includes(s.companyId)) myTenants.push(s.companyId);
        } else {
          note(`[ACCT-001] signup produced: ${signupToast}`);
        }
      }
      await m.ctx.close().catch(() => {});
    }

    /* ══ BLOCK 10 — sole admin with teammates is blocked ════════════════ */
    console.log("\n-- block 10: sole-admin guard --");
    // Tenant B now has the admin + one tombstoned member, so re-invite to get
    // a LIVE teammate back before testing the guard.
    const mate2Email = `qa-acct-b-${STAMP}-mate@founderflow.test`;
    const mate2Password = `QaAudit${STAMP}!n`;
    await b.page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
    await b.page.waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 30000 }).catch(() => {});
    await clickButton(b.page, /Invite member/i);
    await b.page.waitForSelector('[role="dialog"] input', { timeout: 15000 });
    await b.page.evaluate(
      ({ n, e }) => {
        const d = document.querySelector('[role="dialog"]');
        const inputs = d.querySelectorAll("input");
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(inputs[0], n);
        set(inputs[1], e);
        const roleBtn = [...d.querySelectorAll("button[aria-pressed]")].find((x) => /team member/i.test(x.textContent ?? ""));
        roleBtn?.click();
      },
      { n: `QA Mate ${STAMP}`, e: mate2Email }
    );
    await b.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await waitForToast(b.page);
    await closeDialog(b.page);
    const mate2Invite = await db.inviteToken.findFirst({
      where: { companyId: B.companyId, email: mate2Email, usedAt: null },
      select: { token: true },
    });
    if (mate2Invite) {
      const m2 = await newCtx(browser, "mate-B", "m2");
      await m2.page.goto(`${BASE}/invite/${mate2Invite.token}`, { waitUntil: "networkidle0", timeout: 60000 });
      await m2.page.waitForFunction(() => {
        const btn = document.querySelector('form button[type="submit"]');
        return !!btn && !btn.disabled;
      }, { timeout: 30000 }).catch(() => {});
      await m2.page.type("input[type=password]", mate2Password);
      await m2.page.click('form button[type="submit"]');
      await m2.page.waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30000 }).catch(() => {});
      note("second teammate live in tenant B");

      const beforeGuard = await tombstoneShape(B.companyId);
      await gotoSettings(b.page);
      await clickButton(b.page, /Delete account/i);
      await b.page.waitForSelector('[role="dialog"] input[type=password]', { timeout: 15000 });
      await setInput(b.page, '[role="dialog"] input[type=password]', B.password);
      await b.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
      const guardToast = await waitForToast(b.page, 25000);
      await shot(b.page, "12-sole-admin-guard");
      if (/only admin/i.test(guardToast)) ok("[negative result] the sole-admin-with-teammates guard holds");
      else fail("[P0 RISK] sole admin deleted themselves with teammates present", `toast: ${guardToast}`);
      const afterGuard = await tombstoneShape(B.companyId);
      if (afterGuard.usersDead === beforeGuard.usersDead && afterGuard.companyDeletedAt === null) {
        ok("[negative result] the blocked delete wrote nothing");
      } else {
        fail("[data safety] blocked delete still wrote", JSON.stringify({ beforeGuard, afterGuard }));
      }
      await closeDialog(b.page);
      await m2.ctx.close().catch(() => {});
    }

    /* ══ BLOCK 11 — workspace delete: cross-tenant name, then the real one ═ */
    console.log("\n-- block 11: workspace delete --");
    // 11a. NEGATIVE RESULT: tenant B's admin types tenant A's workspace name.
    //      `deleteWorkspaceAction` takes no company id, so the only forgeable
    //      input is the name. Tenant A must be untouched.
    const aBefore = await tombstoneShape(A.companyId);
    await gotoSettings(b.page);
    await clickButton(b.page, /Delete workspace/i);
    await b.page.waitForSelector('[role="dialog"] input[type=text]', { timeout: 15000 });
    await b.page.evaluate(
      ({ name, pw }) => {
        const d = document.querySelector('[role="dialog"]');
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(d.querySelector('input[type="text"]'), name);
        set(d.querySelector('input[type="password"]'), pw);
      },
      { name: A.companyName, pw: B.password }
    );
    await b.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    const crossToast = await waitForToast(b.page, 25000);
    await shot(b.page, "13-cross-tenant-name-refused");
    if (/doesn't match/i.test(crossToast)) ok("[negative result] another tenant's workspace name is refused");
    else fail("[P0 RISK] cross-tenant workspace name accepted", `toast: ${crossToast}`);
    const aAfter = await tombstoneShape(A.companyId);
    if (aAfter.companyDeletedAt === null && aAfter.usersLive === aBefore.usersLive) {
      ok("[negative result] tenant A is byte-for-byte untouched by tenant B's attempt");
    } else {
      fail("[P0] cross-tenant write", JSON.stringify({ aBefore, aAfter }));
    }

    // 11b. wrong password with the RIGHT name.
    await drainToasts(b.page);
    await b.page.evaluate(
      ({ name, pw }) => {
        const d = document.querySelector('[role="dialog"]');
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(d.querySelector('input[type="text"]'), name);
        set(d.querySelector('input[type="password"]'), pw);
      },
      { name: B.companyName, pw: "not-the-password" }
    );
    await b.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    const wrongWsToast = await waitForToast(b.page, 25000);
    if (/Password doesn't match/i.test(wrongWsToast)) ok("[error path] workspace delete refuses a wrong password");
    else fail("[error path] workspace delete wrong password", `toast: ${wrongWsToast}`);
    await closeDialog(b.page);

    /* ══ BLOCK 12 — the real workspace delete, on a purpose-built tenant ═ */
    console.log("\n-- block 12: workspace delete, paid tenant, live invite --");
    const d = await newCtx(browser, "admin-D", "d");
    const D = await signUpTenant(d.page, "acct-d");
    note(`tenant D = ${D.companyName} (${D.companyId})`);
    await seedMyTenantContent(D);

    // W1 — make tenant D a PAID workspace. See the header for why this is
    // faked rather than driven through a real checkout.
    await db.company.update({
      where: { id: D.companyId },
      data: {
        plan: "team",
        billingCustomerId: `qa-cust-${STAMP}`,
        billingSubscriptionId: `qa-sub-${STAMP}`,
        subscriptionStatus: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 864e5),
      },
    });
    // W3 — a device registration for MY user, to observe what delete leaves behind.
    await db.pushSubscription.create({
      data: {
        userId: D.userId,
        endpoint: `https://qa.example.invalid/push/${STAMP}`,
        p256dh: "qa-p256dh",
        auth: "qa-auth",
        userAgent: "qa-agent-11",
      },
    }).catch(() => note("pushSubscription seed skipped"));

    // An OUTSTANDING invite that will outlive the workspace [ACCT-003].
    const zombieEmail = `qa-acct-d-${STAMP}-zombie@founderflow.test`;
    const zombiePassword = `QaAudit${STAMP}!z`;
    await d.page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
    await d.page.waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 30000 }).catch(() => {});
    await clickButton(d.page, /Invite member/i);
    await d.page.waitForSelector('[role="dialog"] input', { timeout: 15000 });
    await d.page.evaluate(
      ({ n, e }) => {
        const dd = document.querySelector('[role="dialog"]');
        const inputs = dd.querySelectorAll("input");
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(inputs[0], n);
        set(inputs[1], e);
        const roleBtn = [...dd.querySelectorAll("button[aria-pressed]")].find((x) => /team member/i.test(x.textContent ?? ""));
        roleBtn?.click();
      },
      { n: `QA Zombie ${STAMP}`, e: zombieEmail }
    );
    await d.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await waitForToast(d.page);
    await closeDialog(d.page);
    const zombieInvite = await db.inviteToken.findFirst({
      where: { companyId: D.companyId, email: zombieEmail, usedAt: null },
      select: { token: true },
    });

    // A second live session for the admin, to watch it die.
    const d2 = await newCtx(browser, "admin-D-second", "d2");
    await signIn(d2.page, D.email, D.password);

    const dBefore = await tombstoneShape(D.companyId);
    note(`tenant D before delete: ${JSON.stringify(dBefore)}`);

    await gotoSettings(d.page);
    await clickButton(d.page, /Delete workspace/i);
    await d.page.waitForSelector('[role="dialog"] input[type=text]', { timeout: 15000 });
    const wsModal = await d.page.evaluate(() => {
      const dd = document.querySelector('[role="dialog"]');
      return { text: dd.innerText, inputs: [...dd.querySelectorAll("input")].map((i) => i.type) };
    });
    await shot(d.page, "14-delete-workspace-modal");
    // [ACCT-010] does the confirmation mention that billing keeps running, or
    // how long recovery is possible? Record the exact copy either way.
    note(`workspace delete modal copy: ${JSON.stringify(wsModal.text)}`);
    if (!/billing|subscription|charge/i.test(wsModal.text)) {
      fail(
        "[ACCT-002] the workspace-delete confirmation warns about the live subscription",
        `copy is "${wsModal.text.replace(/\s+/g, " ").slice(0, 200)}" — no mention of billing on a workspace whose plan is "${dBefore.plan}" / status "${dBefore.subscriptionStatus}"`
      );
    }
    if (!/90|recover|restore|retention/i.test(wsModal.text)) {
      fail(
        "[ACCT-011] the delete confirmation states the retention window",
        `copy says "Not reversible" / "no undo" while the data is actually recoverable for 90 days — the promise and the implementation disagree in the direction that stops a panicking customer asking for a restore`
      );
    }

    await d.page.evaluate(
      ({ name, pw }) => {
        const dd = document.querySelector('[role="dialog"]');
        const set = (el, v) => {
          el.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set(dd.querySelector('input[type="text"]'), name);
        set(dd.querySelector('input[type="password"]'), pw);
      },
      { name: D.companyName, pw: D.password }
    );
    await d.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await d.page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
    if (d.page.url().includes("/login")) ok("[happy path] workspace delete lands the admin on /login");
    else fail("[happy path] workspace delete redirect", `at ${d.page.url()}`);

    const dAfter = await tombstoneShape(D.companyId);
    note(`tenant D after delete: ${JSON.stringify(dAfter)}`);

    // What SHOULD be tombstoned.
    const tombstoned = [
      ["Company", dAfter.companyDeletedAt !== null],
      ["User", dAfter.usersLive === 0],
      ["Task", dAfter.tasksLive === 0],
      ["Transaction", dAfter.txnsLive === 0],
      ["Budget", dAfter.budgetsLive === 0],
      ["Project", dAfter.projectsLive === 0],
      ["Message", dAfter.messagesLive === 0],
    ];
    for (const [model, isDead] of tombstoned) {
      if (isDead) ok(`[tombstone] ${model} rows tombstoned in MY tenant`);
      else fail(`[tombstone] ${model} left live`, `after delete: ${JSON.stringify(dAfter)}`);
    }

    // What is NOT tombstoned, and whether that is only-documented or actually harmful.
    if (dAfter.commentsAll === dBefore.commentsAll && dBefore.commentsAll > 0) {
      fail(
        "[ACCT-012] Comment / TimeEntry / Activity / Notification carry no tombstone",
        `Comment=${dAfter.commentsAll}, TimeEntry=${dAfter.timeAll}, Activity=${dAfter.activityAll}, Notification=${dAfter.notifAll}, Channel=${dAfter.channelsAll} rows in a workspace the product reports as deleted — anything that trusts deletedAt rather than the session (an export, a support query, the eventual GDPR anonymization pass) walks straight past them`
      );
    }

    // [ACCT-002] billing is untouched.
    if (dAfter.plan === "team" && dAfter.billingSubscriptionId === dBefore.billingSubscriptionId) {
      fail(
        "[ACCT-002] deleting a paid workspace leaves the subscription running",
        `plan is still "${dAfter.plan}", subscriptionStatus "${dAfter.subscriptionStatus}", billingSubscriptionId "${dAfter.billingSubscriptionId}" — and every user is tombstoned, so nobody can sign in to reach "Manage billing"`
      );
    } else {
      ok("[ACCT-002 NEGATIVE] the delete cleared or cancelled the subscription");
    }

    // [ACCT-008] push registration survives.
    const survivingPush = await db.pushSubscription.count({ where: { user: { companyId: D.companyId } } });
    if (survivingPush > 0) {
      fail(
        "[ACCT-008] a deleted workspace's device registrations survive",
        `${survivingPush} PushSubscription row(s) still point at users in a tombstoned workspace; lib/notify/fan-out.ts filters deletedAt for EMAIL but firePush() → sendPushToUsers() does not, so a fan-out that still names a tombstoned user id pushes workspace content to their device`
      );
    } else {
      ok("[ACCT-008 NEGATIVE] push subscriptions were cleaned up");
    }

    // The admin's other live session must die on its next request.
    await d2.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" }).catch(() => {});
    await d2.page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 20000 }).catch(() => {});
    if (d2.page.url().includes("/login")) ok("[session] the admin's other device is signed out at once");
    else fail("[session] other device survived the workspace delete", `at ${d2.page.url()}`);

    // Double-submit: a second invocation must not re-stamp a NEW tombstone
    // timestamp (CLAUDE.md's recovery runbook reunites child rows by a range
    // filter around ONE timestamp).
    const reDelete = await signIn(d.page, D.email, D.password);
    if (!reDelete) ok("[double-submit] the deleted admin cannot sign in to delete twice");
    else fail("[security] deleted admin signed back in", `at ${d.page.url()}`);

    // [ACCT-003] the outstanding invite still works → a LIVE user inside a
    // tombstoned workspace.
    if (zombieInvite) {
      const z = await newCtx(browser, "zombie", "z");
      await z.page.goto(`${BASE}/invite/${zombieInvite.token}`, { waitUntil: "networkidle0", timeout: 60000 });
      const hasForm = await z.page.$("input[type=password]");
      await shot(z.page, "15-invite-into-deleted-workspace");
      if (!hasForm) {
        ok("[ACCT-003 NEGATIVE] the invite link is refused once the workspace is deleted");
      } else {
        await z.page.waitForFunction(() => {
          const btn = document.querySelector('form button[type="submit"]');
          return !!btn && !btn.disabled;
        }, { timeout: 30000 }).catch(() => {});
        await z.page.type("input[type=password]", zombiePassword);
        await z.page.click('form button[type="submit"]');
        await z.page.waitForFunction(
          () => location.pathname.startsWith("/dashboard") || document.querySelectorAll('[role="status"],[role="alert"]').length > 0,
          { timeout: 30000 }
        ).catch(() => {});
        const zToast = await toastsOf(z.page);
        const zombieRow = await db.user.findFirst({
          where: { companyId: D.companyId, email: zombieEmail },
          select: { id: true, deletedAt: true },
        });
        await shot(z.page, "16-zombie-user-state");
        if (zombieRow && zombieRow.deletedAt === null) {
          fail(
            "[ACCT-003] an outstanding invite still creates a LIVE account inside a deleted workspace",
            `User ${zombieRow.id} committed with deletedAt=null into Company ${D.companyId} whose deletedAt=${dAfter.companyDeletedAt}. softDeleteWorkspace() never touches InviteToken and acceptInviteAction never checks company.deletedAt. Landed at ${z.page.url()} — toast: ${zToast}`
          );
          // Their session, if any, hits getCurrentCompany() → throws.
          const broken = await z.page.evaluate(() => /something went wrong|error/i.test(document.body.innerText));
          if (broken) {
            note("[ACCT-003] the zombie account renders the error boundary on every app page");
          }
        } else {
          ok("[ACCT-003 NEGATIVE] the invite acceptance was refused for a deleted workspace");
        }
        await z.ctx.close().catch(() => {});
      }
    }

    /* ══ BLOCK 13 — solo founder: "delete my account" == workspace delete ═ */
    console.log("\n-- block 13: solo-founder account delete --");
    const e = await newCtx(browser, "admin-E", "e");
    const E = await signUpTenant(e.page, "acct-e");
    note(`tenant E = ${E.companyName} (${E.companyId})`);
    await seedMyTenantContent(E);
    const eBefore = await tombstoneShape(E.companyId);

    await gotoSettings(e.page);
    await clickButton(e.page, /Delete account/i);
    await e.page.waitForSelector('[role="dialog"] input[type=password]', { timeout: 15000 });
    const soloModal = await e.page.evaluate(() => {
      const dd = document.querySelector('[role="dialog"]');
      return { text: dd.innerText, inputs: [...dd.querySelectorAll("input")].map((i) => i.type) };
    });
    await shot(e.page, "17-solo-delete-account-modal");
    // [ACCT-013] PROPORTIONALITY. This single password field is about to
    // destroy the entire workspace — exactly what the workspace-delete modal
    // guards with a typed name confirmation.
    const hasNameField = soloModal.inputs.includes("text");
    const warnsWorkspace = /workspace/i.test(soloModal.text);
    if (!hasNameField && !warnsWorkspace) {
      fail(
        "[ACCT-013] the solo-founder account delete is confirmed as weakly as a name change",
        `the modal offers only ${JSON.stringify(soloModal.inputs)} and says "${soloModal.text.replace(/\s+/g, " ").slice(0, 160)}" — no typed confirmation and no mention of the workspace, yet the action about to run is byte-identical to deleteWorkspaceAction's cascade`
      );
    } else if (!hasNameField) {
      note("[ACCT-013] no typed confirmation, but the copy does mention the workspace");
    } else {
      ok("[ACCT-013 NEGATIVE] the solo delete asks for a typed confirmation too");
    }

    await setInput(e.page, '[role="dialog"] input[type=password]', E.password);
    await e.page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
    await e.page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
    const eAfter = await tombstoneShape(E.companyId);
    note(`tenant E after solo delete: ${JSON.stringify(eAfter)}`);
    if (eAfter.companyDeletedAt !== null && eAfter.usersLive === 0) {
      ok("[ACCT-013] confirmed: 'Delete my account' tombstoned the WHOLE workspace for a solo founder");
    } else {
      fail("[ACCT-013] solo delete cascade", JSON.stringify({ eBefore, eAfter }));
    }
    if (eAfter.tasksLive === 0 && eAfter.txnsLive === 0 && eAfter.budgetsLive === 0) {
      ok("[tombstone] the solo cascade matches the workspace cascade");
    } else {
      fail("[tombstone] solo cascade incomplete", JSON.stringify(eAfter));
    }

    /* ══ BLOCK 14 — sign out ════════════════════════════════════════════ */
    console.log("\n-- block 14: sign out --");
    const f = await newCtx(browser, "admin-F", "f");
    const F = await signUpTenant(f.page, "acct-f");
    await gotoSettings(f.page);
    await clickButton(f.page, /^Sign out$/i);
    const soDialog = await readConfirmDialog(f.page);
    await shot(f.page, "18-signout-confirm");
    if (soDialog) ok("[happy path] sign out asks for confirmation");
    else fail("[happy path] sign out confirm dialog", "none appeared");
    await f.page.evaluate(() => {
      const dd = document.querySelector('[role="dialog"]');
      const btn = [...dd.querySelectorAll("button")].find((x) => /sign out/i.test(x.textContent));
      btn?.click();
    });
    await f.page.waitForFunction(() => location.pathname.startsWith("/login"), { timeout: 25000 }).catch(() => {});
    await f.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" }).catch(() => {});
    if (f.page.url().includes("/login")) ok("[happy path] sign out really clears the session cookie");
    else fail("[happy path] sign out left a live session", `at ${f.page.url()}`);
    note(`tenant F = ${F.companyName}`);

    /* ══ BLOCK 15 — /settings under an expired session ══════════════════ */
    console.log("\n-- block 15: expired session on /settings --");
    const g = await newCtx(browser, "expired", "g");
    await g.page.goto(`${BASE}/settings`, { waitUntil: "networkidle0" }).catch(() => {});
    if (g.page.url().includes("/login")) ok("[error path] anonymous /settings bounces to /login");
    else fail("[error path] anonymous /settings", `served ${g.page.url()}`);
    await shot(g.page, "19-anonymous-settings");
  } catch (err) {
    fail("qa-account-and-workspace-settings threw mid-run", err?.message ?? String(err));
    console.error(err);
  } finally {
    /* ── Teardown: ONLY this agent's tenants, children before parents. ──── */
    for (const companyId of myTenants) {
      try {
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
        await db.company.update({ where: { id: companyId }, data: { ownerId: null } });
        await db.user.deleteMany({ where: { companyId } });
        await db.company.delete({ where: { id: companyId } });
        console.log(`  ..  swept tenant ${companyId}`);
      } catch (err) {
        console.error(`  cleanup failed for ${companyId}:`, err.message);
      }
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n  ${passes} assertion(s) passed`);
  console.log(`  screenshots: ${OUT}`);
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("❌ qa-account-and-workspace-settings threw:", err);
  process.exit(1);
});
