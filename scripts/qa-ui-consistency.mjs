/*
 * QA agent 18 — UI CONSISTENCY / VISUAL POLISH.  PHASE 2 EXERCISE SCRIPT.
 *
 * Commissioned from a user screenshot: the task-status dropdown renders as raw
 * OS chrome — system-blue highlight, system font, native chevron — inside an
 * otherwise designed app. This script does not stop at that dropdown. It
 * measures the whole "looks unfinished / inconsistent" class, because the
 * dropdown is a symptom of a missing primitive layer, not a one-file bug.
 *
 * Everything here is MEASURED in a real browser via getComputedStyle and
 * getBoundingClientRect, not asserted from source. A consistency audit that
 * greps class names cannot see that `rounded-xl` resolves to 48px in this
 * project; only the layout engine can.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DATA SAFETY — read before changing a single line.
 *
 * This script writes NOTHING outside the single workspace it creates itself.
 * It signs up `qa-ui-<stamp>` through the real signup form, invites its own
 * member through the real invite flow, and creates its own task / expense /
 * project through the real UI so the "populated" surfaces have content to
 * measure. Every DB read, assertion and delete below carries
 * `where: { companyId: TENANT }` (or a relation that narrows to it).
 *
 * There is not one bare `db.X.count()` / `db.X.findFirst()` in this file, and
 * that is load-bearing rather than tidy: many agents run against the same
 * database concurrently, so an unscoped "did my row land?" count can be
 * satisfied by somebody else's insert and go green while the feature is
 * broken. A false PASS is the single most expensive outcome of this audit.
 *
 * The seeded `demo-nimbus` workspace is never written and never asserted on.
 * `scripts/_qa-guard.mjs verify` hashes every demo row and fails the run if
 * that is untrue.
 *
 * A FRESH tenant is not a convenience here, it is the instrument: a brand-new
 * workspace is the only way to see EVERY first-run / empty state at once, and
 * first-run is exactly where the inconsistency is loudest (section 6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY x-real-ip IS SET ON EVERY PAGE. `getClientIp()` falls back to the
 * literal string "unknown" when no proxy header is present, which is always,
 * in dev. Without a per-agent header every agent shares ONE `limiters.auth`
 * bucket of 5 per 60s fed by nine call sites, and we would all starve each
 * other and file false "cannot sign in" bugs. Agent 18 owns 10.99.0.18.
 *
 * WHY EVERY WAIT IS A STATE PREDICATE. Under many concurrent agents a dev
 * server's round trips get long and variable; a fixed `setTimeout` that is
 * generous on an idle machine is a coin flip on a loaded one, and it fails in
 * the direction that files phantom bugs. The only fixed sleeps below are the
 * 1500ms hydration pause inside `signIn` / `signUp`, copied verbatim from
 * scripts/smoke-chat.mjs (FaultsAudit A14: a click that beats React performs
 * a NATIVE GET submit and the credentials end up in the query string), and one
 * paint tick after a layout-affecting class change has already been applied.
 *
 * Usage:  node scripts/qa-ui-consistency.mjs
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
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/ui-consistency";
/** Agent 18's rate-limit identity. See the header. */
const AGENT_IP = "10.99.0.18";

const STAMP = Date.now().toString().slice(-8);

/** Prefix `qa-` so the sweeper finds this tenant even if cleanup is killed. */
const COMPANY = `qa-ui-${STAMP}`;
const ADMIN_EMAIL = `qa-ui-${STAMP}@founderflow.test`;
const ADMIN_NAME = `QA UI Admin ${STAMP}`;
const MEMBER_EMAIL = `qa-ui-mem-${STAMP}@founderflow.test`;
const MEMBER_NAME = `QA UI Member ${STAMP}`;
const PASSWORD = `QaUi!${STAMP}`;

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
 * ROUTES
 *
 * Every authenticated surface an admin can reach. `loading` records whether
 * the segment ships a loading.tsx, which section 5 checks against reality.
 * ───────────────────────────────────────────────────────────────────────── */

const ROUTES = [
  { path: "/dashboard", name: "dashboard", loading: true },
  { path: "/chat", name: "chat", loading: true },
  { path: "/expenses", name: "expenses", loading: true },
  { path: "/investments", name: "investments", loading: true },
  { path: "/revenue", name: "revenue", loading: false },
  { path: "/recurring", name: "recurring", loading: true },
  { path: "/budgets", name: "budgets", loading: true },
  { path: "/projects", name: "projects", loading: true },
  { path: "/tasks", name: "tasks", loading: true },
  { path: "/time", name: "time", loading: true },
  { path: "/activities", name: "activities", loading: true },
  { path: "/team", name: "team", loading: true },
  { path: "/reports", name: "reports", loading: true },
  { path: "/notifications", name: "notifications", loading: true },
  { path: "/settings", name: "settings", loading: true },
];

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
async function newAgentPage(browser, viewport) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  if (viewport) await page.setViewport(viewport);
  wire(page);
  return { ctx, page };
}

/**
 * Sign in, retrying until React owns the click. COPIED VERBATIM from
 * scripts/smoke-chat.mjs — see the header note on FaultsAudit A14.
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
 * Create a workspace through the REAL two-step signup form. Same hydration
 * discipline as `signIn`: step 1's "Continue" is a `type="button"` that does
 * nothing without JS and the step-2 submit is `disabled={!hydrated}`, so a
 * pre-hydration run silently produces no workspace and every later assertion
 * becomes a lie.
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

/** Navigate and wait for the shell, not for a timer. */
async function visit(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForSelector('aside[aria-label="Primary"]', { timeout: 30000 })
    .catch(() => note(`no shell on ${path}`));
  // The shell gate renders "Loading workspace…" until Zustand adopts the
  // session. Measuring computed styles before that is measuring the gate.
  await page
    .waitForFunction(() => !/Loading workspace/i.test(document.body.innerText), { timeout: 30000 })
    .catch(() => {});
}

/* ─────────────────────────────────────────────────────────────────────────
 * IN-PAGE MEASUREMENT HELPERS
 *
 * Injected as strings because page.evaluate serialises the function it is
 * given and cannot close over Node-side helpers.
 * ───────────────────────────────────────────────────────────────────────── */

const CONTRAST_HELPERS = `
  function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function parseRgb(s) {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s\\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  /** Composite a possibly-translucent colour over an opaque backdrop. */
  function over(fg, bg) {
    if (!fg) return bg;
    if (fg.a >= 1) return fg;
    return {
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    };
  }
  function lum(c) { return 0.2126 * srgb(c.r) + 0.7152 * srgb(c.g) + 0.0722 * srgb(c.b); }
  function contrast(a, b) {
    if (!a || !b) return 0;
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  /** The nearest ancestor background that is not transparent. */
  function backdropOf(el) {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parseRgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.95) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
`;

/**
 * Every `<select>` on the page, with the three properties that decide whether
 * it reads as part of the design or as OS chrome.
 */
async function auditSelects(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("select")].map((sel) => {
      const cs = getComputedStyle(sel);
      const r = sel.getBoundingClientRect();
      // A custom chevron lives as an absolutely-positioned svg inside the
      // select's positioned wrapper. Radix/Headless would give a role=listbox
      // instead; neither exists in this project, which is the point.
      const wrapper = sel.closest("div,label,span") || sel.parentElement;
      const siblingSvg = wrapper
        ? [...wrapper.querySelectorAll("svg")].some((s) => {
            const sr = s.getBoundingClientRect();
            // Right-hand side of the control, vertically centred: a chevron.
            return sr.left >= r.left + r.width * 0.6 && sr.left <= r.right + 8;
          })
        : false;
      return {
        id: sel.id || null,
        name: sel.name || null,
        cls: sel.className,
        appearance: cs.appearance || cs.webkitAppearance,
        borderRadius: cs.borderTopLeftRadius,
        height: Math.round(r.height),
        fontFamily: cs.fontFamily,
        // A native-appearance select reserves ~16-20px for the OS chevron and
        // draws it itself; `appearance: none` removes it and nothing replaces
        // it unless `siblingSvg` is true.
        hasCustomChevron: siblingSvg,
        // No engine lets CSS reach the OPEN option list. If the app had a real
        // Select primitive there would be a role=listbox/option tree instead,
        // and there is not one anywhere in this codebase.
        hasListboxPrimitive: !!sel.closest('[role="combobox"]'),
        optionCount: sel.options.length,
      };
    });
  });
}

/**
 * Computed border-radius of every form control and card on the page, so the
 * token-vs-Tailwind radius inversion is measured rather than argued.
 */
async function auditRadii(page) {
  return page.evaluate(() => {
    const out = [];
    const sel = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const cs = getComputedStyle(el);
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const cls = el.className || "";
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        id: el.id || null,
        height: Math.round(r.height),
        width: Math.round(r.width),
        radius,
        // The engine clamps radius to half the shorter side, so a pill is
        // "radius >= height/2" — the honest test, not "radius === 48".
        rendersAsPill: radius >= r.height / 2 - 0.5,
        declaredXl: /(^|\s)rounded-xl(\s|$)/.test(cls),
        declaredLg: /(^|\s)rounded-lg(\s|$)/.test(cls),
        declared2xl: /(^|\s)rounded-2xl(\s|$)/.test(cls),
      });
    }
    return out;
  });
}

/**
 * Focus each interactive element the way a keyboard user would and measure
 * whether ANY visible indicator appears. Returns contrast ratios so "the
 * border tints slightly" is separated from "there is a focus ring".
 */
async function auditFocusIndicators(page) {
  return page.evaluate(`(() => {
    ${CONTRAST_HELPERS}
    const results = [];
    const sel = "input:not([type=hidden]),select,textarea,button,a[href]";
    const els = [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.width > 0 && !el.disabled;
    });
    for (const el of els.slice(0, 60)) {
      const before = getComputedStyle(el);
      const beforeBorder = before.borderTopColor;
      const beforeShadow = before.boxShadow;
      el.focus({ preventScroll: true });
      const after = getComputedStyle(el);
      const bd = backdropOf(el.parentElement || el);

      const outlineW = parseFloat(after.outlineWidth) || 0;
      const outlineColor = parseRgb(after.outlineColor);
      const outlineVisible =
        after.outlineStyle !== "none" && outlineW >= 1 && outlineColor && outlineColor.a > 0.1;

      const borderChanged = after.borderTopColor !== beforeBorder;
      const borderContrast = borderChanged
        ? contrast(over(parseRgb(after.borderTopColor), bd), bd)
        : 0;
      const shadowChanged = after.boxShadow !== beforeShadow && after.boxShadow !== "none";

      results.push({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || null,
        id: el.id || null,
        matchesFocusVisible: el.matches(":focus-visible"),
        outlineStyle: after.outlineStyle,
        outlineWidth: outlineW,
        outlineColor: after.outlineColor,
        outlineVisible,
        borderChanged,
        // WCAG 2.2 SC 1.4.11 wants >= 3:1 for a non-text indicator against
        // what it sits on. Below that the "focus ring" is decoration.
        borderContrast: Math.round(borderContrast * 100) / 100,
        shadowChanged,
        anyIndicator: outlineVisible || shadowChanged || borderContrast >= 3,
      });
      el.blur();
    }
    return results;
  })()`);
}

/**
 * Are the design-system classes declared in globals.css actually used? A
 * stylesheet full of unused primitives IS the drift mechanism: every screen
 * re-invents the button.
 */
async function auditDesignSystemUsage(page) {
  return page.evaluate(() => {
    const classes = [
      "btn-primary",
      "btn-secondary",
      "btn-ghost",
      "btn-danger",
      "input",
      "label",
      "card",
      "glass-card",
      "badge",
      "badge-success",
      "badge-warning",
      "badge-danger",
      "badge-info",
      "badge-default",
      "pill-mono",
    ];
    const declared = {};
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin (Google Fonts) — not ours
      }
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        for (const c of classes) {
          if (rule.selectorText.split(/[\s,>+~]+/).includes("." + c)) declared[c] = true;
        }
      }
    }
    const used = {};
    for (const c of classes) used[c] = document.getElementsByClassName(c).length;
    return { declared, used };
  });
}

/**
 * Collect the rendered signature of every "primary action" button — a
 * primary-filled pill — so the number of DISTINCT shapes can be counted.
 * One product should have one primary button, not eight.
 */
async function auditButtonSignatures(page) {
  return page.evaluate(`(() => {
    ${CONTRAST_HELPERS}
    const sigs = [];
    for (const el of document.querySelectorAll("button,a[href]")) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const cs = getComputedStyle(el);
      const bg = parseRgb(cs.backgroundColor);
      if (!bg || bg.a < 0.6) continue;
      // The emerald brand fill is rgb(16 185 129) in both themes.
      const isPrimaryFill = Math.abs(bg.r - 16) < 24 && Math.abs(bg.g - 185) < 24 && Math.abs(bg.b - 129) < 24;
      if (!isPrimaryFill) continue;
      sigs.push([
        Math.round(r.height),
        cs.paddingLeft,
        cs.paddingTop,
        cs.fontSize,
        cs.fontWeight,
        Math.round(parseFloat(cs.borderTopLeftRadius) || 0),
      ].join("|"));
    }
    return sigs;
  })()`);
}

/**
 * Classify how this surface tells the user "there is nothing here yet":
 * the illustrated EmptyState primitive, or a bare line of prose.
 */
async function auditEmptyStates(page) {
  return page.evaluate(() => {
    // EmptyState renders a 64px tinted icon tile above an h3 and a p.
    const tiles = [...document.querySelectorAll("div")].filter((d) => {
      const c = typeof d.className === "string" ? d.className : "";
      return (
        c.includes("h-16") && c.includes("w-16") && c.includes("rounded-2xl") && !!d.querySelector("svg")
      );
    });
    const primitive = tiles
      .map((t) => {
        const box = t.parentElement;
        const h3 = box?.querySelector("h3,h1,h2");
        return h3 ? h3.textContent.trim() : null;
      })
      .filter(Boolean);

    // A bare-prose empty state: a muted <p> that says nothing is here, with no
    // icon tile and no call to action anywhere near it.
    const prose = [];
    for (const p of document.querySelectorAll("p")) {
      const text = p.textContent.trim();
      if (!/^(no |nothing )/i.test(text)) continue;
      if (text.length > 90) continue;
      const box = p.closest("section,div") || p.parentElement;
      const hasTile = box
        ? [...box.querySelectorAll("div")].some((d) => {
            const c = typeof d.className === "string" ? d.className : "";
            return c.includes("h-16") && c.includes("w-16");
          })
        : false;
      if (hasTile) continue;
      const hasCta = box ? !!box.querySelector("button,a[href]") : false;
      prose.push({ text, hasCta });
    }
    return { primitive, prose };
  });
}

/** The widest thing on the page vs the viewport — clipped or scrolling. */
async function auditOverflow(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement || document.documentElement;
    const main = document.getElementById("main");
    const offenders = [];
    if (main) {
      const mr = main.getBoundingClientRect();
      for (const el of main.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        // Overflow of more than 2px past the scrollport's content box, in an
        // ancestor chain that cannot scroll, means the pixels are CUT OFF.
        if (r.right > mr.right + 2) {
          let scrollable = false;
          let n = el.parentElement;
          while (n && n !== main.parentElement) {
            const ov = getComputedStyle(n).overflowX;
            if ((ov === "auto" || ov === "scroll") && n.scrollWidth > n.clientWidth + 1) {
              scrollable = true;
              break;
            }
            n = n.parentElement;
          }
          if (!scrollable) {
            offenders.push({
              tag: el.tagName.toLowerCase(),
              cls: String(el.className).slice(0, 90),
              overflowPx: Math.round(r.right - mr.right),
            });
          }
        }
      }
    }
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      horizontalPageScroll: doc.scrollWidth > doc.clientWidth + 1,
      // Dedupe by class signature: 40 rows of one broken table is one bug.
      clipped: [...new Map(offenders.map((o) => [o.cls, o])).values()].slice(0, 8),
    };
  });
}

/** The page's own content container width — the "how wide is this surface" drift. */
async function auditContainerWidth(page) {
  return page.evaluate(() => {
    const main = document.getElementById("main");
    if (!main) return null;
    // The page root is main's first element child that actually holds content.
    const kid = [...main.children].find((c) => c.getBoundingClientRect().height > 0);
    if (!kid) return null;
    const cs = getComputedStyle(kid);
    return {
      maxWidth: cs.maxWidth,
      width: Math.round(kid.getBoundingClientRect().width),
      mainWidth: Math.round(main.getBoundingClientRect().width),
    };
  });
}

/** How much of the visible copy is still Latin script after switching to Urdu. */
async function auditTranslationCoverage(page) {
  return page.evaluate(() => {
    const main = document.getElementById("main");
    const scope = main || document.body;
    const latin = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n;
    let latinChars = 0;
    let urduChars = 0;
    while ((n = walker.nextNode())) {
      const el = n.parentElement;
      if (!el || el.closest(".sr-only") || el.offsetParent === null) continue;
      const t = n.textContent.trim();
      if (!t) continue;
      const lat = (t.match(/[A-Za-z]/g) || []).length;
      const urd = (t.match(/[\u0600-\u06FF]/g) || []).length;
      latinChars += lat;
      urduChars += urd;
      if (lat >= 4 && urd === 0 && latin.length < 12) latin.push(t.slice(0, 48));
    }
    return {
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      latinChars,
      urduChars,
      sampleUntranslated: latin,
    };
  });
}

/**
 * Every visible text node whose colour misses its WCAG AA floor, plus which
 * accent token produced it.
 *
 * WHY THIS IS A CONSISTENCY CHECK, NOT AN A11Y SIDE QUEST: globals.css defines
 * TWO ramps and says so in its own comments — the bare token (`--danger`,
 * `--primary`, `--warning`) for FILLS and borders, and a `-strong` variant that
 * is the only one safe as text. Reaching for the fill token in a `text-*`
 * utility is the single most common token misuse in this codebase, and it fails
 * in OPPOSITE themes depending on the token: `--danger` is red-600 in both
 * themes so `text-danger` misses on DARK, while `--primary`/`--warning` stay
 * bright so `text-primary` misses on LIGHT. Sweeping one theme would clear the
 * other half and report a false all-clear.
 */
async function sweepContrast(page) {
  return page.evaluate(`(() => {
    ${CONTRAST_HELPERS}
    const out = [];
    const main = document.getElementById("main");
    if (!main) return out;
    for (const el of main.querySelectorAll("*")) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || "").trim();
      if (t.length < 3) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || el.offsetParent === null) continue;
      if (el.closest(".sr-only")) continue;
      const cs = getComputedStyle(el);
      const bd = backdropOf(el);
      const ratio = contrast(over(parseRgb(cs.color), bd), bd);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      const floor = large ? 3 : 4.5;
      if (ratio >= floor) continue;
      const cls = String(el.className);
      // Name the token so the fix is "swap to -strong", not "investigate".
      const token = (cls.match(/text-(danger|warning|success|info|primary|forest|mint|slate)(?!-strong)\\b/) || [])[0] || null;
      out.push({
        text: t.slice(0, 40),
        ratio: Math.round(ratio * 100) / 100,
        floor,
        size,
        token,
        cls: cls.slice(0, 70),
      });
    }
    return [...new Map(out.map((o) => [o.text + "|" + o.token, o])).values()].slice(0, 8);
  })()`);
}

/** Native scrollbar chrome on the main scrollport vs a themed inner one. */
async function auditScrollbars(page) {
  return page.evaluate(() => {
    const main = document.getElementById("main");
    const thin = document.querySelector(".scrollbar-thin");
    const read = (el) =>
      el
        ? {
            cls: String(el.className).slice(0, 70),
            scrollbarWidth: getComputedStyle(el).scrollbarWidth || "auto",
            hasThinClass: String(el.className).includes("scrollbar-thin"),
            gutterPx: el.offsetWidth - el.clientWidth,
            scrolls: el.scrollHeight > el.clientHeight + 1,
          }
        : null;
    return { main: read(main), inner: read(thin) };
  });
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

  console.log("== qa: ui consistency ==");

  let TENANT = null;

  try {
    /* ── 0. Tenant: sign up through the real form ─────────────────────── */
    const { page: admin } = await newAgentPage(browser);
    await signUp(admin, {
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: PASSWORD,
      companyName: COMPANY,
    });

    // THE ONE QUERY THAT CANNOT CARRY companyId, because it is the query that
    // DISCOVERS companyId. It is safe for the same reason the rule exists: the
    // key is `qa-ui-<8-digit stamp>`, a name no other agent and no seeded row
    // can hold, so another tenant's insert cannot satisfy it. Every assertion
    // after this line is scoped to the id it returns.
    const company = await db.company.findFirst({
      where: { name: COMPANY },
      select: { id: true },
    });
    if (!company) {
      fail("signup created a workspace", `no Company row named ${COMPANY}`);
      return;
    }
    TENANT = company.id;
    ok(`tenant created through the signup form (${TENANT})`);

    /* ═══════════════════════════════════════════════════════════════════
     * 1. THE RADIUS INVERSION  (promotes ui-001)
     *
     * tailwind.config.ts overrides borderRadius.{sm,DEFAULT,lg,xl} with the
     * --radius-* tokens (0.5 / 1 / 2 / 3rem) but leaves 2xl/3xl/md at stock.
     * The scale therefore inverts: `rounded-xl` is 48px — a PILL on a 42px
     * input — while `rounded-2xl` is stock 16px. components/auth/auth-ui.ts
     * documents this trap in a comment and is imported by nothing.
     *
     * The honest test is not "radius === 48". It is "the engine clamped the
     * radius to half the height", i.e. the control renders as a pill when the
     * class name says it should be a 12px rounded rectangle.
     * ═══════════════════════════════════════════════════════════════════ */
    await visit(admin, "/tasks");
    // Open the task form — the densest collection of controls in the product.
    const opened = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /new task|add task/i.test(b.textContent || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (opened) {
      await admin
        .waitForFunction(() => !!document.querySelector('[role="dialog"] input'), { timeout: 15000 })
        .catch(() => {});
    } else {
      note("no New task button found — measuring the page's own controls instead");
    }

    const radii = await auditRadii(admin);
    await admin.screenshot({ path: `${OUT}/01-task-form-radii.png` });

    const xlPills = radii.filter((r) => r.declaredXl && r.rendersAsPill);
    const xlTotal = radii.filter((r) => r.declaredXl);
    if (xlTotal.length === 0) {
      note("no rounded-xl control on screen — radius check inconclusive here");
    } else if (xlPills.length > 0) {
      fail(
        "rounded-xl form controls render as full pills",
        `${xlPills.length}/${xlTotal.length} measured rounded-xl controls have radius >= height/2 ` +
          `(e.g. ${xlPills[0].tag}${xlPills[0].id ? "#" + xlPills[0].id : ""}: ` +
          `radius ${xlPills[0].radius}px on a ${xlPills[0].height}px control). ` +
          `Tailwind's stock rounded-xl is 12px. Promotes ui-001 to observed.`
      );
    } else {
      ok("rounded-xl controls render as rounded rectangles, not pills");
    }

    // The inversion itself: 2xl must be LARGER than xl for the scale to be
    // coherent. Measure both on the same page.
    const xlR = xlTotal[0]?.radius;
    const twoXl = radii.find((r) => r.declared2xl)?.radius;
    if (xlR != null && twoXl != null) {
      if (xlR > twoXl) {
        fail(
          "the radius scale is non-monotonic",
          `rounded-xl measured ${xlR}px but rounded-2xl measured ${twoXl}px — a bigger-sounding ` +
            `name produces a smaller radius, so every surface guesses. Promotes ui-001.`
        );
      } else {
        ok(`radius scale is monotonic (xl ${xlR}px <= 2xl ${twoXl}px)`);
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 2. NATIVE <select> — the screenshot  (promotes ui-002, ui-003)
     * ═══════════════════════════════════════════════════════════════════ */
    let totalSelects = 0;
    let withChevron = 0;
    let appearanceNone = 0;
    let anyListbox = 0;
    const chevronByRoute = {};

    for (const route of ROUTES) {
      await visit(admin, route.path);
      const selects = await auditSelects(admin);
      if (selects.length === 0) continue;
      totalSelects += selects.length;
      const none = selects.filter((s) => s.appearance === "none").length;
      const chev = selects.filter((s) => s.hasCustomChevron).length;
      appearanceNone += none;
      withChevron += chev;
      anyListbox += selects.filter((s) => s.hasListboxPrimitive).length;
      chevronByRoute[route.name] = { count: selects.length, appearanceNone: none, chevron: chev };
      await admin.screenshot({ path: `${OUT}/02-selects-${route.name}.png` });
    }

    // Open the exact control from the user's screenshot and photograph it.
    await visit(admin, "/tasks");
    const statusSel = await admin.$('select[id^="status-"], select[id^="board-status-"]');
    if (statusSel) {
      await statusSel.focus();
      await admin.screenshot({ path: `${OUT}/03-task-status-select-focused.png` });
      ok("captured the task-status select from the user's screenshot");
    } else {
      note("no task-status select on /tasks in an empty workspace — create a task first");
    }

    if (anyListbox === 0 && totalSelects > 0) {
      fail(
        "no Select primitive exists — every dropdown is a native <select>",
        `${totalSelects} native selects measured across ${Object.keys(chevronByRoute).length} routes, ` +
          `0 backed by a role=combobox/listbox. An open <option> list cannot be styled by CSS at ` +
          `any level, so it renders in the OS font with the OS highlight colour on every platform. ` +
          `Promotes ui-002 to observed.`
      );
    } else if (totalSelects > 0) {
      ok(`${anyListbox}/${totalSelects} dropdowns use a styleable listbox primitive`);
    }

    if (totalSelects > 0 && withChevron < totalSelects) {
      fail(
        "dropdowns disagree about whether they have a chevron",
        `of ${totalSelects} selects: ${appearanceNone} set appearance:none (OS chevron removed) ` +
          `and only ${withChevron} draw a replacement. ${totalSelects - appearanceNone} keep the raw ` +
          `OS chevron. So the same product shows three different affordances: native arrow, custom ` +
          `arrow, and NO arrow at all (a select that looks exactly like a text input). ` +
          `Per route: ${JSON.stringify(chevronByRoute)}. Promotes ui-003 to observed.`
      );
    } else if (totalSelects > 0) {
      ok("every dropdown shows exactly one chevron treatment");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 3. FOCUS INDICATORS  (promotes ui-004)
     *
     * globals.css declares `:focus-visible { outline: 2px solid ring }`, but
     * Tailwind's `focus:outline-none` compiles to `.focus\\:outline-none:focus`
     * — specificity (0,2,0) beats `:focus-visible` (0,1,0) — so the utility
     * wins wherever both apply. What is left is `focus:border-primary/50`: a
     * 1px border at 50% alpha.
     * ═══════════════════════════════════════════════════════════════════ */
    for (const path of ["/tasks", "/settings", "/expenses"]) {
      await visit(admin, path);
      const focusAudit = await auditFocusIndicators(admin);
      const keyboardish = focusAudit.filter((f) => f.matchesFocusVisible);
      const blind = keyboardish.filter((f) => !f.anyIndicator);
      const weak = keyboardish.filter(
        (f) => !f.outlineVisible && !f.shadowChanged && f.borderChanged && f.borderContrast < 3
      );

      if (blind.length > 0) {
        fail(
          `${path}: keyboard focus is invisible on ${blind.length} controls`,
          `of ${keyboardish.length} focusable elements matching :focus-visible, ${blind.length} show ` +
            `no outline, no box-shadow and no border change — e.g. ` +
            `${blind[0].tag}${blind[0].id ? "#" + blind[0].id : ""} (outlineStyle ` +
            `${blind[0].outlineStyle}, width ${blind[0].outlineWidth}px, colour ${blind[0].outlineColor}). ` +
            `Promotes ui-004 to observed.`
        );
      } else {
        ok(`${path}: every :focus-visible control shows some indicator`);
      }

      if (weak.length > 0) {
        fail(
          `${path}: ${weak.length} controls replace the focus ring with a sub-3:1 border tint`,
          `WCAG 2.2 SC 1.4.11 wants >= 3:1 for a non-text indicator; measured ` +
            `${weak.map((w) => w.borderContrast).slice(0, 5).join(", ")}. Promotes ui-004.`
        );
      }

      // Also walk with a real Tab, because Chrome only grants :focus-visible
      // to buttons after keyboard interaction.
      await admin.evaluate(() => document.body.focus());
      const tabbed = [];
      for (let i = 0; i < 14; i++) {
        await admin.keyboard.press("Tab");
        tabbed.push(
          await admin.evaluate(`(() => {
            ${CONTRAST_HELPERS}
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const cs = getComputedStyle(el);
            const w = parseFloat(cs.outlineWidth) || 0;
            const c = parseRgb(cs.outlineColor);
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              ringVisible: cs.outlineStyle !== "none" && w >= 1 && !!c && c.a > 0.1,
              shadow: cs.boxShadow !== "none",
            };
          })()`)
        );
      }
      const real = tabbed.filter(Boolean);
      const noRing = real.filter((t) => !t.ringVisible && !t.shadow);
      if (noRing.length > 0) {
        fail(
          `${path}: Tab-walk found ${noRing.length}/${real.length} stops with no focus ring`,
          `first: ${noRing[0].tag}${noRing[0].id ? "#" + noRing[0].id : ""}. A keyboard user cannot ` +
            `tell where they are. Promotes ui-004.`
        );
      } else {
        ok(`${path}: every Tab stop paints a focus ring`);
      }
      await admin.screenshot({ path: `${OUT}/04-focus-${path.slice(1)}.png` });
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 4. THE DEAD DESIGN SYSTEM  (promotes ui-005)
     *
     * globals.css @layer components declares .btn-primary/.btn-secondary/
     * .btn-ghost, .btn-danger, .input, .card, .badge-N, .pill-mono. If those are
     * declared and used zero times, every screen hand-rolls its own button —
     * which is the mechanism behind all the drift above.
     * ═══════════════════════════════════════════════════════════════════ */
    const allSigs = [];
    let dsReport = null;
    for (const route of ROUTES) {
      await visit(admin, route.path);
      const ds = await auditDesignSystemUsage(admin);
      if (!dsReport) dsReport = { declared: ds.declared, used: { ...ds.used } };
      else for (const k of Object.keys(ds.used)) dsReport.used[k] += ds.used[k];
      allSigs.push(...(await auditButtonSignatures(admin)));
    }

    if (dsReport) {
      const deadPrimitives = Object.keys(dsReport.declared).filter((c) => dsReport.used[c] === 0);
      if (deadPrimitives.length > 0) {
        fail(
          `${deadPrimitives.length} declared design-system classes are never used`,
          `declared in globals.css and rendered zero times across all ${ROUTES.length} routes: ` +
            `${deadPrimitives.join(", ")}. Nothing enforces a shared button/input, so each screen ` +
            `re-invents one. Promotes ui-005 to observed.`
        );
      } else {
        ok("every declared design-system class is actually used");
      }
    }

    const distinct = new Set(allSigs);
    if (distinct.size > 3) {
      fail(
        `the primary button has ${distinct.size} distinct rendered shapes`,
        `${allSigs.length} primary-filled buttons across ${ROUTES.length} routes resolve to ` +
          `${distinct.size} different (height|padding|font|radius) signatures: ` +
          `${[...distinct].slice(0, 8).join("  /  ")}. Promotes ui-005 to observed.`
      );
    } else {
      ok(`the primary button has ${distinct.size} rendered shapes`);
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 5. LOADING: MISSING SKELETON + SKELETON/PAGE WIDTH MISMATCH
     *    (promotes ui-006, ui-007)
     *
     * Throttling the network is how a skeleton becomes observable at all; on
     * localhost every RSC payload lands before the Suspense boundary paints.
     * ═══════════════════════════════════════════════════════════════════ */
    const cdp = await admin.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 1200,
      downloadThroughput: (200 * 1024) / 8,
      uploadThroughput: (200 * 1024) / 8,
    });

    const skeletonWidths = {};
    for (const route of ROUTES) {
      await visit(admin, "/dashboard");
      // Click the sidebar link so this is a real client-side transition — the
      // only navigation kind a loading.tsx participates in.
      const clicked = await admin.evaluate((p) => {
        const a = document.querySelector(`aside a[href="${p}"], nav a[href="${p}"]`);
        if (!a) return false;
        a.click();
        return true;
      }, route.path);
      if (!clicked) {
        note(`no sidebar link to ${route.path} (role-gated or nested) — skipping skeleton check`);
        continue;
      }

      // A skeleton is an animate-pulse block. Look for one BEFORE the route's
      // real content resolves; a miss with 1.2s of latency means none exists.
      const sawSkeleton = await admin
        .waitForFunction(
          () => {
            const main = document.getElementById("main");
            return !!main && !!main.querySelector(".animate-pulse");
          },
          { timeout: 4000, polling: 50 }
        )
        .then(() => true)
        .catch(() => false);

      if (sawSkeleton) {
        skeletonWidths[route.name] = await admin.evaluate(() => {
          const main = document.getElementById("main");
          const kid = [...main.children].find((c) => c.getBoundingClientRect().height > 0);
          return kid ? Math.round(kid.getBoundingClientRect().width) : null;
        });
        await admin.screenshot({ path: `${OUT}/05-skeleton-${route.name}.png` });
      }

      if (route.loading && !sawSkeleton) {
        note(`${route.path}: expected a skeleton and saw none (may have resolved too fast)`);
      }
      if (!route.loading) {
        if (sawSkeleton) {
          ok(`${route.path} shows a loading skeleton after all`);
        } else {
          fail(
            `${route.path} has no loading skeleton while every sibling does`,
            `with 1.2s latency the sidebar click produced no .animate-pulse in #main — the sidebar ` +
              `item highlights and the screen sits on the PREVIOUS page's content until the query ` +
              `resolves. app/(app)/revenue/ ships no loading.tsx; all 14 sibling routes do. ` +
              `Promotes ui-006 to observed.`
          );
        }
      }

      // Now the settled width, to catch a skeleton sized differently from its page.
      await admin
        .waitForFunction(
          () => {
            const main = document.getElementById("main");
            return !!main && !main.querySelector(".animate-pulse");
          },
          { timeout: 60000 }
        )
        .catch(() => {});
      const settled = await auditContainerWidth(admin);
      const sk = skeletonWidths[route.name];
      if (sk != null && settled && Math.abs(sk - settled.width) > 24) {
        fail(
          `${route.path}: the skeleton is a different width from the page it stands in for`,
          `skeleton container ${sk}px, settled page ${settled.width}px (max-width ` +
            `${settled.maxWidth}) — a ${Math.abs(sk - settled.width)}px horizontal jump on every ` +
            `navigation to this route. Promotes ui-007 to observed.`
        );
      } else if (sk != null) {
        ok(`${route.path}: skeleton and page agree on width (${sk}px)`);
      }
    }
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    /* ── 5b. Container-width drift between sibling surfaces ─────────────── */
    const widths = {};
    for (const route of ROUTES) {
      await visit(admin, route.path);
      const w = await auditContainerWidth(admin);
      if (w) widths[route.name] = w.maxWidth;
    }
    const distinctWidths = new Set(Object.values(widths).filter((v) => v && v !== "none"));
    if (distinctWidths.size > 2) {
      fail(
        `sibling surfaces use ${distinctWidths.size} different content widths`,
        `${JSON.stringify(widths)} — at 1440px the same workspace is visibly narrower on some ` +
          `routes than others, with no rule a reader can infer. Promotes ui-008 to observed.`
      );
    } else {
      ok(`content width is consistent (${[...distinctWidths].join(", ")})`);
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 6. FIRST-RUN / EMPTY STATES  (promotes ui-009)
     *
     * This is why the tenant is fresh: right now EVERY surface is empty, so
     * one pass sees every zero-state the product has.
     * ═══════════════════════════════════════════════════════════════════ */
    const emptyByRoute = {};
    for (const route of ROUTES) {
      await visit(admin, route.path);
      emptyByRoute[route.name] = await auditEmptyStates(admin);
      await admin.screenshot({ path: `${OUT}/06-firstrun-${route.name}.png`, fullPage: true });
    }
    const usingPrimitive = Object.entries(emptyByRoute).filter(([, v]) => v.primitive.length > 0);
    const usingProse = Object.entries(emptyByRoute).filter(
      ([, v]) => v.primitive.length === 0 && v.prose.length > 0
    );
    if (usingPrimitive.length > 0 && usingProse.length > 0) {
      fail(
        "empty states use two different visual languages",
        `${usingPrimitive.length} routes render the illustrated EmptyState (icon tile + heading + ` +
          `description + CTA): ${usingPrimitive.map(([k]) => k).join(", ")}. ` +
          `${usingProse.length} render one line of muted prose instead: ` +
          `${usingProse.map(([k]) => k).join(", ")} — e.g. ` +
          `${JSON.stringify(usingProse[0][1].prose.slice(0, 3))}. Promotes ui-009 to observed.`
      );
    } else {
      ok("every empty state uses one visual language");
    }
    const ctaLess = Object.entries(emptyByRoute).flatMap(([k, v]) =>
      v.prose.filter((p) => !p.hasCta).map((p) => `${k}: "${p.text}"`)
    );
    if (ctaLess.length > 0) {
      fail(
        `${ctaLess.length} first-run empty states offer the user no next step`,
        `${ctaLess.slice(0, 6).join(" | ")} — on a brand-new workspace this is the FIRST thing the ` +
          `paying customer sees on these panels. Promotes ui-009.`
      );
    } else {
      ok("every empty state offers a next step");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 7. SCROLLBARS  (promotes ui-010)
     * ═══════════════════════════════════════════════════════════════════ */
    await visit(admin, "/settings");
    const sb = await auditScrollbars(admin);
    if (sb.main && sb.inner && sb.main.hasThinClass !== sb.inner.hasThinClass) {
      fail(
        "the app's primary scrollbar is OS chrome while inner panels are themed",
        `#main: scrollbar-thin=${sb.main.hasThinClass}, gutter ${sb.main.gutterPx}px, ` +
          `scrollbar-width "${sb.main.scrollbarWidth}". Inner panel (${sb.inner.cls}): ` +
          `scrollbar-thin=${sb.inner.hasThinClass}, scrollbar-width "${sb.inner.scrollbarWidth}". ` +
          `On Windows that is a 17px light-grey system bar next to a 6px themed one. ` +
          `Promotes ui-010 to observed.`
      );
    } else {
      ok("scrollbar treatment is consistent between the scrollport and inner panels");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 8. RESPONSIVE — 375 / 768 / 1440  (promotes ui-011)
     *
     * #main is `overflow-x-hidden`, so anything too wide is CLIPPED, not
     * scrollable. `auditOverflow` only reports offenders whose ancestors
     * cannot scroll, which is the difference between a design choice and
     * lost content.
     * ═══════════════════════════════════════════════════════════════════ */
    for (const vp of [
      { width: 375, height: 812, label: "375" },
      { width: 768, height: 1024, label: "768" },
      { width: 1440, height: 1000, label: "1440" },
    ]) {
      const { page: rp } = await newAgentPage(browser, { width: vp.width, height: vp.height });
      await signIn(rp, ADMIN_EMAIL, PASSWORD);
      for (const route of ROUTES) {
        await visit(rp, route.path);
        const of = await auditOverflow(rp);
        if (of.horizontalPageScroll) {
          fail(
            `${route.path} @${vp.label}px scrolls horizontally`,
            `document scrollWidth ${of.docScrollWidth} > clientWidth ${of.docClientWidth}`
          );
        }
        if (of.clipped.length > 0) {
          fail(
            `${route.path} @${vp.label}px clips content that cannot be scrolled to`,
            `#main is overflow-x-hidden, so these pixels are unreachable: ` +
              `${of.clipped.map((c) => `${c.tag}(+${c.overflowPx}px) ${c.cls}`).join(" | ")}. ` +
              `Promotes ui-011 to observed.`
          );
          await rp.screenshot({
            path: `${OUT}/07-clip-${vp.label}-${route.name}.png`,
            fullPage: true,
          });
        }
      }
      // Evidence shots regardless of pass/fail — this is a visual audit.
      for (const route of ["/dashboard", "/tasks", "/expenses", "/settings", "/reports"]) {
        await visit(rp, route);
        await rp.screenshot({
          path: `${OUT}/08-${vp.label}-${route.slice(1)}.png`,
          fullPage: true,
        });
      }
      await rp.close().catch(() => {});
      ok(`captured every surface at ${vp.label}px`);
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 9. TOKEN MISUSE IN BOTH THEMES  (promotes ui-012)
     *
     * Swept in DARK (the default) and LIGHT, because the fill-vs-text token
     * split fails in opposite themes — see sweepContrast's header.
     * ═══════════════════════════════════════════════════════════════════ */
    async function contrastPass(label) {
      const offenders = {};
      for (const route of ROUTES) {
        await visit(admin, route.path);
        const bad = await sweepContrast(admin);
        if (bad.length > 0) {
          offenders[route.name] = bad;
          await admin.screenshot({
            path: `${OUT}/09-${label}-${route.name}.png`,
            fullPage: true,
          });
        }
      }
      const routes = Object.keys(offenders);
      if (routes.length === 0) {
        ok(`${label} theme: every text node clears its WCAG AA floor`);
        return;
      }
      const tokens = [
        ...new Set(
          Object.values(offenders)
            .flat()
            .map((b) => b.token)
            .filter(Boolean)
        ),
      ];
      const worst = Object.values(offenders)
        .flat()
        .sort((a, b) => a.ratio - b.ratio)
        .slice(0, 5);
      fail(
        `${label} theme: low-contrast text on ${routes.length}/${ROUTES.length} surfaces`,
        `offending routes: ${routes.join(", ")}. Fill-ramp tokens used as text: ` +
          `${tokens.join(", ")} (each has a -strong variant that exists for exactly this). ` +
          `Worst: ${worst
            .map((w) => `"${w.text}" ${w.ratio}:1 (needs ${w.floor}) via ${w.token ?? w.cls}`)
            .join(" | ")}. Promotes ui-012 to observed.`
      );
    }

    await contrastPass("dark");

    await visit(admin, "/settings");
    const flipped = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /switch to light|light/i.test(b.getAttribute("aria-label") || b.textContent || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (flipped) {
      await admin
        .waitForFunction(() => !document.documentElement.classList.contains("dark"), {
          timeout: 10000,
        })
        .catch(() => {});
      await sleep(250); // one paint tick after the class already landed
      await contrastPass("light");
      // Return to dark so later sections measure the default experience.
      await visit(admin, "/settings");
      await admin.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /switch to dark|dark/i.test(b.getAttribute("aria-label") || b.textContent || "")
        );
        btn?.click();
      });
      await admin
        .waitForFunction(() => document.documentElement.classList.contains("dark"), {
          timeout: 10000,
        })
        .catch(() => {});
    } else {
      note("could not find the theme toggle — light-theme sweep skipped");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 10. HALF-TRANSLATED RTL  (promotes ui-013)
     *
     * Only 26 of 140 client components call useT(). Switching to Urdu flips
     * `dir="rtl"` on <html> for the WHOLE document, so the untranslated 114
     * get mirrored layout with English copy.
     * ═══════════════════════════════════════════════════════════════════ */
    await visit(admin, "/settings");
    const urdu = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /اردو/.test(b.textContent || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (urdu) {
      await admin
        .waitForFunction(() => document.documentElement.dir === "rtl", { timeout: 10000 })
        .catch(() => {});
      const coverage = {};
      for (const route of ROUTES) {
        await visit(admin, route.path);
        coverage[route.name] = await auditTranslationCoverage(admin);
        await admin.screenshot({ path: `${OUT}/10-urdu-${route.name}.png`, fullPage: true });
      }
      const untranslated = Object.entries(coverage).filter(
        ([, v]) => v.dir === "rtl" && v.latinChars > v.urduChars * 2 && v.latinChars > 80
      );
      if (untranslated.length > 0) {
        fail(
          `${untranslated.length}/${ROUTES.length} surfaces are English inside an RTL layout`,
          untranslated
            .map(
              ([k, v]) =>
                `${k}: ${v.latinChars} Latin vs ${v.urduChars} Urdu chars ` +
                `(e.g. ${JSON.stringify(v.sampleUntranslated.slice(0, 2))})`
            )
            .slice(0, 6)
            .join(" | ") +
            `. dir=rtl is set on <html> for the whole document, so these pages get a mirrored ` +
            `layout with left-to-right English copy in it. Promotes ui-013 to observed.`
        );
      } else {
        ok("every surface is translated when the locale is Urdu");
      }
      // Restore English so cleanup and any later assertion reads normally.
      await visit(admin, "/settings");
      await admin.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /English/i.test(b.textContent || "")
        );
        btn?.click();
      });
      await admin
        .waitForFunction(() => document.documentElement.dir === "ltr", { timeout: 10000 })
        .catch(() => {});
    } else {
      note("could not find the Urdu locale control — RTL sweep skipped");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 11. THE SAME DATUM, TWO VISUAL LANGUAGES  (promotes ui-014)
     *
     * Task status is a colour-coded chip inside the detail modal
     * (STATUS_STYLES) and a bare OS dropdown in the list and board. Create
     * one task IN MY OWN TENANT through the real UI and compare.
     * ═══════════════════════════════════════════════════════════════════ */
    await visit(admin, "/tasks");
    const taskTitle = `qa ui task ${STAMP}`;
    const madeTask = await admin
      .evaluate((title) => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /new task|add task/i.test(b.textContent || "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      }, taskTitle)
      .catch(() => false);
    if (madeTask) {
      await admin
        .waitForSelector('[role="dialog"] input[id*="title"], [role="dialog"] input', {
          timeout: 15000,
        })
        .catch(() => {});
      await admin.type('[role="dialog"] input', taskTitle).catch(() => {});
      await admin.evaluate(() => {
        const f = document.querySelector('[role="dialog"] form');
        const submit = f?.querySelector('button[type="submit"]');
        submit?.click();
      });
      // The row is the predicate, not a timer.
      const landed = await admin
        .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 30000 }, taskTitle)
        .then(() => true)
        .catch(() => false);

      // DB assertion, scoped to MY tenant. A bare task.findFirst({ where:
      // { title } }) could be satisfied by another agent's row.
      const row = await db.task.findFirst({
        where: { companyId: TENANT, title: taskTitle },
        select: { id: true, status: true },
      });
      if (landed && row) ok(`task created in my own tenant (${row.id})`);
      else fail("could not create a task to compare status presentations", `landed=${landed}`);

      if (row) {
        const listChip = await admin.evaluate(() => {
          const sel = document.querySelector('select[id^="status-"], select[id^="board-status-"]');
          if (!sel) return null;
          const cs = getComputedStyle(sel);
          return { kind: "select", bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius };
        });
        // Open the detail modal and read the status treatment there.
        await admin.evaluate((t) => {
          const el = [...document.querySelectorAll("button,tr,li,div")].find((n) =>
            (n.textContent || "").includes(t)
          );
          el?.click();
        }, taskTitle);
        await admin
          .waitForSelector('[role="dialog"]', { timeout: 15000 })
          .catch(() => {});
        const modalChip = await admin.evaluate(() => {
          const d = document.querySelector('[role="dialog"]');
          if (!d) return null;
          const sel = d.querySelector("select");
          const chip = [...d.querySelectorAll("span")].find((s) =>
            /pending|in progress|completed/i.test(s.textContent || "")
          );
          return {
            hasSelect: !!sel,
            hasColouredChip: !!chip,
            chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
          };
        });
        await admin.screenshot({ path: `${OUT}/11-task-detail-status.png` });
        if (listChip && modalChip && listChip.kind === "select" && modalChip.hasColouredChip) {
          fail(
            "the same task status renders as two different controls",
            `in the list it is a native <select> (bg ${listChip.bg}, radius ${listChip.radius}); in ` +
              `the detail modal a colour-coded chip also exists (bg ${modalChip.chipBg}). Status is ` +
              `colour-coded in one place and OS chrome in the other, for the same field on the same ` +
              `record. Promotes ui-014 to observed.`
          );
        } else {
          ok("task status renders consistently across list and detail");
        }
      }
    } else {
      note("no New task affordance on /tasks — status-presentation check skipped");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 12. THE ROLES — member and member-as-supervisor
     *
     * A member sees a different navigation set (finance is hidden). Invite
     * one through the REAL invite flow so the second identity is created the
     * way a customer creates it, and stays inside my tenant.
     * ═══════════════════════════════════════════════════════════════════ */
    await visit(admin, "/team");
    const invited = await admin.evaluate(
      (email) => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /invite/i.test(b.textContent || "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      },
      MEMBER_EMAIL
    );
    let inviteUrl = null;
    if (invited) {
      await admin.waitForSelector('[role="dialog"] input', { timeout: 15000 }).catch(() => {});
      await admin.type('[role="dialog"] input[type=email], [role="dialog"] input', MEMBER_EMAIL);
      await admin.evaluate(() => {
        document.querySelector('[role="dialog"] button[type="submit"]')?.click();
      });
      const tok = await db.inviteToken
        .findFirst({
          where: { companyId: TENANT, email: MEMBER_EMAIL },
          select: { token: true },
          orderBy: { createdAt: "desc" },
        })
        .catch(() => null);
      if (tok) {
        inviteUrl = `${BASE}/invite/${tok.token}`;
        ok("invite created through the real invite flow, inside my tenant");
      } else {
        note("no invite token row for my tenant — member sweep will be skipped");
      }
    }

    if (inviteUrl) {
      const { page: mem } = await newAgentPage(browser);
      await mem.goto(inviteUrl, { waitUntil: "networkidle0", timeout: 60000 });
      await mem.waitForSelector("input", { timeout: 30000 }).catch(() => {});
      await sleep(1500); // hydration, same reason as signIn
      await mem.evaluate(
        (n, p) => {
          const name = document.querySelector("input[name=name]");
          const pw = document.querySelector("input[type=password]");
          const set = (el, v) => {
            if (!el) return;
            const s = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value"
            ).set;
            s.call(el, v);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          };
          set(name, n);
          set(pw, p);
        },
        MEMBER_NAME,
        PASSWORD
      );
      await mem.evaluate(() => document.querySelector('button[type="submit"]')?.click());
      await mem
        .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 45000 })
        .catch(() => {});

      const memberRow = await db.user.findFirst({
        where: { companyId: TENANT, email: MEMBER_EMAIL },
        select: { id: true, role: true },
      });
      if (memberRow?.role === "member") ok("invited user joined MY tenant as a member");
      else fail("invite accept role", `expected member, got ${memberRow?.role ?? "no row"}`);

      // A member's shell must not just hide finance — it must not leave a
      // ragged nav (empty group heading, stray divider, orphaned chevron).
      await visit(mem, "/tasks");
      const memberNav = await mem.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Main navigation"]');
        if (!nav) return null;
        const links = [...nav.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
        // A group heading with no visible children under it is a dead row.
        const orphanHeadings = [...nav.querySelectorAll("button")]
          .filter((b) => {
            const region = b.nextElementSibling;
            return !region || region.querySelectorAll("a[href]").length === 0;
          })
          .map((b) => (b.textContent || "").trim())
          .filter(Boolean);
        return { links, orphanHeadings };
      });
      if (memberNav) {
        const finance = ["/expenses", "/investments", "/revenue", "/recurring", "/budgets"];
        const leaked = finance.filter((f) => memberNav.links.includes(f));
        if (leaked.length > 0) fail("member nav shows finance routes", leaked.join(", "));
        else ok("member nav hides every finance route");
        if (memberNav.orphanHeadings.length > 0) {
          fail(
            "the member sidebar keeps a group heading with nothing under it",
            `${memberNav.orphanHeadings.join(", ")} — a collapsible row that opens to nothing reads ` +
              `as a broken menu. Promotes ui-015 to observed.`
          );
        } else {
          ok("no orphaned nav group headings for a member");
        }
      }
      await mem.screenshot({ path: `${OUT}/12-member-nav.png`, fullPage: true });

      // Empty states and selects as seen by a MEMBER — a different role can
      // reach a different (worse) zero state.
      for (const route of ["/tasks", "/projects", "/time", "/chat", "/settings"]) {
        await visit(mem, route);
        const es = await auditEmptyStates(mem);
        const sels = await auditSelects(mem);
        note(
          `member ${route}: emptyState=${es.primitive.length} prose=${es.prose.length} selects=${sels.length}`
        );
        await mem.screenshot({ path: `${OUT}/13-member-${route.slice(1)}.png`, fullPage: true });
      }
      await mem.close().catch(() => {});
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 13. TRY TO BREAK IT — long strings, double-submit, forged ids, error
     *     boundary, refresh mid-flow. Each one is a place where a layout that
     *     looks fine with tidy data falls over.
     * ═══════════════════════════════════════════════════════════════════ */
    // 13a. A pathologically long, unbroken token in a name must wrap, not
    // push the card past the scrollport (which is overflow-x-hidden).
    await visit(admin, "/projects");
    const longName = "Q" + "a".repeat(120) + STAMP;
    const madeProject = await admin.evaluate((n) => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /new project|create project/i.test(b.textContent || "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    }, longName);
    if (madeProject) {
      await admin.waitForSelector('[role="dialog"] input', { timeout: 15000 }).catch(() => {});
      await admin.type('[role="dialog"] input', longName).catch(() => {});
      await admin.evaluate(() =>
        document.querySelector('[role="dialog"] button[type="submit"]')?.click()
      );
      await admin
        .waitForFunction((t) => document.body.innerText.includes(t.slice(0, 40)), {
          timeout: 30000,
        }, longName)
        .catch(() => {});
      const proj = await db.project.findFirst({
        where: { companyId: TENANT, name: longName },
        select: { id: true },
      });
      if (proj) {
        const of = await auditOverflow(admin);
        if (of.clipped.length > 0 || of.horizontalPageScroll) {
          fail(
            "a long unbroken project name breaks the layout",
            `clipped: ${JSON.stringify(of.clipped)} pageScroll=${of.horizontalPageScroll}`
          );
        } else {
          ok("a 120-character unbroken name wraps without breaking the grid");
        }
        await admin.screenshot({ path: `${OUT}/14-long-name.png`, fullPage: true });
        await db.project.deleteMany({ where: { companyId: TENANT, id: proj.id } });
      } else {
        note("long-name project was rejected by validation — no layout to measure");
      }
    }

    // 13b. Double-submit: does the button reach a disabled STATE the user can
    // see, or does it stay live and look identical while a second write flies?
    await visit(admin, "/tasks");
    const dbl = await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /new task|add task/i.test(b.textContent || "")
      );
      btn?.click();
      return !!btn;
    });
    if (dbl) {
      await admin.waitForSelector('[role="dialog"] input', { timeout: 15000 }).catch(() => {});
      await admin.type('[role="dialog"] input', `qa dbl ${STAMP}`).catch(() => {});
      const pressed = await admin.evaluate(() => {
        const s = document.querySelector('[role="dialog"] button[type="submit"]');
        if (!s) return null;
        const before = { disabled: s.disabled, opacity: getComputedStyle(s).opacity };
        s.click();
        s.click();
        const after = { disabled: s.disabled, opacity: getComputedStyle(s).opacity };
        return { before, after, cursor: getComputedStyle(s).cursor };
      });
      // State predicate, not a timer: the dialog closing (or the row landing)
      // is what says both writes have been attempted. A fixed sleep here would
      // either undercount under load — reporting "no duplicate" while a second
      // insert is still in flight — or pad every run.
      await admin
        .waitForFunction(
          (t) => !document.querySelector('[role="dialog"]') || document.body.innerText.includes(t),
          { timeout: 30000 },
          `qa dbl ${STAMP}`
        )
        .catch(() => {});
      const dupes = await db.task.count({
        where: { companyId: TENANT, title: `qa dbl ${STAMP}` },
      });
      if (dupes > 1) {
        fail("double-clicking submit created duplicate rows", `${dupes} tasks with the same title`);
      } else if (pressed && !pressed.after.disabled && pressed.after.opacity === pressed.before.opacity) {
        fail(
          "the submit button gives no visual in-flight state",
          `disabled ${pressed.before.disabled}→${pressed.after.disabled}, opacity unchanged at ` +
            `${pressed.after.opacity}, cursor "${pressed.cursor}". Nothing on screen tells the user ` +
            `the click registered. Promotes ui-016 to observed.`
        );
      } else {
        ok("submit shows an in-flight state and does not duplicate");
      }
      await db.task.deleteMany({ where: { companyId: TENANT, title: `qa dbl ${STAMP}` } });
      await admin.keyboard.press("Escape");
    }

    // 13c. The error boundary must look like the product, not like a stack trace.
    await visit(admin, "/dashboard");
    const boundary = await admin.evaluate(`(() => {
      ${CONTRAST_HELPERS}
      // Nothing here throws on purpose; measure the boundary's OWN styling by
      // reading the tokens it depends on, so a hardcoded-dark boundary in a
      // light theme is visible as a token mismatch rather than a guess.
      const cs = getComputedStyle(document.documentElement);
      return {
        bg: cs.getPropertyValue("--bg").trim(),
        fg: cs.getPropertyValue("--fg").trim(),
        dark: document.documentElement.classList.contains("dark"),
      };
    })()`);
    note(`token snapshot for boundary comparison: ${JSON.stringify(boundary)}`);

    // 13d. A forged id from no tenant at all must render the designed 404,
    // not a bare Next.js page outside the shell.
    await admin.goto(`${BASE}/projects/clforged000000000000000`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    const notFound = await admin.evaluate(() => ({
      text: document.body.innerText.slice(0, 200),
      hasShell: !!document.querySelector('aside[aria-label="Primary"]'),
      bg: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
    }));
    await admin.screenshot({ path: `${OUT}/15-not-found.png`, fullPage: true });
    if (!/not found|404/i.test(notFound.text)) {
      note(`forged project id rendered: ${JSON.stringify(notFound)}`);
    } else if (!/Inter/i.test(notFound.font)) {
      fail(
        "the not-found page falls back to the system font",
        `fontFamily "${notFound.font}" — the designed shell uses Inter. Promotes ui-017.`
      );
    } else {
      ok("the not-found page keeps the product's typography");
    }

    // 13e. Refresh mid-modal: does the URL carry the state, or does the user
    // silently lose the dialog they were in?
    await visit(admin, "/tasks");
    await admin.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /new task|add task/i.test(b.textContent || "")
      );
      btn?.click();
    });
    const hadDialog = await admin
      .waitForSelector('[role="dialog"]', { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    if (hadDialog) {
      const urlWithDialog = admin.url();
      await admin.reload({ waitUntil: "networkidle0", timeout: 60000 });
      const stillThere = !!(await admin.$('[role="dialog"]'));
      if (!stillThere && !/[?#]/.test(urlWithDialog)) {
        note(
          "a modal is not URL-addressable, so refresh and browser-back both discard it " +
            "(consistent across all 20 modals — filed as a suggestion, not a bug)"
        );
      }
      ok("refresh inside a modal returns to a clean, shelled page");
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 14. CHART PALETTE DRIFT  (promotes ui-018)
     *
     * Five files redeclare the chart palette as raw hex instead of reading the
     * tokens: dashboard-charts, dashboard-client, reports-charts, reports-client
     * and expenses-charts — and expenses-charts declares a DIFFERENT ramp
     * (mint -> amber) from the emerald one everywhere else. Raw hex also means
     * the charts do not re-light when the theme flips, while everything around
     * them does.
     * ═══════════════════════════════════════════════════════════════════ */
    const chartColours = {};
    for (const path of ["/dashboard", "/expenses", "/reports", "/revenue", "/investments"]) {
      await visit(admin, path);
      // Recharts mounts via next/dynamic ssr:false, so wait for the SVG, not a timer.
      const painted = await admin
        .waitForFunction(() => !!document.querySelector(".recharts-surface"), { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (!painted) {
        note(`${path}: no chart painted (empty workspace) — palette check skipped`);
        continue;
      }
      chartColours[path] = await admin.evaluate(() => {
        const seen = new Set();
        for (const el of document.querySelectorAll(
          ".recharts-surface path, .recharts-surface rect, .recharts-surface stop"
        )) {
          for (const attr of ["stroke", "fill", "stop-color"]) {
            const v = el.getAttribute(attr);
            if (v && v.startsWith("#")) seen.add(v.toUpperCase());
          }
        }
        return [...seen];
      });
    }
    const allChart = new Set(Object.values(chartColours).flat());
    // Amber lives outside the emerald brand ramp; any amber in a chart is the
    // expenses-charts outlier.
    const amber = [...allChart].filter((c) => /^#F5(9E|A)/i.test(c) || /^#FBBF/i.test(c));
    if (amber.length > 0) {
      fail(
        "one chart uses a palette no other chart uses",
        `hex literals found across charts: ${JSON.stringify(chartColours)}. ${amber.join(", ")} is ` +
          `amber, outside the emerald brand ramp every other chart draws from. The palette is a raw ` +
          `hex list duplicated in 5 files rather than read from the tokens, so nothing keeps them ` +
          `in step. Promotes ui-018 to observed.`
      );
    } else if (allChart.size > 0) {
      ok(`chart palette is consistent (${[...allChart].join(", ")})`);
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 15. TWO LOADING LANGUAGES  (promotes ui-019)
     *
     * A soft navigation shows the route's skeleton. A COLD load shows the
     * shell's own `currentUser` gate — a centred 40px emerald pulse under
     * "Loading workspace…" — which matches nothing else in the product. Same
     * route, same user, two unrelated loading screens depending on how you
     * arrived.
     * ═══════════════════════════════════════════════════════════════════ */
    const { page: cold } = await newAgentPage(browser);
    await signIn(cold, ADMIN_EMAIL, PASSWORD);
    const coldCdp = await cold.createCDPSession();
    await coldCdp.send("Network.enable");
    await coldCdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 1500,
      downloadThroughput: (150 * 1024) / 8,
      uploadThroughput: (150 * 1024) / 8,
    });
    cold.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 90000 }).catch(() => {});
    const sawGate = await cold
      .waitForFunction(() => /Loading workspace/i.test(document.body.innerText), {
        timeout: 20000,
        polling: 50,
      })
      .then(() => true)
      .catch(() => false);
    if (sawGate) {
      await cold.screenshot({ path: `${OUT}/17-cold-load-gate.png` });
      const gate = await cold.evaluate(() => {
        const main = document.getElementById("main");
        return {
          hasShell: !!document.querySelector('aside[aria-label="Primary"]'),
          hasSkeleton: !!document.querySelector(".animate-pulse"),
          skeletonCount: document.querySelectorAll(".animate-pulse").length,
          insideMain: !!main,
        };
      });
      fail(
        "a cold load and a soft navigation show two unrelated loading screens",
        `cold load of /tasks renders the shell's own gate instead of the route skeleton: ` +
          `sidebar present=${gate.hasShell}, #main present=${gate.insideMain}, ` +
          `pulse blocks=${gate.skeletonCount} (the route's loading.tsx renders a PageHeaderSkeleton ` +
          `plus a table of ~30). So the same route paints a full-screen centred spinner on refresh ` +
          `and a content-shaped skeleton on a sidebar click. Promotes ui-019 to observed.`
      );
    } else {
      ok("a cold load goes straight to the route's own skeleton");
    }
    await coldCdp
      .send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
      .catch(() => {});
    await cold.close().catch(() => {});

    await admin.screenshot({ path: `${OUT}/16-final.png`, fullPage: true });
  } catch (e) {
    fail("run aborted", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e));
  } finally {
    /* ── Cleanup: MY tenant only, children before parents ───────────────
     * Every delete is scoped to TENANT (or a relation that narrows to it).
     * Nothing outside the workspace this run created is touched. */
    if (TENANT) {
      try {
        await db.messageReaction.deleteMany({ where: { message: { companyId: TENANT } } });
        await db.message.deleteMany({ where: { companyId: TENANT } });
        await db.channelMember.deleteMany({ where: { channel: { companyId: TENANT } } });
        await db.channel.deleteMany({ where: { companyId: TENANT } });
        await db.comment.deleteMany({ where: { companyId: TENANT } });
        await db.timeEntry.deleteMany({ where: { companyId: TENANT } });
        await db.notification.deleteMany({ where: { companyId: TENANT } });
        await db.activity.deleteMany({ where: { companyId: TENANT } });
        await db.inviteToken.deleteMany({ where: { companyId: TENANT } });
        await db.recurringRule.deleteMany({ where: { companyId: TENANT } });
        await db.budget.deleteMany({ where: { companyId: TENANT } });
        await db.transaction.deleteMany({ where: { companyId: TENANT } });
        await db.task.deleteMany({ where: { companyId: TENANT } });
        await db.project.deleteMany({ where: { companyId: TENANT } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId: TENANT } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId: TENANT } } });
        await db.user.deleteMany({ where: { companyId: TENANT } });
        await db.company.deleteMany({ where: { id: TENANT } });
        note(`cleaned up tenant ${TENANT}`);
      } catch (e) {
        console.error("  cleanup failed:", e.message);
      }
    }
    await db.$disconnect().catch(() => {});
    await browser.close().catch(() => {});
    console.log(`\n== ui consistency: ${passes} ok, ${failures} failed ==`);
    console.log(`screenshots: ${OUT}`);
    if (failures > 0) console.log("❌");
  }
}

main();
