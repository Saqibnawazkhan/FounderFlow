/*
 * Login rate-limit smoke: six wrong passwords from one address, and the sixth
 * must be REFUSED BY THE LIMITER rather than by bcrypt.
 *
 * WHY IT WAS REWRITTEN (audit harness-014 item 9, and the failure class of
 * harness-002). Every pass criterion in this file sat inside `if (logPath)`,
 * gated on `process.env.DEV_LOG`, which scripts/run-all-smoke.sh does not set.
 * So on every suite run the whole block was skipped and control fell through to
 * a bare `process.exit(0)`: the script asserted NOTHING, printed no failure
 * marker, and the summary read `OK smoke-rate-limit`. The one automated check of
 * the brute-force defence added to close a P0 was decoration.
 *
 * AND THE SIGNAL WAS THE WRONG ONE. It inferred the limiter from RESPONSE
 * TIMING — "a short-circuit returns in under 100ms, bcrypt takes 400ms+" — read
 * out of a dev-server log. That is a heuristic about the machine it runs on,
 * and a slow disk or a warm bcrypt turns it into a false verdict in either
 * direction. The app says what happened in words: `loginAction` returns
 * `Too many requests. Try again in Ns.` (lib/actions/auth.ts, via
 * gateAuthAction's login class) and app/login/page.tsx toasts it. That is what
 * this script asserts now. Timing stays in the log as diagnostics and gates
 * nothing.
 *
 * THE TWO ASSERTIONS ARE BOTH STALE-TOAST-PROOF, which is why they are the two.
 * react-hot-toast keeps a message on screen for ~4s, so reading the DOM between
 * attempts can show a previous attempt's text. So:
 *   - after attempt 1, "Too many requests" must be ABSENT. It cannot be stale,
 *     because it has never been said. Present here means the bucket was already
 *     exhausted by something else — which is exactly the cross-script starvation
 *     harness-009 is about, and this script has its own SMOKE_IP so that it
 *     cannot happen.
 *   - after attempt 6, "Too many requests" must be PRESENT. An earlier
 *     "Invalid email or password" lingering on screen does not affect that.
 */

import puppeteer from "puppeteer-core";
import { readFile } from "node:fs/promises";

/**
 * This script's own rate-limit bucket (audit harness-009). Every puppeteer
 * request in dev arrives with no forwarding header, so lib/client-ip.ts finds no
 * trusted address and lib/rate-limit.ts falls back to per-ACCOUNT limits — which
 * means two scripts signing in as the same seeded user share one 5-per-minute
 * budget, and whichever runs second reports "cannot sign in". A distinct address
 * per script is what lib/client-ip.ts already documents the harness as relying
 * on, and what every scripts/qa-*.mjs already does on 10.99.0.x.
 *
 * IT MATTERS MORE HERE THAN ANYWHERE ELSE, in both directions: this script
 * deliberately exhausts a login bucket, so without its own address it would
 * starve whatever ran next — and its own first assertion (the bucket is NOT
 * already exhausted) would be at the mercy of whatever ran before.
 *
 * tests/ops/smoke-hygiene.test.ts asserts these are unique across the directory
 * and that every page created here is given one.
 */
const SMOKE_IP = "10.98.0.17";

const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3000";

/** The limiter's own words. lib/rate-limit.ts builds this string. */
const LIMITED = "Too many requests";
/** 5 per 60s per key, so the sixth attempt is the first refused one. */
const ATTEMPTS = 6;

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1280, height: 800 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// Track POST /login responses so each attempt can be waited for in sequence.
// Diagnostics, plus the vacuity check below: if the form never posted, nothing
// here means anything.
const timings = [];
page.on("response", (resp) => {
  const req = resp.request();
  if (req.method() === "POST" && resp.url().endsWith("/login")) {
    timings.push({ status: resp.status(), at: Date.now() });
  }
});

console.log("== login rate-limit smoke ==");

/** One wrong-password submission. Returns the page text right after it settles. */
async function attempt(label) {
  const startCount = timings.length;
  const t0 = Date.now();

  await page.evaluate(() => {
    const emailEl = document.querySelector("input[name=email]");
    const pwEl = document.querySelector("input[name=password]");
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setVal(emailEl, "bogus-attacker@example.com");
    setVal(pwEl, "wrong-password");
    document.querySelector("form")?.requestSubmit();
  });

  // Wait for a NEW POST /login response to arrive.
  for (let i = 0; i < 100; i += 1) {
    if (timings.length > startCount) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // The action returns before the toast paints.
  await new Promise((r) => setTimeout(r, 900));
  const elapsed = Date.now() - t0;
  const text = await page.evaluate(() => document.body.innerText);
  console.log(
    `  attempt ${label}: status=${timings[startCount]?.status ?? "?"} elapsed=${elapsed}ms` +
      `${text.includes(LIMITED) ? " [limited]" : ""}`
  );
  return text;
}

try {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("input[name=email]", { timeout: 30_000 });
  // Beat for RHF hydration so the form actually intercepts submit; a
  // pre-hydration submit is a native GET and reaches no server action at all.
  await new Promise((r) => setTimeout(r, 1200));

  let firstText = "";
  let lastText = "";
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    const text = await attempt(i);
    if (i === 1) firstText = text;
    if (i === ATTEMPTS) lastText = text;
  }

  // Vacuity first: with no POST observed, the form never submitted and both
  // assertions below are about a page that did nothing.
  if (timings.length === 0) {
    fail("login submissions", "no POST /login response was observed at all");
  } else {
    ok(`${timings.length} POST /login response(s) observed across ${ATTEMPTS} attempts`);
  }

  if (firstText.includes(LIMITED)) {
    fail(
      "fresh bucket",
      `the FIRST attempt was already answered "${LIMITED}" — this address's budget was ` +
        "spent before the script started. Check that SMOKE_IP is unique and that " +
        "x-real-ip is being trusted (lib/client-ip.ts)."
    );
  } else {
    ok("the first attempt reached the credential check rather than the limiter");
  }

  if (lastText.includes(LIMITED)) {
    ok(`attempt ${ATTEMPTS} was refused by the limiter, not by bcrypt`);
  } else {
    // THE assertion this file existed to make and never made. Six wrong
    // passwords a minute from one address is a brute-force attempt.
    fail(
      "login throttle",
      `attempt ${ATTEMPTS} was still answered by the credential check — the login ` +
        "limiter did not engage. Is RATE_LIMIT_DISABLED=true, or is x-real-ip untrusted?"
    );
  }

  console.log(`  (timings: ${timings.map((t, i) => `${i + 1}@${t.at}`).join(" ")})`);

  // ── optional corroboration, never the gate ────────────────────────────
  // If a dev-server log is pointed at, the short-circuit shows up as a
  // dramatically shorter server-side duration. Useful, machine-dependent, and
  // the reason this whole file used to assert nothing when DEV_LOG was unset.
  const logPath = process.env.DEV_LOG;
  if (logPath) {
    try {
      const log = await readFile(logPath, "utf8");
      const posts = log.match(/POST \/login \d+ in (\d+)ms/g)?.slice(-ATTEMPTS) ?? [];
      if (posts.length > 0) {
        console.log(`  (server-side durations: ${posts.join(", ")})`);
      }
    } catch (e) {
      console.log(`  (DEV_LOG set but unreadable: ${e.message})`);
    }
  }
} catch (err) {
  fail("rate-limit smoke threw", err.message);
} finally {
  await browser.close();
}

console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
process.exit(process.exitCode ? 1 : 0);
