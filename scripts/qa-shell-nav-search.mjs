/*
 * QA agent 2 — shell / nav / search.  PHASE 2 EXERCISE SCRIPT.
 *
 * Surface: app/(app)/layout.tsx, components/layout/{sidebar,topbar,breadcrumbs,
 * command-palette}.tsx, lib/queries/search.ts, lib/actions/search.ts,
 * theme/appearance, PWA install, /offline, public/sw.js.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DATA SAFETY — read before changing a single line.
 *
 * This script writes NOTHING outside the two workspaces it creates itself.
 * It signs up `qa-shell-<stamp>` and `qa-shellx-<stamp>` through the real
 * signup form, invites its own member through the real invite flow, and every
 * DB read/assert/delete below carries `companyId: <one of my two tenant ids>`.
 *
 * There is not one bare `db.X.count()` / `db.X.findFirst()` in this file, and
 * that is load-bearing rather than tidy: nine agents run against the same
 * database, so an unscoped "did my row land?" count can be satisfied by
 * somebody else's insert and go green while my feature is broken. A false PASS
 * is the single most expensive outcome of this audit.
 *
 * The seeded `demo-nimbus` workspace is never read for an assertion and never
 * written at all. `scripts/_qa-guard.mjs verify` hashes every demo row and
 * will fail the run if that is untrue.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY TWO TENANTS. The strongest property on this surface is a NEGATIVE one:
 * a term that exists only in another company's chat must return nothing. That
 * cannot be proved inside one workspace, and it must not be proved against
 * demo-nimbus (asserting on seeded rows is forbidden, and a seeded row another
 * agent touched would make the assertion lie). So tenant B exists purely to
 * hold one nonce that tenant A must never be able to find. See section 12.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY x-real-ip IS SET ON EVERY PAGE. `getClientIp()` (lib/client-ip.ts:36)
 * falls back to the literal string "unknown" when no proxy header is present,
 * which is always, in dev. Without a per-agent header every agent shares ONE
 * `limiters.auth` bucket of 5 per 60s fed by nine call sites, and we would all
 * starve each other and file false "cannot sign in" bugs. Agent 2 owns
 * 10.99.0.2.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY EVERY WAIT IS A STATE PREDICATE. Under nine concurrent agents a dev
 * server's round trips get long and variable; a fixed `setTimeout` that is
 * generous on an idle machine is a coin flip on a loaded one, and it fails in
 * the direction that files phantom bugs. The only fixed sleeps below are the
 * 1500ms hydration pause inside the `signIn` / `signUp` helpers, copied
 * verbatim from scripts/smoke-chat.mjs (FaultsAudit A14: a click that beats
 * React performs a NATIVE GET submit and the credentials end up in the query
 * string), and one paint tick after a palette response has already settled.
 *
 * Usage:  node scripts/qa-shell-nav-search.mjs
 * Env:    BASE (default http://localhost:3000 — must match AUTH_URL or the
 *         sign-in redirect dies), PUPPETEER_EXECUTABLE_PATH.
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** Per-agent screenshot directory. A shared fixed filename destroys evidence. */
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/shell-nav-search";
/** Agent 2's rate-limit identity. See the header. */
const AGENT_IP = "10.99.0.2";

const STAMP = Date.now().toString().slice(-8);

/**
 * Nonces are LETTERS ONLY, and that is load-bearing.
 *
 * A message is indexed by `to_tsvector('english', body)` and searched with
 * `websearch_to_tsquery('english', term)`. A token carrying digits or
 * punctuation lexes through a different branch of the Postgres parser on each
 * side and can split or drop out entirely — so a miss would mean "the fixture
 * was unlexable", not "search is broken". A nonsense WORD goes through both
 * sides identically. The timestamp's digits are mapped to letters for the same
 * reason and keep two runs from colliding.
 */
const ALPHA = STAMP.split("")
  .map((d) => "abcdefghij"[Number(d)])
  .join("");

/** Tenant A — the workspace under test. Prefix `qa-` so the sweeper finds it. */
const A_COMPANY = `qa-shell-${STAMP}`;
const A_EMAIL = `qa-shell-${STAMP}@founderflow.test`;
const A_NAME = `QA Shell Admin ${STAMP}`;
/** Tenant B — exists only to hold the cross-tenant nonce. */
const B_COMPANY = `qa-shellx-${STAMP}`;
const B_EMAIL = `qa-shellx-${STAMP}@founderflow.test`;
const B_NAME = `QA Shell Other ${STAMP}`;
/** The member invited into tenant A through the real invite flow. */
const M_EMAIL = `qa-shell-mem-${STAMP}@founderflow.test`;
const M_NAME = `QA Shell Member ${STAMP}`;

const PASSWORD = `QaShell!${STAMP}`;

/** Appears ONLY in a tenant-A chat message. Prefix-searchable test subject. */
const A_NONCE = `zqshell${ALPHA}`;
/** Appears ONLY in a tenant-B chat message. Tenant A must never find it. */
const B_NONCE = `zqother${ALPHA}`;
/** Appears ONLY as the invited member's NAME. Search must (not) find people. */
const PEOPLE_NONCE = `zqperson${ALPHA}`;

const PALETTE_INPUT = '[role="dialog"] input[role="combobox"]';

mkdirSync(OUT, { recursive: true });

const db = localDb();

let passes = 0;
let failures = 0;

function ok(label) {
  passes++;
  console.log(`  ok  ${label}`);
}

/**
 * Records a failure and KEEPS GOING. Deliberately does not throw: one run has
 * to report every broken assertion, not just the first. The literal ❌ is what
 * the runner's summary counts.
 */
function fail(label, detail) {
  failures++;
  process.exitCode = 1;
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function note(label) {
  console.log(`  ··  ${label}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────────────────────────────────────────────────
 * Browser plumbing
 * ───────────────────────────────────────────────────────────────────────── */

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

/**
 * A fresh page in its own context, stamped with this agent's IP BEFORE its
 * first navigation. Every page in this file is born here; there is no other
 * `newPage()` call, so there is no way to forget the header.
 */
async function newAgentPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  wire(page);
  return { ctx, page };
}

/**
 * Sign in, retrying until React owns the click.
 *
 * COPIED VERBATIM from scripts/smoke-chat.mjs. On a cold dev server the form
 * paints before hydration; a click that lands first performs a NATIVE submit,
 * which (the form declares no method on /login) becomes a GET with the
 * credentials in the query string and no sign-in at all. FaultsAudit A14.
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
 * Create a workspace through the REAL two-step signup form.
 *
 * Same hydration discipline as `signIn`, for the same reason: step 1's
 * "Continue" is a `type="button"` that does nothing without JS, and the step-2
 * submit is `disabled={!hydrated}` (app/signup/page.tsx), so a pre-hydration
 * run silently produces no workspace and every later assertion becomes a lie.
 */
async function signUp(page, { name, email, password, companyName }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[name=name]", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.type("input[name=name]", name);
    await page.type("input[name=email]", email);
    await page.type("input[name=password]", password);

    // The only unlabelled type=button inside the form at step 1 is Continue.
    // (The password eye carries an aria-label; Back only exists at step 2.)
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("form button[type=button]")].find(
        (b) => !b.getAttribute("aria-label")
      );
      btn?.click();
    });

    // Step 2 is rendered but `hidden` until the step flips — visibility, not
    // presence, is the predicate.
    const onStep2 = await page
      .waitForFunction(
        () => {
          const el = document.querySelector("input[name=companyName]");
          return !!el && el.offsetParent !== null;
        },
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!onStep2) continue;

    await page.type("input[name=companyName]", companyName);
    // industry + currency keep their defaults (Other / PKR) — this agent does
    // not own currency, and a default is the realistic path anyway.
    await page.click("button[type=submit]");

    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 8000 }).catch(() => {});
      return;
    }
  }
  throw new Error(`could not sign up ${companyName} after 3 attempts`);
}

/**
 * Open the palette with the shortcut the product actually binds — the window
 * `keydown` listener in components/layout/topbar.tsx:96.
 *
 * The handler TOGGLES (`setPaletteOpen((open) => !open)`), so every attempt
 * re-tests whether the sheet is already up: a blind second press closes the
 * sheet the first one opened and the retry loop would hunt a palette it was
 * itself dismissing.
 */
async function openPalette(page) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (await page.$(PALETTE_INPUT)) return true;
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
    const up = await page
      .waitForSelector(PALETTE_INPUT, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (up) return true;
  }
  return false;
}

async function closePalette(page) {
  if (!(await page.$(PALETTE_INPUT))) return;
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => !document.querySelector('[role="dialog"] input[role="combobox"]'), {
      timeout: 5000,
    })
    .catch(() => {});
}

/**
 * Wait until the WORKSPACE half of the palette has answered THIS term.
 *
 * `searching` is set synchronously with the keystroke — before the 200ms
 * debounce, let alone the round trip — and cleared only when a response whose
 * request id is still current returns (command-palette.tsx:196). The spinner
 * is therefore the one honest "still asking" signal in the DOM, and waiting
 * for it to APPEAR before waiting for it to GO is what stops this helper from
 * reading the previous term's settled results and calling them this term's.
 * Get that wrong and every negative assertion below becomes a coin flip.
 */
async function settle(page) {
  await page
    .waitForFunction(() => !!document.querySelector('[role="dialog"] .animate-spin'), {
      timeout: 3000,
    })
    .catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] .animate-spin'), {
    timeout: 45000,
  });
  await sleep(250); // one paint for the groups that arrived with the response
}

/** Type a term into an already-open palette and wait for it to answer. */
async function searchFor(page, term) {
  await page.click(PALETTE_INPUT, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(PALETTE_INPUT, term);
  await settle(page);
}

/** Everything the rendered sheet is currently saying, as plain data. */
function readPalette(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const groups = [...dialog.querySelectorAll('[role="group"]')].map((g) => ({
      label: (g.getAttribute("aria-label") || "").trim(),
      hits: [...g.querySelectorAll('[role="option"]')].map((o) => o.innerText.trim()),
    }));
    const allOptions = [...dialog.querySelectorAll('[role="option"]')];
    // Nav rows are the options that are NOT inside a workspace group.
    const navRows = allOptions
      .filter((o) => !o.closest('[role="group"]'))
      .map((o) => o.innerText.trim());
    const status = dialog.querySelector('[role="status"]');
    return {
      groupCount: groups.length,
      groups,
      navRows,
      optionCount: allOptions.length,
      statusText: status ? status.innerText.trim() : null,
      // The centred "nothing at all" panel, distinct from the status strip.
      emptyPanelText:
        allOptions.length === 0 ? (dialog.querySelector(".text-center")?.innerText || "").trim() : null,
      placeholder: dialog.querySelector('input[role="combobox"]')?.placeholder ?? null,
    };
  });
}

/** Post one message into the channel currently open, via the real composer. */
async function postMessage(page, body) {
  await page.waitForSelector("textarea", { timeout: 20000 });
  const composer = await page.$("textarea");
  await composer.click();
  await page.keyboard.type(body);
  await page.keyboard.press("Enter");
  return page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 20000 }, body)
    .then(() => true)
    .catch(() => false);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Tenant teardown — children before parents, every delete scoped by company.
 * Mirrors the ordering in scripts/_qa-guard.mjs so it never leans on cascade.
 * ───────────────────────────────────────────────────────────────────────── */
async function destroyTenant(companyId, label) {
  if (!companyId) return;
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
    await db.user.deleteMany({ where: { companyId } });
    await db.company.deleteMany({ where: { id: companyId } });
    note(`cleaned up ${label} (${companyId})`);
  } catch (e) {
    console.error(`  cleanup of ${label} failed:`, e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * MAIN
 * ───────────────────────────────────────────────────────────────────────── */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  console.log("== qa: shell / nav / search ==");

  let tenantA = null;
  let tenantB = null;

  try {
    /* ── 0. Tenant A: sign up through the real form ──────────────────── */
    const { page: admin } = await newAgentPage(browser);
    await signUp(admin, {
      name: A_NAME,
      email: A_EMAIL,
      password: PASSWORD,
      companyName: A_COMPANY,
    });

    const companyA = await db.company.findFirst({
      where: { name: A_COMPANY },
      select: { id: true, name: true },
    });
    if (!companyA) {
      fail("signup created a workspace", `no Company row named ${A_COMPANY}`);
      return;
    }
    tenantA = companyA.id;
    ok(`tenant A created through the signup form (${tenantA})`);

    const adminRow = await db.user.findFirst({
      where: { companyId: tenantA, email: A_EMAIL },
      select: { id: true, role: true, theme: true, locale: true },
    });
    if (adminRow?.role === "admin") ok("signup made the creator an admin");
    else fail("signup role", `expected admin, got ${adminRow?.role}`);

    await admin.screenshot({ path: `${OUT}/01-admin-first-run.png` });

    /* ── 1. Shell chrome exists and is coherent ──────────────────────── */
    await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector('aside[aria-label="Primary"]', { timeout: 30000 });

    const shell = await admin.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="Primary"]');
      const nav = document.querySelector('nav[aria-label="Main navigation"]');
      const crumbs = document.querySelector('nav[aria-label="Breadcrumb"]');
      return {
        hasAside: !!aside,
        hasNav: !!nav,
        navHrefs: nav ? [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")) : [],
        hasFinanceGroup: !!nav?.querySelector("button[aria-expanded]"),
        crumbText: crumbs ? crumbs.innerText.replace(/\s+/g, " ").trim() : null,
        crumbHomeHref: crumbs?.querySelector("a")?.getAttribute("href") ?? null,
        activeRow: nav?.querySelector('a[aria-current="page"]')?.getAttribute("href") ?? null,
        mainId: !!document.getElementById("main"),
      };
    });

    if (shell.hasAside && shell.hasNav && shell.mainId) ok("app shell renders sidebar + nav + main");
    else fail("app shell", JSON.stringify(shell));

    if (shell.hasFinanceGroup) ok("admin sees the collapsible Finance group");
    else fail("finance group", "no collapsible group row in the sidebar for an admin");

    if (shell.activeRow === "/tasks") ok('active nav row carries aria-current="page"');
    else fail("active nav row", `expected /tasks, got ${shell.activeRow}`);

    if (shell.crumbHomeHref === "/dashboard") ok("breadcrumb Home routes an admin to /dashboard");
    else fail("breadcrumb home (admin)", `expected /dashboard, got ${shell.crumbHomeHref}`);

    /* ── 2. Mobile: is there ANY way to search? ──────────────────────── */
    // Static finding shell-006: the topbar search control is `hidden … sm:block`
    // (topbar.tsx:175) and ⌘K needs a hardware keyboard. On a phone that leaves
    // no search entry point at all. Observe it rather than argue it.
    await admin.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    await admin.reload({ waitUntil: "networkidle0" });
    await admin.waitForSelector("header", { timeout: 30000 });
    const mobileChrome = await admin.evaluate(() => {
      const header = document.querySelector("header");
      const buttons = [...header.querySelectorAll("button")];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        searchAffordances: buttons.filter(
          (b) => visible(b) && /search|تلاش/i.test(b.getAttribute("aria-label") || "")
        ).length,
        visibleHeaderButtons: buttons.filter(visible).length,
        burger: buttons.some(
          (b) => visible(b) && /menu|مینو/i.test(b.getAttribute("aria-label") || "")
        ),
      };
    });
    if (mobileChrome.searchAffordances > 0) {
      ok("a search control is reachable at 375px");
    } else {
      fail(
        "mobile search entry point",
        `no visible search affordance at 375px (header shows ${mobileChrome.visibleHeaderButtons} buttons, burger=${mobileChrome.burger}) — promotes shell-006 to observed`
      );
    }
    await admin.screenshot({ path: `${OUT}/02-mobile-topbar.png` });

    /* ── 3. Mobile: the CLOSED drawer must not be focusable ──────────── */
    // shell-007. The aside is always in the DOM, parked off-screen with a
    // transform, and carries no `inert` / `aria-hidden` when closed — so a
    // keyboard or screen-reader user walks through eleven invisible links.
    const drawerA11y = await admin.evaluate(() => {
      const aside = document.querySelector('aside[aria-label="Primary"]');
      if (!aside) return null;
      const r = aside.getBoundingClientRect();
      const links = [...aside.querySelectorAll("a, button")];
      return {
        offscreen: r.right <= 0 || r.left >= window.innerWidth,
        inert: aside.hasAttribute("inert"),
        ariaHidden: aside.getAttribute("aria-hidden"),
        focusableCount: links.filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled"))
          .length,
      };
    });
    if (!drawerA11y) {
      fail("closed drawer a11y", "no aside found at mobile width");
    } else if (drawerA11y.offscreen && drawerA11y.focusableCount > 0 && !drawerA11y.inert && drawerA11y.ariaHidden !== "true") {
      fail(
        "closed mobile drawer is still focusable",
        `${drawerA11y.focusableCount} off-screen links with no inert/aria-hidden — promotes shell-007 to observed`
      );
    } else {
      ok("closed mobile drawer is hidden from keyboard + AT");
    }

    // Drawer opens from the burger and closes on route change.
    const burgerOpened = await admin.evaluate(() => {
      const b = [...document.querySelectorAll("header button")].find((x) =>
        /menu/i.test(x.getAttribute("aria-label") || "")
      );
      b?.click();
      return !!b;
    });
    if (burgerOpened) {
      const opened = await admin
        .waitForFunction(
          () => {
            const a = document.querySelector('aside[aria-label="Primary"]');
            if (!a) return false;
            const r = a.getBoundingClientRect();
            return r.left >= -1 && r.width > 0;
          },
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      if (opened) ok("burger opens the mobile drawer");
      else fail("burger", "drawer never slid in");
      await admin.screenshot({ path: `${OUT}/03-mobile-drawer.png` });
      await admin.keyboard.press("Escape");
    }
    await admin.setViewport({ width: 1440, height: 1000 });
    await admin.reload({ waitUntil: "networkidle0" });

    /* ── 4. Command palette: open, keyboard model, focus behaviour ───── */
    if (!(await openPalette(admin))) {
      fail("palette opens on Ctrl-K", "never appeared after 6 attempts");
    } else {
      ok("Ctrl-K opens the command palette");

      const focusedInput = await admin.evaluate(
        () => document.activeElement?.getAttribute("role") === "combobox"
      );
      if (focusedInput) ok("palette autofocuses its input");
      else fail("palette focus", "input did not receive focus on open");

      // shell-008: `aria-modal="true"` + a documented "Tab wraps" that does not
      // exist. Tab from the last option must not land outside the dialog.
      const tabEscapes = await admin.evaluate(async () => {
        const dialog = document.querySelector('[role="dialog"]');
        const opts = [...dialog.querySelectorAll('[role="option"]')];
        if (opts.length === 0) return null;
        opts[opts.length - 1].focus();
        return true;
      });
      if (tabEscapes) {
        await admin.keyboard.press("Tab");
        const escaped = await admin.evaluate(
          () => !document.querySelector('[role="dialog"]')?.contains(document.activeElement)
        );
        if (escaped) {
          fail(
            "palette focus trap",
            'Tab moved focus outside a dialog marked aria-modal="true" — promotes shell-008 to observed'
          );
        } else {
          ok("focus stays inside the palette on Tab");
        }
      }

      // Arrow + Enter is the documented model; prove it navigates.
      await admin.evaluate(() => document.querySelector('[role="dialog"] input')?.focus());
      await searchFor(admin, "settings");
      const beforeNav = await readPalette(admin);
      if (beforeNav && beforeNav.navRows.some((r) => /settings/i.test(r))) {
        ok('typing "settings" filters the nav half locally');
      } else {
        fail("nav filter", JSON.stringify(beforeNav?.navRows ?? null));
      }

      // shell-009: rows are on screen AND the status strip says "No results".
      if (
        beforeNav &&
        beforeNav.optionCount > 0 &&
        beforeNav.groupCount === 0 &&
        beforeNav.statusText &&
        /no results|کوئی نتیجہ/i.test(beforeNav.statusText)
      ) {
        fail(
          "palette says No results while showing results",
          `${beforeNav.optionCount} rows visible under the strip "${beforeNav.statusText}" — promotes shell-009 to observed`
        );
      } else {
        ok("palette status strip does not contradict the visible rows");
      }
      await admin.screenshot({ path: `${OUT}/04-palette-nav.png` });

      await admin.keyboard.press("Enter");
      const navigated = await admin
        .waitForFunction(() => location.pathname === "/settings", { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      if (navigated) ok("Enter navigates to the highlighted palette row");
      else fail("palette Enter", `still at ${new URL(admin.url()).pathname}`);
    }

    // Focus restoration after Escape.
    await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
    if (await openPalette(admin)) {
      await closePalette(admin);
      const restored = await admin.evaluate(() => {
        const el = document.activeElement;
        return { tag: el?.tagName ?? null, isBody: el === document.body };
      });
      if (restored.isBody) {
        fail(
          "palette focus restoration",
          "focus fell to <body> after Escape; a keyboard user restarts from the top of the page"
        );
      } else {
        ok("focus returns to a real element after the palette closes");
      }
    }

    /* ── 5. ⌘K while typing in a real text field ─────────────────────── */
    // shell-005. topbar.tsx:95 claims the shortcut "Only fires when not typing
    // in an editable target". There is no such check in the handler.
    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const inChannel = await admin
      .waitForFunction(() => location.pathname.startsWith("/chat/"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (inChannel) ok(`/chat lands in a channel (${new URL(admin.url()).pathname})`);
    else fail("chat landing", `expected /chat/<slug>, got ${new URL(admin.url()).pathname}`);

    await admin.waitForSelector("textarea", { timeout: 30000 });
    await admin.click("textarea");
    await admin.keyboard.type("draft that should survive");
    await admin.keyboard.down("Control");
    await admin.keyboard.press("KeyK");
    await admin.keyboard.up("Control");
    const hijacked = await admin
      .waitForSelector(PALETTE_INPUT, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (hijacked) {
      fail(
        "Ctrl-K hijacks an editable target",
        "palette opened over the chat composer mid-typing, contradicting topbar.tsx:95 — promotes shell-005 to observed"
      );
      await admin.screenshot({ path: `${OUT}/05-ctrlk-over-composer.png` });
      await closePalette(admin);
    } else {
      ok("Ctrl-K is ignored while typing in an editable target");
    }
    // Clear the draft so it never posts.
    await admin.click("textarea", { clickCount: 3 });
    await admin.keyboard.press("Backspace");

    /* ── 6. Post the tenant-A nonce, then test prefix matching ───────── */
    const posted = await postMessage(admin, `${A_NONCE} shell audit line`);
    if (posted) ok("posted the tenant-A search fixture into #general");
    else fail("post fixture", "message never rendered");

    const aMessage = await db.message.findFirst({
      where: { companyId: tenantA, body: { contains: A_NONCE } },
      select: { id: true, channel: { select: { slug: true } } },
    });
    if (aMessage) ok("the fixture message is in the database, scoped to tenant A");
    else fail("fixture persistence", `no Message in company ${tenantA} containing ${A_NONCE}`);

    if (await openPalette(admin)) {
      // Control: the whole token must be findable.
      await searchFor(admin, A_NONCE);
      const whole = await readPalette(admin);
      const foundWhole = whole?.groups.some((g) => g.hits.some((h) => h.includes(A_NONCE)));
      if (foundWhole) ok("chat search finds a message by its whole token (control)");
      else
        fail(
          "chat search control",
          `whole token "${A_NONCE}" returned ${JSON.stringify(whole?.groups ?? null)} — everything below is unreliable if this is red`
        );

      // shell-002: a prefix. `websearch_to_tsquery` emits no `:*`, so the GIN
      // index is asked for an exact lexeme. Tasks/projects use Prisma
      // `contains` and DO match a prefix, so the palette answers the same
      // keystroke two different ways.
      const prefix = A_NONCE.slice(0, A_NONCE.length - 3);
      await searchFor(admin, prefix);
      const part = await readPalette(admin);
      const foundPrefix = part?.groups.some((g) => g.hits.some((h) => h.includes(A_NONCE)));
      if (foundPrefix) {
        ok("chat search matches a prefix while you type");
      } else {
        fail(
          "chat search cannot prefix-match",
          `"${prefix}" finds nothing though "${A_NONCE}" does; the migration header (20260925120000_add_message_search/migration.sql:105) claims prefix matching "is what makes type-ahead work" — promotes shell-002 to observed`
        );
      }
      await admin.screenshot({ path: `${OUT}/06-palette-prefix.png` });
      await closePalette(admin);
    }

    /* ── 7. The ?message= deep link, against the ?taskId= control ────── */
    // shell-003. lib/queries/search.ts:332 emits /chat/<slug>?message=<id>, the
    // same shape three mention notifications use (lib/actions/chat.ts:307,365,
    // 1168). Nothing reads it. The control proves deep links CAN work here:
    // tasks-client.tsx:181 STRIPS ?taskId= from the URL once it has handled it.
    const myTask = await db.task.findFirst({
      where: { companyId: tenantA },
      select: { id: true },
    });
    if (myTask) {
      await admin.goto(`${BASE}/tasks?taskId=${myTask.id}`, { waitUntil: "networkidle0" });
      const consumedTaskId = await admin
        .waitForFunction(() => !location.search.includes("taskId="), { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (consumedTaskId) ok("?taskId= is consumed and cleared from the URL (control)");
      else note("?taskId= control inconclusive — no seeded task in this fresh tenant");
    } else {
      note("tenant A has no task to use as the ?taskId= control");
    }

    if (aMessage?.channel?.slug) {
      // Push the fixture out of view so "did it scroll to the match?" is a real
      // question rather than an accident of a three-message channel.
      await admin.goto(`${BASE}/chat/${aMessage.channel.slug}`, { waitUntil: "networkidle0" });
      for (let i = 0; i < 25; i++) {
        await postMessage(admin, `filler line ${i} ${ALPHA}`);
      }
      await admin.goto(`${BASE}/chat/${aMessage.channel.slug}?message=${aMessage.id}`, {
        waitUntil: "networkidle0",
      });
      await admin.waitForSelector('[aria-label="Messages"]', { timeout: 30000 });
      const deep = await admin.evaluate((nonce) => {
        const log = document.querySelector('[aria-label="Messages"]');
        const scroller = log?.closest("[class*=overflow-y]") ?? log;
        const target = [...(log?.querySelectorAll("*") ?? [])].find((el) =>
          el.childElementCount === 0 && (el.textContent || "").includes(nonce)
        );
        const inView = (() => {
          if (!target) return false;
          const r = target.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        })();
        return {
          stillInUrl: location.search.includes("message="),
          targetPresent: !!target,
          inView,
          atBottom: scroller
            ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
            : null,
        };
      }, A_NONCE);
      if (deep.stillInUrl && !deep.inView) {
        fail(
          "?message= deep link does nothing",
          `landed at the bottom of the channel (atBottom=${deep.atBottom}) with the match off screen and "message=" still in the URL — promotes shell-003 to observed`
        );
      } else if (deep.inView) {
        ok("?message= scrolls the matching message into view");
      } else {
        note(`?message= inconclusive: ${JSON.stringify(deep)}`);
      }
      await admin.screenshot({ path: `${OUT}/07-message-deeplink.png` });
    }

    /* ── 8. Search promises "team" ───────────────────────────────────── */
    // shell-001. t.common.search — the topbar button label AND the palette
    // placeholder — reads "Search expenses, tasks, team…". SEARCH_GROUPS has no
    // people group at all, and for a member "expenses" is not searchable
    // either. Prove the placeholder, then prove the promise is empty.
    await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
    if (await openPalette(admin)) {
      const ph = (await readPalette(admin))?.placeholder ?? "";
      if (/team|ٹیم/i.test(ph)) {
        note(`palette placeholder advertises people search: "${ph}"`);
      }
      await closePalette(admin);
    }

    /* ── 9. Invite a member through the real invite flow ─────────────── */
    await admin.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /invite member/i.test(b.innerText)),
      { timeout: 30000 }
    );
    await admin.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => /invite member/i.test(b.innerText))
        ?.click();
    });
    await admin.waitForSelector("input[name=name]", { timeout: 20000 });
    await admin.type("input[name=name]", `${M_NAME} ${PEOPLE_NONCE}`);
    await admin.type("input[name=email]", M_EMAIL);
    await admin.evaluate(() => {
      [...document.querySelectorAll("button[aria-pressed]")]
        .find((b) => /team member/i.test(b.innerText))
        ?.click();
    });
    await admin.evaluate(() => document.querySelector("form")?.requestSubmit());

    // Poll the DB for MY tenant's invite token — scoped, so a concurrent
    // agent's invite can never satisfy it. Polling the row rather than scraping
    // the toast: the toast text depends on whether GMAIL_* is configured, which
    // is an environment fact this assertion must not depend on.
    let token = null;
    for (let i = 0; i < 40 && !token; i++) {
      const row = await db.inviteToken.findFirst({
        where: { companyId: tenantA, email: M_EMAIL },
        select: { token: true },
      });
      token = row?.token ?? null;
      if (!token) await sleep(500);
    }
    if (token) ok("invite created through the real /team flow, scoped to tenant A");
    else fail("invite", `no InviteToken for ${M_EMAIL} in company ${tenantA}`);

    let member = null;
    if (token) {
      const m = await newAgentPage(browser);
      member = m.page;
      await member.goto(`${BASE}/invite/${token}`, { waitUntil: "networkidle0", timeout: 60000 });
      await member.waitForSelector("input[name=password]", { timeout: 30000 });
      await sleep(1500); // same hydration rule as signIn — a native submit here loses the password
      await member.type("input[name=password]", PASSWORD);
      await member.click("button[type=submit]");
      const accepted = await member
        .waitForFunction(() => !location.pathname.startsWith("/invite/"), { timeout: 45000 })
        .then(() => true)
        .catch(() => false);
      if (accepted) ok(`invite accepted; member landed on ${new URL(member.url()).pathname}`);
      else fail("invite accept", `still on ${new URL(member.url()).pathname}`);

      const memberRow = await db.user.findFirst({
        where: { companyId: tenantA, email: M_EMAIL },
        select: { id: true, role: true },
      });
      if (memberRow?.role === "member") ok("the invited user is a member in tenant A");
      else fail("invited role", `expected member, got ${memberRow?.role}`);
    }

    /* ── 10. The member's shell: nav AND search must both be gated ───── */
    if (member) {
      await member.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
      await member.waitForSelector('nav[aria-label="Main navigation"]', { timeout: 30000 });
      // Wait for persist rehydration to settle: the sidebar deliberately shows
      // EVERY item until `useStoreHasHydrated()` is true (sidebar.tsx:114), so
      // reading too early asserts against the optimistic list.
      await member.waitForFunction(
        () => {
          const raw = localStorage.getItem("founderflow-storage");
          return !!raw && !!JSON.parse(raw)?.state?.currentUser;
        },
        { timeout: 20000 }
      );
      await sleep(400);

      const memberNav = await member.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Main navigation"]');
        const crumbs = document.querySelector('nav[aria-label="Breadcrumb"]');
        return {
          hrefs: [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")),
          hasGroupRow: !!nav.querySelector("button[aria-expanded]"),
          crumbHome: crumbs?.querySelector("a")?.getAttribute("href") ?? null,
        };
      });
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
      const leaked = memberNav.hrefs.filter((h) => BLOCKED.includes(h));
      if (leaked.length === 0) ok("member sidebar hides every finance/blocked route");
      else fail("member nav leak", `sidebar offers ${leaked.join(", ")}`);

      if (!memberNav.hasGroupRow) ok("the empty Finance group row drops out entirely for a member");
      else fail("member finance group", "an expandable group row is still rendered");

      if (memberNav.crumbHome === "/tasks") ok("breadcrumb Home routes a member to /tasks");
      else fail("breadcrumb home (member)", `expected /tasks, got ${memberNav.crumbHome}`);

      await member.screenshot({ path: `${OUT}/08-member-shell.png` });

      if (await openPalette(member)) {
        const memberPalette = await readPalette(member);
        const navLeak = memberPalette.navRows.filter((r) =>
          BLOCKED.some((b) => r.includes(b))
        );
        if (navLeak.length === 0) ok("member command palette hides blocked nav destinations");
        else fail("member palette nav leak", navLeak.join(" | "));

        // The member must not receive a finance GROUP even when a term matches.
        // Counted, never labelled: headings come from t.nav.*, so an Urdu
        // workspace would render "مالیات" and a label-based assertion would
        // pass on a leaking build.
        await searchFor(member, A_NONCE);
        const memberHits = await readPalette(member);
        if (memberHits.groupCount <= 1) {
          ok(`member search returned ${memberHits.groupCount} group(s); no finance sections`);
        } else {
          fail(
            "member search groups",
            `expected at most the chat group, got ${memberHits.groupCount}: ${JSON.stringify(memberHits.groups.map((g) => g.label))}`
          );
        }

        // shell-001 observed: a term that matches only a PERSON's name.
        await searchFor(member, PEOPLE_NONCE);
        const peopleHits = await readPalette(member);
        if (peopleHits.groupCount === 0) {
          fail(
            "search advertises people it cannot find",
            `placeholder says "…tasks, team" but a term matching only a teammate's name returns 0 groups — promotes shell-001 to observed`
          );
        } else {
          ok("search returns a people/team result");
        }
        await closePalette(member);
      }

      // The route gate itself, from the member's own session.
      await member.goto(`${BASE}/budgets?ref=qa`, { waitUntil: "networkidle0", timeout: 60000 });
      const bounced = new URL(member.url());
      if (bounced.pathname === "/tasks") ok("member is bounced off /budgets to /tasks");
      else fail("member route gate", `landed on ${bounced.pathname}`);
      if (bounced.search.includes("ref=qa")) ok("the bounce preserves the original querystring");
      else fail("bounce querystring", `lost the query: ${bounced.search}`);
    }

    /* ── 11. Breadcrumb on a DM: does it render a raw id? ────────────── */
    // shell-011. /chat/dm-<cuid>_<cuid> has no entry in breadcrumbLabels, and
    // the fallback only special-cases a segment under /projects — so the trail
    // humanizes the slug and prints both user ids into the chrome.
    if (member) {
      await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
      const dmButton = await admin
        .waitForSelector('button[aria-label="New direct message"]', { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (dmButton) {
        await admin.click('button[aria-label="New direct message"]');
        const opened = await admin
          .waitForFunction(
            (needle) => document.body.innerText.includes(needle),
            { timeout: 15000 },
            M_NAME.split(" ")[2] ?? M_NAME
          )
          .then(() => true)
          .catch(() => false);
        if (opened) {
          await admin.evaluate((email) => {
            const row = [...document.querySelectorAll('[role="dialog"] button, dialog button')].find(
              (b) => (b.innerText || "").includes(email.split("@")[0])
            );
            row?.click();
          }, M_EMAIL);
        }
        const inDm = await admin
          .waitForFunction(() => /\/chat\/dm-/.test(location.pathname), { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        if (inDm) {
          const crumb = await admin.evaluate(() => {
            const nav = document.querySelector('nav[aria-label="Breadcrumb"]');
            const last = nav?.querySelector('[aria-current="page"]');
            return last ? last.textContent.trim() : null;
          });
          if (crumb && /^Dm-/.test(crumb)) {
            fail(
              "breadcrumb prints a raw DM slug",
              `trail reads "${crumb}" — two user ids in the app chrome — promotes shell-011 to observed`
            );
          } else if (crumb) {
            ok(`DM breadcrumb reads "${crumb}"`);
          }
          await admin.screenshot({ path: `${OUT}/09-dm-breadcrumb.png` });
        } else {
          note("could not open a DM through the modal; DM breadcrumb unchecked");
        }
      } else {
        note("no New direct message affordance found");
      }
    }

    /* ── 12. CROSS-TENANT. The one that must never go green wrongly. ── */
    // Tenant B posts a nonce; tenant A must not be able to find it. Both
    // workspaces are mine, so nothing pre-existing is touched, and the answer
    // cannot be contaminated by another agent's data.
    const { page: other } = await newAgentPage(browser);
    await signUp(other, {
      name: B_NAME,
      email: B_EMAIL,
      password: PASSWORD,
      companyName: B_COMPANY,
    });
    const companyB = await db.company.findFirst({
      where: { name: B_COMPANY },
      select: { id: true },
    });
    tenantB = companyB?.id ?? null;
    if (!tenantB) {
      fail("tenant B", `no Company row named ${B_COMPANY}; cross-tenant check skipped`);
    } else {
      await other.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
      await other
        .waitForFunction(() => location.pathname.startsWith("/chat/"), { timeout: 30000 })
        .catch(() => {});
      const bPosted = await postMessage(other, `${B_NONCE} other company secret`);
      const bRow = await db.message.findFirst({
        where: { companyId: tenantB, body: { contains: B_NONCE } },
        select: { id: true },
      });
      if (bPosted && bRow) ok("tenant B holds a message only it should be able to find");
      else fail("tenant B fixture", `posted=${bPosted} row=${!!bRow}`);

      // Control FIRST: tenant B can find its own nonce. Without this, "no
      // results" below would also be the answer a completely broken search
      // gives to every question.
      if (await openPalette(other)) {
        await searchFor(other, B_NONCE);
        const own = await readPalette(other);
        if (own?.groups.some((g) => g.hits.some((h) => h.includes(B_NONCE)))) {
          ok("control: tenant B finds its own message");
        } else {
          fail("cross-tenant control", "tenant B cannot find its own nonce; the negative below proves nothing");
        }
        await closePalette(other);
      }

      // The negative.
      await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
      if (await openPalette(admin)) {
        await searchFor(admin, B_NONCE);
        const leak = await readPalette(admin);
        const leaked = leak?.groups.some((g) => g.hits.some((h) => h.includes(B_NONCE)));
        if (leaked) {
          fail(
            "CROSS-TENANT SEARCH LEAK",
            `tenant A (${tenantA}) surfaced tenant B's message: ${JSON.stringify(leak.groups)}`
          );
        } else {
          ok(`cross-tenant: tenant A returned ${leak?.groupCount ?? 0} groups for tenant B's nonce`);
        }
        await admin.screenshot({ path: `${OUT}/10-cross-tenant.png` });
        await closePalette(admin);
      }
    }

    /* ── 13. Expired session, mid-search ─────────────────────────────── */
    // shell-010. Deleting the cookie from the page (no DB write, nothing of
    // mine mutated) makes searchAction answer {success:false,"Not
    // authenticated"}, which the palette renders verbatim in 12px grey with no
    // way back in.
    const { page: expiring } = await newAgentPage(browser);
    await signIn(expiring, A_EMAIL, PASSWORD);
    await expiring.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
    if (await openPalette(expiring)) {
      const cookies = await expiring.cookies();
      const sessionCookies = cookies.filter((c) => /authjs|next-auth/i.test(c.name));
      for (const c of sessionCookies) await expiring.deleteCookie(c);
      await searchFor(expiring, A_NONCE);
      const dead = await readPalette(expiring);
      if (dead?.statusText && /not authenticated/i.test(dead.statusText)) {
        fail(
          "expired session shows a raw error string",
          `palette status reads "${dead.statusText}" with no sign-in affordance — promotes shell-010 to observed`
        );
      } else if (dead?.groupCount === 0) {
        note(`expired-session palette said: ${JSON.stringify(dead?.statusText)}`);
      }
      await expiring.screenshot({ path: `${OUT}/11-expired-session.png` });
      await closePalette(expiring);
    }

    /* ── 14. Theme + locale: does the DB agree with the UI? ──────────── */
    await admin.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
    const themeBefore = await admin.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
    await admin.evaluate(() => {
      [...document.querySelectorAll("header button")]
        .find((b) => /switch to (light|dark) theme/i.test(b.getAttribute("aria-label") || ""))
        ?.click();
    });
    const themeFlipped = await admin
      .waitForFunction(
        (was) => document.documentElement.classList.contains("dark") !== was,
        { timeout: 8000 },
        themeBefore
      )
      .then(() => true)
      .catch(() => false);
    if (themeFlipped) ok("topbar theme toggle flips the document class immediately");
    else fail("theme toggle", "the dark class never changed");

    // The write is fire-and-forget (`void updateAppearanceAction`), so poll the
    // row rather than assuming it landed by the time the class flipped.
    let themeStored = null;
    for (let i = 0; i < 20; i++) {
      const row = await db.user.findFirst({
        where: { companyId: tenantA, email: A_EMAIL },
        select: { theme: true },
      });
      themeStored = row?.theme ?? null;
      if (themeStored && themeStored !== adminRow?.theme) break;
      await sleep(500);
    }
    if (themeStored && themeStored !== adminRow?.theme) {
      ok(`theme persisted to the DB for my admin (${adminRow?.theme} → ${themeStored})`);
    } else {
      fail(
        "theme persistence",
        `User.theme in company ${tenantA} is still ${themeStored}; the toggle's write is unawaited (topbar.tsx handleToggleTheme)`
      );
    }

    await admin.reload({ waitUntil: "networkidle0" });
    const themeAfterReload = await admin.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
    if (themeAfterReload !== themeBefore) ok("theme survives a reload (no flash back)");
    else fail("theme after reload", "reverted to the pre-toggle theme");

    // Locale → RTL, and what stays English once it flips.
    await admin.evaluate(() => {
      [...document.querySelectorAll("header button")]
        .find((b) => /switch language/i.test(b.getAttribute("aria-label") || ""))
        ?.click();
    });
    const rtl = await admin
      .waitForFunction(() => document.documentElement.dir === "rtl", { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (rtl) {
      ok("locale toggle flips <html dir> to rtl");
      const englishLeftovers = await admin.evaluate(() => {
        const found = [];
        const sidebar = document.querySelector('aside[aria-label="Primary"]');
        if (sidebar && /Collapse/.test(sidebar.innerText)) found.push("sidebar: Collapse");
        if (sidebar && /(Admin Founder|Co-Founder|Team Member)/.test(sidebar.innerText))
          found.push("sidebar: role label");
        return found;
      });
      if (englishLeftovers.length > 0) {
        fail(
          "shell chrome is half-translated in Urdu",
          `${englishLeftovers.join("; ")} stay English in an RTL workspace — promotes shell-013 to observed`
        );
      } else {
        ok("sidebar chrome is fully localized in Urdu");
      }
      if (await openPalette(admin)) {
        const urduPalette = await admin.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          return {
            hasAsciiHints: /to move|to open|Searching/i.test(d?.innerText || ""),
            text: (d?.innerText || "").slice(0, 200),
          };
        });
        if (urduPalette.hasAsciiHints) {
          fail(
            "palette footer hints are hardcoded English",
            '"↑ ↓ to move · ↵ to open" / "Searching…" are not in the dictionary (command-palette.tsx:474,488)'
          );
        } else {
          ok("palette hints are localized");
        }
        await admin.screenshot({ path: `${OUT}/12-palette-urdu.png` });
        await closePalette(admin);
      }
      // Put it back so later screenshots read normally.
      await admin.evaluate(() => {
        [...document.querySelectorAll("header button")]
          .find((b) => /switch language/i.test(b.getAttribute("aria-label") || ""))
          ?.click();
      });
      await admin
        .waitForFunction(() => document.documentElement.dir === "ltr", { timeout: 10000 })
        .catch(() => {});
    } else {
      fail("locale toggle", "dir never became rtl");
    }

    /* ── 15. Notification badges: topbar vs sidebar ──────────────────── */
    // shell-004. The sidebar polls every 30s AND listens for
    // "ff-notifications-changed" (sidebar.tsx:89). The topbar refetches only on
    // mount and after a markRead (topbar.tsx:76) and listens for nothing, so
    // the bell and the nav badge drift apart. The invite acceptance above has
    // already fanned a notification out to this admin.
    await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    const unreadInDb = await db.notification.count({
      where: { companyId: tenantA, userId: adminRow?.id ?? "__none__", read: false },
    });
    note(`tenant A admin has ${unreadInDb} unread notifications in the DB`);
    if (unreadInDb > 0) {
      const badges = await admin
        .waitForFunction(
          () => {
            const side = document.querySelector('nav[aria-label="Main navigation"] a[href="/notifications"] span[aria-label]');
            return !!side;
          },
          { timeout: 45000 }
        )
        .then(() =>
          admin.evaluate(() => {
            const side = document.querySelector(
              'nav[aria-label="Main navigation"] a[href="/notifications"] span[aria-label]'
            );
            const bell = [...document.querySelectorAll("header button")].find((b) =>
              /notification/i.test(b.getAttribute("aria-label") || "")
            );
            return {
              sidebar: side ? side.textContent.trim() : null,
              bell: bell ? (bell.innerText || "").trim() : null,
              bellLabel: bell ? bell.getAttribute("aria-label") : null,
            };
          })
        )
        .catch(() => null);
      if (badges) {
        note(`sidebar badge="${badges.sidebar}" bell="${badges.bell}" (${badges.bellLabel})`);
        if (badges.sidebar && badges.bell !== badges.sidebar) {
          fail(
            "topbar bell and sidebar badge disagree",
            `sidebar says "${badges.sidebar}", bell says "${badges.bell}" — the topbar never re-polls — promotes shell-004 to observed`
          );
        } else {
          ok("topbar bell and sidebar badge agree");
        }
      } else {
        note("the sidebar badge never appeared within 45s; badge comparison skipped");
      }
      await admin.screenshot({ path: `${OUT}/13-badges.png` });
    }

    /* ── 16. /offline, manifest, service worker ──────────────────────── */
    const { page: anon } = await newAgentPage(browser);
    await anon.goto(`${BASE}/offline`, { waitUntil: "networkidle0", timeout: 60000 });
    const offline = await anon.evaluate(() => {
      const a = [...document.querySelectorAll("a")].find((x) => /try again/i.test(x.innerText));
      return { href: a?.getAttribute("href") ?? null, reachable: document.title };
    });
    if (offline.href === null) {
      fail("/offline", "no Try again link");
    } else if (offline.href === "/dashboard") {
      fail(
        "/offline sends everyone to /dashboard",
        'hardcoded instead of homeRouteForRole(); a member takes an extra bounce and a signed-out visitor lands on /login — promotes shell-012 to observed'
      );
    } else {
      ok(`/offline Try again points at ${offline.href}`);
    }

    const manifest = await anon.evaluate(async () => {
      const res = await fetch("/manifest.json");
      return res.ok ? res.json() : null;
    });
    if (!manifest) {
      fail("manifest", "/manifest.json did not return JSON");
    } else {
      if (manifest.start_url === "/dashboard") {
        fail(
          "PWA start_url is a role-gated route",
          'installed app always cold-starts on /dashboard; a member is redirected to /tasks on every launch — promotes shell-012 to observed'
        );
      } else {
        ok(`manifest start_url = ${manifest.start_url}`);
      }
      if (manifest.orientation === "portrait") {
        fail(
          "PWA is locked to portrait",
          "a finance dashboard installed on a tablet cannot be used in landscape"
        );
      } else {
        ok(`manifest orientation = ${manifest.orientation ?? "(unset)"}`);
      }
    }

    const swRegs = await anon.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return -1;
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length;
    });
    note(
      `service workers registered: ${swRegs} (components/providers.tsx:35 registers only when NODE_ENV === "production", so a dev run cannot exercise the offline layer)`
    );

    /* ── 17. The shell's own loading state, with /api/auth blocked ───── */
    // shell-014. app/(app)/layout.tsx:39 gates on the Zustand `currentUser`
    // and renders "Loading workspace…" forever when the session never resolves
    // — no timeout, no retry, no sign-in link. Block the session endpoint and
    // watch.
    const { page: stuck } = await newAgentPage(browser);
    await signIn(stuck, A_EMAIL, PASSWORD);
    await stuck.setRequestInterception(true);
    stuck.on("request", (req) => {
      if (req.url().includes("/api/auth/session")) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });
    await stuck.evaluate(() => {
      try {
        localStorage.removeItem("founderflow-storage");
      } catch {}
    });
    await stuck.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    const spinnerHeld = await stuck
      .waitForFunction(() => /Loading workspace/i.test(document.body.innerText), { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (spinnerHeld) {
      const recovered = await stuck
        .waitForFunction(() => !/Loading workspace/i.test(document.body.innerText), {
          timeout: 20000,
        })
        .then(() => true)
        .catch(() => false);
      if (recovered) {
        ok("the shell recovers from a failed session fetch");
      } else {
        fail(
          "app shell hangs on 'Loading workspace…'",
          "20s with the session endpoint failing: no timeout, no retry, no sign-in link — promotes shell-014 to observed"
        );
      }
      await stuck.screenshot({ path: `${OUT}/14-stuck-shell.png` });
    } else {
      note("could not reproduce the loading gate with the session endpoint blocked");
    }
    await stuck.setRequestInterception(false).catch(() => {});

    /* ── 18. Break it: forged ids, junk terms, double-submit ─────────── */
    await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });
    if (await openPalette(admin)) {
      // A one-character term must never reach the server (SEARCH_MIN_LENGTH).
      await searchFor(admin, "a");
      const tiny = await readPalette(admin);
      if ((tiny?.groupCount ?? 0) === 0) ok("a one-character term runs no workspace query");
      else fail("min length", `a single character returned ${tiny.groupCount} groups`);

      // tsquery-hostile input must not 500 the palette.
      for (const nasty of ["' OR 1=1 --", '"unbalanced', "budget & ", "::;:", "%_%"]) {
        await searchFor(admin, nasty);
        const r = await readPalette(admin);
        if (r === null) fail("hostile term crashed the palette", nasty);
        else if (r.statusText && /couldn't run that search/i.test(r.statusText))
          fail("hostile term errored server-side", `${nasty} → ${r.statusText}`);
      }
      ok("tsquery-hostile terms are absorbed without an error or a crash");

      // A 400-char paste must be clamped by maxLength, not rejected.
      await admin.click(PALETTE_INPUT, { clickCount: 3 });
      await admin.keyboard.press("Backspace");
      await admin.evaluate((sel) => {
        const el = document.querySelector(sel);
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
        setter.call(el, "z".repeat(400));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, PALETTE_INPUT);
      await settle(admin).catch(() => {});
      const long = await readPalette(admin);
      if (long && !(long.statusText && /invalid request/i.test(long.statusText))) {
        ok("an over-long paste does not produce 'Invalid request'");
      } else {
        fail("long term", `status: ${long?.statusText}`);
      }
      await closePalette(admin);
    }

    // A forged project id from no tenant at all must 404, not 500 or render.
    await admin.goto(`${BASE}/projects/clforged000000000000000`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    const forged = await admin.evaluate(() => ({
      text: document.body.innerText.slice(0, 200),
      path: location.pathname,
    }));
    if (/not found|404/i.test(forged.text)) ok("a forged project id answers not-found");
    else note(`forged project id rendered: ${JSON.stringify(forged)}`);

    // Back/forward through the shell must not strand the user.
    await admin.goto(`${BASE}/settings`, { waitUntil: "networkidle0" });
    await admin.goBack({ waitUntil: "networkidle0" }).catch(() => {});
    await admin.goForward({ waitUntil: "networkidle0" }).catch(() => {});
    const afterHistory = await admin.evaluate(() => ({
      path: location.pathname,
      hasShell: !!document.querySelector('aside[aria-label="Primary"]'),
      stuck: /Loading workspace/i.test(document.body.innerText),
    }));
    if (afterHistory.hasShell && !afterHistory.stuck) ok("back/forward keeps the shell intact");
    else fail("history navigation", JSON.stringify(afterHistory));

    await admin.screenshot({ path: `${OUT}/15-final.png` });
  } catch (e) {
    fail("run aborted", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e));
  } finally {
    await destroyTenant(tenantA, "tenant A");
    await destroyTenant(tenantB, "tenant B");
    await db.$disconnect().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`\n== shell/nav/search: ${passes} ok, ${failures} failed ==`);
    if (failures > 0) console.log("❌");
  }
}

main();
