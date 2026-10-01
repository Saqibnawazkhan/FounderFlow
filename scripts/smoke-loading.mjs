/*
 * Loading-skeleton smoke: every authenticated route shows ITS OWN skeleton
 * during a client-side navigation, rather than a blank frame.
 *
 * `loading.tsx` only fires for App-Router client navigation, not for a full
 * reload, so the navigation is a click on the sidebar <Link>. The network is
 * throttled first so the page chunk takes long enough for the skeleton to be
 * observable at all.
 *
 * TWO THINGS WERE WRONG WITH THIS FILE (audit harness-010), and they compounded.
 *
 * 1. THE PASS CRITERION COULD NOT TELL WHOSE SKELETON IT WAS SEEING. It was
 *    `document.querySelectorAll(".animate-pulse").length > 0`. But
 *    app/(app)/layout.tsx renders `<div className="h-10 w-10 animate-pulse …" />`
 *    with "Loading workspace…" during the SHELL's own load, and
 *    components/time/clock-widget.tsx uses the class too. So the count can be
 *    satisfied with no `loading.tsx` rendering at all. The criterion is now a
 *    DELTA against the settled page: take the count before the click, and require
 *    it to RISE during the transition. Neither the shell loader nor the clock
 *    widget can produce a rise, because they are already counted in the baseline.
 *
 * 2. THE ROUTE LIST WAS HAND-WRITTEN, and it had stopped growing when the route
 *    tree did: 9 of the 15 static authenticated routes, omitting /revenue,
 *    /recurring, /budgets, /time, /projects and /chat. It had drifted precisely
 *    onto the gap — /revenue had no loading.tsx at the time and was not in the
 *    list, so nothing here noticed a route rendering a blank frame. The list is
 *    now derived by walking app/(app) for page.tsx, and the derivation is
 *    asserted to find more routes than the old list held.
 *
 *    AN EARLIER VERSION OF THIS PARAGRAPH said "the script reported 9/9". It
 *    cannot have: the old list led with /expenses and /investments, both children
 *    of the collapsed FINANCE_GROUP, which have no sidebar <a href> at all (see
 *    the expansion step below), so it failed to find their links and reported at
 *    most 7 of 9. A confident number in a comment, never run against the thing it
 *    describes — the same shape as the defect the paragraph is about.
 *
 * WHAT IT STILL CANNOT COVER: the two dynamic routes, /projects/[id] and
 * /chat/[slug], because a URL for them has to come from data. `tests/ops/
 * loading-coverage.test.ts` checks every page.tsx has a sibling loading.tsx
 * INCLUDING those two, needs no browser, and cannot drift — that is the guard
 * that catches a missing skeleton file; this script checks that the file which
 * exists actually paints.
 */

import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This script's own rate-limit bucket (audit harness-009). Every puppeteer
 * request in dev arrives with no forwarding header, so lib/client-ip.ts finds no
 * trusted address and lib/rate-limit.ts falls back to per-ACCOUNT limits — which
 * means two scripts signing in as the same seeded user share one 5-per-minute
 * budget, and whichever runs second reports "cannot sign in". A distinct address
 * per script is what lib/client-ip.ts already documents the harness as relying
 * on, and what every scripts/qa-*.mjs already does on 10.99.0.x.
 *
 * tests/ops/smoke-hygiene.test.ts asserts these are unique across the directory
 * and that every page created here is given one.
 */
const SMOKE_IP = "10.98.0.12";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const APP_GROUP = join(REPO_ROOT, "app", "(app)");

/** How many routes the hand-written list used to hold. The derivation must beat it. */
const OLD_HARDCODED_COUNT = 9;

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

/**
 * Every STATIC route under app/(app), derived from the tree. A segment in
 * brackets is dynamic and is skipped, because the URL needs an id from the
 * database; those are covered by tests/ops/loading-coverage.test.ts instead.
 */
function staticRoutes(dir = APP_GROUP, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && e.name === "page.tsx") && prefix !== "") {
    out.push(prefix);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // A bracketed segment is dynamic; a parenthesised one is a route group and
    // contributes nothing to the URL.
    if (entry.name.startsWith("[")) continue;
    const segment = entry.name.startsWith("(") ? "" : `/${entry.name}`;
    out.push(...staticRoutes(join(dir, entry.name), prefix + segment));
  }
  return out;
}

const derived = staticRoutes();
// /dashboard goes last: the tour starts there, and clicking the link for the
// page you are already on navigates nowhere and would read as a missing skeleton.
const ROUTES = derived.filter((r) => r !== "/dashboard").concat(["/dashboard"]);

console.log("== loading-skeleton smoke ==");

if (ROUTES.length <= OLD_HARDCODED_COUNT) {
  // Guards the derivation. If the walk breaks, it returns a short list and every
  // assertion below passes over the routes it did find — which is the exact
  // failure the hand-written list already had.
  fail(
    "route derivation",
    `only ${ROUTES.length} route(s) found under app/(app) — the walk is broken, or ` +
      `the tree shrank below the ${OLD_HARDCODED_COUNT} the old hardcoded list held`
  );
} else {
  ok(`derived ${ROUTES.length} static routes from app/(app) — ${ROUTES.join(" ")}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

const pulseCount = () => page.evaluate(() => document.querySelectorAll(".animate-pulse").length);

try {
  // ── sign in ───────────────────────────────────────────────────────────
  // Retry until React owns the submit; a pre-hydration submit is a native GET
  // (FaultsAudit A14).
  let signedIn = false;
  for (let attempt = 1; attempt <= 3 && !signedIn; attempt += 1) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("input[name=email]", { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.type("input[name=email]", "demo@founderflow.app");
    await page.type("input[name=password]", "demo123");
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    signedIn = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
  }
  if (signedIn) ok("signed in as demo@founderflow.app");
  else fail("sign-in", `still on ${page.url()} after 3 attempts`);

  // Land on /dashboard cleanly so the sidebar is rendered + clickable.
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle2" });
  await page.waitForSelector('aside[aria-label="Primary"]', { timeout: 15_000 });

  // EXPAND EVERY COLLAPSIBLE NAV GROUP FIRST, or a third of this script cannot
  // pass. Found by adversarial verification, not by running it.
  //
  // The loop below clicks `aside[aria-label="Primary"] a[href="${path}"]`, which
  // assumes every route derived from the tree has a link in the rail. Five do
  // not: components/layout/sidebar.tsx renders FINANCE_GROUP as a <button> when
  // the sidebar is expanded, and its five children (/expenses, /revenue,
  // /investments, /recurring, /budgets) are inside `{financeOpen && …}`.
  // `financeNavOpen` defaults to false (lib/store.ts), so on a fresh puppeteer
  // profile no <a href> exists for any of them. The group force-opens on ARRIVAL
  // at a finance route — and the only sidebar way in is the link that is missing,
  // so the condition is unreachable from here.
  //
  // Done once rather than per route because the flag is persisted in the store,
  // and asserted rather than assumed: if the expansion stops working, this fails
  // with one clear line instead of five confusing ones.
  const expanded = await page.evaluate(() => {
    const rail = document.querySelector('aside[aria-label="Primary"]');
    if (!rail) return 0;
    const closed = rail.querySelectorAll(
      'button[aria-expanded="false"][aria-controls^="nav-group-"]'
    );
    closed.forEach((b) => b.click());
    return closed.length;
  });
  // React renders the children on the next tick, so the count has to be taken
  // after a beat rather than in the same evaluate.
  await new Promise((r) => setTimeout(r, 400));
  const missing = [];
  for (const path of ROUTES) {
    const present = await page.evaluate(
      (href) => !!document.querySelector(`aside[aria-label="Primary"] a[href="${href}"]`),
      path
    );
    if (!present) missing.push(path);
  }
  if (missing.length === 0) {
    ok(
      `every one of the ${ROUTES.length} derived routes has a sidebar link` +
        (expanded ? ` (after expanding ${expanded} nav group(s))` : "")
    );
  } else {
    fail(
      "sidebar links for the derived routes",
      `${missing.length} of ${ROUTES.length} have no <a href> in the rail even after ` +
        `expanding ${expanded} group(s): ${missing.join(", ")}. lib/nav.ts, the route ` +
        `tree and components/layout/sidebar.tsx disagree.`
    );
  }

  // Throttle so the page-chunk fetch takes long enough to see the skeleton.
  const cdp = await page.target().createCDPSession();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: (200 * 1024) / 8,
    uploadThroughput: (50 * 1024) / 8,
  });

  for (const path of ROUTES) {
    // BASELINE on the settled page. This is the whole fix: the shell's own
    // loader and the clock widget are counted here, so they cannot be mistaken
    // for the route's skeleton below.
    await new Promise((r) => setTimeout(r, 300));
    const baseline = await pulseCount();

    // Click the sidebar link by exact href so this is client-side App Router
    // navigation; Next.js then shows loading.tsx until the chunk + RSC resolve.
    const clicked = await page.evaluate((href) => {
      const link = document.querySelector(`aside[aria-label="Primary"] a[href="${href}"]`);
      if (!link) return false;
      link.click();
      return true;
    }, path);
    if (!clicked) {
      fail(
        `${path} skeleton`,
        `no sidebar link with href="${path}" — lib/nav.ts and the route tree disagree`
      );
      continue;
    }

    // Sample shortly after the click — still in the loading state.
    await new Promise((r) => setTimeout(r, 250));
    let during = baseline;
    try {
      during = await pulseCount();
    } catch {
      // Execution context destroyed mid-probe means navigation completed;
      // take another sample.
      await new Promise((r) => setTimeout(r, 200));
      try {
        during = await pulseCount();
      } catch {
        /* swallow: reported as no rise below */
      }
    }

    // Let the route settle before moving on. Waiting for the count to return to
    // the baseline rather than to zero, for the same reason the criterion is a
    // delta: something on the settled page may legitimately pulse.
    await page
      .waitForFunction(
        (base) =>
          document.querySelectorAll(".animate-pulse").length <= base &&
          !!document.querySelector("h1"),
        { timeout: 20_000 },
        baseline
      )
      .catch(() => {});
    const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent ?? "");

    if (during > baseline) {
      ok(
        `${path} — skeleton painted (${baseline} -> ${during} pulsing), settled h1 "${h1.slice(0, 40)}"`
      );
    } else {
      fail(
        `${path} skeleton`,
        `pulsing element count did not rise during navigation (${baseline} -> ${during}). ` +
          `Either app/(app)${path}/loading.tsx is missing, or it renders nothing that pulses. ` +
          `A count of ${baseline} on its own is the shell loader and the clock widget, not this route.`
      );
    }
  }
} catch (err) {
  fail("loading smoke threw", err.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
process.exit(process.exitCode ? 1 : 0);
