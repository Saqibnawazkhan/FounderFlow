/*
 * Web Push smoke.
 *
 * THE THREE HALVES OF THIS FEATURE, and which of them a headless browser can
 * actually check:
 *
 *   1. ENTRY POINT — Settings renders the push control, and it offers "Turn on".
 *      Checkable here, and worth checking on its own: this repo has shipped nine
 *      pieces of complete, tested code with no way in.
 *   2. SERVER PERSIST — clicking it reaches `savePushSubscriptionAction` and a
 *      PushSubscription row lands for the signed-in user. Checkable here, and
 *      this is the gate.
 *   3. REAL FCM DELIVERY — the push service accepts the message and the service
 *      worker hands it to the page. NOT checkable here: headless Chrome has no
 *      FCM messaging connection, so `pushManager.subscribe()` never resolves.
 *      Best-effort below, and a MANUAL check: run a real desktop Chrome, turn
 *      push on in Settings, and trigger a notifying event.
 *
 * WHY IT WAS REWRITTEN (audit harness-002). Half 2 was unreachable, and not
 * because of the browser. The script printed "SKIPPED" and called
 * `process.exit(0)` when no subscription appeared — and that exit sat BEFORE
 * `pass = clicked && subscribed` and before the line that prints the failure
 * marker. In headless, the only mode scripts/run-all-smoke.sh uses, the skip
 * fired on every single run: the script exited 0 having asserted nothing, printed
 * no marker, and the suite summary read `OK smoke-push`. Web push has been live
 * since commit 1a19e01 with no working automated check of any kind.
 *
 * That is the same failure class as smoke-rate-limit.mjs: pass criteria
 * downstream of a branch that always fires.
 *
 * WHAT CHANGED. Half 2 is now driven with a STUBBED `PushManager.subscribe`, so
 * the client's `enable()` reaches the server action with a synthetic subscription
 * and the persist half is asserted for real in headless. The real subscribe is
 * still attempted first, so a real browser exercises the real path. And a genuine
 * prerequisite failure — no VAPID key configured, no service worker — now exits
 * 78 ("not runnable", the same code scripts/db-staging.mjs uses for an
 * unprovisioned environment) instead of 0, so the runner prints EXIT78 rather
 * than OK. An unrunnable gate is not a pass.
 */

import puppeteer from "puppeteer-core";
import webpush from "web-push";
import { psqlScalar as psql } from "./_local-psql.mjs";

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
const SMOKE_IP = "10.98.0.16";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";
/** prisma/seed.ts: `const founderId = "demo-saqib"`. */
const USER_ID = "demo-saqib";
const PUB = process.env.VAPID_PUBLIC_KEY ?? "";
const PRIV = process.env.VAPID_PRIVATE_KEY ?? "";

/** Exit code for "this environment cannot run the check", not "the check failed". */
const NOT_RUNNABLE = 78;

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  --  ${label}`);
}

// Raw SQL against the LOCAL docker Postgres, through the one module allowed to
// shell out to psql. It pins the container as a literal and refuses the run when
// .env.local names a non-loopback host, so this path carries the same host
// discipline `localDb()` gives the Prisma path — audit harness-004, where six
// smoke scripts (this one among them) reached the database with no host check at
// all. SQL goes in on stdin, so a quoted identifier needs no shell quoting.

function storedSubscription() {
  return psql(
    `SELECT endpoint || '|' || p256dh || '|' || auth FROM "PushSubscription" ` +
      `WHERE "userId"='${USER_ID}' ORDER BY "createdAt" DESC LIMIT 1;`
  );
}

function cleanup() {
  try {
    psql(`DELETE FROM "PushSubscription" WHERE "userId"='${USER_ID}';`);
  } catch {}
}

async function login(page, email, pw) {
  // Retry until React owns the submit; a pre-hydration click performs a native
  // GET and signs nobody in (FaultsAudit A14).
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await page.waitForSelector("input[type=email]", { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", pw);
    await page.evaluate(() => document.querySelector("form")?.requestSubmit());
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (left) return true;
  }
  return false;
}

/** Click the control's "Turn on", and say whether it was there to click. */
async function clickTurnOn(page) {
  return page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find(
      (x) => x.textContent?.trim() === "Turn on"
    );
    if (!b) return false;
    b.click();
    return true;
  });
}

cleanup();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
// Auto-grant notifications so requestPermission() resolves granted.
await browser.defaultBrowserContext().overridePermissions(BASE, ["notifications"]);
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

console.log("== web push smoke ==");

let notRunnable = null;
let row = "";

try {
  if (await login(page, "demo@founderflow.app", "demo123")) {
    ok("signed in as demo@founderflow.app");
  } else {
    fail("sign-in", `still on ${page.url()} after 3 attempts`);
  }

  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle2" });
  await page.waitForSelector("button", { timeout: 25_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  // ── prerequisite: is push configured on this deployment at all? ────────
  // PushToggle renders a plain status line instead of a button when
  // NEXT_PUBLIC_VAPID_PUBLIC_KEY is unset. That is a configuration fact about
  // the environment, not a product failure, so it must not read as either OK or
  // FAIL.
  const unconfigured = await page.evaluate(() =>
    /aren.t set up on this deployment|doesn.t support push notifications/i.test(
      document.body.innerText
    )
  );
  if (unconfigured) {
    notRunnable =
      "Settings reports push as unsupported/unconfigured. Set " +
      "NEXT_PUBLIC_VAPID_PUBLIC_KEY (and VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY for " +
      "stage 2) on the dev server and re-run.";
  } else {
    // ── 1. the entry point ──────────────────────────────────────────────
    const clicked = await clickTurnOn(page);
    if (clicked) ok('Settings offers a "Turn on" control for push');
    else fail("push entry point", 'no "Turn on" button on /settings');

    // ── 2. the server persist, real subscribe first ─────────────────────
    await new Promise((r) => setTimeout(r, 5000));
    row = storedSubscription();
    if (row) {
      ok("a real subscription was created and stored (not a headless browser)");
    } else {
      // Headless Chrome has no FCM connection, so `pushManager.subscribe()`
      // never resolves and `enable()` falls into its catch. Stub subscribe with
      // something that satisfies `sub.toJSON()` — the only thing
      // lib/hooks/usePushNotifications.ts reads off it — so the client reaches
      // savePushSubscriptionAction and the PERSIST half is exercised for real.
      note("no real subscription (expected in headless) — retrying with a stubbed PushManager");
      const stubbed = await page.evaluate(() => {
        if (!("PushManager" in window) || !("serviceWorker" in navigator)) return false;
        const endpoint = `https://smoke.invalid/ff-${Date.now()}`;
        window.PushManager.prototype.subscribe = function stubSubscribe() {
          return Promise.resolve({
            endpoint,
            toJSON: () => ({
              endpoint,
              expirationTime: null,
              keys: { p256dh: "BSmokeP256dhStubValue", auth: "SmokeAuthStub" },
            }),
            unsubscribe: () => Promise.resolve(true),
          });
        };
        return true;
      });

      if (!stubbed) {
        notRunnable =
          "this browser exposes no PushManager / serviceWorker, so neither the real " +
          "nor the stubbed subscribe path can run";
      } else {
        const reclicked = await clickTurnOn(page);
        if (!reclicked) {
          fail("push retry", 'the "Turn on" button did not come back after the failed attempt');
        }
        await new Promise((r) => setTimeout(r, 5000));
        row = storedSubscription();
        if (row) {
          ok("clicking Turn on persisted a PushSubscription row for the signed-in user");
        } else {
          // THE assertion this file never made. The subscribe call now resolves,
          // so nothing browser-shaped is in the way: if no row landed, the
          // server action, its auth gate or its write is broken.
          fail(
            "push persist",
            `no PushSubscription row for userId=${USER_ID} after a resolving subscribe — ` +
              "check savePushSubscriptionAction and PushSubscriptionSchema"
          );
        }
      }
    }
  }

  // ── 3. real delivery, best effort, never the gate ──────────────────────
  if (row && PUB && PRIV) {
    const [endpoint, p256dh, auth] = row.split("|");
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@founderflow.app", PUB, PRIV);
    try {
      const res = await webpush.sendNotification(
        { endpoint, keys: { p256dh, auth } },
        JSON.stringify({ title: "Push smoke", body: "hello", url: "/notifications", tag: "smoke" })
      );
      note(`stage 3: push service answered ${res.statusCode} (best effort)`);
    } catch (e) {
      // A stubbed endpoint is smoke.invalid and will always fail here. That is
      // expected and is why this stage cannot be the gate.
      note(`stage 3: send did not complete (${e.statusCode ?? e.message}) — manual check only`);
    }
  } else {
    note("stage 3: skipped (no stored subscription, or no VAPID keypair in the env)");
  }
} catch (err) {
  fail("push smoke threw", err.message);
} finally {
  await browser.close();
  cleanup();
}

// A RECORDED FAILURE OUTRANKS "not runnable", and getting that order wrong here
// would have reintroduced harness-002 in a new costume. `fail()` can already have
// run above — the push entry point is asserted before the browser is asked for a
// PushManager at all — and `notRunnable` is set later, when headless turns out to
// have no FCM connection. Exiting 78 unconditionally discarded that verdict, and
// scripts/run-all-smoke.sh classifies 78 as NOTRUN, which deliberately does NOT
// count as a failure. So a real product bug would have been reported as "this
// environment cannot run the check" and the run would have stayed green.
if (notRunnable && !process.exitCode) {
  console.log(`\n== NOT RUNNABLE (exit ${NOT_RUNNABLE}) ==\n${notRunnable}`);
  process.exit(NOT_RUNNABLE);
}
if (notRunnable) {
  console.log(
    `\n== ${notRunnable}\n   …but a check above already FAILED, so this run is a failure.`
  );
}
console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
process.exit(process.exitCode ? 1 : 0);
