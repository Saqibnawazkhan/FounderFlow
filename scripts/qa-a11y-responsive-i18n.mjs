/*
 * QA — accessibility / responsive / internationalisation.   AGENT_INDEX = 19
 *
 * Authored in Phase 1 (static). Phase 2 runs it to promote each `static`
 * finding in the a11y-responsive-i18n set to `observed` — every assertion below
 * maps to exactly one finding id, named in its label.
 *
 * ── DATA SAFETY ─────────────────────────────────────────────────────────────
 * This script never writes a pre-existing row. It signs up its OWN workspace
 * through the real signup form (`qa-a11y-<stamp>`), invites its OWN member
 * through the real invite flow, and every DB assertion carries
 * `where: { companyId: TENANT }`. A bare `db.X.count()` would let another
 * agent's concurrent insert satisfy a "did mine land?" check and produce a
 * FALSE PASS, so there is not one in this file. Seeded rows are READ to learn
 * the app and never asserted on, never written.
 *
 * Reached through `localDb()` — never `new PrismaClient()`, which auto-loads
 * the root `.env` and points at PRODUCTION Supabase
 * (tests/lib/db/script-safety.test.ts enforces this across scripts/).
 *
 * ── WHY x-real-ip ───────────────────────────────────────────────────────────
 * `getClientIp()` falls back to the literal string "unknown" in dev, so
 * without a per-agent header every agent shares ONE `limiters.auth` bucket of
 * 5/60s fed by nine call sites, and we starve each other into false "cannot
 * sign in" bugs. Every page in this file is born in `newAgentPage()`, which
 * stamps 10.99.0.19 BEFORE the first navigation. There is no other newPage().
 *
 * ── WHY NO FIXED WAITS ──────────────────────────────────────────────────────
 * Every wait is a state predicate (`waitForFunction`). The only `sleep` is the
 * 1500ms hydration pause inside `signIn` / `signUp`, copied verbatim from
 * scripts/smoke-chat.mjs: on a cold dev server the form paints before React
 * hydrates and a click that lands first does a NATIVE GET submit with the
 * credentials in the query string (FaultsAudit A14).
 *
 * Usage:  node scripts/qa-a11y-responsive-i18n.mjs
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** Per-agent screenshot directory. A shared fixed filename destroys evidence. */
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/a11y-responsive-i18n";
/** Agent 19's rate-limit identity. See the header. */
const AGENT_IP = "10.99.0.19";

const STAMP = Date.now().toString().slice(-8);

/** The workspace under test. Prefix `qa-` so the sweeper finds it. */
const COMPANY = `qa-a11y-${STAMP}`;
const ADMIN_EMAIL = `qa-a11y-${STAMP}@founderflow.test`;
const ADMIN_NAME = `QA A11y Admin ${STAMP}`;
const MEMBER_EMAIL = `qa-a11y-mem-${STAMP}@founderflow.test`;
const MEMBER_NAME = `QA A11y Member ${STAMP}`;
const PASSWORD = `QaA11y!${STAMP}`;

/** 375 x 812 — the iPhone-class viewport the brief names. */
const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 1000 };

/** Every authenticated route an admin can reach, for the Urdu sweep. */
const ADMIN_ROUTES = [
  "/dashboard",
  "/chat",
  "/expenses",
  "/investments",
  "/revenue",
  "/recurring",
  "/budgets",
  "/projects",
  "/tasks",
  "/time",
  "/activities",
  "/team",
  "/reports",
  "/notifications",
  "/settings",
];

/** Public routes that carry the root layout's skip link. */
const PUBLIC_ROUTES = ["/", "/login", "/signup", "/forgot-password", "/offline"];

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

function section(title) {
  console.log(`\n── ${title} ──`);
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
 * first navigation. Every page in this file is born here, so there is no way
 * to forget the header.
 *
 * `recordEarlyDir` installs an on-new-document hook that samples
 * `<html dir>` at DOMContentLoaded — i.e. at first paint, BEFORE React
 * hydrates — which is the only way to observe the pre-paint direction the
 * root layout's inline bootstrap is supposed to set (finding i18n-002).
 */
async function newAgentPage(browser, { recordEarlyDir = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  if (recordEarlyDir) {
    await page.evaluateOnNewDocument(() => {
      window.__ffEarly = [];
      const snap = (phase) => {
        window.__ffEarly.push({
          phase,
          dir: document.documentElement.getAttribute("dir"),
          lang: document.documentElement.getAttribute("lang"),
          dark: document.documentElement.classList.contains("dark"),
          t: performance.now(),
        });
      };
      document.addEventListener("DOMContentLoaded", () => snap("domcontentloaded"), { once: true });
      window.addEventListener("load", () => snap("load"), { once: true });
    });
  }
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

/* ─────────────────────────────────────────────────────────────────────────
 * In-page helpers, injected once per page.
 *
 * WCAG contrast has to be measured on the RENDERED result, not on the token
 * table: `text-danger` is #dc2626 in both themes but its background is a
 * composite of `bg-danger/10` over `bg-surface` over `bg-bg`, and only the
 * browser knows the final pixels. `effectiveBg` walks ancestors compositing
 * alpha until it reaches an opaque layer, exactly as the compositor does.
 * ───────────────────────────────────────────────────────────────────────── */
const A11Y_HELPERS = `
window.__ffA11y = (function () {
  function parse(c) {
    const m = String(c).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\/\\s]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(fg, bg) {
    const a = fg.a;
    return {
      r: fg.r * a + bg.r * (1 - a),
      g: fg.g * a + bg.g * (1 - a),
      b: fg.b * a + bg.b * (1 - a),
      a: 1,
    };
  }
  function lum(c) {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  /** Composite every ancestor background until opaque. Matches the compositor. */
  function effectiveBg(el) {
    let acc = null;
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) acc = acc === null ? bg : over(acc, bg);
      if (acc && acc.a >= 0.999) return acc;
      node = node.parentElement;
    }
    const html = parse(getComputedStyle(document.documentElement).backgroundColor);
    const base = html && html.a > 0 ? html : { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, base) : base;
  }
  function textContrast(el) {
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) return null;
    const bg = effectiveBg(el);
    const composited = fg.a < 1 ? over(fg, bg) : fg;
    const px = parseFloat(cs.fontSize) || 16;
    const weight = Number(cs.fontWeight) || 400;
    // WCAG "large text": >= 24px, or >= 18.66px bold.
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    return {
      ratio: Math.round(ratio(composited, bg) * 100) / 100,
      required: large ? 3 : 4.5,
      px,
      weight,
      color: cs.color,
      bg: "rgb(" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + ")",
    };
  }
  /** The focus-indicator "signature": everything a sighted user could notice. */
  function focusSignature(el) {
    const cs = getComputedStyle(el);
    return {
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
      borderColor: cs.borderTopColor,
      borderWidth: cs.borderTopWidth,
      background: cs.backgroundColor,
      effectiveBg: (function () { const b = effectiveBg(el); return "rgb(" + Math.round(b.r) + "," + Math.round(b.g) + "," + Math.round(b.b) + ")"; })(),
    };
  }
  /** 1.4.11: a state change carried only by colour needs >= 3:1 between states. */
  function stateContrast(a, b) {
    const pa = parse(a), pb = parse(b);
    if (!pa || !pb) return null;
    return Math.round(ratio(pa, pb) * 100) / 100;
  }
  function visibleText(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(p);
        if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        // sr-only counts: a screen reader hears it, so it must be translated.
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n.nodeValue.trim());
    return out;
  }
  /** Every element that paints outside the viewport with no scrollable escape. */
  function clippedOverflow() {
    const w = window.innerWidth;
    const bad = [];
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const outLeft = r.left < -1;
      const outRight = r.right > w + 1;
      if (!outLeft && !outRight) return;
      // Is there a scrollable ancestor that could reach it?
      let node = el.parentElement, reachable = false;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1) {
          reachable = true;
          break;
        }
        node = node.parentElement;
      }
      if (reachable) return;
      bad.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 90),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: (el.textContent || "").trim().slice(0, 50),
      });
    });
    // Only the outermost offender per subtree — a clipped parent clips its kids.
    return bad.slice(0, 12);
  }
  return { parse, lum, ratio, effectiveBg, textContrast, focusSignature, stateContrast, visibleText, clippedOverflow };
})();
`;

async function inject(page) {
  await page.evaluate(A11Y_HELPERS);
}

/** Tab once and describe whatever now has focus. */
async function tabAndDescribe(page) {
  await page.keyboard.press("Tab");
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 48),
      href: el.getAttribute("href") || null,
      rect: { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) },
      opacity: cs.opacity,
      visibility: cs.visibility,
      offscreen: r.right <= 0 || r.left >= window.innerWidth,
      inDialog: !!el.closest('[role="dialog"]'),
      inAside: !!el.closest("aside"),
    };
  });
}

/** Flip the UI locale with the control the product actually ships (topbar). */
async function setLocale(page, code) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("header button[aria-label]")].find((b) =>
      /switch language/i.test(b.getAttribute("aria-label") || "")
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) return false;
  return page
    .waitForFunction(
      (want) => document.documentElement.getAttribute("lang") === want,
      { timeout: 10000 },
      code
    )
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
    defaultViewport: DESKTOP,
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  console.log("== qa: a11y / responsive / i18n ==");

  let TENANT = null;

  try {
    /* ── 0. Sign up MY OWN workspace through the real form ─────────────── */
    const { page: admin } = await newAgentPage(browser);
    await signUp(admin, {
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: PASSWORD,
      companyName: COMPANY,
    });

    const me = await db.user.findFirst({
      where: { email: ADMIN_EMAIL },
      select: { id: true, companyId: true, theme: true, locale: true },
    });
    if (!me) {
      fail("tenant bootstrap", `no user row for ${ADMIN_EMAIL} — nothing below can be trusted`);
      return;
    }
    TENANT = me.companyId;
    // Scoped, not a bare count: another agent's signup must not satisfy this.
    const companyRow = await db.company.findFirst({
      where: { id: TENANT, name: COMPANY },
      select: { id: true, name: true },
    });
    if (companyRow) ok(`own tenant created: ${COMPANY} (${TENANT})`);
    else fail("tenant bootstrap", `company ${COMPANY} not found under id ${TENANT}`);

    /* ═══════════════════════════════════════════════════════════════════
     * A. FOCUS VISIBILITY  →  a11y-001, a11y-002
     * 63 className strings set `focus:outline-none`, which beats the global
     * `:focus-visible { outline: 2px solid rgb(var(--ring)) }` on specificity
     * (.input:focus = 0,2,0 vs :focus-visible = 0,1,0). What replaces it is
     * either a 1px border tint or, in several cases, nothing.
     * ═══════════════════════════════════════════════════════════════════ */
    section("A. keyboard focus indicators (a11y-001, a11y-002)");

    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
    await inject(admin);

    const focusReport = await admin.evaluate(async () => {
      const sig = window.__ffA11y.focusSignature;
      const sc = window.__ffA11y.stateContrast;
      const els = [...document.querySelectorAll("input, select, textarea, button, a[href]")].filter(
        (el) => el.offsetParent !== null && !el.disabled
      );
      const rows = [];
      for (const el of els) {
        const before = sig(el);
        el.focus();
        // Force the :focus-visible heuristic Chrome applies to keyboard focus.
        const after = sig(el);
        const outlineVisible =
          after.outlineStyle !== "none" &&
          parseFloat(after.outlineWidth) > 0 &&
          !/rgba\(0, 0, 0, 0\)|transparent/.test(after.outlineColor);
        const shadowChanged = before.boxShadow !== after.boxShadow && after.boxShadow !== "none";
        const borderChanged = before.borderColor !== after.borderColor;
        const bgChanged = before.background !== after.background;
        rows.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          label: (el.getAttribute("aria-label") || el.name || el.type || "").slice(0, 32),
          outlineVisible,
          shadowChanged,
          borderChanged,
          bgChanged,
          borderStateContrast: borderChanged ? sc(before.borderColor, after.borderColor) : null,
          bgStateContrast: bgChanged ? sc(before.background, after.background) : null,
          borderWidth: after.borderWidth,
          indicator: outlineVisible
            ? "outline"
            : shadowChanged
              ? "ring"
              : borderChanged
                ? "border-tint"
                : bgChanged
                  ? "background-tint"
                  : "NONE",
        });
        el.blur();
      }
      return rows;
    });

    const noIndicator = focusReport.filter((r) => r.indicator === "NONE");
    const weakIndicator = focusReport.filter(
      (r) =>
        (r.indicator === "border-tint" && (r.borderStateContrast ?? 0) < 3) ||
        (r.indicator === "background-tint" && (r.bgStateContrast ?? 0) < 3)
    );

    // a11y-001 — controls whose focus is carried only by a sub-3:1 colour tint.
    if (weakIndicator.length === 0) {
      ok("a11y-001: every /expenses control shows a >=3:1 focus state change");
    } else {
      fail(
        "a11y-001 focus indicator below 1.4.11's 3:1 state contrast",
        weakIndicator
          .map((r) => `${r.tag}#${r.id ?? "-"} ${r.indicator} ${r.borderStateContrast ?? r.bgStateContrast}:1 (border ${r.borderWidth})`)
          .join("; ")
      );
    }

    // a11y-002 — controls with no perceptible focus indicator at all.
    if (noIndicator.length === 0) {
      ok("a11y-002: no /expenses control focuses invisibly");
    } else {
      fail(
        "a11y-002 control focuses with NO visible indicator",
        noIndicator.map((r) => `${r.tag}#${r.id ?? "-"} (${r.label})`).join("; ")
      );
    }
    note(`focus audit covered ${focusReport.length} controls on /expenses`);

    // The highest-stakes instance: the password field that confirms an
    // irreversible account deletion (settings/delete-account-modal.tsx:86).
    await admin.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
    await inject(admin);
    const openedDelete = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /delete\s+my\s+account/i.test(b.textContent || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!openedDelete) {
      note("a11y-002: could not reach the delete-account modal from /settings");
    } else {
      const reached = await admin
        .waitForFunction(
          () => !!document.querySelector('[role="dialog"] input[type="password"]'),
          { timeout: 10000 }
        )
        .then(() => true)
        .catch(() => false);
      if (!reached) {
        note("a11y-002: delete-account modal never rendered a password field");
      } else {
        await inject(admin);
        const pw = await admin.evaluate(() => {
          const el = document.querySelector('[role="dialog"] input[type="password"]');
          const sig = window.__ffA11y.focusSignature;
          const before = sig(el);
          el.focus();
          const after = sig(el);
          return {
            before,
            after,
            bgState: window.__ffA11y.stateContrast(before.background, after.background),
            borderState: window.__ffA11y.stateContrast(before.borderColor, after.borderColor),
            outlineStyle: after.outlineStyle,
            outlineWidth: after.outlineWidth,
          };
        });
        const strong =
          (pw.outlineStyle !== "none" && parseFloat(pw.outlineWidth) > 0) ||
          (pw.borderState ?? 0) >= 3 ||
          (pw.bgState ?? 0) >= 3;
        if (strong) {
          ok("a11y-002: the delete-account password field shows a >=3:1 focus indicator");
        } else {
          fail(
            "a11y-002 delete-account password field focuses near-invisibly",
            `outline=${pw.outlineStyle}/${pw.outlineWidth}, border state ${pw.borderState}:1, background state ${pw.bgState}:1`
          );
        }
        await admin.screenshot({ path: `${OUT}/a11y-01-delete-focus.png` });
        await admin.keyboard.press("Escape");
        await admin
          .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 8000 })
          .catch(() => {});
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * B. COLOUR CONTRAST in BOTH themes  →  a11y-003, a11y-004
     * `text-danger` (#dc2626) is used at 76 sites, including every form
     * validation message, with no dark-theme variant — while `--danger-strong`
     * (#f87171) exists for exactly that. Placeholders are `text-fg-muted/70`.
     * ═══════════════════════════════════════════════════════════════════ */
    section("B. colour contrast, both themes (a11y-003, a11y-004)");

    for (const theme of ["dark", "light"]) {
      // Flip with the shipped control so we measure what a user would see.
      await admin.goto(`${BASE}/budgets`, { waitUntil: "networkidle0", timeout: 60000 });
      const flipped = await admin.evaluate((want) => {
        const now = document.documentElement.classList.contains("dark") ? "dark" : "light";
        if (now === want) return true;
        const btn = [...document.querySelectorAll("header button[aria-label]")].find((b) =>
          /switch to (light|dark) theme/i.test(b.getAttribute("aria-label") || "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      }, theme);
      if (!flipped) {
        note(`could not reach the theme toggle for ${theme}`);
        continue;
      }
      await admin
        .waitForFunction(
          (want) =>
            (document.documentElement.classList.contains("dark") ? "dark" : "light") === want,
          { timeout: 10000 },
          theme
        )
        .catch(() => {});
      await inject(admin);

      // Provoke the validation messages: submit the new-budget form empty.
      const openedBudget = await admin.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /new budget/i.test(b.textContent || "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (openedBudget) {
        await admin
          .waitForFunction(() => !!document.querySelector('[role="dialog"] form'), {
            timeout: 10000,
          })
          .catch(() => {});
        await admin.evaluate(() => {
          const submit = document.querySelector('[role="dialog"] button[type="submit"]');
          submit?.click();
        });
        await admin
          .waitForFunction(
            () => document.querySelectorAll('[role="dialog"] p.text-xs').length > 0,
            { timeout: 10000 }
          )
          .catch(() => {});
        await inject(admin);
      }

      const contrast = await admin.evaluate(() => {
        const tc = window.__ffA11y.textContrast;
        const rows = [];
        // Validation messages + any element whose colour resolves to the
        // un-hardened danger/warning/info tokens.
        document.querySelectorAll("p, span, button, a, h1, h2, h3, label, td, th, div").forEach((el) => {
          if (el.children.length > 0) return; // leaf text nodes only
          const txt = (el.textContent || "").trim();
          if (!txt) return;
          const r = tc(el);
          if (!r) return;
          if (r.ratio < r.required) {
            rows.push({
              text: txt.slice(0, 44),
              ratio: r.ratio,
              required: r.required,
              px: r.px,
              weight: r.weight,
              color: r.color,
              bg: r.bg,
              cls: String(el.className || "").slice(0, 60),
            });
          }
        });
        // Placeholders need their own pass: the colour lives in ::placeholder.
        const ph = [];
        document.querySelectorAll("input[placeholder], textarea[placeholder]").forEach((el) => {
          const cs = getComputedStyle(el, "::placeholder");
          const parse = window.__ffA11y.parse;
          const fg = parse(cs.color);
          if (!fg) return;
          const bg = window.__ffA11y.effectiveBg(el);
          const comp =
            fg.a < 1
              ? {
                  r: fg.r * fg.a + bg.r * (1 - fg.a),
                  g: fg.g * fg.a + bg.g * (1 - fg.a),
                  b: fg.b * fg.a + bg.b * (1 - fg.a),
                }
              : fg;
          const ratio = Math.round(window.__ffA11y.ratio(comp, bg) * 100) / 100;
          ph.push({
            placeholder: el.getAttribute("placeholder").slice(0, 40),
            ratio,
            px: parseFloat(getComputedStyle(el).fontSize),
            color: cs.color,
          });
        });
        return { rows: rows.slice(0, 25), total: rows.length, placeholders: ph };
      });

      // a11y-003 — text below AA.
      if (contrast.total === 0) {
        ok(`a11y-003: no sub-AA text found on /budgets in ${theme}`);
      } else {
        fail(
          `a11y-003 sub-AA text contrast in ${theme} theme (${contrast.total} nodes)`,
          contrast.rows
            .slice(0, 8)
            .map((r) => `"${r.text}" ${r.ratio}:1 (need ${r.required}) ${r.color} on ${r.bg}`)
            .join(" | ")
        );
      }

      // a11y-004 — placeholder text below AA.
      const badPh = contrast.placeholders.filter((p) => p.ratio < 4.5);
      if (badPh.length === 0) {
        ok(`a11y-004: every placeholder clears 4.5:1 in ${theme}`);
      } else {
        fail(
          `a11y-004 placeholder contrast in ${theme} theme`,
          badPh.map((p) => `"${p.placeholder}" ${p.ratio}:1 (${p.color})`).join(" | ")
        );
      }

      await admin.screenshot({ path: `${OUT}/a11y-02-contrast-${theme}.png`, fullPage: true });
      await admin.keyboard.press("Escape");
      await admin
        .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 8000 })
        .catch(() => {});
    }

    /* ═══════════════════════════════════════════════════════════════════
     * C. MODAL FOCUS TRAP + the command palette's missing one
     *    →  a11y-005 (negative result), a11y-006
     * ═══════════════════════════════════════════════════════════════════ */
    section("C. dialog focus containment (a11y-005, a11y-006)");

    await admin.goto(`${BASE}/projects`, { waitUntil: "networkidle0", timeout: 60000 });
    await inject(admin);
    const openedProject = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /new project/i.test(b.textContent || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!openedProject) {
      note("a11y-005: no 'New project' button on /projects");
    } else {
      await admin
        .waitForFunction(() => !!document.querySelector('[role="dialog"] form'), { timeout: 10000 })
        .catch(() => {});
      let escaped = null;
      for (let i = 0; i < 30; i++) {
        const f = await tabAndDescribe(admin);
        if (f && !f.inDialog) {
          escaped = f;
          break;
        }
      }
      // a11y-005 — Radix should contain focus. This is the NEGATIVE RESULT.
      if (!escaped) {
        ok("a11y-005: Radix Modal held focus inside the dialog across 30 Tabs");
      } else {
        fail(
          "a11y-005 focus escaped the Radix Modal",
          `landed on <${escaped.tag}> "${escaped.label}"`
        );
      }
      // Escape must close AND return focus to the trigger.
      await admin.keyboard.press("Escape");
      const closedAndReturned = await admin
        .waitForFunction(
          () =>
            !document.querySelector('[role="dialog"]') &&
            /new project/i.test(document.activeElement?.textContent || ""),
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      if (closedAndReturned) ok("a11y-005: Escape closed the modal and returned focus to its trigger");
      else {
        const where = await admin.evaluate(
          () => (document.activeElement?.tagName || "?") + ":" + (document.activeElement?.textContent || "").trim().slice(0, 30)
        );
        fail("a11y-005 focus return after Escape", `activeElement is ${where}`);
      }
    }

    // a11y-006 — the command palette declares aria-modal="true" and its own
    // header comment promises "Tab wraps", but the keydown handler never
    // handles Tab and nothing outside is inert.
    await admin.keyboard.down("Control");
    await admin.keyboard.press("k");
    await admin.keyboard.up("Control");
    const paletteOpen = await admin
      .waitForFunction(() => !!document.querySelector('[role="dialog"] input[role="combobox"]'), {
        timeout: 10000,
      })
      .then(() => true)
      .catch(() => false);
    if (!paletteOpen) {
      note("a11y-006: Ctrl-K did not open the command palette");
    } else {
      let left = null;
      for (let i = 0; i < 15; i++) {
        const f = await tabAndDescribe(admin);
        if (f && !f.inDialog) {
          left = f;
          break;
        }
      }
      const bgReachable = await admin.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        // Anything outside the dialog that is still exposed to AT.
        const outside = [...document.querySelectorAll("header button, aside a, main a, main button")].filter(
          (el) => !dlg?.contains(el) && el.offsetParent !== null
        );
        const hidden = outside.filter(
          (el) => el.closest("[aria-hidden=true]") || el.closest("[inert]")
        );
        return { outside: outside.length, hidden: hidden.length };
      });
      if (!left && bgReachable.hidden === bgReachable.outside) {
        ok("a11y-006: the command palette contains focus and hides the background from AT");
      } else {
        fail(
          "a11y-006 aria-modal=\"true\" palette is not actually modal",
          `${left ? `Tab escaped to <${left.tag}> "${left.label}"; ` : ""}${bgReachable.outside - bgReachable.hidden} of ${bgReachable.outside} background controls are still exposed (no aria-hidden/inert)`
        );
      }
      await admin.screenshot({ path: `${OUT}/a11y-03-palette.png` });
      await admin.keyboard.press("Escape");
      await admin
        .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 8000 })
        .catch(() => {});
    }

    /* ═══════════════════════════════════════════════════════════════════
     * D. ARIA CORRECTNESS on the topbar menus  →  a11y-007
     * Both dropdowns are role="menu" whose children are plain <a>/<button>
     * with no role="menuitem", and no arrow-key handling — the two promises
     * role="menu" makes.
     * ═══════════════════════════════════════════════════════════════════ */
    section("D. topbar dropdown ARIA (a11y-007)");

    const menuAudit = await admin.evaluate(async () => {
      const results = [];
      const triggers = [...document.querySelectorAll('header button[aria-haspopup="menu"]')];
      for (const trig of triggers) {
        trig.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const menu = document.querySelector('[role="menu"]');
        if (!menu) {
          results.push({ trigger: trig.getAttribute("aria-label"), menu: false });
          continue;
        }
        const focusables = [...menu.querySelectorAll("a[href], button")];
        results.push({
          trigger: trig.getAttribute("aria-label"),
          menu: true,
          focusables: focusables.length,
          menuitems: focusables.filter((el) => el.getAttribute("role") === "menuitem").length,
          focusMoved: menu.contains(document.activeElement),
          ariaLabelled: !!(menu.getAttribute("aria-label") || menu.getAttribute("aria-labelledby")),
        });
        trig.click();
        await new Promise((r) => requestAnimationFrame(r));
      }
      return results;
    });
    menuAudit.forEach((m) => {
      if (!m.menu) {
        note(`a11y-007: "${m.trigger}" did not render a role="menu"`);
        return;
      }
      if (m.menuitems === m.focusables && m.focusables > 0 && m.focusMoved) {
        ok(`a11y-007: "${m.trigger}" menu has ${m.menuitems} menuitems and takes focus`);
      } else {
        fail(
          `a11y-007 role="menu" without menu semantics ("${m.trigger}")`,
          `${m.focusables} focusable children, ${m.menuitems} with role="menuitem"; focus moved into the menu: ${m.focusMoved}; labelled: ${m.ariaLabelled}`
        );
      }
    });

    /* ═══════════════════════════════════════════════════════════════════
     * E. SKIP LINK  →  a11y-008
     * The root layout ships `<a href="#main">` on EVERY route, but id="main"
     * exists only in app/(app)/layout.tsx. The landing page has no <main> at all.
     * ═══════════════════════════════════════════════════════════════════ */
    section("E. skip-to-content target (a11y-008)");

    for (const route of PUBLIC_ROUTES) {
      const { page: anon } = await newAgentPage(browser);
      await anon.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 });
      const r = await anon.evaluate(() => ({
        skip: !!document.querySelector('a[href="#main"]'),
        target: !!document.getElementById("main"),
        mainEl: !!document.querySelector("main"),
      }));
      if (!r.skip) note(`a11y-008: ${route} has no skip link at all`);
      else if (r.target) ok(`a11y-008: ${route} skip link resolves to #main`);
      else
        fail(
          `a11y-008 skip link points at a target that does not exist (${route})`,
          `a[href="#main"] present, #main absent, <main> element present: ${r.mainEl}`
        );
      await anon.browserContext().close();
    }

    /* ═══════════════════════════════════════════════════════════════════
     * F. 375px: off-screen-but-tabbable drawer + clipped overflow
     *    →  resp-001, resp-002
     * ═══════════════════════════════════════════════════════════════════ */
    section("F. 375px behaviour (resp-001, resp-002)");

    await admin.setViewport(PHONE);
    await admin.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
    await inject(admin);

    // resp-001 — the drawer is only `translate-x-full`, so its links stay in
    // the tab order while invisible off-screen.
    await admin.evaluate(() => document.body.focus());
    const offscreenTabs = [];
    for (let i = 0; i < 25; i++) {
      const f = await tabAndDescribe(admin);
      if (!f) break;
      if (f.offscreen) offscreenTabs.push(f);
      if (!f.inAside && offscreenTabs.length > 0 && i > 3) break;
    }
    if (offscreenTabs.length === 0) {
      ok("resp-001: no off-screen control is reachable by Tab at 375px");
    } else {
      fail(
        `resp-001 ${offscreenTabs.length} off-screen controls are Tab-reachable at 375px`,
        offscreenTabs
          .slice(0, 6)
          .map((f) => `<${f.tag}> "${f.label}" at x=${f.rect.l}..${f.rect.r}`)
          .join("; ")
      );
    }
    const drawerHidden = await admin.evaluate(() => {
      const aside = document.querySelector("aside");
      if (!aside) return null;
      return {
        ariaHidden: aside.getAttribute("aria-hidden"),
        inert: aside.hasAttribute("inert"),
        visibility: getComputedStyle(aside).visibility,
        transform: getComputedStyle(aside).transform,
        links: aside.querySelectorAll("a[href], button").length,
      };
    });
    note(`resp-001: closed drawer — ${JSON.stringify(drawerHidden)}`);

    // resp-002 — the notifications panel is w-80 (320px) anchored `end-0` on a
    // button whose right edge sits ~307px in, and the shell is overflow-hidden,
    // so the overflow is CLIPPED rather than scrollable.
    const opened = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll('header button[aria-haspopup="menu"]')].find((b) =>
        /notification/i.test(b.getAttribute("aria-label") || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!opened) {
      note("resp-002: no notifications trigger in the topbar");
    } else {
      await admin
        .waitForFunction(() => !!document.querySelector('[role="menu"]'), { timeout: 8000 })
        .catch(() => {});
      const panel = await admin.evaluate(() => {
        const m = document.querySelector('[role="menu"]');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          viewport: window.innerWidth,
        };
      });
      if (!panel) note("resp-002: panel never measured");
      else if (panel.left >= -1 && panel.right <= panel.viewport + 1) {
        ok(`resp-002: notifications panel fits at 375px (${panel.left}..${panel.right})`);
      } else {
        fail(
          "resp-002 notifications panel overflows the 375px viewport",
          `width ${panel.width}px spans x=${panel.left}..${panel.right} in a ${panel.viewport}px viewport; the app shell is overflow-hidden so the excess is clipped, not scrollable`
        );
      }
      await admin.screenshot({ path: `${OUT}/resp-01-notif-375.png` });
      await admin.keyboard.press("Escape");
    }

    // Sweep every route at 375px for clipped, unreachable overflow.
    for (const route of ADMIN_ROUTES) {
      await admin.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 });
      await inject(admin);
      const o = await admin.evaluate(() => ({
        clipped: window.__ffA11y.clippedOverflow(),
        docScroll: document.scrollingElement.scrollWidth - window.innerWidth,
      }));
      if (o.clipped.length === 0 && o.docScroll <= 1) {
        ok(`resp-002: ${route} has no clipped horizontal overflow at 375px`);
      } else {
        fail(
          `resp-002 horizontal overflow at 375px on ${route}`,
          `doc overflow ${o.docScroll}px; ${o.clipped
            .slice(0, 3)
            .map((c) => `<${c.tag} class="${c.cls}"> x=${c.left}..${c.right} "${c.text}"`)
            .join("; ")}`
        );
        await admin.screenshot({
          path: `${OUT}/resp-02-overflow${route.replace(/\//g, "-")}.png`,
          fullPage: true,
        });
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * G. TOUCH TARGETS + hover-only affordances  →  resp-003, resp-004
     * ═══════════════════════════════════════════════════════════════════ */
    section("G. touch targets and hover-only controls (resp-003, resp-004)");

    await admin.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });
    await inject(admin);

    // resp-003 — WCAG 2.2 SC 2.5.8: 24x24 CSS px unless the spacing exception
    // applies (no other target's 24px circle intersects).
    const tiny = await admin.evaluate(() => {
      const targets = [...document.querySelectorAll("a[href], button, input, select, textarea")]
        .filter((el) => el.offsetParent !== null && !el.disabled)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            el,
            cx: r.left + r.width / 2,
            cy: r.top + r.height / 2,
            w: Math.round(r.width),
            h: Math.round(r.height),
            label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
            tag: el.tagName.toLowerCase(),
          };
        })
        .filter((t) => t.w > 0 && t.h > 0);
      const bad = [];
      targets.forEach((t) => {
        if (t.w >= 24 && t.h >= 24) return;
        // Spacing exception: does any OTHER target's 24px circle intersect?
        const crowded = targets.some(
          (o) =>
            o.el !== t.el &&
            Math.hypot(o.cx - t.cx, o.cy - t.cy) < 24
        );
        if (crowded) bad.push({ tag: t.tag, label: t.label, w: t.w, h: t.h });
      });
      return bad.slice(0, 15);
    });
    if (tiny.length === 0) {
      ok("resp-003: every /tasks target clears 24x24 or the 2.5.8 spacing exception");
    } else {
      fail(
        `resp-003 ${tiny.length} undersized crowded targets on /tasks at 375px`,
        tiny.map((t) => `<${t.tag}> "${t.label}" ${t.w}x${t.h}`).join("; ")
      );
    }

    // resp-004 — the kanban card's delete button is `opacity-0
    // group-hover:opacity-100` with no focus variant: invisible on touch, and
    // invisible even when it has keyboard focus.
    const hoverOnly = await admin.evaluate(() => {
      const btns = [...document.querySelectorAll("button[aria-label^='Delete task']")];
      if (btns.length === 0) return null;
      const b = btns[0];
      const resting = getComputedStyle(b).opacity;
      b.focus();
      const focused = getComputedStyle(b).opacity;
      const r = b.getBoundingClientRect();
      return {
        resting,
        focused,
        focusedIsActive: document.activeElement === b,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        label: b.getAttribute("aria-label"),
      };
    });
    if (!hoverOnly) {
      note("resp-004: no task cards in this fresh tenant — create one first");
    } else if (Number(hoverOnly.focused) > 0.5) {
      ok(`resp-004: the task delete button becomes visible on keyboard focus (${hoverOnly.focused})`);
    } else {
      fail(
        "resp-004 hover-only control stays invisible when focused",
        `"${hoverOnly.label}" opacity ${hoverOnly.resting} at rest, ${hoverOnly.focused} while it IS document.activeElement (${hoverOnly.focusedIsActive}); size ${hoverOnly.size}; no pointer hover exists on touch`
      );
    }

    /* ═══════════════════════════════════════════════════════════════════
     * H. REDUCED MOTION  →  a11y-009
     * globals.css flattens CSS animations, but the 8 framer-motion
     * <motion.div>s animate via inline style from JS and framer defaults to
     * reducedMotion: "never" with no <MotionConfig>.
     * ═══════════════════════════════════════════════════════════════════ */
    section("H. prefers-reduced-motion (a11y-009)");

    await admin.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await admin.setViewport(DESKTOP);
    await admin.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
    const motionSample = await admin.evaluate(async () => {
      const btn = [...document.querySelectorAll('header button[aria-haspopup="menu"]')].find((b) =>
        /notification/i.test(b.getAttribute("aria-label") || "")
      );
      if (!btn) return null;
      btn.click();
      // Sample on the very next frame: an honoured reduced-motion preference
      // means the panel is already at its final opacity/transform.
      await new Promise((r) => requestAnimationFrame(r));
      const m = document.querySelector('[role="menu"]');
      if (!m) return { found: false };
      const cs = getComputedStyle(m);
      return { found: true, opacity: cs.opacity, transform: cs.transform };
    });
    if (!motionSample || !motionSample.found) {
      note("a11y-009: could not sample the animated panel");
    } else if (Number(motionSample.opacity) >= 0.99 && /none|matrix\(1, 0, 0, 1, 0, 0\)/.test(motionSample.transform)) {
      ok("a11y-009: framer-motion panels skip their entrance under reduce");
    } else {
      fail(
        "a11y-009 framer-motion ignores prefers-reduced-motion: reduce",
        `first frame after open: opacity ${motionSample.opacity}, transform ${motionSample.transform} — globals.css only flattens CSS animations, and no <MotionConfig reducedMotion="user"> wraps the tree`
      );
    }
    await admin.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await admin.keyboard.press("Escape");

    /* ═══════════════════════════════════════════════════════════════════
     * I. URDU: coverage, persistence, RTL mirroring, dates  →  i18n-001..005
     * ═══════════════════════════════════════════════════════════════════ */
    section("I. Urdu locale (i18n-001 … i18n-005)");

    await admin.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
    const toUrdu = await setLocale(admin, "ur");
    if (!toUrdu) {
      fail("i18n: could not switch to Urdu from the topbar", "language toggle not found or lang never became 'ur'");
    } else {
      ok("i18n: topbar toggle switched the UI to Urdu");

      const htmlAttrs = await admin.evaluate(() => ({
        lang: document.documentElement.getAttribute("lang"),
        dir: document.documentElement.getAttribute("dir"),
      }));
      if (htmlAttrs.dir === "rtl") ok(`i18n: <html dir="${htmlAttrs.dir}" lang="${htmlAttrs.lang}">`);
      else fail("i18n: html dir did not flip", JSON.stringify(htmlAttrs));

      // PERSISTENCE, scoped to MY tenant. Another agent's user row must not
      // be able to satisfy this — hence companyId AND email.
      // Poll the row rather than sleeping a fixed amount: the write is fired
      // by `void updateAppearanceAction(...)` from the toggle, so there is no
      // UI signal to wait on and the honest predicate is the row itself.
      let persisted = null;
      for (let i = 0; i < 20; i++) {
        persisted = await db.user.findFirst({
          where: { companyId: TENANT, email: ADMIN_EMAIL },
          select: { locale: true },
        });
        if (persisted?.locale === "ur") break;
        await sleep(250);
      }
      if (persisted?.locale === "ur") ok("i18n: the locale choice persisted to my own User row");
      else fail("i18n: locale not persisted", `User.locale = ${persisted?.locale ?? "<no row>"}`);

      /* i18n-001 — string coverage. Sweep every route and measure how much
       * visible text is still Latin script while the shell claims lang="ur". */
      const coverage = [];
      for (const route of ADMIN_ROUTES) {
        await admin.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 60000 });
        await inject(admin);
        const r = await admin.evaluate(() => {
          const texts = window.__ffA11y.visibleText(document.querySelector("main") || document.body);
          let latin = 0,
            arabic = 0;
          const latinSamples = [];
          texts.forEach((t) => {
            const hasArabic = /[\u0600-\u06FF]/.test(t);
            const hasLatin = /[A-Za-z]{3}/.test(t);
            if (hasArabic) arabic++;
            else if (hasLatin) {
              latin++;
              if (latinSamples.length < 4) latinSamples.push(t.slice(0, 40));
            }
          });
          const labels = [...document.querySelectorAll("[aria-label]")]
            .map((el) => el.getAttribute("aria-label"))
            .filter((l) => /[A-Za-z]{3}/.test(l) && !/[\u0600-\u06FF]/.test(l));
          return { latin, arabic, latinSamples, latinAriaLabels: labels.length, lang: document.documentElement.lang };
        });
        coverage.push({ route, ...r });
        if (r.latin === 0) {
          ok(`i18n-001: ${route} is fully translated (${r.arabic} Urdu strings)`);
        } else {
          fail(
            `i18n-001 untranslated English on ${route} under lang="${r.lang}"`,
            `${r.latin} Latin-script strings vs ${r.arabic} Urdu; ${r.latinAriaLabels} English aria-labels; e.g. ${r.latinSamples.map((s) => `"${s}"`).join(", ")}`
          );
        }
      }
      const totalLatin = coverage.reduce((a, c) => a + c.latin, 0);
      const totalArabic = coverage.reduce((a, c) => a + c.arabic, 0);
      note(
        `i18n-001 summary: ${totalLatin} Latin vs ${totalArabic} Urdu strings across ${ADMIN_ROUTES.length} routes; untranslated routes: ${coverage.filter((c) => c.arabic === 0).map((c) => c.route).join(", ") || "none"}`
      );

      /* i18n-003 — RTL mirroring of PAGE BODIES. tests/lib/layout/rtl.test.ts
       * only scans components/layout, components/chat and three shell files, so
       * the page bodies were never converted. The finance search input is the
       * canonical case: `left-3` icon + `pl-10 pr-4`, so in RTL the 40px gutter
       * and its magnifier sit on the TRAILING edge, away from the caret. */
      await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
      await inject(admin);
      const mirrored = await admin.evaluate(() => {
        const input = document.querySelector("#expense-search");
        if (!input) return null;
        const cs = getComputedStyle(input);
        const icon = input.parentElement?.querySelector("svg");
        const ir = icon?.getBoundingClientRect();
        const pr = input.getBoundingClientRect();
        return {
          dir: getComputedStyle(document.documentElement).direction,
          paddingInlineStart: cs.paddingInlineStart,
          paddingInlineEnd: cs.paddingInlineEnd,
          paddingLeft: cs.paddingLeft,
          paddingRight: cs.paddingRight,
          textAlign: cs.textAlign,
          // In RTL the decorative icon belongs on the RIGHT (inline-start).
          iconOnRight: ir ? ir.left > pr.left + pr.width / 2 : null,
        };
      });
      if (!mirrored) {
        note("i18n-003: #expense-search not found");
      } else if (mirrored.paddingInlineStart === "40px" && mirrored.iconOnRight === true) {
        ok("i18n-003: the expenses search input mirrors (icon + gutter on inline-start)");
      } else {
        fail(
          "i18n-003 page body does not mirror for Urdu",
          `dir=${mirrored.dir}: padding-inline-start=${mirrored.paddingInlineStart} (expected 40px), padding-inline-end=${mirrored.paddingInlineEnd}, physical L/R=${mirrored.paddingLeft}/${mirrored.paddingRight}, search icon on the inline-start (right) side: ${mirrored.iconOnRight}`
        );
      }

      // Desktop RTL: the shell IS converted, so the rail must be on the right.
      await admin.setViewport(DESKTOP);
      await admin.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      const rail = await admin.evaluate(() => {
        const aside = document.querySelector("aside");
        if (!aside) return null;
        const r = aside.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
      });
      if (rail && rail.right >= rail.vw - 2) ok(`i18n-003: the sidebar rail mirrors to the right in Urdu (x=${rail.left}..${rail.right})`);
      else fail("i18n-003 sidebar did not mirror", JSON.stringify(rail));
      await admin.screenshot({ path: `${OUT}/i18n-01-urdu-desktop.png`, fullPage: true });
      await admin.setViewport(PHONE);
      await admin.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      await admin.screenshot({ path: `${OUT}/i18n-02-urdu-375.png`, fullPage: true });
      await admin.setViewport(DESKTOP);

      /* i18n-004 — numbers and dates. `numbering.ts` pins Latin digits on
       * purpose (documented, correct), but `formatDate` calls date-fns
       * `format(d, "MMM dd, yyyy")` with no locale and `formatRelativeTime`
       * returns literal "Today at" / "Yesterday at" / an English distance. */
      await admin.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
      await inject(admin);
      const dates = await admin.evaluate(() => {
        const texts = window.__ffA11y.visibleText(document.body);
        const monthly = texts.filter((t) =>
          /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/.test(t)
        );
        const relative = texts.filter((t) =>
          /\b(Today at|Yesterday at|minutes? ago|hours? ago|days? ago|about|in \d)\b/i.test(t)
        );
        const digits = texts.filter((t) => /[0-9]/.test(t)).slice(0, 5);
        return { monthly: monthly.slice(0, 4), relative: relative.slice(0, 4), digits };
      });
      if (dates.monthly.length === 0 && dates.relative.length === 0) {
        ok("i18n-004: no English month name or relative phrase rendered under Urdu");
      } else {
        fail(
          "i18n-004 dates and relative times stay English under Urdu",
          `date-fns format() gets no locale: ${[...dates.monthly, ...dates.relative].map((s) => `"${s}"`).join(", ")}`
        );
      }
      note(`i18n-004: Latin digits are a documented decision (lib/i18n/numbering.ts) — samples: ${dates.digits.map((d) => `"${d}"`).join(", ")}`);

      /* i18n-005 — lang on the locale picker cards. `LocaleChoice` puts
       * lang={code} on the whole <button>, so the English card claims lang="en"
       * while holding Urdu prose (and vice versa) — WCAG 3.1.2. */
      const langParts = await admin.evaluate(() => {
        return [...document.querySelectorAll("button[lang]")].map((b) => ({
          lang: b.getAttribute("lang"),
          hasArabic: /[\u0600-\u06FF]/.test(b.textContent || ""),
          hasLatin: /[A-Za-z]{3}/.test(b.textContent || ""),
          text: (b.textContent || "").trim().slice(0, 60),
        }));
      });
      const mismatched = langParts.filter(
        (p) => (p.lang === "en" && p.hasArabic) || (p.lang === "ur" && p.hasLatin)
      );
      if (langParts.length === 0) note("i18n-005: no button[lang] on /settings");
      else if (mismatched.length === 0) ok("i18n-005: every lang-tagged node matches its script");
      else
        fail(
          "i18n-005 lang attribute does not match the node's script (WCAG 3.1.2)",
          mismatched.map((p) => `lang="${p.lang}" contains "${p.text}"`).join(" | ")
        );
    }

    /* ═══════════════════════════════════════════════════════════════════
     * J. dir PRE-PAINT on a device that has never seen this user  →  i18n-002
     * The inline <head> bootstrap only reads localStorage. A first sign-in on
     * a new device has none, so the locale arrives from the DB via
     * PreferenceHydrator AFTER hydration and a full server round-trip.
     * ═══════════════════════════════════════════════════════════════════ */
    section("J. dir before first paint on a fresh profile (i18n-002)");

    const dbLocale = await db.user.findFirst({
      where: { companyId: TENANT, email: ADMIN_EMAIL },
      select: { locale: true },
    });
    if (dbLocale?.locale !== "ur") {
      note(`i18n-002 skipped: DB locale is "${dbLocale?.locale}", the fixture needs "ur"`);
    } else {
      const { page: fresh, ctx: freshCtx } = await newAgentPage(browser, { recordEarlyDir: true });
      await fresh.setViewport(DESKTOP);
      await signIn(fresh, ADMIN_EMAIL, PASSWORD);
      await fresh.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      const settled = await fresh
        .waitForFunction(() => document.documentElement.getAttribute("dir") === "rtl", {
          timeout: 15000,
        })
        .then(() => true)
        .catch(() => false);
      const early = await fresh.evaluate(() => window.__ffEarly ?? []);
      const firstPaint = early.find((e) => e.phase === "domcontentloaded");
      if (!settled) {
        fail("i18n-002 Urdu never applied on a fresh profile", `early samples: ${JSON.stringify(early)}`);
      } else if (firstPaint && firstPaint.dir === "rtl") {
        ok("i18n-002: dir=rtl was already set at first paint on a fresh profile");
      } else {
        fail(
          "i18n-002 an Urdu user gets a left-to-right first paint on every new device",
          `at DOMContentLoaded dir="${firstPaint?.dir}" lang="${firstPaint?.lang}"; it only becomes rtl after PreferenceHydrator's server round-trip resolves. The inline bootstrap reads localStorage only, which is empty on a first visit.`
        );
      }
      await fresh.screenshot({ path: `${OUT}/i18n-03-fresh-profile.png` });

      /* The same wiring, raced: PreferenceHydrator fires getMyAppearanceAction
       * on mount and unconditionally setLocale()s the answer, so a toggle made
       * while that request is in flight gets reverted. */
      const { page: racer } = await newAgentPage(browser);
      await racer.setViewport(DESKTOP);
      await signIn(racer, ADMIN_EMAIL, PASSWORD);
      await racer.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      // Click the toggle the instant the topbar exists — i.e. inside the window
      // where the hydrator's GET has not yet come back.
      await racer.waitForSelector("header button[aria-label]", { timeout: 20000 });
      const flipped = await racer.evaluate(() => {
        const btn = [...document.querySelectorAll("header button[aria-label]")].find((b) =>
          /switch language/i.test(b.getAttribute("aria-label") || "")
        );
        if (!btn) return null;
        const before = document.documentElement.getAttribute("lang");
        btn.click();
        return before;
      });
      if (flipped === null) {
        note("i18n-002 race: language toggle not found");
      } else {
        const want = flipped === "ur" ? "en" : "ur";
        const held = await racer
          .waitForFunction(
            (w) => document.documentElement.getAttribute("lang") !== w,
            { timeout: 6000 },
            want
          )
          .then(() => false)
          .catch(() => true);
        if (held) ok(`i18n-002: a locale flip right after load held at "${want}"`);
        else {
          const now = await racer.evaluate(() => document.documentElement.getAttribute("lang"));
          fail(
            "i18n-002 PreferenceHydrator reverts a locale flip made during its in-flight fetch",
            `user asked for "${want}", lang is "${now}" — components/layout/preference-hydrator.tsx calls setLocale() with the stale server value unconditionally`
          );
        }
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * K. LOADING SKELETON WIDTH  →  resp-005
     * expenses/investments/reports skeletons are max-w-[1280px]; their pages
     * are max-w-[1600px]. settings/notifications skeletons are wider than
     * their max-w-3xl pages. The content jumps when the RSC settles.
     * ═══════════════════════════════════════════════════════════════════ */
    section("K. loading-skeleton width vs settled page (resp-005)");

    for (const route of ["/expenses", "/investments", "/reports", "/settings", "/notifications"]) {
      const { page: slow } = await newAgentPage(browser);
      await slow.setViewport({ width: 1800, height: 1000 });
      await signIn(slow, ADMIN_EMAIL, PASSWORD);
      // Throttle so the skeleton is actually observable, then read both widths.
      const cdp = await slow.createCDPSession();
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 400,
        downloadThroughput: 200 * 1024,
        uploadThroughput: 200 * 1024,
      });
      slow.goto(`${BASE}${route}`, { waitUntil: "networkidle0", timeout: 90000 }).catch(() => {});
      const skeletonWidth = await slow
        .waitForFunction(
          () => {
            const el = document.querySelector("main > div");
            if (!el) return false;
            const w = el.getBoundingClientRect().width;
            return w > 0 ? w : false;
          },
          { timeout: 30000, polling: "raf" }
        )
        .then((h) => h.jsonValue())
        .catch(() => null);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      const settledWidth = await slow
        .waitForFunction(
          () => {
            const el = document.querySelector("main > div");
            return el ? el.getBoundingClientRect().width : false;
          },
          { timeout: 60000 }
        )
        .then((h) => h.jsonValue())
        .catch(() => null);
      if (skeletonWidth == null || settledWidth == null) {
        note(`resp-005: could not measure ${route}`);
      } else if (Math.abs(skeletonWidth - settledWidth) <= 2) {
        ok(`resp-005: ${route} skeleton and page are the same width (${Math.round(settledWidth)}px)`);
      } else {
        fail(
          `resp-005 content width jumps when ${route} settles`,
          `skeleton ${Math.round(skeletonWidth)}px → page ${Math.round(settledWidth)}px (${Math.round(settledWidth - skeletonWidth)}px shift) at a 1800px viewport`
        );
      }
      await slow.browserContext().close();
    }

    /* ═══════════════════════════════════════════════════════════════════
     * L. NATIVE SELECT KEYBOARD ACCESS  →  a11y-010 (baseline to protect)
     * The 27 native <select>s are the keyboard baseline any custom Select
     * primitive must not regress. Record it so a later replacement can be held
     * against a measured number, not a memory.
     * ═══════════════════════════════════════════════════════════════════ */
    section("L. native <select> keyboard baseline (a11y-010)");

    await admin.setViewport(DESKTOP);
    await admin.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
    const selectBaseline = await admin.evaluate(() => {
      const sels = [...document.querySelectorAll("select")];
      return sels.map((s) => {
        const ax = s.labels && s.labels.length > 0 ? s.labels[0].textContent.trim() : null;
        return {
          id: s.id || null,
          tabIndex: s.tabIndex,
          reachable: s.tabIndex >= 0 && s.offsetParent !== null && !s.disabled,
          accessibleName: s.getAttribute("aria-label") || ax,
          options: s.options.length,
        };
      });
    });
    const unnamed = selectBaseline.filter((s) => !s.accessibleName);
    const unreachable = selectBaseline.filter((s) => !s.reachable);
    if (unnamed.length === 0 && unreachable.length === 0) {
      ok(
        `a11y-010: all ${selectBaseline.length} native selects on /expenses are Tab-reachable and named`
      );
    } else {
      fail(
        "a11y-010 native select baseline is already broken",
        `${unnamed.length} without an accessible name, ${unreachable.length} not Tab-reachable: ${JSON.stringify(
          [...unnamed, ...unreachable].slice(0, 4)
        )}`
      );
    }
    // Keyboard value change: ArrowDown on a focused select must commit.
    const arrowWorks = await admin.evaluate(async () => {
      const s = document.querySelector("#expense-category");
      if (!s || s.options.length < 2) return null;
      const before = s.value;
      s.focus();
      s.selectedIndex = Math.min(s.selectedIndex + 1, s.options.length - 1);
      s.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
      return { before, after: s.value, changed: s.value !== before };
    });
    if (!arrowWorks) note("a11y-010: #expense-category has fewer than 2 options in a fresh tenant");
    else if (arrowWorks.changed) ok(`a11y-010: keyboard selection commits (${arrowWorks.before} → ${arrowWorks.after})`);
    else fail("a11y-010 keyboard selection did not commit", JSON.stringify(arrowWorks));

    /* ═══════════════════════════════════════════════════════════════════
     * M. MEMBER ROLE at 375px in Urdu — the role a11y regressions hide in.
     * Invited through the REAL invite flow, so this stays inside my tenant.
     * ═══════════════════════════════════════════════════════════════════ */
    section("M. member role, 375px, Urdu");

    const inviteUrl = await (async () => {
      await admin.setViewport(DESKTOP);
      await admin.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
      const sent = await admin.evaluate(async (email) => {
        const open = [...document.querySelectorAll("button")].find((b) =>
          /invite/i.test(b.textContent || "")
        );
        if (!open) return false;
        open.click();
        return true;
      }, MEMBER_EMAIL);
      if (!sent) return null;
      const formReady = await admin
        .waitForFunction(() => !!document.querySelector('[role="dialog"] input[type="email"]'), {
          timeout: 10000,
        })
        .then(() => true)
        .catch(() => false);
      if (!formReady) return null;
      await admin.type('[role="dialog"] input[type="email"]', MEMBER_EMAIL);
      await admin.evaluate(() => {
        document.querySelector('[role="dialog"] button[type="submit"]')?.click();
      });
      for (let i = 0; i < 24; i++) {
        const tok = await db.inviteToken.findFirst({
          where: { companyId: TENANT, email: MEMBER_EMAIL },
          select: { token: true },
          orderBy: { createdAt: "desc" },
        });
        if (tok) return `${BASE}/invite/${tok.token}`;
        await sleep(250);
      }
      return null;
    })();

    if (!inviteUrl) {
      note("member pass skipped: no invite token was issued for my tenant");
    } else {
      ok("invited a member through the real invite flow (scoped to my tenant)");
      const { page: member } = await newAgentPage(browser);
      await member.setViewport(PHONE);
      await member.goto(inviteUrl, { waitUntil: "networkidle0", timeout: 60000 });
      await member.waitForSelector("input", { timeout: 30000 });
      await sleep(1500);
      const accepted = await member.evaluate(
        (name, pw) => {
          const nameEl = document.querySelector("input[name=name], input[type=text]");
          const pwEl = document.querySelector("input[type=password]");
          if (!nameEl || !pwEl) return false;
          return true;
        },
        MEMBER_NAME,
        PASSWORD
      );
      if (!accepted) {
        note("member pass: invite form shape not recognised");
      } else {
        await member.type("input[name=name], input[type=text]", MEMBER_NAME);
        await member.type("input[type=password]", PASSWORD);
        await member.evaluate(() => document.querySelector("button[type=submit]")?.click());
        const landed = await member
          .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 45000 })
          .then(() => true)
          .catch(() => false);
        if (!landed) {
          note("member pass: invite acceptance never navigated");
        } else {
          const memberRow = await db.user.findFirst({
            where: { companyId: TENANT, email: MEMBER_EMAIL },
            select: { id: true, role: true },
          });
          if (memberRow?.role === "member") ok(`member joined my tenant as ${memberRow.role}`);
          else fail("member join", `role = ${memberRow?.role ?? "<no row>"}`);

          await inject(member);
          const memberShell = await member.evaluate(() => ({
            clipped: window.__ffA11y.clippedOverflow(),
            docOverflow: document.scrollingElement.scrollWidth - window.innerWidth,
            navLinks: [...document.querySelectorAll("aside a[href]")].map((a) =>
              a.getAttribute("href")
            ),
          }));
          if (memberShell.clipped.length === 0 && memberShell.docOverflow <= 1) {
            ok("resp-002: the member shell has no clipped overflow at 375px");
          } else {
            fail(
              "resp-002 member shell overflows at 375px",
              `${memberShell.docOverflow}px doc overflow; ${JSON.stringify(memberShell.clipped.slice(0, 2))}`
            );
          }
          note(`member nav: ${memberShell.navLinks.join(", ")}`);
          await member.screenshot({ path: `${OUT}/resp-03-member-375.png`, fullPage: true });
        }
      }
    }
  } catch (e) {
    fail("script threw before finishing", e.message);
    console.error(e);
  } finally {
    await destroyTenant(TENANT, COMPANY);
    await browser.close();
    await db.$disconnect();
  }

  console.log(`\n${passes} ok, ${failures} failed`);
  console.log(process.exitCode ? "== FAIL ==" : "== pass ==");
}

main().catch((err) => {
  console.error("qa-a11y-responsive-i18n threw:", err);
  process.exit(1);
});
